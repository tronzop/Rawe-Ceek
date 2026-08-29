// Scores: always kept locally; mirrored to the optional server API when reachable.
import { STORAGE_KEYS } from './config.js';

const API = '/api/leaderboard';
const MAX_LOCAL = 20;

const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const Leaderboard = {
  best() { return Number(load(STORAGE_KEYS.best, 0)) || 0; },
  recordBest(score) {
    const b = Math.max(this.best(), score);
    save(STORAGE_KEYS.best, b);
    return b;
  },
  playerName() { return String(load(STORAGE_KEYS.name, '') || ''); },
  local() { return load(STORAGE_KEYS.scores, []); },

  async submit(entry) {
    const clean = sanitize(entry);
    save(STORAGE_KEYS.name, clean.name);
    const local = this.local();
    local.push(clean);
    local.sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
    save(STORAGE_KEYS.scores, local.slice(0, MAX_LOCAL));
    let online = false;
    try {
      const res = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clean),
      });
      online = res.ok;
    } catch { online = false; }
    return { online };
  },

  /** Returns { entries, source: 'server' | 'local' } */
  async fetch() {
    try {
      const res = await fetch(API, { cache: 'no-store' });
      if (res.ok) {
        const entries = await res.json();
        if (Array.isArray(entries)) return { entries: entries.slice(0, 10), source: 'server' };
      }
    } catch { /* offline */ }
    return { entries: this.local().slice(0, 10), source: 'local' };
  },
};

export function sanitize(e) {
  return {
    name: String(e.name || 'anon').replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'anon',
    score: Math.max(0, Math.floor(Number(e.score) || 0)),
    distance: Math.max(0, Math.floor(Number(e.distance) || 0)),
    overtakes: Math.max(0, Math.floor(Number(e.overtakes) || 0)),
    stops: Math.max(0, Math.floor(Number(e.stops) || 0)),
    timestamp: Number(e.timestamp) || Date.now(),
  };
}
