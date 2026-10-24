'use strict';
// The page: its helpers, and a real browser on made-up data (all working,
// an outage, an old check, text that looks like HTML). Needs Playwright:
//   NODE_PATH=<folder with playwright> node --test test/*.test.js
// Without Playwright the browser part is skipped and says so.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../docs/status.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');
const DAY = 86400000;

describe('page helpers', () => {
  test('day colours', () => {
    assert.equal(S.dayState(undefined), 'none');
    assert.equal(S.dayState({ n: 0 }), 'none');
    assert.equal(S.dayState({ n: 288, up: 288, slow: 0, down: 0 }), 'up');
    assert.equal(S.dayState({ n: 288, up: 287, slow: 0, down: 1 }), 'slow', 'one failed check is amber');
    assert.equal(S.dayState({ n: 288, up: 250, slow: 38, down: 0 }), 'slow', 'lots of slow is amber');
    assert.equal(S.dayState({ n: 288, up: 282, slow: 0, down: 6 }), 'down', 'about half an hour is red');
  });
  test('uptime counts slow as working and rounds down', () => {
    assert.equal(S.uptime({}), null);
    assert.equal(S.uptime({ a: { n: 100, up: 90, slow: 10, down: 0 } }), '100%');
    assert.equal(S.uptime({ a: { n: 10000, up: 9999, slow: 0, down: 1 } }), '99.99%');
    assert.equal(S.uptime({ a: { n: 3, up: 2, slow: 0, down: 1 } }), '66.66%');
  });
  test('headline names what is wrong', () => {
    const c = (status, name) => ({ status, name });
    assert.equal(S.headline({ components: [c('up', 'A'), c('up', 'B')] }), 'Everything is working');
    assert.equal(S.headline({ components: [c('up', 'A'), c('slow', 'Messages')] }), 'Messages: slow');
    assert.equal(S.headline({ components: [c('slow', 'A'), c('slow', 'B')] }), 'Some services are slow');
    assert.equal(S.headline({ components: [c('down', 'Voice and video calls'), c('slow', 'B')] }), 'Voice and video calls: down');
    assert.equal(S.headline({ components: [c('down', 'A'), c('down', 'B')] }), '2 services are down');
  });
  test('minutes down on a day, clipped to that day, open outages up to now', () => {
    const o = [
      { component: 'calls', started_at: '2026-10-20T23:50:00Z', ended_at: '2026-10-21T00:20:00Z' },
      { component: 'calls', started_at: '2026-10-21T11:30:00Z', ended_at: null },
      { component: 'website', started_at: '2026-10-21T01:00:00Z', ended_at: '2026-10-21T02:00:00Z' },
    ];
    assert.equal(S.downMinutes(o, 'calls', '2026-10-20', NOW), 10);
    assert.equal(S.downMinutes(o, 'calls', '2026-10-21', NOW), 20 + 30);
    assert.equal(S.downMinutes(o, 'messages', '2026-10-21', NOW), 0);
  });
  // Sam, 22 Oct: hovering a day shows each outage's start and end, UK time.
  test('outage times for a day, in UK time: "22:14–22:52", "now" while open, the date when it is another day', () => {
    const o = [
      { component: 'calls', started_at: '2026-10-21T21:14:00Z', ended_at: '2026-10-21T21:52:00Z' }, // BST: 22:14–22:52
      { component: 'calls', started_at: '2026-10-21T22:50:00Z', ended_at: '2026-10-21T23:40:00Z' }, // 23:50 to 00:40 the next day
      { component: 'calls', started_at: '2026-10-22T08:00:00Z', ended_at: null },
      { component: 'website', started_at: '2026-10-21T10:00:00Z', ended_at: '2026-10-21T10:10:00Z' },
    ];
    const now = Date.parse('2026-10-22T09:00:00Z');
    assert.deepEqual(S.outageSpans(o, 'calls', '2026-10-21', now).map((x) => S.spanText(x, '2026-10-21')), ['22:14\u201322:52', '23:50\u201322 Oct 00:40']);
    assert.deepEqual(S.outageSpans(o, 'calls', '2026-10-22', now).map((x) => S.spanText(x, '2026-10-22')), ['09:00\u2013now']);
    assert.deepEqual(S.outageSpans(o, 'calls', '2026-10-20', now), []);
    // Winter time: UK time is UTC.
    const winter = [{ component: 'calls', started_at: '2026-12-01T22:14:00Z', ended_at: '2026-12-01T22:52:00Z' }];
    assert.deepEqual(S.outageSpans(winter, 'calls', '2026-12-01', now).map((x) => S.spanText(x, '2026-12-01')), ['22:14\u201322:52']);
  });
  test('times and durations in plain words', () => {
    assert.equal(S.ago(NOW - 20e3, NOW), 'just now');
    assert.equal(S.ago(NOW - 60e3, NOW), '1 minute ago');
    assert.equal(S.ago(NOW - 47 * 60e3, NOW), '47 minutes ago');
    assert.equal(S.ago(NOW - 3 * 3600e3, NOW), '3 hours ago');
    assert.equal(S.duration(0), 'under a minute');
    assert.equal(S.duration(25), '25 min');
    assert.equal(S.duration(60), '1 h');
    assert.equal(S.duration(135), '2 h 15 min');
  });
  test('open incidents and outages are "now"; the last 14 days are history, newest first', () => {
    const inc = [
      { title: 'Calls not connecting', components: ['calls'], updates: [{ at: '2026-10-21T11:40:00Z', stage: 'identified', text: 'b' }, { at: '2026-10-21T11:35:00Z', stage: 'investigating', text: 'a' }] },
      { title: 'Old', updates: [{ at: '2026-09-01T10:00:00Z', stage: 'resolved', text: 'x' }] },
      { title: 'Slow sign-in', updates: [{ at: '2026-10-19T10:00:00Z', stage: 'resolved', text: 'done' }, { at: '2026-10-19T09:00:00Z', stage: 'investigating', text: 'looking' }] },
    ];
    const out = [
      { component: 'messages', started_at: '2026-10-20T08:00:00Z', ended_at: '2026-10-20T08:12:00Z' },
      { component: 'calls', started_at: '2026-10-21T11:30:00Z', ended_at: null },
    ];
    const e = S.events(inc, out, { calls: 'Voice and video calls', messages: 'Messages' }, NOW);
    assert.deepEqual(e.active.map((x) => x.title), ['Calls not connecting'], 'the outage is covered by the incident about calls');
    assert.deepEqual(e.past.map((x) => x.title), ['Messages: outage', 'Slow sign-in']);
    const alone = S.events([], out, { calls: 'Voice and video calls', messages: 'Messages' }, NOW);
    assert.deepEqual(alone.active.map((x) => x.title), ['Voice and video calls: down'], 'with no incident posted, the outage shows on its own');
    assert.equal(e.active[0].updates[0].stage, 'identified', 'newest update first');
  });
});

describe('corrections', () => {
  const real = require('../docs/corrections.json');
  const daily = { calls: { '2026-10-22': { n: 210, up: 192, slow: 0, down: 18 }, '2026-10-23': { n: 316, up: 312, slow: 0, down: 4 } }, website: { '2026-10-22': { n: 5, up: 5, slow: 0, down: 0 } } };
  const out = [
    { component: 'calls', started_at: '2026-10-22T11:41:18.831Z', ended_at: '2026-10-22T12:31:43.884Z' },
    { component: 'calls', started_at: '2026-10-22T23:24:45.964Z', ended_at: '2026-10-23T00:15:11.018Z' },
    { component: 'calls', started_at: '2026-10-24T09:00:00.000Z', ended_at: '2026-10-24T09:20:00.000Z' }, // a real one
    { component: 'website', started_at: '2026-10-22T11:41:18.831Z', ended_at: '2026-10-22T12:00:00.000Z' }, // same start, other service
  ];
  test('the three false call outages are removed, a real one and other services stay', () => {
    const f = S.correct(daily, out, real);
    assert.deepEqual(f.outages.map((o) => o.component + o.started_at.slice(0, 13)), ['calls2026-10-24T09', 'website2026-10-22T11']);
    assert.deepEqual(f.daily.calls['2026-10-22'], { n: 210, up: 210, slow: 0, down: 0 });
    assert.deepEqual(f.daily.calls['2026-10-23'], { n: 316, up: 316, slow: 0, down: 0 });
    assert.equal(S.dayState(f.daily.calls['2026-10-22']), 'up');
    assert.deepEqual(daily.calls['2026-10-22'], { n: 210, up: 192, slow: 0, down: 18 }, 'the data itself is not changed');
  });
  test('never moves more than were down, ignores unknown days, and an empty list changes nothing', () => {
    const f = S.correct({ calls: { '2026-10-22': { n: 3, up: 2, slow: 0, down: 1 } } }, [], [{ component: 'calls', started_at: 'x', down_to_up: { '2026-10-22': 50, '2020-01-01': 3 } }]);
    assert.deepEqual(f.daily.calls['2026-10-22'], { n: 3, up: 3, slow: 0, down: 0 });
    assert.deepEqual(S.correct(daily, out, []), { daily, outages: out });
    assert.deepEqual(S.correct(null, null, null), { daily: {}, outages: [] });
  });
  test('the posted incidents cover the three windows', () => {
    const inc = require('../docs/incidents.json');
    assert.equal(inc.length, 3);
    for (const i of inc) { assert.deepEqual(i.components, ['calls']); assert.equal(i.updates[0].stage, 'resolved'); }
  });
});

// ── browser ──────────────────────────────────────────────────────────────

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* skipped below */ }

const COMPONENTS = require('../components');

// Made-up data, relative to the real clock so the page's "today" lines up.
function fixtures(now) {
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const daily = {};
  for (const c of COMPONENTS) {
    daily[c.id] = {};
    for (let i = 59; i >= 0; i--) daily[c.id][key(now - i * DAY)] = { n: 288, up: 288, slow: 0, down: 0 };
  }
  daily.calls[key(now - 3 * DAY)] = { n: 288, up: 270, slow: 0, down: 18 };
  daily.messages[key(now - 1 * DAY)] = { n: 288, up: 280, slow: 6, down: 2 };
  const outages = [
    { component: 'calls', started_at: new Date(now - 3 * DAY).toISOString(), ended_at: new Date(now - 3 * DAY + 90 * 60e3).toISOString(), checks: 18 },
    { component: 'calls', started_at: new Date(now - 25 * 60e3).toISOString(), ended_at: null, checks: 5 },
  ];
  const status = (overrides) => ({
    updated_at: new Date(now - 2 * 60e3).toISOString(),
    overall: 'up',
    components: COMPONENTS.map((c) => Object.assign({ id: c.id, name: c.name, description: c.description, status: 'up', latency_ms: 300, detail: null, since: new Date(now - DAY).toISOString() }, overrides[c.id] || {})),
  });
  const down = status({ calls: { status: 'down', latency_ms: null, detail: 'HTTP 502', since: new Date(now - 25 * 60e3).toISOString() } });
  down.overall = 'down';
  const old = status({});
  old.updated_at = new Date(now - 50 * 60e3).toISOString();
  const evil = status({ website: { name: '<img src=x onerror="window.pwned=1">Website' } });
  return {
    up: { 'status.json': status({}), 'daily.json': daily, 'outages.json': [outages[0]] },
    down: { 'status.json': down, 'daily.json': daily, 'outages.json': outages },
    old: { 'status.json': old, 'daily.json': daily, 'outages.json': [] },
    evil: { 'status.json': evil, 'daily.json': {}, 'outages.json': [] },
    empty: {},
  };
}

describe('the page in a browser', { skip: chromium ? false : 'Playwright is not installed' }, () => {
  let server, base, browser;
  const shots = process.env.STATUS_SHOTS; // folder for screenshots, if wanted
  before(async () => {
    const fx = fixtures(Date.now());
    const docs = path.join(__dirname, '..', 'docs');
    const incidents = [{ title: 'Calls not connecting for some people', components: ['calls'], updates: [
      { at: new Date(Date.now() - 10 * 60e3).toISOString(), stage: 'identified', text: 'The call server ran out of memory. We are restarting it.' },
      { at: new Date(Date.now() - 22 * 60e3).toISOString(), stage: 'investigating', text: 'Some calls are not connecting. We are looking into it.' },
    ] }];
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const m = /^\/fixtures\/([a-z]+)\/([a-z]+\.json)$/.exec(u.pathname);
      if (m) {
        const body = fx[m[1]] && fx[m[1]][m[2]];
        if (!body) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(body));
      }
      if (u.pathname === '/corrections.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); } // the real list is for the real data
      if (u.pathname === '/incidents.json' && req.headers['x-test-incidents'] !== 'none') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(u.searchParams.get('t') && server.incidents ? incidents : []));
      }
      const file = path.join(docs, u.pathname === '/' ? 'index.html' : u.pathname);
      if (!file.startsWith(docs) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff': 'font/woff' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); if (server) { server.closeAllConnections(); server.close(); } });

  async function open(name, opts = {}) {
    server.incidents = !!opts.incidents;
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // Point config at nothing, so only the fixtures are read.
    await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.MUSTER_STATUS = { data: "fixtures/none/" };' }));
    await page.goto(`${base}/?data=fixtures/${name}/`);
    await page.waitForFunction(() => document.documentElement.dataset.loaded === '1');
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}${opts.tag || ''}.png`), fullPage: true }); }
    return { page, ctx, errors };
  }

  test('all working: green headline, every service, 90 bars each, uptime, no errors', async () => {
    const { page, ctx, errors } = await open('up');
    assert.equal(await page.textContent('#headline'), 'Everything is working');
    assert.equal(await page.getAttribute('#hero', 'data-state'), 'up');
    assert.match(await page.textContent('#checked'), /Last checked 2 minutes ago/);
    assert.equal(await page.isVisible('#stale'), false);
    assert.equal(await page.locator('.comp').count(), COMPONENTS.length);
    assert.equal(await page.locator('.comp').first().locator('.bar').count(), 90);
    assert.equal(await page.locator('.comp[data-id="website"] .bar.none').count(), 30, 'days before the checks began are grey');
    assert.equal(await page.locator('.comp[data-id="calls"] .bar.down').count(), 1, 'the bad day is red');
    assert.equal(await page.locator('.comp[data-id="messages"] .bar.slow').count(), 1, 'a few failures make a day amber');
    assert.match(await page.textContent('.comp[data-id="calls"] .uptime'), /^99\.89% working$/);
    assert.equal(await page.locator('.pill.up').count(), COMPONENTS.length);
    assert.match(await page.textContent('#history'), /Voice and video calls: outage/);
    assert.equal(await page.isVisible('#active'), false);
    // the tooltip on a bad day
    await page.locator('.comp[data-id="calls"] .bar.down').hover();
    assert.match(await page.textContent('.tip'), /Down for 1 h 30 min/);
    // ...and when the outage started and ended, UK time (Sam, 22 Oct)
    const o = fixtures(Date.now()).up['outages.json'][0];
    const fmt = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    const spans = await page.locator('.tip .tip-span').allTextContents();
    assert.equal(spans.length, 1);
    assert.ok(spans[0].startsWith(fmt(o.started_at)) || spans[0].includes(' ' + fmt(o.started_at)), spans[0]);
    assert.ok(spans[0].endsWith(fmt(o.ended_at)), spans[0]);
    assert.match(spans[0], /^(\d+ \w+ )?\d\d:\d\d\u2013(\d+ \w+ )?\d\d:\d\d$/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('an outage with an incident: red headline, the service marked down with its reason, "Happening now"', async () => {
    const { page, ctx, errors } = await open('down', { incidents: true });
    assert.equal(await page.textContent('#headline'), 'Voice and video calls: down');
    assert.equal(await page.getAttribute('#hero', 'data-state'), 'down');
    assert.equal(await page.textContent('.comp[data-id="calls"] .pill'), 'Down');
    assert.match(await page.textContent('.comp[data-id="calls"] .comp-detail'), /HTTP 502/);
    assert.equal(await page.isVisible('#active'), true);
    const now = await page.textContent('#active');
    assert.doesNotMatch(now, /Voice and video calls: down/, 'no second card for the same outage');
    assert.match(now, /Calls not connecting for some people/);
    assert.match(now, /Found the cause\. The call server ran out of memory/);
    assert.match(now, /Affected: Voice and video calls/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('an old check says the page may be behind', async () => {
    const { page, ctx } = await open('old');
    assert.equal(await page.isVisible('#stale'), true);
    assert.match(await page.textContent('#stale'), /50 minutes ago\. GitHub sometimes runs the checks late/);
    await ctx.close();
  });

  test('no data: says so instead of breaking', async () => {
    const { page, ctx, errors } = await open('empty');
    assert.equal(await page.textContent('#headline'), 'Status unavailable');
    assert.match(await page.textContent('#checked'), /couldn't be loaded/);
    assert.equal(await page.locator('.comp').count(), 0);
    assert.deepEqual(errors.filter((e) => !/404/.test(e)), []);
    await ctx.close();
  });

  test('names from the data are shown as text, never run as HTML', async () => {
    const { page, ctx } = await open('evil');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('.comp img').count(), 0);
    assert.match(await page.textContent('.comp[data-id="website"] .comp-name'), /<img src=x/);
    await ctx.close();
  });

  test('a phone: the last 30 days, nothing wider than the screen', async () => {
    const { page, ctx } = await open('down', { viewport: { width: 375, height: 800 }, incidents: true, tag: '-phone' });
    const visible = await page.locator('.comp').first().locator('.bar').evaluateAll((bs) => bs.filter((b) => getComputedStyle(b).display !== 'none').length);
    assert.equal(visible, 30);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.match(await page.locator('.comp').first().locator('.bar-scale').innerText(), /30 days ago/);
    await ctx.close();
  });

  test('a ?data= that is not a plain folder on this site is ignored', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const asked = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.MUSTER_STATUS = { data: "fixtures/up/" };' }));
    await page.goto(`${base}/?data=${encodeURIComponent('https://evil.example/')}`);
    await page.waitForFunction(() => document.documentElement.dataset.loaded === '1');
    assert.ok(!asked.some((u) => new URL(u).hostname === 'evil.example'), 'nothing is fetched from that host');
    assert.equal(await page.textContent('#headline'), 'Everything is working');
    await ctx.close();
  });
});
