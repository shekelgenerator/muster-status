#!/usr/bin/env node
// Muster status checker. Runs every few minutes from GitHub Actions:
//   node check.js <data folder>
// It checks each component in components.js, then updates three files in the
// data folder (the `data` branch, which the page reads):
//   status.json   — the state right now
//   daily.json    — per component, per UTC day: how many checks were up, slow, down (90 days)
//   outages.json  — each time a component was down, from when to when (90 days)
// Zero dependencies (Node 22+: global fetch and WebSocket).

'use strict';
const fs = require('fs');
const path = require('path');

const DAYS = 90;
const TIMEOUT_MS = 10000;
const RETRY_AFTER_MS = 5000;

// ── pure logic (tested in test/check.test.js) ─────────────────────────────

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

// One check's raw result → 'up' | 'slow' | 'down'.
function classify(result, slowMs) {
  if (!result || !result.ok) return 'down';
  return result.ms > slowMs ? 'slow' : 'up';
}

// The headline: worst state wins.
function overall(components) {
  if (components.some((c) => c.status === 'down')) return 'down';
  if (components.some((c) => c.status === 'slow')) return 'slow';
  return 'up';
}

// Add this run's states to the per-day counts and drop days older than 90.
function updateDaily(daily, states, now) {
  const out = {};
  const today = dayKey(now);
  const oldest = dayKey(now - (DAYS - 1) * 86400e3);
  for (const [id, status] of Object.entries(states)) {
    const days = Object.assign({}, (daily && daily[id]) || {});
    const d = Object.assign({ n: 0, up: 0, slow: 0, down: 0 }, days[today]);
    d.n += 1;
    d[status] += 1;
    days[today] = d;
    out[id] = {};
    for (const k of Object.keys(days).sort()) if (k >= oldest) out[id][k] = days[k];
  }
  return out;
}

// Open an outage when a component goes down, close it when it comes back.
function updateOutages(outages, states, now) {
  const list = (outages || []).map((o) => Object.assign({}, o));
  const iso = new Date(now).toISOString();
  for (const [id, status] of Object.entries(states)) {
    const open = list.find((o) => o.component === id && !o.ended_at);
    if (status === 'down') {
      if (open) open.checks += 1;
      else list.push({ component: id, started_at: iso, ended_at: null, checks: 1 });
    } else if (open) {
      open.ended_at = iso;
    }
  }
  const cutoff = now - DAYS * 86400e3;
  return list.filter((o) => !o.ended_at || Date.parse(o.ended_at) >= cutoff);
}

// The status.json for this run. `since` is when the component last changed state.
function buildStatus(components, results, previous, now) {
  const prev = new Map(((previous && previous.components) || []).map((c) => [c.id, c]));
  const iso = new Date(now).toISOString();
  const list = components.map((c) => {
    const r = results[c.id] || { ok: false, detail: 'not checked' };
    const status = classify(r, c.check.slowMs);
    const before = prev.get(c.id);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      status,
      latency_ms: r.ok ? Math.round(r.ms) : null,
      detail: status === 'down' ? String(r.detail || 'no answer').slice(0, 120) : null,
      since: before && before.status === status && before.since ? before.since : iso,
    };
  });
  return { updated_at: iso, overall: overall(list), components: list };
}

// ── checks ────────────────────────────────────────────────────────────────

async function checkHttp(c) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(c.url, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'muster-status (+https://status.musterchat.com)', 'cache-control': 'no-cache' } });
    const ms = performance.now() - t0;
    if (!c.expect.includes(res.status)) return { ok: false, ms, detail: `HTTP ${res.status}` };
    if (c.json) {
      let body = null;
      try { body = await res.json(); } catch (e) { /* not JSON */ }
      if (!c.json(body)) return { ok: false, ms, detail: 'unexpected answer' };
    }
    return { ok: true, ms };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, detail: e.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000} s` : 'could not connect' };
  } finally {
    clearTimeout(timer);
  }
}

function checkWs(c) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    let ws;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) { /* closing */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: performance.now() - t0, detail: `no answer in ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS);
    try { ws = new WebSocket(c.url); } catch (e) { return finish({ ok: false, ms: 0, detail: 'could not connect' }); }
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(String(ev.data)); } catch (e) { /* not JSON */ }
      const ms = performance.now() - t0;
      finish(c.message(m) ? { ok: true, ms } : { ok: false, ms, detail: 'unexpected answer' });
    };
    ws.onerror = () => finish({ ok: false, ms: performance.now() - t0, detail: 'could not connect' });
    ws.onclose = () => finish({ ok: false, ms: performance.now() - t0, detail: 'closed before answering' });
  });
}

async function runCheck(c) {
  return c.kind === 'ws' ? checkWs(c) : checkHttp(c);
}

// A failure is tried once more before it counts, so one dropped packet
// doesn't show as an outage.
async function checkWithRetry(c, wait = RETRY_AFTER_MS) {
  const first = await runCheck(c);
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, wait));
  return runCheck(c);
}

// ── files ─────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n');
}

async function main(dir, components = require('./components'), now = Date.now(), check = checkWithRetry) {
  fs.mkdirSync(dir, { recursive: true });
  const results = {};
  await Promise.all(components.map(async (c) => { results[c.id] = await check(c.check); }));
  const status = buildStatus(components, results, readJson(path.join(dir, 'status.json'), null), now);
  const states = Object.fromEntries(status.components.map((c) => [c.id, c.status]));
  writeJson(path.join(dir, 'status.json'), status);
  writeJson(path.join(dir, 'daily.json'), updateDaily(readJson(path.join(dir, 'daily.json'), {}), states, now));
  writeJson(path.join(dir, 'outages.json'), updateOutages(readJson(path.join(dir, 'outages.json'), []), states, now));
  return status;
}

module.exports = { classify, overall, updateDaily, updateOutages, buildStatus, checkHttp, checkWs, checkWithRetry, main, dayKey, DAYS };

if (require.main === module) {
  main(process.argv[2] || 'data').then((s) => {
    for (const c of s.components) console.log(`${c.status.padEnd(4)} ${c.id.padEnd(9)} ${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}${c.detail ? '  ' + c.detail : ''}`);
    console.log(`overall: ${s.overall}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
