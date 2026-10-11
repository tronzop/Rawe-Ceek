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
  playerXNarrow: 0.16, // on narrow screens (width/height below 1.5) the car sits further back, so more track shows ahead
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

/**
 * Car-shaped hitboxes (see logic.carHitParts): a low body block (floor, sidepods, wheels, nose) and a
 * cockpit block above it (halo, airbox, engine cover and the rear wing), as fractions of the drawn
 * car's width and height, centred on the car. The air above the nose is not part of the car.
 * `player` follows the sprite sheet (tall rear wing), `rival` the vector car (no rear wing to speak of).
 */
export const HITBOX = {
  player: {
    body: { x0: -0.46, x1: 0.46, y0: -0.08, y1: 0.33 },
    cockpit: { x0: -0.46, x1: 0.1, y0: -0.33, y1: -0.08 },
  },
  rival: {
    body: { x0: -0.46, x1: 0.49, y0: -0.2, y1: 0.47 },
    cockpit: { x0: -0.16, x1: 0.08, y0: -0.45, y1: -0.2 },
  },
};

/** Edge warnings for hazards that are about to come on screen (render.drawIncoming). */
export const WARN = {
  lead: 1.0, // seconds before a hazard reaches the right edge that its chevron appears
  mirrorLead: 1.2, // seconds of mirror warning on the left edge for a car attacking from behind
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
  soft: { id: 'soft', label: 'SOFT', short: 'S', color: '#ff3b3b', grip: 1.12, pace: 1.05, wearRate: 1.7 },
  medium: { id: 'medium', label: 'MEDIUM', short: 'M', color: '#ffd400', grip: 1.0, pace: 1.0, wearRate: 1.0 },
  hard: { id: 'hard', label: 'HARD', short: 'H', color: '#f2f2f2', grip: 0.9, pace: 0.96, wearRate: 0.62 },
  inter: { id: 'inter', label: 'INTER', short: 'I', color: '#2ecc71', grip: 0.8, pace: 1.0, wearRate: 1.15, wet: 0.6, dryWear: 2.5 },
  wet: { id: 'wet', label: 'WET', short: 'W', color: '#2f80ff', grip: 0.72, pace: 1.0, wearRate: 1.05, wet: 1.0, dryWear: 3.5 },
};
// `dryWear`: rain tyres on a dry track (rain below TYRES.dryBelow) chew through themselves this many times faster.
// `grip` is cornering (steering speed, and the throttle you can use once it falls below 1);
// `pace` is straight-line speed on top of that, so a fresh soft is quicker than a medium.
export const COMPOUND_ORDER = ['soft', 'medium', 'hard', 'inter', 'wet'];

export const TYRES = {
  // Wear accrues as (speed/current base speed)^2 * compound.wearRate * this per second, so a
  // stint lasts about as long at 3 minutes as at the start (a medium at neutral throttle hits the cliff in ~30 s).
  wearPerSecond: 1.95,
  // Above this wear (0..100) grip falls off linearly to gripAtCliff at 100.
  cliffStart: 65,
  gripAtCliff: 0.45,
  // Grip multiplier for a tyre in completely the wrong conditions (see logic.suitability: 0 → this, 1 → full grip).
  wrongWeatherGrip: 0.55,
  // Weather suitability curves (track wetness 0..1). Slicks are happy until `slick.full` and useless from
  // `slick.zero`; inters peak between `inter.lo` and `inter.hi` and fade to `inter.dry` / `inter.flooded` at
  // the ends; full wets are at their best from `wet.full` and useless below `wet.zero`.
  suit: {
    slick: { full: 0.25, zero: 0.6 },
    inter: { lo: 0.35, hi: 0.7, dry: 0.4, flooded: 0.2 },
    wet: { full: 0.75, zero: 0.1 },
  },
  dryBelow: 0.2, // rain tyres wear at COMPOUNDS.*.dryWear below this wetness
  rateSmoothing: 1, // s: the wear rate shown on the tyre card is an EMA over about this long
};

export const PIT = {
  // Seconds between pit windows and how long each stays open.
  firstWindowAt: 24,
  interval: 26,
  openFor: 7,
  // How long the car is stationary is decided by the wheel-gun mini-game (see PITGAME).
  // Total time spent in the lane (entry, stop, exit) is padded by this.
  laneTravel: 2.2,
  // Seconds after a stop before the window will accept you again.
  cooldown: 10,
  // Rejoining: time spent arcing back onto the track, then ghosted grace once you are on it.
  mergeTime: 1.1,
  graceAfterExit: 1.6,
  typicalStop: 2.6, // s stationary in an ordinary stop (for the cost estimate on the SC cheap-stop chip)
};

export const WEATHER = {
  firstRainAfter: 55, // seconds
  rainChancePerSecond: 0.012,
  rainDuration: { min: 18, max: 34 },
  dryGap: 25,
  transition: 10, // seconds for the track to go from dry to fully wet (and back)
  forecast: { min: 8, max: 14 }, // the wall sees the rain coming this many seconds before it starts
  dryForecast: 8, // ...and calls the end of a shower this long before it stops
  lightShare: 0.4, // share of showers that are light: the track only gets damp (inter weather)
  damp: 0.5, // wetness a light shower peaks at, and where a drying track holds on its way out
  hold: { min: 6, max: 10 }, // s the drying track holds at `damp` (the inter window on the way out)
};

export const SPAWN = {
  // Seconds between hazards (the timer runs on track covered, see World.updateSpawns). Traffic now
  // stays on screen for a while as you reel it in, so this is sparser than it looks; the floor
  // arrives at about three minutes.
  baseInterval: 1.3, // at t=0
  minInterval: 0.45,
  intervalDecayPerSecond: 0.0048,
  drsEvery: { min: 9, max: 16 },
  // Relative weights of hazard types; shifted over time in logic.pickHazard.
  weights: { tyre: 5, rival: 2.2, oil: 1.6, debris: 1.4 },
  // Fair spawns (logic.freeLanes): a new hazard may not close the last gap the car fits through.
  minGap: 2.2 * (PLAYER.height - PLAYER.hitboxInset.y * 2), // px of clear track the car needs (2.2 × its hitbox height)
  wallSlack: 0.35, // s: hazards crossing your line this close together in time count as one wall
  retry: 0.2, // s to wait before trying again when there is no fair lane
  onRamp: { seconds: 15, mult: 1.6 }, // after the launch the interval starts this much longer and eases to normal
  breather: 3, // s of no spawns after the chequered flag
  bigTyreChance: 0.08, // share of loose tyres that are a big one (r × 1.5)
};

export const SCORING = {
  overtake: 60,
  closeCall: 25,
  closeCallDistance: 16,
  drs: 20, // a DRS gate (and its battery top-up)
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
  track: 'rawe-ceek:track',
  car: 'rawe-ceek:car',
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
  { id: 'monza', name: 'Monza', flag: '🇮🇹', skyline: 'trees', night: false, rainBias: 1.0, sky: ['#6fb6ff', '#dcefff'], horizon: '#9fd08a', ground: '#2f7d32', barrier: '#9aa0ad', asphalt: '#3a3d44' },
  { id: 'monaco', name: 'Monaco', flag: '🇲🇨', skyline: 'harbour', night: false, rainBias: 0.5, sky: ['#5aa9ff', '#cfe7ff'], horizon: '#7db7e8', ground: '#5c6470', barrier: '#c7ccd6', asphalt: '#3d3f46' },
  { id: 'zandvoort', name: 'Zandvoort', flag: '🇳🇱', skyline: 'dunes', night: false, rainBias: 1.6, sky: ['#7fb5e6', '#e3eef7'], horizon: '#d8c78f', ground: '#7f9a4a', barrier: '#e07b1a', asphalt: '#3b3c42' },
  { id: 'silverstone', name: 'Silverstone', flag: '🇬🇧', skyline: 'stands', night: false, rainBias: 1.7, sky: ['#8aa2b8', '#d9e1ea'], horizon: '#b6c2ce', ground: '#3f8a3c', barrier: '#9aa0ad', asphalt: '#40434a' },
  { id: 'spa', name: 'Spa-Francorchamps', flag: '🇧🇪', skyline: 'forest', night: false, rainBias: 2.4, sky: ['#6f8fae', '#cfdbe6'], horizon: '#4f7a4a', ground: '#2c6b2f', barrier: '#8e949f', asphalt: '#34373f' },
  { id: 'baku', name: 'Baku', flag: '🇦🇿', skyline: 'oldcity', night: false, rainBias: 0.3, sky: ['#5fa8e8', '#d9ecfa'], horizon: '#c9b48a', ground: '#6b6f6a', barrier: '#b8bcc4', asphalt: '#3c3e45' },
  { id: 'suzuka', name: 'Suzuka', flag: '🇯🇵', skyline: 'wheel', night: false, rainBias: 1.3, sky: ['#7cc0ff', '#e6f2ff'], horizon: '#93c58f', ground: '#357f39', barrier: '#9aa0ad', asphalt: '#3a3d44' },
  { id: 'singapore', name: 'Singapore', flag: '🇸🇬', skyline: 'city', night: true, rainBias: 1.5, sky: ['#0b1030', '#3a2757'], horizon: '#1b2148', ground: '#33383f', barrier: '#5f6672', asphalt: '#2a2c34' },
  { id: 'austin', name: 'Austin', flag: '🇺🇸', skyline: 'tower', night: false, rainBias: 0.8, sky: ['#63a9f0', '#f3e2c0'], horizon: '#a9b36a', ground: '#7d8f3f', barrier: '#c02c2c', asphalt: '#4a4744' },
  { id: 'mexico', name: 'Mexico City', flag: '🇲🇽', skyline: 'stadium', night: false, rainBias: 0.9, sky: ['#5b9be0', '#f0d9b0'], horizon: '#8a7a5c', ground: '#5f8f3a', barrier: '#1f8a4c', asphalt: '#3e3d43' },
  { id: 'interlagos', name: 'Interlagos', flag: '🇧🇷', skyline: 'hills', night: false, rainBias: 2.0, sky: ['#5f9fe0', '#d3e6f8'], horizon: '#6ea56a', ground: '#2f7d32', barrier: '#9aa0ad', asphalt: '#3a3d44' },
  { id: 'vegas', name: 'Las Vegas', flag: '🇺🇸', skyline: 'neon', night: true, rainBias: 0.1, sky: ['#070a1c', '#2a1442'], horizon: '#1a1330', ground: '#3a3740', barrier: '#4c4c5c', asphalt: '#26272f' },
  { id: 'melbourne', name: 'Melbourne', flag: '🇦🇺', skyline: 'lake', night: false, rainBias: 1.1, sky: ['#6fb3f0', '#dfeefb'], horizon: '#5d9fd0', ground: '#4a8a3a', barrier: '#9aa0ad', asphalt: '#3a3d44' },
  { id: 'bahrain', name: 'Bahrain', flag: '🇧🇭', skyline: 'desert', night: true, rainBias: 0.0, sky: ['#0a0d22', '#3b2a3f'], horizon: '#2a2238', ground: '#8f7c55', barrier: '#5f6672', asphalt: '#2e2d33' },
];

export const GP = {
  lengthMetres: 1500,
  finishBonus: 150,
  points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], // championship points by finishing position at each chequered flag
  transition: 3, // seconds to morph the scenery between venues
  placeGapMetres: 60, // track between two places: a pit stop that costs 180 m costs three places
  fieldSize: 20, // you can drop no further than this
};

export const SAFETY_CAR = {
  firstAfter: 40, // seconds before the first one can be deployed
  chancePerSecond: 0.012,
  minGap: 45, // seconds between periods
  duration: { min: 9, max: 14 },
  speedCap: 0.62, // fraction of base speed while deployed (at neutral throttle; lifting goes slower)
  liftFloor: 0.7, // lifting fully under the safety car gets you down to this fraction of the cap
  bunchSpread: [0.98, 1.05], // rivals under the safety car run at this fraction of the cap (some hold, some pull away)
  graceSeconds: 0.4, // no penalty for passes in the first moments after the yellow (the takeover is SC_GAME.takeoverAfter)
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
  rainCooling: 0.35, // per second temp loss on a fully wet track: slicks go cold in the rain (inters/wets lose 0.3 of this)
};

export const TEAMMATE = {
  chance: 0.14, // share of rivals that are your team-mate (the other car from the team you drive for)
  bonus: 100, // extra for passing him (the wall will not be happy)
};

export const RIVAL_AI = {
  defendChance: 0.35, // rivals that move to cover your lane
  defendRange: 340,
  defendSpeed: 70, // px/s lateral
  commitRange: 2.5 * 340, // px: a defender picks the lane it will cover this far ahead of you (2.5 × defendRange)...
  commitTell: 0.5, // ...flashes its rain light and an arrow for this long, then slides there and holds
  paceRange: [0.62, 0.85], // ordinary traffic runs at this fraction of the current base speed (you are ~1.0)
  passMargin: [180, 320], // px/s a car attacking from behind runs above your speed until it is past your nose
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

/**
 * Under the safety car the race is neutralised: once the field has bunched up the car is
 * taken off you and holds station behind the safety car on its own. Your job is the weave —
 * swing the car left and right to keep the tyres in the temperature window — and a 3-2-1
 * countdown hands the car back at the green. Warm tyres restart with grip; cold ones do not.
 */
export const SC_GAME = {
  takeoverAfter: 3.0, // seconds after the yellow before the car is taken off you (the field bunches up first)
  paceFactor: 0.97, // fraction of the safety-car speed cap the neutralised car holds (rivals ahead pull away slowly)
  weaveAmplitude: 40, // px either side of the centre line the weave can reach
  weaveSpeed: 0.9, // fraction of normal vertical speed while weaving
  minSwing: 40, // px the car must have moved since the last reversal for a weave to count: half the band, so no mashing
  heatPerWeave: 0.045, // temperature 0..1 gained per counted weave: a steady edge-to-edge rhythm holds, hurrying overheats
  coolPerSecond: 0.075, // temperature lost per second at safety-car pace
  band: { lo: 0.5, hi: 0.88 }, // the window: below is cold (less grip at the restart), above blisters the tyres
  blisterWear: 4, // % tyre wear per second spent above the window
  bonus: 80, // restart bonus, scaled by the share of the neutralised time spent in the window
  countdown: 3, // seconds of countdown while the safety car peels off
  jumpWindow: 0.35, // seconds after the green to hit the throttle for the jump bonus
  jumpBonus: 40,
};

Object.assign(STORAGE_KEYS, { career: 'rawe-ceek:career' });

/**
 * The start. You line up at the back of a staggered grid, five red lights come on one
 * by one, hold, and go out. The opening seconds are forgiving: nothing spawns and a
 * touch with a rival costs bodywork, not the race.
 */
export const START = {
  gridCars: 12, // rivals lined up ahead of you
  spacing: 96, // px between grid slots along the track
  preLights: 1.4, // seconds sitting on the grid before the first light
  lights: 5,
  lightInterval: 0.9, // seconds between each red light
  hold: { min: 0.3, max: 1.4 }, // random pause with all five lit before they go out
  launchSeconds: 10, // opening phase: no hazards spawn, contact with rivals is survivable
  launchAccel: 1.7, // how quickly you get up to speed off the line (normal is 2.5)
  rivalAccel: { min: 1.2, max: 2.6 }, // spread of rival launches (some bog down, some rocket)
  // where each car settles relative to the pack once everyone is up to speed: slow starters as a
  // fraction of the pack speed (they fade back to you), fast ones px/s above it (they pull away)
  rivalLaunch: { slow: [-0.35, -0.12], fast: [30, 110] },
  fastShare: 0.35, // share of the grid that pulls away instead of coming back to you
  launchBog: [-30, 50], // px/s per-car wobble in the first moment off the line (a few bog down, most get away)
  spreadOver: 0.7, // fraction of launchSeconds over which the pack spreads from a unit to its settled speeds
  reactionWindow: 0.35, // push / boost within this of lights out = great start
  reactionBonus: 50,
  overtakeBonus: 30, // grid cars are slow traffic off the line: worth less than a real overtake
};

/**
 * Damageable parts, 0..100 each. The front wing takes debris and nose-to-tail
 * contact and costs top speed; the floor takes side-by-side rubs and costs grip.
 * The pit crew fixes both during a stop. A part already at 100 cannot take another hit.
 */
export const DAMAGE = {
  wingPerDebris: 25,
  wingPerHit: [25, 45], // nose into the car ahead
  floorPerRub: [15, 30], // alongside contact, or a car running into your rear
  wingThrottleLoss: 0.24, // top-speed loss at 100 % wing damage
  floorGripLoss: 0.22, // grip loss at 100 % floor damage
  maxClosing: 150, // px/s: a faster frontal impact than this outside the launch is a crash
  frontalDepth: 18, // px: a deeper frontal overlap than this outside the launch is a crash
  needsStop: 30, // total damage from which the wall calls you in
  launchScale: 0.5, // contact during the launch costs this fraction of the usual bodywork
  shove: 160, // px/s the car you hit is pushed on for the moment after contact
};

/** Pit-stop mini-game: fire the wheel gun when the sweeping marker is in the zone. */
export const PITGAME = {
  wheels: ['FL', 'FR', 'RL', 'RR'],
  window: 1.1, // seconds you have per wheel before the mechanic gives up and does it slowly
  sweepSpeed: 1.6, // full left→right→left sweeps per second
  zoneHalf: 0.13, // half-width of the green zone (0..1 bar)
  perfectHalf: 0.045,
  jamChance: 0.15, // Ferrari: some wheels have a much narrower zone
  jamZoneHalf: 0.06,
  time: { base: 0.55, perfect: 0.28, good: 0.42, miss: 1.35 }, // seconds each wheel takes by result
  recordUnder: 2.0, // total stop time for a RECORD STOP
  recordBonus: 100,
  cleanBonus: 50, // no misses
};

/**
 * Flow: close calls, overtakes and DRS gates chained inside `window` seconds of each other build a
 * score multiplier (+`step` each, up to `max`). Contact, oil, a penalty or the pit lane break it.
 * A close call nearer than `scrapeGap` px is a scrape: it pays double, with a flash and a beat of slow motion.
 */
export const FLOW = { step: 0.25, max: 3, window: 3, scrapeGap: 6, scrapeSlowmo: 0.08 };
