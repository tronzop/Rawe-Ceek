// Single zero-dependency server: serves the static game and the leaderboard API.
//   GET  /api/leaderboard          -> top 25 as JSON
//   POST /api/leaderboard {name,score,...} -> { ok: true }
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
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
let writeQueue = Promise.resolve();
function writeScores(scores) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DATA_FILE, JSON.stringify(scores, null, 2))).catch(() => {});
  return writeQueue;
}

export function sanitize(e) {
  return {
    name: String(e.name || 'anon').replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'anon',
    score: Math.max(0, Math.floor(Number(e.score) || 0)),
    distance: Math.max(0, Math.floor(Number(e.distance) || 0)),
    overtakes: Math.max(0, Math.floor(Number(e.overtakes) || 0)),
    stops: Math.max(0, Math.floor(Number(e.stops) || 0)),
    timestamp: Date.now(),
  };
}

// very small per-IP throttle for POSTs
const recent = new Map();
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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || file.startsWith(path.join(ROOT, 'server')) || file.includes(`${path.sep}.`)) {
    res.writeHead(403); res.end(); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

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
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
      if (throttled(ip)) return json(res, 429, { ok: false, error: 'slow down' });
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { json(res, 413, { ok: false, error: 'too large' }); req.destroy(); }
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        try {
          const entry = sanitize(JSON.parse(body));
          if (entry.score <= 0) return json(res, 400, { ok: false, error: 'no score' });
          const scores = readScores();
          scores.push(entry);
          scores.sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
          await writeScores(scores.slice(0, MAX_KEEP));
          json(res, 200, { ok: true, rank: scores.indexOf(entry) + 1 });
        } catch {
          json(res, 400, { ok: false, error: 'invalid json' });
        }
      });
      return;
    }
    res.writeHead(405); return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => console.log(`Rawe Ceek on http://localhost:${PORT}  (leaderboard: ${DATA_FILE})`));
}
export { server };
