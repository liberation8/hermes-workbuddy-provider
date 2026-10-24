"""FastAPI routes for the workbuddy-switch Hermes plugin.

Namespace: /api/plugins/workbuddy-switch
Endpoints: GET /status, POST /start, POST /stop, POST /toggle

Standard library + fastapi only. Windows only.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_PORT = int(os.environ.get("WORKBUDDY_SWITCH_PORT") or 8788)
DEFAULT_HOST = os.environ.get("WORKBUDDY_SWITCH_HOST") or "127.0.0.1"
NODE_PATH = os.environ.get("WORKBUDDY_SWITCH_NODE") or r"C:\Program Files\nodejs\node.exe"
PROXY_SCRIPT = os.environ.get("WORKBUDDY_SWITCH_PROXY_SCRIPT") or (
    r"D:\Hermes\skills\workbuddy-reverse-proxy\server\workbuddy-proxy.mjs"
)
LOG_DIR = Path(os.environ.get("WORKBUDDY_SWITCH_LOG_DIR") or r"D:\dsh\logs")
OUT_LOG = LOG_DIR / "workbuddy-proxy.out.log"
ERR_LOG = LOG_DIR / "workbuddy-proxy.err.log"
PROXY_STATE_FILE = Path(
    os.environ.get("WORKBUDDY_SWITCH_STATE_FILE") or r"D:\dsh\.workbuddy-proxy.json"
)
STATE_HOME = os.environ.get("WORKBUDDY_SWITCH_HOME") or ""

START_TIMEOUT_S = 15.0
STOP_TIMEOUT_S = 10.0
POLL_INTERVAL_S = 0.25
HEALTH_TIMEOUT_S = 2.0

# Windows process creation flags (absent on non-Windows Python builds).
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000
_CREATE_FLAGS = _DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW
_NO_WINDOW = 0x08000000

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


# Popen handles for proxies this process started. Holding the handle lets
# do_stop() terminate the child through the handle (always permitted for our
# own child) instead of relying on taskkill, which can be denied when the
# Hermes host runs under a different integrity level than the proxy.
_OWNED: Dict[int, subprocess.Popen] = {}


def _state_file() -> Path:
    """Writable location for our own pid record.

    The pid here is display-only (liveness is decided by /healthz), so a base
    directory that turns out to be unwritable must degrade quietly rather than
    break a start/stop call.
    """
    candidates = [
        STATE_HOME or None,
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("TEMP"),
        os.environ.get("TMP"),
    ]
    for base in candidates:
        if not base:
            continue
        path = Path(base) / "hermes-workbuddy-switch" / "state.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "ab"):
                pass
            return path
        except Exception:
            continue
    return Path(os.environ.get("TEMP") or ".") / "hermes-workbuddy-switch" / "state.json"


def _read_own_state() -> Dict[str, Any]:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_own_state(data: Dict[str, Any]) -> None:
    try:
        path = _state_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _read_proxy_config() -> Dict[str, Any]:
    """Read the proxy's own state file for port/host only (no secrets kept)."""
    try:
        data = json.loads(PROXY_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    port = data.get("port")
    if isinstance(port, int) and 0 < port < 65536:
        out["port"] = port
    host = data.get("host")
    if isinstance(host, str) and host.strip():
        out["host"] = host.strip()
    return out


def _resolve_endpoint() -> Tuple[str, int]:
    cfg = _read_proxy_config()
    port = cfg.get("port", DEFAULT_PORT)
    host = cfg.get("host", DEFAULT_HOST)
    if host in ("0.0.0.0", "::", ""):
        host = DEFAULT_HOST
    return host, port


def _health(host: str, port: int, timeout: float = HEALTH_TIMEOUT_S) -> Optional[Dict[str, Any]]:
    """GET /healthz. Returns the decoded JSON body, or None when unreachable."""
    url = "http://{}:{}/healthz".format(host, port)
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            raw = resp.read(65536)
    except Exception:
        return None
    try:
        body = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _decode_cli(raw: bytes) -> str:
    """Decode console-tool output.

    netstat/taskkill/tasklist write in the OEM code page (e.g. cp936 on a
    Chinese Windows), never UTF-8: decoding those bytes as UTF-8 mangles them
    into replacement characters, which silently breaks any text matching.
    """
    for enc in ("mbcs", "oem", "utf-8"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "replace")


def _run_proc(argv: List[str], timeout: int = 15) -> Tuple[Optional[int], str]:
    """Run a console tool. Returns (exit code, combined output); code is None if it failed to run."""
    try:
        proc = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=_NO_WINDOW,
        )
    except Exception:
        return None, ""
    raw = (proc.stdout or b"") + b"\n" + (proc.stderr or b"")
    return proc.returncode, _decode_cli(raw)


def _run_capture(argv: List[str], timeout: int = 15) -> Optional[str]:
    code, text = _run_proc(argv, timeout)
    return None if code is None else text


def _netstat_pids(port: int) -> List[int]:
    """PIDs LISTENING on *port*, resolved through netstat -ano.

    psutil-style enumeration misses sockets owned by another integrity level
    on this host, so the raw netstat table is the only reliable source.
    """
    out = _run_capture(["netstat", "-ano"])
    if out is None:
        return []
    pat = re.compile(r"^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$", re.IGNORECASE)
    pids: List[int] = []
    for line in out.splitlines():
        m = pat.match(line)
        if not m:
            continue
        try:
            if int(m.group(1)) != int(port):
                continue
            pid = int(m.group(2))
        except ValueError:
            continue
        if pid > 0 and pid not in pids:
            pids.append(pid)
    return pids


def _pid_alive(pid: Optional[int]) -> bool:
    """True when *pid* names a live process.

    tasklist's "no match" notice is localised OEM text, so the row is matched
    by shape instead: a CSV match begins with a quoted image name and carries
    the pid as its second field.
    """
    if not pid or pid <= 0:
        return False
    code, out = _run_proc(["tasklist", "/FI", "PID eq {}".format(pid), "/NH", "/FO", "CSV"])
    if code != 0:
        return False
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith('"'):
            continue
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[1] == str(pid):
            return True
    return False


def _tail(path: Path, lines: int = 20) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    return "\n".join(text.splitlines()[-lines:]).strip()


_LOG_TARGET: Optional[Tuple[Path, Path]] = None


def _ensure_log_dir() -> Tuple[Path, Path]:
    """Return the (out, err) log paths to use, creating the directory first.

    D:\dsh\logs is the canonical location. When it is not writable (a host
    policy or ACL can deny it) fall back to a temp directory so a start is
    never blocked purely by logging.
    """
    global _LOG_TARGET
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        probe = LOG_DIR / ".write-test"
        probe.write_bytes(b"")
        probe.unlink()
        _LOG_TARGET = (OUT_LOG, ERR_LOG)
    except Exception:
        fallback = Path(os.environ.get("TEMP") or ".") / "hermes-workbuddy-switch"
        try:
            fallback.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        _LOG_TARGET = (
            fallback / "workbuddy-proxy.out.log",
            fallback / "workbuddy-proxy.err.log",
        )
    return _LOG_TARGET


def _err_log_path() -> Path:
    """The stderr log actually in use; resolves the target on first use.

    /status must report the file a start would really write, so the log
    directory is probed once here rather than only inside do_start().
    """
    if _LOG_TARGET is None:
        _ensure_log_dir()
    return _LOG_TARGET[1] if _LOG_TARGET is not None else ERR_LOG


# ---------------------------------------------------------------------------
# Status payload
# ---------------------------------------------------------------------------


def _status_payload(error: Optional[str] = None) -> Dict[str, Any]:
    host, port = _resolve_endpoint()
    health = _health(host, port)
    running = health is not None
    own = _read_own_state()
    own_pid = own.get("pid")
    if not isinstance(own_pid, int):
        own_pid = None

    pid: Optional[int] = None
    if running:
        candidates = _netstat_pids(port)
        if own_pid is not None and own_pid in candidates:
            pid = own_pid
        elif candidates:
            pid = candidates[0]
    elif own_pid is not None and _pid_alive(own_pid):
        pid = own_pid

    uptime: Optional[float] = None
    if running and health is not None:
        raw = health.get("uptime_s")
        if isinstance(raw, (int, float)):
            uptime = float(raw)

    return {
        "ok": error is None,
        "running": running,
        "pid": pid,
        "port": port,
        "uptimeS": uptime,
        "nodePath": NODE_PATH,
        "proxyScript": PROXY_SCRIPT,
        "logPath": str(_err_log_path()),
        "error": error,
    }


# ---------------------------------------------------------------------------
# Core actions (importable and directly callable by selftest.py)
# ---------------------------------------------------------------------------


def do_status() -> Dict[str, Any]:
    return _status_payload()


def do_start() -> Dict[str, Any]:
    host, port = _resolve_endpoint()

    if _health(host, port) is not None:
        return _status_payload()

    out_log, err_log = _ensure_log_dir()

    if not Path(NODE_PATH).exists():
        return _status_payload(error="node.exe not found at {}".format(NODE_PATH))
    if not Path(PROXY_SCRIPT).exists():
        return _status_payload(error="proxy script not found at {}".format(PROXY_SCRIPT))

    popen_kwargs: Dict[str, Any] = {
        "cwd": str(Path(PROXY_SCRIPT).parent),
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = _CREATE_FLAGS

    out_f = None
    err_f = None
    try:
        out_f = open(out_log, "ab")
        err_f = open(err_log, "ab")
        popen_kwargs["stdout"] = out_f
        popen_kwargs["stderr"] = err_f
        proc = subprocess.Popen([NODE_PATH, PROXY_SCRIPT], **popen_kwargs)
    except Exception as exc:
        return _status_payload(error="failed to spawn proxy: {}".format(exc))
    finally:
        # The detached child owns duplicated handles; keeping these open in the
        # parent would leak a file object on every start.
        for f in (out_f, err_f):
            try:
                if f is not None:
                    f.close()
            except Exception:
                pass

    _OWNED[proc.pid] = proc
    _write_own_state(
        {"pid": proc.pid, "port": port, "startedAtMs": int(time.time() * 1000)}
    )

    deadline = time.time() + START_TIMEOUT_S
    while time.time() < deadline:
        if _health(host, port) is not None:
            return _status_payload()
        if proc.poll() is not None:
            # The child exited; allow one last probe before reporting failure.
            time.sleep(POLL_INTERVAL_S)
            if _health(host, port) is not None:
                return _status_payload()
            msg = "proxy exited with code {} before becoming healthy".format(proc.returncode)
            tail = _tail(err_log, 20)
            if tail:
                msg += "\n" + tail
            return _status_payload(error=msg)
        time.sleep(POLL_INTERVAL_S)

    msg = "timed out after {:.0f}s waiting for /healthz on {}:{}".format(
        START_TIMEOUT_S, host, port
    )
    tail = _tail(err_log, 20)
    if tail:
        msg += "\n" + tail
    return _status_payload(error=msg)


def do_stop() -> Dict[str, Any]:
    host, port = _resolve_endpoint()

    if _health(host, port) is None:
        _write_own_state({})
        return _status_payload()

    pids = _netstat_pids(port)
    own = _read_own_state()
    own_pid = own.get("pid")
    if isinstance(own_pid, int) and own_pid > 0 and own_pid not in pids:
        pids.append(own_pid)

    if not pids:
        return _status_payload(
            error="proxy is listening on {}:{} but no owning PID could be resolved".format(
                host, port
            )
        )

    killed: List[int] = []
    failures: List[str] = []
    for pid in pids:
        # A proxy this process spawned is terminated through its own handle:
        # that path is permitted even when taskkill is denied because the host
        # and the proxy sit at different integrity levels.
        owned = _OWNED.get(pid)
        if owned is not None:
            try:
                owned.terminate()
                owned.wait(timeout=5)
                killed.append(pid)
                continue
            except Exception:
                pass
        # The verdict comes from the exit code: taskkill's message is localised
        # OEM text, so matching English keywords never detects a denial.
        code, out = _run_proc(["taskkill", "/PID", str(pid), "/T", "/F"])
        if code == 0:
            killed.append(pid)
        else:
            detail = out.strip().replace("\r", " ").replace("\n", " ") or "no output"
            failures.append("{}: exit={} {}".format(pid, code, detail))

    deadline = time.time() + STOP_TIMEOUT_S
    while time.time() < deadline:
        if _health(host, port) is None:
            for pid in killed:
                _OWNED.pop(pid, None)
            _write_own_state({})
            return _status_payload()
        time.sleep(POLL_INTERVAL_S)

    detail = "killed={} failed={}".format(killed, failures)
    return _status_payload(
        error="timed out after {:.0f}s stopping proxy ({})".format(STOP_TIMEOUT_S, detail)
    )


def do_toggle() -> Dict[str, Any]:
    host, port = _resolve_endpoint()
    if _health(host, port) is not None:
        return do_stop()
    return do_start()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/status")
def route_status() -> Dict[str, Any]:
    return do_status()


@router.post("/start")
def route_start() -> Dict[str, Any]:
    return do_start()


@router.post("/stop")
def route_stop() -> Dict[str, Any]:
    return do_stop()


@router.post("/toggle")
def route_toggle() -> Dict[str, Any]:
    return do_toggle()
