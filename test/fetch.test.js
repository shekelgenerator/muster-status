'use strict';
// M20 (23 Oct): getting the last results must never quietly start from empty
// when the data branch exists, or save.sh would force-push over the history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'fetch.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muster-fetch-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const fetch = (url, dir) => spawnSync('sh', [SCRIPT, url, dir], { encoding: 'utf8', env: Object.assign({}, process.env, { FETCH_RETRY_WAIT: '0' }) });

function remote(withData) {
  const root = tmp();
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '--quiet', '-b', withData ? 'data' : 'main');
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'daily.json'), '{"website":{"2026-10-01":{"n":1}}}\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'x');
  git(work, 'push', '--quiet', bare, 'HEAD');
  return { root, url: bare };
}

test('the data branch exists: its files are fetched', () => {
  const r = remote(true);
  const dir = path.join(r.root, 'data');
  const out = fetch(r.url, dir);
  assert.equal(out.status, 0, out.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'), /2026-10-01/);
});

test('no data branch yet: starts with an empty folder', () => {
  const r = remote(false);
  const dir = path.join(r.root, 'data');
  const out = fetch(r.url, dir);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("the remote can't be reached: the run stops instead of starting empty", () => {
  const root = tmp();
  const dir = path.join(root, 'data');
  const out = fetch(path.join(root, 'missing.git'), dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /history isn't overwritten/);
  assert.equal(fs.existsSync(dir), false, 'no empty folder for check.js to start from');
});

test('the workflow uses fetch.sh, not "clone || mkdir"', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'check.yml'), 'utf8');
  assert.match(yml, /sh fetch\.sh /);
  assert.doesNotMatch(yml, /\|\| mkdir -p data/);
});
