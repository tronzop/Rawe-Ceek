// Career: persistent stats + trophy cabinet, all in localStorage.
// Pure evaluation lives in `evaluateTrophies` so it can be unit-tested.
import { STORAGE_KEYS } from './config.js';

export const TROPHIES = [
  { id: 'lightsout', name: 'Lights out', desc: 'Start your first race.', check: (c) => c.races >= 1 },
  { id: 'chequered', name: 'Chequered flag', desc: 'Complete a Grand Prix.', check: (c, r) => r.gps >= 1 },
  { id: 'triple', name: 'Triple header', desc: 'Complete three Grands Prix in one run.', check: (c, r) => r.gps >= 3 },
  { id: 'season', name: 'Full season', desc: 'Complete all eight venues in one run.', check: (c, r) => r.gps >= 8 },
  { id: 'animal', name: 'Pushing like an animal', desc: 'Get told off for pushing three times in one run.', check: (c, r) => r.pushes >= 3 },
  { id: 'bono', name: 'Bono, my tyres are gone', desc: 'Suffer a puncture.', check: (c, r) => r.punctures >= 1 },
  { id: 'undercut', name: 'The undercut works', desc: 'Make three pit stops in one run.', check: (c, r) => r.stops >= 3 },
  { id: 'regen', name: 'Regenmeister', desc: 'Survive 45 seconds of rain in one run.', check: (c, r) => r.rainTime >= 45 },
  { id: 'lights', name: 'Under the lights', desc: 'Race at a night venue.', check: (c, r) => r.nightTime >= 5 },
  { id: 'sc', name: 'Safety car, safety car', desc: 'Sit behind the safety car without a penalty.', check: (c, r) => r.scClean >= 1 },
  { id: 'multi21', name: 'Multi 21', desc: 'Overtake your team-mate. Copy, we will discuss it after.', check: (c, r) => r.teammatePasses >= 1 },
  { id: 'tow', name: 'Get the tow', desc: 'Harvest 100 ERS from slipstreams in one run.', check: (c, r) => r.towEnergy >= 100 },
  { id: 'p1', name: 'P1', desc: 'Reach P1: nineteen overtakes in one run.', check: (c, r) => r.overtakes >= 19 },
  { id: 'podium', name: 'Podium', desc: 'Score 5000 points in one run.', check: (c, r) => r.score >= 5000 },
  { id: 'checking', name: 'We are checking', desc: 'Suffer three botched pit stops over your career.', check: (c) => c.slowStops >= 3 },
  { id: 'marathon', name: 'Rawe Ceek every week', desc: 'Drive 50 km over your career.', check: (c) => c.metres >= 50000 },
];

export const EMPTY_CAREER = () => ({
  races: 0, metres: 0, overtakes: 0, gps: 0, points: 0, slowStops: 0, penalties: 0, trophies: [],
});

/** Fresh per-run counters the world fills in. */
export const EMPTY_RUN = () => ({
  gps: 0, pushes: 0, punctures: 0, stops: 0, slowStops: 0, rainTime: 0, nightTime: 0, scClean: 0, scPeriods: 0,
  penalties: 0, teammatePasses: 0, legendPasses: 0, towEnergy: 0, overtakes: 0, score: 0, metres: 0,
});

const load = () => {
  try { return { ...EMPTY_CAREER(), ...(JSON.parse(localStorage.getItem(STORAGE_KEYS.career)) || {}) }; } catch { return EMPTY_CAREER(); }
};
const save = (c) => { try { localStorage.setItem(STORAGE_KEYS.career, JSON.stringify(c)); } catch { /* ignore */ } };

/** Folds a finished run into the career totals (pure). */
export function applyRun(career, run, gpPoints) {
  return {
    ...career,
    races: career.races + 1,
    metres: career.metres + Math.floor(run.metres),
    overtakes: career.overtakes + run.overtakes,
    gps: career.gps + run.gps,
    points: career.points + run.gps * gpPoints,
    slowStops: career.slowStops + run.slowStops,
    penalties: career.penalties + run.penalties,
  };
}

/** Returns the ids of trophies newly unlocked by this run (pure). */
export function evaluateTrophies(career, run) {
  const have = new Set(career.trophies);
  return TROPHIES.filter((t) => !have.has(t.id) && t.check(career, run)).map((t) => t.id);
}

export const Career = {
  load,
  /** Records a finished run; returns { career, unlocked: Trophy[] }. */
  record(run, gpPoints) {
    const next = applyRun(load(), run, gpPoints);
    const unlocked = evaluateTrophies(next, run);
    next.trophies = [...next.trophies, ...unlocked];
    save(next);
    return { career: next, unlocked: unlocked.map((id) => TROPHIES.find((t) => t.id === id)) };
  },
};
