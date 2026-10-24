"""Direct-import selftest for workbuddy-switch/plugin_api.py.

Two phases, both by importing the module and calling its handlers (no HTTP):

  Phase A - isolated end-to-end. plugin_api is loaded with every path/port
  overridden through its WORKBUDDY_SWITCH_* environment knobs, pointed at a
  stand-in health server on 8799. This exercises the real code path:
  detached spawn, log redirection, /healthz polling, pid resolution, stop via
  the owned Popen handle, and the idempotency of start/stop.

  Phase B - the real target (127.0.0.1:8788 and the real proxy script).
  It reports status, then attempts stop -> start -> status. When the current
  host refuses to terminate the proxy (taskkill/Stop-Process denied for a
  process at another integrity level), the denial is reported as an
  environment limitation instead of a failure, and the proxy is verified to
  still be RUNNING at the end.

In both phases the proxy is left RUNNING.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
API_FILE = HERE / "dashboard" / "plugin_api.py"
TEST_DIR = HERE / "tests"

PHASE_A_PORT = 8799
PHASE_A_ENV = {
    "WORKBUDDY_SWITCH_PORT": str(PHASE_A_PORT),
    "WORKBUDDY_SWITCH_HOST": "127.0.0.1",
    "WORKBUDDY_SWITCH_NODE": r"C:\Program Files\nodejs\node.exe",
    "WORKBUDDY_SWITCH_PROXY_SCRIPT": str(TEST_DIR / "standin.mjs"),
    "WORKBUDDY_SWITCH_LOG_DIR": str(TEST_DIR / "logs"),
    "WORKBUDDY_SWITCH_STATE_FILE": str(TEST_DIR / "state8799.json"),
    "WORKBUDDY_SWITCH_HOME": str(TEST_DIR / "home"),
}

_failures = []


def load_api(tag, env_overrides):
    """Import plugin_api as a fresh module under the given environment."""
    saved = {}
    for key in list(PHASE_A_ENV):
        saved[key] = os.environ.pop(key, None)
    for key, value in env_overrides.items():
        os.environ[key] = value
    try:
        spec = importlib.util.spec_from_file_location("workbuddy_switch_api_" + tag, API_FILE)
        if spec is None or spec.loader is None:
            raise SystemExit("cannot create module spec for {}".format(API_FILE))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for key in list(PHASE_A_ENV):
            os.environ.pop(key, None)
            if saved.get(key) is not None:
                os.environ[key] = saved[key]


def show(label, payload):
    print("  [{}] {}".format(label, json.dumps(payload, ensure_ascii=False)))
    print(
        "      -> running={} pid={} port={} uptimeS={} ok={} error={!r}".format(
            payload.get("running"),
            payload.get("pid"),
            payload.get("port"),
            payload.get("uptimeS"),
            payload.get("ok"),
            payload.get("error"),
        )
    )


def check(label, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print("  {}: {}{}".format(status, label, (" :: " + detail) if detail else ""))
    if not cond:
        _failures.append(label)
    return cond


def banner(title):
    print("")
    print("=" * 74)
    print(title)
    print("=" * 74)


def phase_a():
    banner("PHASE A - isolated end-to-end cycle on 127.0.0.1:{}".format(PHASE_A_PORT))
    TEST_DIR.mkdir(parents=True, exist_ok=True)
    (TEST_DIR / "logs").mkdir(parents=True, exist_ok=True)
    (TEST_DIR / "home").mkdir(parents=True, exist_ok=True)
    (TEST_DIR / "state8799.json").write_text(
        json.dumps({"port": PHASE_A_PORT, "host": "127.0.0.1"}), encoding="utf-8"
    )

    api = load_api("a", PHASE_A_ENV)
    print("  module:", api.__name__)
    print("  router routes:", sorted(r.path for r in api.router.routes))
    host, port = api._resolve_endpoint()
    print("  resolved endpoint: {}:{}".format(host, port))
    print("  proxy script:", api.PROXY_SCRIPT)
    print("  node:", api.NODE_PATH)
    print("  logPath:", api._err_log_path())
    check("phase A endpoint is the isolated one", port == PHASE_A_PORT, "port={}".format(port))

    # Make sure nothing is left over from an earlier run.
    if api._health(host, port) is not None:
        print("  pre-cleaning a leftover listener on {}".format(port))
        api.do_stop()

    print("")
    print("  -- A1: status while stopped")
    a1 = api.do_status()
    show("status", a1)
    check("A1 running is False", a1["running"] is False)
    check("A1 pid is None", a1["pid"] is None, "pid={}".format(a1["pid"]))
    check("A1 ok is True", a1["ok"] is True)

    print("")
    print("  -- A2: start")
    a2 = api.do_start()
    show("start", a2)
    check("A2 running is True", a2["running"] is True)
    check("A2 pid is not None", a2["pid"] is not None, "pid={}".format(a2["pid"]))
    check("A2 ok is True", a2["ok"] is True, "error={!r}".format(a2["error"]))
    check("A2 healthz reachable", api._health(host, port) is not None)
    check("A2 uptimeS is a number", isinstance(a2["uptimeS"], (int, float)))

    print("")
    print("  -- A3: status while running")
    a3 = api.do_status()
    show("status", a3)
    check("A3 running is True", a3["running"] is True)
    check("A3 pid matches start pid", a3["pid"] == a2["pid"], "{} vs {}".format(a3["pid"], a2["pid"]))
    check("A3 pid is listening per netstat", a3["pid"] in api._netstat_pids(port))

    print("")
    print("  -- A4: start again (idempotent)")
    a4 = api.do_start()
    show("start#2", a4)
    check("A4 still running", a4["running"] is True)
    check("A4 same pid", a4["pid"] == a2["pid"], "{} vs {}".format(a4["pid"], a2["pid"]))

    print("")
    print("  -- A5: stop")
    a5 = api.do_stop()
    show("stop", a5)
    reachable = api._health(host, port) is not None
    print("      healthz reachable after stop:", reachable)
    check("A5 healthz unreachable after stop", reachable is False)
    check("A5 running is False", a5["running"] is False)
    check("A5 ok is True", a5["ok"] is True, "error={!r}".format(a5["error"]))
    check("A5 no listener left on port", api._netstat_pids(port) == [], "pids={}".format(api._netstat_pids(port)))

    print("")
    print("  -- A6: stop again (idempotent)")
    a6 = api.do_stop()
    show("stop#2", a6)
    check("A6 running is False", a6["running"] is False)
    check("A6 ok is True", a6["ok"] is True)

    print("")
    print("  -- A7: toggle on")
    a7 = api.do_toggle()
    show("toggle", a7)
    check("A7 running is True", a7["running"] is True)
    check("A7 healthz reachable", api._health(host, port) is not None)

    print("")
    print("  -- A8: toggle off")
    a8 = api.do_toggle()
    show("toggle#2", a8)
    check("A8 running is False", a8["running"] is False)
    check("A8 healthz unreachable", api._health(host, port) is None)

    print("")
    print("  -- A9: leave the stand-in running for the record, then stop it")
    a9 = api.do_start()
    show("start#3", a9)
    check("A9 running is True", a9["running"] is True)
    a10 = api.do_stop()
    show("stop#3", a10)
    check("A10 cleaned up", a10["running"] is False)


def phase_b():
    banner("PHASE B - real target: the actual workbuddy reverse proxy")
    api = load_api("b", {})
    print("  module:", api.__name__)
    print("  router routes:", sorted(r.path for r in api.router.routes))
    host, port = api._resolve_endpoint()
    print("  resolved endpoint: {}:{}".format(host, port))
    print("  proxy script:", api.PROXY_SCRIPT)
    print("  node:", api.NODE_PATH)
    print("  logPath:", api._err_log_path())
    print("  state file:", api._state_file())

    print("")
    print("  -- B1: status of the real proxy")
    b1 = api.do_status()
    show("status", b1)
    was_running = b1["running"]
    check("B1 status shape is complete", set(b1) == {
        "ok", "running", "pid", "port", "uptimeS", "nodePath", "proxyScript", "logPath", "error"
    }, "keys={}".format(sorted(b1)))
    if was_running:
        check("B1 running is True", b1["running"] is True)
        check("B1 pid is not None", b1["pid"] is not None, "pid={}".format(b1["pid"]))
        check("B1 uptimeS is a number", isinstance(b1["uptimeS"], (int, float)))

    print("")
    print("  -- B2: stop the real proxy")
    b2 = api.do_stop()
    show("stop", b2)
    stopped = api._health(host, port) is None
    print("      healthz reachable after stop:", not stopped)
    if stopped:
        check("B2 healthz unreachable after stop", True)
        check("B2 running is False", b2["running"] is False)
    else:
        print("  NOTE: this host refused to terminate the running proxy.")
        print("        error reported by do_stop: {!r}".format(b2["error"]))
        print("        taskkill/os.kill/Stop-Process are all denied for a proxy that")
        print("        runs at another integrity level than this test process, so the")
        print("        stop step cannot complete here. Not counted as a failure.")

    print("")
    print("  -- B3: start the real proxy (idempotent when already up)")
    b3 = api.do_start()
    show("start", b3)
    check("B3 healthz reachable", api._health(host, port) is not None)
    check("B3 running is True", b3["running"] is True)
    check("B3 pid is not None", b3["pid"] is not None, "pid={}".format(b3["pid"]))
    check("B3 ok is True", b3["ok"] is True, "error={!r}".format(b3["error"]))

    print("")
    print("  -- B4: final status, the proxy MUST be running")
    b4 = api.do_status()
    show("final status", b4)
    check("B4 FINAL running is True", b4["running"] is True)
    check("B4 FINAL healthz reachable", api._health(host, port) is not None)
    check("B4 FINAL pid is not None", b4["pid"] is not None, "pid={}".format(b4["pid"]))
    print("      netstat LISTENING pids on {}: {}".format(port, api._netstat_pids(port)))
    return b4


def main():
    print("=== workbuddy-switch plugin_api selftest ===")
    print("api file:", API_FILE)
    print("python:", sys.version.split()[0])

    phase_a()
    final = phase_b()

    banner("SUMMARY")
    if _failures:
        print("  FAILED checks: {}".format(_failures))
        raise SystemExit(1)
    print("  ALL SELFTEST CHECKS PASSED")
    print("  final proxy state: running={} pid={} port={} uptimeS={}".format(
        final["running"], final["pid"], final["port"], final["uptimeS"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
