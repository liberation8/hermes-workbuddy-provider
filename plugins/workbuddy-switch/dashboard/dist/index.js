/**
 * Hermes WorkBuddy Switch — Dashboard Plugin
 *
 * Panel for the local workbuddy reverse proxy (default 127.0.0.1:8788).
 * Calls the plugin's backend at /api/plugins/workbuddy-switch/ (the host
 * mounts plugin_api.py under that prefix), polls GET /status every 10s and
 * flips the proxy with POST /toggle.
 *
 * Plain IIFE, no build step, no JSX, no bare imports — the dashboard host
 * injects this file with a plain <script> tag (web/src/plugins/usePlugins.ts:58).
 * React, the fetch helpers and the UI primitives all come from
 * window.__HERMES_PLUGIN_SDK__ (see web/src/plugins/sdk.d.ts).
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks || {};
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useCallback = hooks.useCallback;
  var useRef = hooks.useRef;

  // Design-system primitives where the host exposes them, plain DOM
  // elements otherwise, so the panel still renders on older host builds.
  var components = SDK.components || {};
  var Card = components.Card || "div";
  var CardContent = components.CardContent || "div";
  var Badge = components.Badge || "span";
  var Button = components.Button || "button";

  // Same convention as the built-in kanban bundle (plugins/kanban/dashboard/
  // dist/index.js:195 -> const API = "/api/plugins/kanban"). The host adds
  // the /api/plugins/<manifest name> prefix itself; the bundle only names it.
  var API = "/api/plugins/workbuddy-switch";
  var POLL_MS = 10000;

  // SDK.fetchJSON rejects with Error("<status>: <raw body>") and FastAPI
  // bodies look like {"detail":"<message>"} — same unwrapping the kanban
  // bundle does (plugins/kanban/dashboard/dist/index.js:75-87).
  function parseApiErrorMessage(err) {
    var raw = err && err.message ? String(err.message) : String(err || "");
    var m = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
    var body = m ? m[2] : raw;
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed.detail === "string") return parsed.detail;
      if (parsed && parsed.detail && typeof parsed.detail.message === "string") {
        return parsed.detail.message;
      }
    } catch (_e) {
      /* not JSON — fall through to the raw body */
    }
    return body || raw;
  }

  function formatUptime(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return null;
    var total = Math.floor(seconds);
    var d = Math.floor(total / 86400);
    var hh = Math.floor((total % 86400) / 3600);
    var mm = Math.floor((total % 3600) / 60);
    var ss = total % 60;
    var parts = [];
    if (d) parts.push(d + "d");
    if (d || hh) parts.push(hh + "h");
    if (d || hh || mm) parts.push(mm + "m");
    parts.push(ss + "s");
    return parts.join(" ");
  }

  var S = {
    root: { padding: "16px", display: "flex", flexDirection: "column", gap: "16px" },
    headRow: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      flexWrap: "wrap",
    },
    titleRow: { display: "flex", alignItems: "center", gap: "10px" },
    title: { fontSize: "16px", fontWeight: 600, margin: 0 },
    dot: { width: "10px", height: "10px", borderRadius: "50%", display: "inline-block" },
    grid: {
      display: "grid",
      gridTemplateColumns: "max-content 1fr",
      columnGap: "16px",
      rowGap: "6px",
      fontSize: "13px",
    },
    key: { opacity: 0.65 },
    val: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
    banner: {
      border: "1px solid rgba(220, 38, 38, 0.45)",
      background: "rgba(220, 38, 38, 0.10)",
      color: "rgb(220, 38, 38)",
      borderRadius: "8px",
      padding: "8px 12px",
      fontSize: "13px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    },
    hint: { fontSize: "12px", opacity: 0.6 },
  };

  var STATUS_STYLE = {
    running: { dot: { background: "rgb(22, 163, 74)" }, label: "Running" },
    stopped: { dot: { background: "rgb(148, 163, 184)" }, label: "Stopped" },
    error: { dot: { background: "rgb(220, 38, 38)" }, label: "Error" },
    loading: { dot: { background: "rgb(148, 163, 184)" }, label: "Loading…" },
  };

  function badge(variant, text) {
    var style = STATUS_STYLE[variant] || STATUS_STYLE.loading;
    var props = { key: "badge" };
    if (typeof Badge === "string") {
      props.style = {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        fontWeight: 600,
      };
    } else {
      props.variant = variant === "error" ? "destructive" : variant === "running" ? "default" : "secondary";
    }
    props.children = [
      h("span", { key: "dot", style: Object.assign({}, S.dot, style.dot) }),
      h("span", { key: "label" }, text),
    ];
    return h(Badge, props);
  }

  function row(key, value) {
    return [
      h("div", { key: key + "-k", style: S.key }, key),
      h("div", { key: key + "-v", style: S.val }, value),
    ];
  }

  function WorkbuddySwitchPage() {
    var statusPair = useState(null);
    var status = statusPair[0];
    var setStatus = statusPair[1];

    var errorPair = useState(null);
    var error = errorPair[0];
    var setError = errorPair[1];

    var loadingPair = useState(true);
    var loading = loadingPair[0];
    var setLoading = loadingPair[1];

    var busyPair = useState(false);
    var busy = busyPair[0];
    var setBusy = busyPair[1];

    var aliveRef = useRef(true);

    useEffect(function () {
      aliveRef.current = true;
      return function () {
        aliveRef.current = false;
      };
    }, []);

    var load = useCallback(function () {
      // Auth is the host's job: SDK.fetchJSON applies the loopback session-
      // token header or the gated cookie. Never read the session token
      // global by hand (sdk.d.ts:56-63).
      return SDK.fetchJSON(API + "/status")
        .then(function (data) {
          if (!aliveRef.current) return;
          setStatus(data);
          setError(null);
        })
        .catch(function (err) {
          if (!aliveRef.current) return;
          setError(parseApiErrorMessage(err));
        })
        .then(function () {
          if (aliveRef.current) setLoading(false);
        });
    }, []);

    useEffect(function () {
      load();
      var timer = window.setInterval(load, POLL_MS);
      return function () {
        window.clearInterval(timer);
      };
    }, [load]);

    var onToggle = useCallback(function () {
      setBusy(true);
      setError(null);
      SDK.fetchJSON(API + "/toggle", { method: "POST" })
        .then(function (data) {
          if (!aliveRef.current) return;
          setStatus(data);
          if (data && data.ok === false && data.error) setError(String(data.error));
        })
        .catch(function (err) {
          if (!aliveRef.current) return;
          setError(parseApiErrorMessage(err));
        })
        .then(function () {
          if (aliveRef.current) setBusy(false);
        });
    }, []);

    var running = !!(status && status.running);
    var serverError = status && status.error ? String(status.error) : null;
    var variant = error ? "error" : loading && !status ? "loading" : running ? "running" : "stopped";
    var badgeText = STATUS_STYLE[variant].label;
    var uptimeText = status ? formatUptime(status.uptimeS) : null;

    var detailRows = [];
    detailRows = detailRows.concat(row("Status", running ? "Running" : "Stopped"));
    detailRows = detailRows.concat(row("Port", status && status.port != null ? String(status.port) : "—"));
    detailRows = detailRows.concat(
      row("PID", status && status.pid != null ? String(status.pid) : "—"),
    );
    detailRows = detailRows.concat(row("Uptime", uptimeText || "—"));
    detailRows = detailRows.concat(row("Proxy script", status && status.proxyScript ? status.proxyScript : "—"));
    detailRows = detailRows.concat(row("Log", status && status.logPath ? status.logPath : "—"));

    var children = [
      h(
        "div",
        { key: "head", style: S.headRow },
        h(
          "div",
          { style: S.titleRow },
          h("h3", { style: S.title }, "WorkBuddy Switch"),
          badge(variant, badgeText),
        ),
        h(
          Button,
          {
            key: "toggle",
            type: "button",
            onClick: onToggle,
            disabled: busy || loading,
            "aria-busy": busy ? "true" : "false",
          },
          busy ? "Working…" : running ? "Stop" : "Start",
        ),
      ),
    ];

    if (error) {
      children.push(h("div", { key: "err", style: S.banner, role: "alert" }, "Request failed: " + error));
    } else if (serverError) {
      children.push(h("div", { key: "serr", style: S.banner, role: "alert" }, serverError));
    }

    children.push(h("div", { key: "grid", style: S.grid }, detailRows));
    children.push(
      h(
        "div",
        { key: "hint", style: S.hint },
        "Local reverse proxy on 127.0.0.1:" +
          (status && status.port != null ? status.port : 8788) +
          " — refreshed every " +
          POLL_MS / 1000 +
          "s.",
      ),
    );

    return h(Card, { key: "card" }, h(CardContent, { style: S.root }, children));
  }

  // Register (mirrors plugins/kanban/dashboard/dist/index.js:4466-4468).
  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("workbuddy-switch", WorkbuddySwitchPage);
  }
})();
