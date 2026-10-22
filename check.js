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
// A service is marked down only after this many checks in a row fail (Sam,
// 22 Oct). One failed check (after its retry) is a blip: shown as it was,
// counted as "slow" for the day, and if the next check fails too the outage
// is dated from the first failure.
const CONFIRM = 2;

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

// One component's state after this run, with the two-in-a-row rule.
// prev is its entry in the last status.json; raw is this run's classify().
function confirm(prev, raw, now) {
  const iso = new Date(now).toISOString();
  if (raw !== 'down') return { status: raw, fails: 0, first_failed_at: null, last_failed_at: null };
  // Files written before this rule have no count: a component already shown
  // down counts as confirmed.
  const before = prev ? (Number.isFinite(prev.fails) ? prev.fails : prev.status === 'down' ? CONFIRM : 0) : 0;
  const fails = before + 1;
  const first = before > 0 && prev.first_failed_at ? prev.first_failed_at : (before > 0 && prev.since ? prev.since : iso);
  if (fails >= CONFIRM) return { status: 'down', fails, first_failed_at: fails === 1 ? iso : first, last_failed_at: iso };
  const shown = prev && prev.status && prev.status !== 'down' ? prev.status : 'up';
  return { status: shown, fails, first_failed_at: iso, last_failed_at: iso, unconfirmed: true };
}

// What a run counts as for the day's bar: a lone failed check counts as slow.
function dayStateOf(c) { return c.unconfirmed ? 'slow' : c.status; }

// Add this run's states to the per-day counts and drop days older than 90.
// `fixes` are earlier lone failures that turned out to be the start of an
// outage: [{ id, day }], moved from slow to down on that day.
function updateDaily(daily, states, now, fixes = []) {
  const out = {};
  const today = dayKey(now);
  const oldest = dayKey(now - (DAYS - 1) * 86400e3);
  for (const [id, status] of Object.entries(states)) {
    const days = Object.assign({}, (daily && daily[id]) || {});
    for (const f of fixes) {
      if (f.id !== id || !days[f.day] || !(days[f.day].slow > 0)) continue;
      days[f.day] = Object.assign({}, days[f.day], { slow: days[f.day].slow - 1, down: days[f.day].down + 1 });
    }
    const d = Object.assign({ n: 0, up: 0, slow: 0, down: 0 }, days[today]);
    d.n += 1;
    d[status] += 1;
    days[today] = d;
    out[id] = {};
    for (const k of Object.keys(days).sort()) if (k >= oldest) out[id][k] = days[k];
  }
  return out;
}

// Open an outage when a component is confirmed down (dated from its first
// failed check), close it when it comes back. It ends at the last failed
// check, not at the run that found it working again, so a late GitHub run
// doesn't make it look longer than it was.
// states: id -> a component from buildStatus (or just its status string).
function updateOutages(outages, states, now) {
  const list = (outages || []).map((o) => Object.assign({}, o));
  const iso = new Date(now).toISOString();
  for (const [id, st] of Object.entries(states)) {
    const c = typeof st === 'string' ? { status: st, fails: st === 'down' ? CONFIRM : 0, first_failed_at: iso, last_failed_at: iso } : st;
    const open = list.find((o) => o.component === id && !o.ended_at);
    if (c.status === 'down') {
      if (open) { open.checks += 1; open.last_failed_at = c.last_failed_at || iso; } else list.push({ component: id, started_at: c.first_failed_at || iso, ended_at: null, last_failed_at: c.last_failed_at || iso, checks: c.fails || 1 });
    } else if (open) {
      open.ended_at = open.last_failed_at || iso; // older files: when it was seen back
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
    const before = prev.get(c.id);
    const k = confirm(before, classify(r, c.check.slowMs), now);
    const status = k.status;
    const out = {
      id: c.id,
      name: c.name,
      description: c.description,
      status,
      latency_ms: r.ok ? Math.round(r.ms) : null,
      detail: status === 'down' ? String(r.detail || 'no answer').slice(0, 120) : null,
      since: status === 'down' && k.fails === CONFIRM ? k.first_failed_at
        : before && before.status === status && before.since ? before.since : iso,
      fails: k.fails,
      first_failed_at: k.first_failed_at,
      last_failed_at: k.last_failed_at,
    };
    if (k.unconfirmed) out.unconfirmed = true;
    return out;
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
  const dayStates = Object.fromEntries(status.components.map((c) => [c.id, dayStateOf(c)]));
  // A lone failure last run that this run confirmed: it was the outage's start.
  const fixes = status.components.filter((c) => c.status === 'down' && c.fails === CONFIRM && c.first_failed_at !== status.updated_at)
    .map((c) => ({ id: c.id, day: dayKey(Date.parse(c.first_failed_at)) }));
  writeJson(path.join(dir, 'status.json'), status);
  writeJson(path.join(dir, 'daily.json'), updateDaily(readJson(path.join(dir, 'daily.json'), {}), dayStates, now, fixes));
  writeJson(path.join(dir, 'outages.json'), updateOutages(readJson(path.join(dir, 'outages.json'), []), Object.fromEntries(status.components.map((c) => [c.id, c])), now));
  return status;
}

module.exports = { classify, overall, confirm, dayStateOf, CONFIRM, updateDaily, updateOutages, buildStatus, checkHttp, checkWs, checkWithRetry, main, dayKey, DAYS };

if (require.main === module) {
  main(process.argv[2] || 'data').then((s) => {
    for (const c of s.components) console.log(`${c.status.padEnd(4)} ${c.id.padEnd(9)} ${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}${c.detail ? '  ' + c.detail : ''}`);
    console.log(`overall: ${s.overall}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
