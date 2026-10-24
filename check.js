#!/usr/bin/env node
// Muster status checker, run from GitHub Actions:
//   node check.js <data folder>                      one round of checks
//   node check.js <data folder> --for 55 --save save.sh
//                 a round every 5 minutes for 55 minutes, running save.sh
//                 after each (GitHub starts scheduled runs 30-45 minutes
//                 apart, not every 5, so each run keeps checking itself)
// Each round checks each component in components.js, then updates three files in the
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
// A service is marked down only when two checks in a row fail (Sam, 22 Oct).
// When a check fails, it's checked again a minute later, in the same round:
// fail then fail is down, dated from the first failure; fail then pass is a
// blip, shown as working and counted as "slow" for the day. A service that's
// already down isn't rechecked: one failure keeps it down.
const RECHECK_AFTER_MS = 60e3;
const ROUND_EVERY_MS = 5 * 60e3;

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

// One component's state after this round. prev is its entry in the last
// status.json; raw is this round's classify(); r is the check's result, which
// says when it first failed (failed_at) and whether the recheck passed (blip).
function confirm(prev, raw, now, r = {}) {
  const iso = new Date(now).toISOString();
  if (raw !== 'down') {
    const out = { status: raw, fails: 0, first_failed_at: null, last_failed_at: null };
    if (r.blip) Object.assign(out, { blip: true, first_failed_at: r.failed_at || iso, last_failed_at: r.failed_at || iso });
    return out;
  }
  // Files written before this rule have no count: a component shown down counts.
  const before = prev ? (Number.isFinite(prev.fails) ? prev.fails : prev.status === 'down' ? 1 : 0) : 0;
  const wasDown = !!prev && prev.status === 'down';
  const first = wasDown && (prev.first_failed_at || prev.since) ? (prev.first_failed_at || prev.since) : (r.failed_at || iso);
  return { status: 'down', fails: wasDown ? before + 1 : 1, first_failed_at: first, last_failed_at: iso };
}

// What a round counts as for the day's bar: a blip counts as slow.
function dayStateOf(c) { return c.blip ? 'slow' : c.status; }

// Add this round's states to the per-day counts and drop days older than 90.
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

// Open an outage when a component is confirmed down (dated from its first
// failed check), close it when it comes back. It ends at the last failed
// check, not at the round that found it working again.
// states: id -> a component from buildStatus (or just its status string).
function updateOutages(outages, states, now) {
  const list = (outages || []).map((o) => Object.assign({}, o));
  const iso = new Date(now).toISOString();
  for (const [id, st] of Object.entries(states)) {
    const c = typeof st === 'string' ? { status: st, fails: st === 'down' ? 1 : 0, first_failed_at: iso, last_failed_at: iso } : st;
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

// The status.json for this round. `since` is when the component last changed state.
function buildStatus(components, results, previous, now) {
  const prev = new Map(((previous && previous.components) || []).map((c) => [c.id, c]));
  const iso = new Date(now).toISOString();
  const list = components.map((c) => {
    const r = results[c.id] || { ok: false, detail: 'not checked' };
    const before = prev.get(c.id);
    const k = confirm(before, classify(r, c.check.slowMs), now, r);
    const status = k.status;
    const out = {
      id: c.id,
      name: c.name,
      description: c.description,
      status,
      latency_ms: r.ok ? Math.round(r.ms) : null,
      detail: status === 'down' ? String(r.detail || 'no answer').slice(0, 120) : null,
      since: status === 'down' && k.fails === 1 ? k.first_failed_at
        : before && before.status === status && before.since ? before.since : iso,
      fails: k.fails,
      first_failed_at: k.first_failed_at,
      last_failed_at: k.last_failed_at,
    };
    if (k.blip) out.blip = true;
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

// A check can name a second opinion (`ask`): when this machine can't get an
// answer, Muster is asked whether it can. "up" from Muster means the service
// is fine and only this runner can't reach it (22 Oct: three false call
// outages, each one runner for its whole life), so it isn't an outage. Any
// other answer, or none, leaves the failure standing.
async function secondOpinion(c, first) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(c.ask.url, { signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': 'muster-status (+https://status.musterchat.com)', 'cache-control': 'no-cache' } });
    if (res.status !== 200) return first;
    const body = await res.json();
    if (body && body[c.ask.key] === 'up') return { ok: true, ms: null, detail: 'not reachable from the checker, answering for Muster', second_opinion: true };
  } catch (e) { /* no second opinion: the failure stands */ } finally { clearTimeout(timer); }
  return first;
}

async function runCheck(c) {
  if (c.kind === 'ws') return checkWs(c);
  const r = await checkHttp(c);
  return r.ok || !c.ask ? r : secondOpinion(c, r);
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

// One component for one round: its check (with the quick retry) and, if that
// fails and it wasn't already down, the recheck a minute later.
async function checkTwice(c, wasDown, { check = checkWithRetry, wait = RECHECK_AFTER_MS, clock = Date.now } = {}) {
  const failedAt = new Date(clock()).toISOString();
  const first = await check(c);
  if (first.ok || wasDown) return first.ok ? first : Object.assign({}, first, { failed_at: failedAt });
  await new Promise((r) => setTimeout(r, wait));
  const again = await check(c);
  return again.ok ? Object.assign({}, again, { blip: true, failed_at: failedAt }) : Object.assign({}, again, { failed_at: failedAt });
}

// One round: check everything, update the three files. `now` is when the
// round's results are recorded (after any recheck).
async function main(dir, components = require('./components'), now = null, check = checkWithRetry, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const clock = opts.clock || Date.now;
  const previous = readJson(path.join(dir, 'status.json'), null);
  const wasDown = new Set(((previous && previous.components) || []).filter((c) => c.status === 'down').map((c) => c.id));
  const results = {};
  await Promise.all(components.map(async (c) => {
    results[c.id] = await checkTwice(c.check, wasDown.has(c.id), { check, wait: opts.recheckMs != null ? opts.recheckMs : RECHECK_AFTER_MS, clock });
  }));
  const at = now == null ? clock() : now;
  const status = buildStatus(components, results, previous, at);
  const dayStates = Object.fromEntries(status.components.map((c) => [c.id, dayStateOf(c)]));
  writeJson(path.join(dir, 'status.json'), status);
  writeJson(path.join(dir, 'daily.json'), updateDaily(readJson(path.join(dir, 'daily.json'), {}), dayStates, at));
  writeJson(path.join(dir, 'outages.json'), updateOutages(readJson(path.join(dir, 'outages.json'), []), Object.fromEntries(status.components.map((c) => [c.id, c])), at));
  return status;
}

// Rounds every `every` ms, starting now, until `forMs` has passed; `save`
// after each (pushes the data branch). A round that fails to save is logged
// and the next one tries again.
async function loop(dir, { forMs, every = ROUND_EVERY_MS, save = () => {}, round = (d) => main(d), clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = clock();
  const rounds = [];
  for (let i = 0; ; i++) {
    const due = start + i * every;
    if (i > 0 && due >= start + forMs) break;
    if (due > clock()) await sleep(due - clock());
    const s = await round(dir);
    rounds.push(s);
    try { await save(dir, s); } catch (e) { console.error('save failed:', e.message); }
  }
  return rounds;
}

function report(s) {
  for (const c of s.components) console.log(`${c.status.padEnd(4)} ${c.id.padEnd(9)} ${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}${c.detail ? '  ' + c.detail : ''}${c.blip ? '  (failed once, fine on recheck)' : ''}`);
  console.log(`${s.updated_at} overall: ${s.overall}`);
}

module.exports = { classify, overall, confirm, dayStateOf, updateDaily, updateOutages, buildStatus, checkHttp, checkWs, checkWithRetry, checkTwice, main, loop, dayKey, DAYS, RECHECK_AFTER_MS, ROUND_EVERY_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || 'data';
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const minutes = Number(opt('--for'));
  const script = opt('--save');
  const run = minutes > 0
    ? loop(dir, {
      forMs: minutes * 60e3,
      round: async (d) => { const s = await main(d); report(s); return s; },
      save: script ? () => { const r = require('child_process').spawnSync('sh', [script, dir], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${script} exited ${r.status}`); } : undefined,
    })
    : main(dir).then(report);
  run.catch((e) => { console.error(e); process.exit(1); });
}
