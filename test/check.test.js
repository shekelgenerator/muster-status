'use strict';
// node --test test/  — the checker's logic, its HTTP and WebSocket checks
// against local servers, and a whole run into a folder.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../check');

const T = Date.parse('2026-10-21T12:00:00Z');

describe('classify and overall', () => {
  test('down when the check failed, slow over the limit, otherwise up', () => {
    assert.equal(C.classify({ ok: false }, 1000), 'down');
    assert.equal(C.classify(null, 1000), 'down');
    assert.equal(C.classify({ ok: true, ms: 1500 }, 1000), 'slow');
    assert.equal(C.classify({ ok: true, ms: 1000 }, 1000), 'up');
  });
  test('the worst state wins', () => {
    assert.equal(C.overall([{ status: 'up' }, { status: 'up' }]), 'up');
    assert.equal(C.overall([{ status: 'up' }, { status: 'slow' }]), 'slow');
    assert.equal(C.overall([{ status: 'slow' }, { status: 'down' }]), 'down');
  });
});

describe('daily counts', () => {
  test('adds this run to today and keeps 90 days', () => {
    const old = { website: { '2026-07-01': { n: 1, up: 1, slow: 0, down: 0 }, '2026-07-24': { n: 1, up: 1, slow: 0, down: 0 }, '2026-10-21': { n: 2, up: 2, slow: 0, down: 0 } } };
    const d = C.updateDaily(old, { website: 'down', calls: 'slow' }, T);
    assert.deepEqual(d.website['2026-10-21'], { n: 3, up: 2, slow: 0, down: 1 });
    assert.deepEqual(d.calls['2026-10-21'], { n: 1, up: 0, slow: 1, down: 0 });
    assert.ok(!d.website['2026-07-01'], 'older than 90 days is dropped');
    assert.ok(d.website['2026-07-24'], 'day 90 is kept');
    assert.deepEqual(Object.keys(d.website), ['2026-07-24', '2026-10-21'], 'sorted');
  });
  test('a component taken out of the config drops out of the file', () => {
    const d = C.updateDaily({ gone: { '2026-10-21': { n: 1, up: 1, slow: 0, down: 0 } } }, { website: 'up' }, T);
    assert.deepEqual(Object.keys(d), ['website']);
  });
});

describe('outages', () => {
  test('opens on down, counts while down, closes when back', () => {
    let o = C.updateOutages([], { calls: 'down', website: 'up' }, T);
    assert.deepEqual(o, [{ component: 'calls', started_at: '2026-10-21T12:00:00.000Z', ended_at: null, checks: 1 }]);
    o = C.updateOutages(o, { calls: 'down' }, T + 300e3);
    assert.equal(o[0].checks, 2);
    assert.equal(o.length, 1);
    o = C.updateOutages(o, { calls: 'slow' }, T + 600e3);
    assert.equal(o[0].ended_at, '2026-10-21T12:10:00.000Z', 'slow counts as back');
    o = C.updateOutages(o, { calls: 'down' }, T + 900e3);
    assert.equal(o.length, 2, 'a new outage after it ended');
  });
  test('outages that ended over 90 days ago are dropped, open ones never', () => {
    const old = [
      { component: 'a', started_at: '2026-07-01T00:00:00Z', ended_at: '2026-07-01T01:00:00Z', checks: 3 },
      { component: 'b', started_at: '2026-07-01T00:00:00Z', ended_at: null, checks: 9 },
    ];
    const o = C.updateOutages(old, { a: 'up', b: 'down' }, T);
    assert.deepEqual(o.map((x) => x.component), ['b']);
    assert.equal(o[0].checks, 10);
  });
});

describe('status.json', () => {
  const comps = [
    { id: 'website', name: 'Website', description: 'd', check: { slowMs: 1000 } },
    { id: 'calls', name: 'Calls', description: 'd', check: { slowMs: 1000 } },
  ];
  test('names, states, latency and the reason when down', () => {
    const s = C.buildStatus(comps, { website: { ok: true, ms: 123.6 }, calls: { ok: false, ms: 10000, detail: 'HTTP 503' } }, null, T);
    assert.equal(s.overall, 'down');
    assert.equal(s.updated_at, '2026-10-21T12:00:00.000Z');
    assert.deepEqual(s.components[0], { id: 'website', name: 'Website', description: 'd', status: 'up', latency_ms: 124, detail: null, since: s.updated_at });
    assert.equal(s.components[1].latency_ms, null);
    assert.equal(s.components[1].detail, 'HTTP 503');
  });
  test('since stays when the state is unchanged, moves when it changes', () => {
    const prev = C.buildStatus(comps, { website: { ok: true, ms: 1 }, calls: { ok: true, ms: 1 } }, null, T);
    const next = C.buildStatus(comps, { website: { ok: true, ms: 1 }, calls: { ok: false, detail: 'x' } }, prev, T + 300e3);
    assert.equal(next.components[0].since, '2026-10-21T12:00:00.000Z');
    assert.equal(next.components[1].since, '2026-10-21T12:05:00.000Z');
  });
  test('a component with no result counts as down', () => {
    const s = C.buildStatus(comps, { website: { ok: true, ms: 1 } }, null, T);
    assert.equal(s.components[1].status, 'down');
    assert.equal(s.components[1].detail, 'not checked');
  });
});

// A tiny server: plain HTTP on some paths, a WebSocket that says hello on others.
function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); return res.end('hi'); }
      if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      if (req.url === '/badjson') { res.writeHead(200); return res.end('{"ok":false}'); }
      if (req.url === '/moved') { res.writeHead(301, { location: '/ok' }); return res.end(); }
      if (req.url === '/slow') { return setTimeout(() => { res.writeHead(200); res.end('late'); }, 300); }
      res.writeHead(503); res.end();
    });
    s.upgraded = new Set();
    s.stop = () => { for (const so of s.upgraded) so.destroy(); s.closeAllConnections(); s.close(); };
    s.on('upgrade', (req, socket) => {
      s.upgraded.add(socket);
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const text = req.url === '/ws-hello' ? '{"op":10,"d":{"heartbeat_interval":41250}}' : '{"op":0}';
      const body = Buffer.from(text);
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
      socket.on('error', () => {});
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('checks against a local server', () => {
  test('HTTP: expected status, redirects not followed, JSON test, failures named', async (t) => {
    const s = await server();
    t.after(() => s.stop());
    const base = `http://127.0.0.1:${s.address().port}`;
    assert.equal((await C.checkHttp({ url: base + '/ok', expect: [200] })).ok, true);
    assert.equal((await C.checkHttp({ url: base + '/moved', expect: [301] })).ok, true, 'a redirect is an answer');
    assert.deepEqual(await C.checkHttp({ url: base + '/nope', expect: [200] }).then((r) => [r.ok, r.detail]), [false, 'HTTP 503']);
    assert.equal((await C.checkHttp({ url: base + '/json', expect: [200], json: (b) => b.ok === true })).ok, true);
    assert.deepEqual(await C.checkHttp({ url: base + '/badjson', expect: [200], json: (b) => b.ok === true }).then((r) => [r.ok, r.detail]), [false, 'unexpected answer']);
    const slow = await C.checkHttp({ url: base + '/slow', expect: [200] });
    assert.ok(slow.ok && slow.ms >= 250, 'time is measured');
    assert.deepEqual(await C.checkHttp({ url: 'http://127.0.0.1:1/', expect: [200] }).then((r) => [r.ok, r.detail]), [false, 'could not connect']);
  });
  test('WebSocket: up on the right first message, down on the wrong one or none', async (t) => {
    const s = await server();
    t.after(() => s.stop());
    const base = `ws://127.0.0.1:${s.address().port}`;
    const hello = (m) => !!m && m.op === 10;
    assert.equal((await C.checkWs({ url: base + '/ws-hello', message: hello })).ok, true);
    assert.deepEqual(await C.checkWs({ url: base + '/ws-other', message: hello }).then((r) => [r.ok, r.detail]), [false, 'unexpected answer']);
    assert.equal((await C.checkWs({ url: 'ws://127.0.0.1:1/', message: hello })).ok, false);
  });
  test('a failure is tried again before it counts', async (t) => {
    let calls = 0;
    const s = http.createServer((req, res) => { calls += 1; res.writeHead(calls === 1 ? 503 : 200); res.end(); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => { s.closeAllConnections(); s.close(); });
    const r = await C.checkWithRetry({ kind: 'http', url: `http://127.0.0.1:${s.address().port}/`, expect: [200] }, 10);
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
  });
});

describe('a whole run', () => {
  test('writes the three files and carries history forward', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-status-'));
    const comps = [
      { id: 'website', name: 'Website', description: 'd', check: { kind: 'http', slowMs: 1000 } },
      { id: 'calls', name: 'Calls', description: 'd', check: { kind: 'http', slowMs: 1000 } },
    ];
    let callsUp = false;
    const fake = async (c) => (c === comps[1].check && !callsUp ? { ok: false, ms: 1, detail: 'HTTP 502' } : { ok: true, ms: 50 });
    await C.main(dir, comps, T, fake);
    callsUp = true;
    const s = await C.main(dir, comps, T + 300e3, fake);
    assert.equal(s.overall, 'up');
    const daily = JSON.parse(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'));
    assert.deepEqual(daily.calls['2026-10-21'], { n: 2, up: 1, slow: 0, down: 1 });
    const outages = JSON.parse(fs.readFileSync(path.join(dir, 'outages.json'), 'utf8'));
    assert.deepEqual(outages, [{ component: 'calls', started_at: '2026-10-21T12:00:00.000Z', ended_at: '2026-10-21T12:05:00.000Z', checks: 1 }]);
  });
  test('the real config: every component has a name, description and a check the runner knows', () => {
    const comps = require('../components');
    assert.ok(comps.length >= 5);
    const ids = new Set();
    for (const c of comps) {
      assert.match(c.id, /^[a-z]+$/);
      assert.ok(!ids.has(c.id), 'ids are unique');
      ids.add(c.id);
      assert.ok(c.name && c.description);
      assert.ok(['http', 'ws'].includes(c.check.kind));
      assert.match(c.check.url, /^(https|wss):\/\//, 'checks go over TLS');
      assert.ok(c.check.slowMs > 0);
      if (c.check.kind === 'http') assert.ok(Array.isArray(c.check.expect) && c.check.expect.length);
      if (c.check.kind === 'ws') assert.equal(typeof c.check.message, 'function');
    }
  });
});
