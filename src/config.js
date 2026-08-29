// Central tunables for Rawe Ceek. Everything gameplay-related that a designer
// might want to tweak lives here so the simulation code stays readable.

export const WORLD = {
  // Logical design height. The renderer scales the world so this many px fit vertically.
  height: 720,
  // Track geometry as fractions of the logical height.
  pitLaneTop: 0.19,
  pitLaneBottom: 0.28,
  trackTop: 0.31,
  trackBottom: 0.87,
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

// ---------------------------------------------------------------------------
// Expansion: Grand Prix calendar, safety car, slipstream, tyre temperature,
// team orders, weather drama and the career/trophy layer.
// ---------------------------------------------------------------------------

/**
 * The calendar. Each Grand Prix is GP.lengthMetres long; when you cross the
 * line you bank points and the scenery morphs into the next venue.
 * `skyline` picks a backdrop painter in render.js; `night` venues switch on
 * headlights and floodlights; `rainBias` scales the chance of rain.
 */
export const VENUES = [
  { id: 'monza', name: 'Monza', flag: '🇮🇹', skyline: 'trees', night: false, rainBias: 1.0, sky: ['#6fb6ff', '#dcefff'], horizon: '#9fd08a', ground: '#2f7d32', barrier: '#9aa0ad' },
  { id: 'monaco', name: 'Monaco', flag: '🇲🇨', skyline: 'harbour', night: false, rainBias: 0.5, sky: ['#5aa9ff', '#cfe7ff'], horizon: '#7db7e8', ground: '#5c6470', barrier: '#c7ccd6' },
  { id: 'silverstone', name: 'Silverstone', flag: '🇬🇧', skyline: 'stands', night: false, rainBias: 1.7, sky: ['#8aa2b8', '#d9e1ea'], horizon: '#b6c2ce', ground: '#3f8a3c', barrier: '#9aa0ad' },
  { id: 'spa', name: 'Spa-Francorchamps', flag: '🇧🇪', skyline: 'forest', night: false, rainBias: 2.4, sky: ['#6f8fae', '#cfdbe6'], horizon: '#4f7a4a', ground: '#2c6b2f', barrier: '#8e949f' },
  { id: 'suzuka', name: 'Suzuka', flag: '🇯🇵', skyline: 'wheel', night: false, rainBias: 1.3, sky: ['#7cc0ff', '#e6f2ff'], horizon: '#93c58f', ground: '#357f39', barrier: '#9aa0ad' },
  { id: 'singapore', name: 'Singapore', flag: '🇸🇬', skyline: 'city', night: true, rainBias: 1.5, sky: ['#0b1030', '#3a2757'], horizon: '#1b2148', ground: '#33383f', barrier: '#5f6672' },
  { id: 'interlagos', name: 'Interlagos', flag: '🇧🇷', skyline: 'hills', night: false, rainBias: 2.0, sky: ['#5f9fe0', '#d3e6f8'], horizon: '#6ea56a', ground: '#2f7d32', barrier: '#9aa0ad' },
  { id: 'bahrain', name: 'Bahrain', flag: '🇧🇭', skyline: 'desert', night: true, rainBias: 0.0, sky: ['#0a0d22', '#3b2a3f'], horizon: '#2a2238', ground: '#8f7c55', barrier: '#5f6672' },
];

export const GP = {
  lengthMetres: 1500,
  finishBonus: 150,
  points: 25, // championship points banked per completed GP
  transition: 3, // seconds to morph the scenery between venues
};

export const SAFETY_CAR = {
  firstAfter: 40, // seconds before the first one can be deployed
  chancePerSecond: 0.012,
  minGap: 45, // seconds between periods
  duration: { min: 9, max: 14 },
  speedCap: 0.62, // fraction of base speed while deployed
  penaltySeconds: 5,
  penaltyCap: 0.5, // speed cap while serving a penalty
  restartWindow: 4, // seconds after the restart where overtakes pay double
  restartBonus: 50,
};

export const SLIPSTREAM = {
  range: 280, // px behind a rival where the tow starts
  lateral: 30, // vertical alignment tolerance
  speedBonus: 0.12, // max speed multiplier gain at full tow
  ersPerSecond: 16, // extra ERS harvest at full tow
};

export const TYRE_TEMP = {
  warmupSeconds: 4.5, // time for fresh tyres to come up to temperature
  coldGrip: 0.78, // grip multiplier when stone cold
  rainCooling: 0.04, // per second temp loss while it rains
};

export const TEAMMATE = {
  chance: 0.14, // share of rivals that are your team-mate
  bonus: 100, // extra for passing him (the wall will not be happy)
  team: { name: 'Ferrari', primary: '#e10600', accent: '#ffd400', teammate: true },
};

export const RIVAL_AI = {
  defendChance: 0.35, // rivals that move to cover your lane
  defendRange: 340,
  defendSpeed: 70, // px/s lateral
};

export const STORM = {
  minRain: 0.75, // wetness before lightning can strike
  chancePerSecond: 0.09,
};

export const SCORING_EXTRA = {
  closeCallTeammate: 40,
  restartMultiplier: 2,
};

export const SAFETY_CAR_TEAM = { name: 'Safety Car', primary: '#c9ccd2', accent: '#ff9d00' };

Object.assign(STORAGE_KEYS, { career: 'rawe-ceek:career' });
