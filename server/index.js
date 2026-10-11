// Single zero-dependency server: serves the static game and the leaderboard API.
//   GET  /api/leaderboard          -> top 25 as JSON
//   POST /api/leaderboard {name,score,...} -> { ok: true }
//   GET  /api/assets              -> { clips: [...], drivers: [...] } present in assets/
//   GET  /healthz
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.env.LEADERBOARD_FILE || path.join(__dirname, 'leaderboard.json');
const PORT = Number(process.env.PORT) || 8080;
const MAX_KEEP = 200;
const MAX_BODY = 4096;
const MAX_SCORE = 1e7;
// Behind a reverse proxy (Cloudflare tunnel, nginx) set TRUST_PROXY=1 so the throttle keys on the real client;
// otherwise X-Forwarded-For is ignored, since anyone can send one and dodge the throttle with it.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.webp': 'image/webp', '.gif': 'image/gif', '.jpeg': 'image/jpeg',
};

function readScores() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
// Every read-modify-write runs inside one queue, so two POSTs landing together both persist.
let writeQueue = Promise.resolve();
async function writeScores(scores) {
  // write-then-rename so a crash mid-write never leaves a truncated leaderboard behind
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(scores, null, 2));
  await fs.promises.rename(tmp, DATA_FILE);
}
/** Adds a sanitized entry and resolves to its 1-based rank (before trimming to MAX_KEEP). */
export function addScore(entry) {
  const job = writeQueue.then(async () => {
    const scores = readScores();
    scores.push(entry);
    scores.sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
    await writeScores(scores.slice(0, MAX_KEEP));
    return scores.indexOf(entry) + 1;
  });
  writeQueue = job.catch(() => {});
  return job;
}

export function sanitize(e) {
  return {
    name: String(e.name || 'anon').replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'anon',
    score: Math.max(0, Math.floor(Number(e.score) || 0)),
    distance: Math.max(0, Math.floor(Number(e.distance) || 0)),
    overtakes: Math.max(0, Math.floor(Number(e.overtakes) || 0)),
    stops: Math.max(0, Math.floor(Number(e.stops) || 0)),
    car: /^[a-z0-9]{1,16}$/.test(String(e.car || '')) ? String(e.car) : '',
    timestamp: Date.now(),
  };
}

/** Score is distance plus bonuses, so it can't be below the distance, and bonuses can't run away from it. */
export function plausible(e) {
  return e.score > 0 && e.score <= MAX_SCORE && e.score >= e.distance && e.score <= 2 * e.distance + 5000;
}

export function clientIp(req, trustProxy = TRUST_PROXY) {
  if (trustProxy) {
    const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || '?';
}

// very small per-IP throttle for POSTs
const recent = new Map();
// drop keys with no hits in the last minute, so the map can't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of recent) if (!hits.some((t) => now - t < 60_000)) recent.delete(ip);
}, 60_000).unref();
function throttled(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 20;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Maps a raw URL pathname to a file under ROOT: { file } or { status } (400 bad encoding, 403 outside / hidden).
 * Containment uses path.relative, so a sibling like ../Rawe-Ceek-x can't pass a string-prefix test.
 */
export function resolveStatic(pathname, root = ROOT) {
  let urlPath;
  try { urlPath = decodeURIComponent(pathname); } catch { return { status: 400 }; }
  if (urlPath.includes('\0')) return { status: 400 };
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(root, urlPath);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 };
  const parts = rel.split(path.sep);
  if (parts[0] === 'server' || parts.some((p) => p.startsWith('.'))) return { status: 403 };
  return { file };
}

function serveStatic(req, res) {
  const { file, status } = resolveStatic(new URL(req.url, 'http://x').pathname);
  if (status) { res.writeHead(status); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // code is never cached (no-store also stops CDNs like Cloudflare overriding it); media may be cached
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=3600',
      'Last-Modified': st.mtime.toUTCString(),
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  // Which optional meme-pack files are present, so the client never probes for missing ones.
  if (url.pathname === '/api/assets') return json(res, 200, listAssets());

  if (url.pathname === '/api/leaderboard' || url.pathname === '/leaderboard') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') {
      const scores = readScores().sort((a, b) => b.score - a.score || a.timestamp - b.timestamp).slice(0, 25);
      return json(res, 200, scores);
    }
    if (req.method === 'POST') {
      if (throttled(clientIp(req))) return json(res, 429, { ok: false, error: 'slow down' });
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { json(res, 413, { ok: false, error: 'too large' }); req.destroy(); }
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        let entry;
        try {
          entry = sanitize(JSON.parse(body));
        } catch {
          return json(res, 400, { ok: false, error: 'invalid json' });
        }
        if (entry.score <= 0) return json(res, 400, { ok: false, error: 'no score' });
        if (!plausible(entry)) return json(res, 400, { ok: false, error: 'nice try' });
        try {
          json(res, 200, { ok: true, rank: await addScore(entry) });
        } catch {
          json(res, 500, { ok: false, error: 'could not save' });
        }
      });
      return;
    }
    res.writeHead(405); return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

/** Filenames present in assets/clips and assets/drivers (audio / image types only). */
export function listAssets() {
  const list = (dir, exts) => {
    try {
      return fs.readdirSync(path.join(ROOT, 'assets', dir)).filter((f) => exts.includes(path.extname(f).toLowerCase())).sort();
    } catch { return []; }
  };
  const audio = ['.mp3', '.ogg', '.wav', '.m4a'];
  return { clips: list('clips', audio), drivers: list('drivers', ['.png', '.jpg', '.jpeg', '.webp', '.gif']), engine: list('engine', audio) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => console.log(`Rawe Ceek on http://localhost:${PORT}  (leaderboard: ${DATA_FILE})`));
}
export { server };
