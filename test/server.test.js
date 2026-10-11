import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// point the leaderboard at a scratch file before the server module reads its env
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawe-ceek-'));
process.env.LEADERBOARD_FILE = path.join(tmpDir, 'leaderboard.json');
const { server, resolveStatic, plausible, clientIp, sanitize } = await import('../server/index.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ROOT = path.resolve('/srv/game');

test('resolveStatic: bad encoding is 400, escapes and hidden paths are 403', () => {
  assert.equal(resolveStatic('/%', ROOT).status, 400);
  assert.equal(resolveStatic('/a%00b', ROOT).status, 400);
  assert.equal(resolveStatic('/..%2fgame-x/', ROOT).status, 403);
  assert.equal(resolveStatic('/..%2f..%2fetc/passwd', ROOT).status, 403);
  assert.equal(resolveStatic('/server/index.js', ROOT).status, 403);
  assert.equal(resolveStatic('/server', ROOT).status, 403);
  assert.equal(resolveStatic('/.git/config', ROOT).status, 403);
  assert.equal(resolveStatic('/src/.env', ROOT).status, 403);
});

test('resolveStatic: normal paths map under the root', () => {
  assert.equal(resolveStatic('/', ROOT).file, path.join(ROOT, 'index.html'));
  assert.equal(resolveStatic('/src/main.js', ROOT).file, path.join(ROOT, 'src', 'main.js'));
  // only the server/ directory is off limits, not anything that merely starts with "server"
  assert.equal(resolveStatic('/serverless.txt', ROOT).file, path.join(ROOT, 'serverless.txt'));
  assert.equal(resolveStatic('/assets/clips/box%20box.mp3', ROOT).file, path.join(ROOT, 'assets', 'clips', 'box box.mp3'));
});

test('plausible: score must track distance and stay under the cap', () => {
  const e = (score, distance) => sanitize({ score, distance });
  assert.ok(plausible(e(1200, 1000)));
  assert.ok(plausible(e(4000, 0)));
  assert.ok(!plausible(e(500, 1000)), 'score below distance');
  assert.ok(!plausible(e(9000, 1000)), 'bonuses run away from distance');
  assert.ok(!plausible(e(1e15, 1e15)), 'over the 1e7 cap');
  assert.ok(!plausible(e(0, 0)));
});

test('clientIp: X-Forwarded-For only counts behind a trusted proxy', () => {
  const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, false), '127.0.0.1');
  assert.equal(clientIp(req, true), '9.9.9.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '1.2.3.4' } }, true), '1.2.3.4');
});

const post = (body) => fetch(`${base}/api/leaderboard`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('HTTP: malformed escape is 400 and the server stays up', async () => {
  assert.equal((await fetch(`${base}/%`)).status, 400);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('HTTP: sibling-directory escape is 403', async () => {
  assert.equal((await fetch(`${base}/..%2fRawe-Ceek-x/`)).status, 403);
  assert.equal((await fetch(`${base}/server/index.js`)).status, 403);
});

test('HTTP: concurrent POSTs both persist; absurd scores are rejected', async () => {
  const [a, b] = await Promise.all([
    post({ name: 'alpha', score: 1500, distance: 1200 }),
    post({ name: 'bravo', score: 2500, distance: 2000 }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const names = (await (await fetch(`${base}/api/leaderboard`)).json()).map((e) => e.name);
  assert.ok(names.includes('alpha') && names.includes('bravo'), names.join(','));
  assert.equal((await post({ name: 'cheat', score: 1e15, distance: 1e15 })).status, 400);
  assert.equal((await post({ name: 'cheat', score: 99999, distance: 10 })).status, 400);
  const res = await fetch(`${base}/api/leaderboard`, { method: 'POST', body: 'null' });
  assert.equal(res.status, 400);
});
