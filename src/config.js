// Central tunables for Rawe Ceek. Everything gameplay-related that a designer
// might want to tweak lives here so the simulation code stays readable.

export const WORLD = {
  // Logical design height. The renderer scales the world so this many px fit vertically.
  height: 720,
  // Track geometry as fractions of the logical height.
  pitLaneTop: 0.14,
  pitLaneBottom: 0.24,
  trackTop: 0.27,
  trackBottom: 0.86,
  // Where the player car sits horizontally (fraction of width).
  playerX: 0.22,
  // 1 logical px == this many metres for the odometer.
  metresPerPx: 0.08,
};

export const PLAYER = {
  // Visual size of the sprite (logical px). Hitbox is derived from this.
  width: 150,
  height: 46,
  hitboxInset: { x: 6, y: 8 },
  verticalSpeed: 330, // px/s at full grip
  throttleRange: { min: 0.72, max: 1.22 }, // multiplier on base speed (lift vs push)
  throttleLerp: 3.5, // how fast throttle follows the input
};

export const SPEED = {
  base: 420, // px/s at t=0 with neutral throttle
  perSecond: 3.6, // base speed growth per second survived
  max: 1180,
  kmhPerPx: 0.45, // purely cosmetic conversion for the speedo
  pitLimit: 150, // px/s inside the pit lane
};

export const ERS = {
  max: 100,
  drainPerSecond: 40,
  rechargePerSecond: 9,
  boostMultiplier: 1.45,
  minToEngage: 12,
  drsRefill: 60,
};

export const COMPOUNDS = {
  soft: { id: 'soft', label: 'SOFT', short: 'S', color: '#ff3b3b', grip: 1.12, wearRate: 1.7 },
  medium: { id: 'medium', label: 'MEDIUM', short: 'M', color: '#ffd400', grip: 1.0, wearRate: 1.0 },
  hard: { id: 'hard', label: 'HARD', short: 'H', color: '#f2f2f2', grip: 0.9, wearRate: 0.62 },
  inter: { id: 'inter', label: 'INTER', short: 'I', color: '#2ecc71', grip: 0.8, wearRate: 1.15, wet: 0.6 },
  wet: { id: 'wet', label: 'WET', short: 'W', color: '#2f80ff', grip: 0.72, wearRate: 1.05, wet: 1.0 },
};
export const COMPOUND_ORDER = ['soft', 'medium', 'hard', 'inter', 'wet'];

export const TYRES = {
  // Wear accrues as (speed/base)^2 * compound.wearRate * this per second.
  wearPerSecond: 1.35,
  // Above this wear (0..100) grip falls off linearly to gripAtCliff at 100.
  cliffStart: 65,
  gripAtCliff: 0.45,
  // Dry tyres in the rain or wets in the dry lose this much grip.
  wrongWeatherGrip: 0.55,
};

export const PIT = {
  // Seconds between pit windows and how long each stays open.
  firstWindowAt: 24,
  interval: 26,
  openFor: 7,
  // How long the car is stationary in the box.
  stopTime: { min: 1.9, max: 2.6 },
  // Ferrari strategy: chance the stop goes wrong and takes extra time.
  slowStopChance: 0.18,
  slowStopExtra: { min: 2.5, max: 5.0 },
  // Total time spent in the lane (entry, stop, exit) is padded by this.
  laneTravel: 2.2,
};

export const WEATHER = {
  firstRainAfter: 55, // seconds
  rainChancePerSecond: 0.012,
  rainDuration: { min: 18, max: 34 },
  dryGap: 25,
  transition: 4, // seconds for the track to go from dry to wet and back
};

export const SPAWN = {
  baseInterval: 1.05, // seconds between hazards at t=0
  minInterval: 0.38,
  intervalDecayPerSecond: 0.0085,
  drsEvery: { min: 9, max: 16 },
  // Relative weights of hazard types; shifted over time in logic.pickHazard.
  weights: { tyre: 5, rival: 3.2, oil: 1.6, debris: 1.4 },
};

export const SCORING = {
  overtake: 60,
  closeCall: 25,
  closeCallDistance: 16,
  milestoneMetres: 1000,
};

export const RIVAL_TEAMS = [
  { name: 'Red Bull', primary: '#1e2a78', accent: '#ffcc00' },
  { name: 'Mercedes', primary: '#b8bcc4', accent: '#00d2be' },
  { name: 'McLaren', primary: '#ff8000', accent: '#111' },
  { name: 'Aston Martin', primary: '#006f62', accent: '#cedc00' },
  { name: 'Alpine', primary: '#2d6bff', accent: '#ff5ac8' },
  { name: 'Williams', primary: '#00a0de', accent: '#fff' },
  { name: 'Haas', primary: '#e6e6e6', accent: '#e10600' },
];

export const STORAGE_KEYS = {
  best: 'rawe-ceek:best',
  scores: 'rawe-ceek:scores',
  name: 'rawe-ceek:name',
  music: 'rawe-ceek:music',
  sfx: 'rawe-ceek:sfx',
};
