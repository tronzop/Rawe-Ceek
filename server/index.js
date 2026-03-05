const http = require('http');
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'leaderboard.json');
const PORT = process.env.PORT || 3000;

// Simple in-memory rate limiter: max 5 POST submissions per IP per 60 seconds
const _rateMap = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = 5;
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

function readScores() {
  try {
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}

function writeScores(scores) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
  } catch (e) { /* ignore */ }
}

const server = http.createServer((req, res) => {
  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/leaderboard' && req.method === 'GET') {
    const scores = readScores().sort((a,b) => b.score - a.score).slice(0, 25);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(scores));
    return;
  }

  if (req.url === '/leaderboard' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429);
      res.end(JSON.stringify({ ok: false, error: 'too many requests' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const name = (payload.name || 'anon').toString().slice(0, 50);
        const score = Number(payload.score) || 0;
        const timestamp = Date.now();
        const scores = readScores();
        scores.push({ name, score, timestamp });
        // sort and keep top 100
        scores.sort((a,b) => b.score - a.score || a.timestamp - b.timestamp);
        writeScores(scores.slice(0, 100));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok:false, error: 'invalid json' }));
      }
    });
    return;
  }

  // simple status
  if (req.url === '/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('Leaderboard server available');
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`Leaderboard API running on http://localhost:${PORT}`));
