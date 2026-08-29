// The grid: teams, liveries, drivers, helmets and the meme lines that go with
// them. Pure data — world.js picks from it, render.js paints it, radio.js quotes it.
//
// Colours are approximations of real liveries; helmets are two-tone caricatures.

export const TEAMS = {
  ferrari: { id: 'ferrari', name: 'Ferrari', primary: '#e10600', accent: '#ffd400', teammate: true },
  redbull: { id: 'redbull', name: 'Red Bull', primary: '#1e2a78', accent: '#ffcc00', stripe: '#e10600' },
  mclaren: { id: 'mclaren', name: 'McLaren', primary: '#ff8000', accent: '#111', stripe: '#47c7fc' },
  mercedes: { id: 'mercedes', name: 'Mercedes', primary: '#b8bcc4', accent: '#00d2be', stripe: '#111' },
  aston: { id: 'aston', name: 'Aston Martin', primary: '#006f62', accent: '#cedc00' },
  alpine: { id: 'alpine', name: 'Alpine', primary: '#2d6bff', accent: '#ff5ac8', stripe: '#fff' },
  williams: { id: 'williams', name: 'Williams', primary: '#00a0de', accent: '#fff', stripe: '#041e42' },
  racingbulls: { id: 'racingbulls', name: 'Racing Bulls', primary: '#f2f4f8', accent: '#2b4bff', stripe: '#e10600' },
  haas: { id: 'haas', name: 'Haas', primary: '#e6e6e6', accent: '#e10600', stripe: '#111' },
  sauber: { id: 'sauber', name: 'Kick Sauber', primary: '#101010', accent: '#52e252' },
  // classics — rarer, worth a little more
  brawn: { id: 'brawn', name: 'Brawn GP', primary: '#f4f4f4', accent: '#d5ff3c', classic: 2009 },
  lotus: { id: 'lotus', name: 'Lotus', primary: '#111', accent: '#d4af37', classic: 1986 },
  benetton: { id: 'benetton', name: 'Benetton', primary: '#1f6fd0', accent: '#39c25a', stripe: '#ffd400', classic: 1995 },
  jordan: { id: 'jordan', name: 'Jordan', primary: '#ffd400', accent: '#111', classic: 1999 },
  williams92: { id: 'williams92', name: 'Williams', primary: '#1a2c8a', accent: '#ffd400', stripe: '#fff', classic: 1992 },
  mclaren88: { id: 'mclaren88', name: 'McLaren', primary: '#f4f4f4', accent: '#e10600', classic: 1988 },
  renault05: { id: 'renault05', name: 'Renault', primary: '#1a6ee0', accent: '#ffd400', classic: 2005 },
  lotus13: { id: 'lotus13', name: 'Lotus', primary: '#111', accent: '#d4af37', stripe: '#e10600', classic: 2013 },
  merc21: { id: 'merc21', name: 'Mercedes', primary: '#111', accent: '#00d2be', classic: 2021 },
  minardi: { id: 'minardi', name: 'Minardi', primary: '#111', accent: '#ffd400', classic: 2001 },
};

/**
 * Drivers. `lines` are what the pit wall says when you overtake / nearly hit
 * them; `clip` names an optional sound bite (see OPTIONAL_CLIPS) played on the
 * same events if the file is present in assets/. `team` refers to TEAMS.
 */
export const DRIVERS = [
  // --- your team-mates (one of them is picked as the other Ferrari) ---
  { id: 'leclerc', name: 'Leclerc', short: 'LEC', number: 16, team: 'ferrari', helmet: ['#e10600', '#fff'],
    lines: { overtake: ['Copy, we will discuss it after the race.', 'Charles is slower than you. Was.'], close: ['Both cars, both cars!'] }, clip: { overtake: 'iamstupid' } },
  { id: 'hamilton', name: 'Hamilton', short: 'HAM', number: 44, team: 'ferrari', helmet: ['#ffd400', '#7b2cbf'],
    lines: { overtake: ['Lewis says his tyres are gone.', 'Seven titles, one Multi 21.'], close: ['Bono... wrong car, wrong car.'] }, clip: { overtake: 'bono' } },
  // --- 2025 grid ---
  { id: 'verstappen', name: 'Verstappen', short: 'VER', number: 1, team: 'redbull', helmet: ['#ff6a00', '#1e2a78'],
    lines: { overtake: ['Du du du du... not today.', 'Simply lovely.', 'Max is on the radio. Loudly.'], close: ['He is going to complain about that.', 'Leave Max the space. Please.'] }, clip: { overtake: 'dudududu', close: 'simplylovely' } },
  { id: 'tsunoda', name: 'Tsunoda', short: 'TSU', number: 22, team: 'redbull', helmet: ['#fff', '#e10600'],
    lines: { overtake: ['Yuki is asking WHAT?!', 'Clean move on Yuki.'], close: ['WHAT?!', 'Yuki is not happy.'] }, clip: { close: 'what' } },
  { id: 'norris', name: 'Norris', short: 'NOR', number: 4, team: 'mclaren', helmet: ['#d9ff3c', '#2b4bff'],
    lines: { overtake: ['Yes boys! Sorry, wrong radio.', 'Lando is very sorry about that.'], close: ['Lando, leave the space!'] }, clip: { overtake: 'yesboys' } },
  { id: 'piastri', name: 'Piastri', short: 'PIA', number: 81, team: 'mclaren', helmet: ['#111', '#ff8000'],
    lines: { overtake: ['Oscar said one word. It was fine.', 'Papaya rules, apparently.'], close: ['Oscar did not blink.'] } },
  { id: 'russell', name: 'Russell', short: 'RUS', number: 63, team: 'mercedes', helmet: ['#00d2be', '#111'],
    lines: { overtake: ['Mr Saturday. It is Sunday.', 'George is writing to the stewards.'], close: ['George is not impressed.'] } },
  { id: 'antonelli', name: 'Antonelli', short: 'ANT', number: 12, team: 'mercedes', helmet: ['#0044ff', '#fff'],
    lines: { overtake: ['The kid is quick. Not quick enough.'], close: ['Careful with the rookie.'] } },
  { id: 'alonso', name: 'Alonso', short: 'ALO', number: 14, team: 'aston', helmet: ['#0033a0', '#ffd400'],
    lines: { overtake: ['GP2 engine. GP2! Aaargh.', 'Fernando is faster than you. Confirmed.', 'El Plan is working.'], close: ['Fernando says that was amazing. Sarcastically.'] }, clip: { overtake: 'gp2engine' } },
  { id: 'stroll', name: 'Stroll', short: 'STR', number: 18, team: 'aston', helmet: ['#f2f2f2', '#ff69b4'],
    lines: { overtake: ['Lance is checking with his dad.', 'Clean pass on Stroll.'], close: ['Lance did not see you.'] } },
  { id: 'gasly', name: 'Gasly', short: 'GAS', number: 10, team: 'alpine', helmet: ['#fff', '#2d6bff'],
    lines: { overtake: ['Pierre is on the radio in French.', 'Good move on Gasly.'], close: ['Pierre! Attention!'] } },
  { id: 'colapinto', name: 'Colapinto', short: 'COL', number: 43, team: 'alpine', helmet: ['#75aadb', '#fff'],
    lines: { overtake: ['Argentina is watching. Sorry Franco.'], close: ['Franco kept it on the island. Barely.'] } },
  { id: 'albon', name: 'Albon', short: 'ALB', number: 23, team: 'williams', helmet: ['#2b4bff', '#e10600'],
    lines: { overtake: ['Alex is very polite about that.'], close: ['Alex says no worries. He means it.'] } },
  { id: 'sainz', name: 'Sainz', short: 'SAI', number: 55, team: 'williams', helmet: ['#ffd400', '#111'],
    lines: { overtake: ['Smooth operator. Smooooth.', 'Carlos wants to know why. We are checking.'], close: ['Carlos says leave the space, it is his old team.'] }, clip: { overtake: 'smoothoperator' } },
  { id: 'hadjar', name: 'Hadjar', short: 'HAD', number: 6, team: 'racingbulls', helmet: ['#fff', '#2b4bff'],
    lines: { overtake: ['Isack did nothing wrong there.'], close: ['Rookie kept it clean.'] } },
  { id: 'lawson', name: 'Lawson', short: 'LAW', number: 30, team: 'racingbulls', helmet: ['#111', '#e10600'],
    lines: { overtake: ['Liam has been demoted again.'], close: ['Liam is having a week.'] } },
  { id: 'ocon', name: 'Ocon', short: 'OCO', number: 31, team: 'haas', helmet: ['#ff8a00', '#111'],
    lines: { overtake: ['Esteban has an opinion about that.'], close: ['Esteban. Esteban. ESTEBAN.'] } },
  { id: 'bearman', name: 'Bearman', short: 'BEA', number: 87, team: 'haas', helmet: ['#0044ff', '#ffd400'],
    lines: { overtake: ['Ollie is learning. Fast.'], close: ['Bearman kept it out of the wall.'] } },
  { id: 'hulkenberg', name: 'Hülkenberg', short: 'HUL', number: 27, team: 'sauber', helmet: ['#ffd400', '#111'],
    lines: { overtake: ['Hulk still has no podium. You have no points.'], close: ['The Hulk stays calm.'] } },
  { id: 'bortoleto', name: 'Bortoleto', short: 'BOR', number: 5, team: 'sauber', helmet: ['#52e252', '#111'],
    lines: { overtake: ['Gabriel is quick. Give him a year.'], close: ['Bortoleto kept it clean.'] } },
  // --- legends ---
  { id: 'raikkonen', name: 'Räikkönen', short: 'RAI', number: 7, team: 'lotus13', helmet: ['#111', '#fff'], legend: true,
    lines: { overtake: ['Bwoah.', 'Leave him alone, he knows what he is doing.', 'Kimi says: yes yes yes, he knows.'], close: ['Bwoah. He was not even looking.'] }, clip: { overtake: 'bwoah', close: 'leavemealone' } },
  { id: 'bottas', name: 'Bottas', short: 'BOT', number: 77, team: 'merc21', helmet: ['#00d2be', '#fff'], legend: true,
    lines: { overtake: ["Valtteri, it's James. Never mind.", 'Valtteri is going for a porridge.'], close: ["Valtteri, it's James. Leave the space."] }, clip: { overtake: 'itsjames' } },
  { id: 'schumacher', name: 'Schumacher', short: 'MSC', number: 1, team: 'benetton', helmet: ['#e10600', '#fff'], legend: true,
    lines: { overtake: ['You just passed Michael. The Michael.', 'Is that Glock?! No, that is Schumacher.'], close: ['Michael is coming for you.'] }, clip: { overtake: 'isthatglock' } },
  { id: 'button', name: 'Button', short: 'BUT', number: 22, team: 'brawn', helmet: ['#f4f4f4', '#d5ff3c'], legend: true,
    lines: { overtake: ['Jenson has a double diffuser. You have a plan C.'], close: ['Smooth, Jenson.'] } },
  { id: 'senna', name: 'Senna', short: 'SEN', number: 12, team: 'lotus', helmet: ['#ffd400', '#1a9c3f'], legend: true,
    lines: { overtake: ['You passed Senna. On dry tyres.', 'If you no longer go for a gap...'], close: ['Ayrton would have gone for the gap.'] } },
  { id: 'prost', name: 'Prost', short: 'PRO', number: 11, team: 'mclaren88', helmet: ['#f4f4f4', '#1a6ee0'], legend: true,
    lines: { overtake: ['The Professor is taking notes.'], close: ['Alain calculated that gap exactly.'] } },
  { id: 'hill', name: 'Hill', short: 'HIL', number: 9, team: 'jordan', helmet: ['#0033a0', '#fff'], legend: true,
    lines: { overtake: ['Damon says that was a bit much.'], close: ['Damon kept it civil.'] } },
  { id: 'mansell', name: 'Mansell', short: 'MAN', number: 5, team: 'williams92', helmet: ['#0033a0', '#e10600'], legend: true,
    lines: { overtake: ['Nigel is unimpressed. He fainted once. On purpose.'], close: ['Mansell would have done that on a Friday.'] } },
  { id: 'alonso05', name: 'Alonso (2005)', short: 'ALO', number: 5, team: 'renault05', helmet: ['#1a6ee0', '#ffd400'], legend: true,
    lines: { overtake: ['Young Fernando. Same radio.'], close: ['Fernando, in stereo.'] }, clip: { overtake: 'gp2engine' } },
  { id: 'alonso01', name: 'Alonso (2001)', short: 'ALO', number: 21, team: 'minardi', helmet: ['#1a6ee0', '#ffd400'], legend: true,
    lines: { overtake: ['You passed a Minardi. Congratulations.'], close: ['Even the Minardi fought you.'] } },
];

/** Share of rival spawns that are legends. */
export const LEGEND_CHANCE = 0.12;
/** Extra points for passing a legend. */
export const LEGEND_BONUS = 40;

export const driversFor = (teamId) => DRIVERS.filter((d) => d.team === teamId);
export const teamOf = (driver) => TEAMS[driver.team];

/**
 * Meme-pack sound bites. The repo ships a synthesised "pit wall" reading of
 * each one as assets/clips/<id>.wav (see deploy/tools/make-voice-pack.ps1);
 * drop a real clip with the same stem and any of these extensions and it
 * takes precedence: mp3 > ogg > m4a > wav. `event` is where it plays.
 */
export const CLIP_EXTENSIONS = ['mp3', 'ogg', 'm4a', 'wav'];
/** Picks the best available file for a clip id from a list of filenames, or null. */
export function resolveClip(id, files) {
  for (const ext of CLIP_EXTENSIONS) {
    const f = `${id}.${ext}`;
    if (files.includes(f)) return f;
  }
  return null;
}
export const OPTIONAL_CLIPS = {
  lightsout: { event: 'race start', desc: 'Crofty: "It\'s lights out and away we go!"' },
  boxbox: { event: 'pit window opens', desc: '"Box box, box box."' },
  hammertime: { event: 'pushing (alternates with the shipped clip)', desc: 'Bono: "It\'s hammer time."' },
  bono: { event: 'tyres over the cliff · overtaking Hamilton', desc: 'Hamilton: "Bono, my tyres are gone."' },
  iamstupid: { event: 'oil · overtaking Leclerc', desc: 'Leclerc: "I am stupid, I am stupid."' },
  nomichaelno: { event: 'crash (alternates with the shipped clip)', desc: 'Masi/Toto: "No Michael, no! No, that was so not right."' },
  isthatglock: { event: 'rain starts · overtaking Schumacher', desc: 'Brundle: "Is that Glock?!"' },
  dudududu: { event: 'overtaking Verstappen', desc: '"Du du du du Max Verstappen"' },
  simplylovely: { event: 'chequered flag · close call with Verstappen', desc: 'Verstappen: "Simply lovely."' },
  gp2engine: { event: 'overtaking Alonso', desc: 'Alonso: "GP2 engine! GP2! Aaargh!"' },
  smoothoperator: { event: 'overtaking Sainz', desc: 'Sainz: "Smooooth operator."' },
  what: { event: 'close call with Tsunoda', desc: 'Tsunoda: "WHAT?!"' },
  bwoah: { event: 'overtaking Räikkönen', desc: 'Räikkönen: "Bwoah."' },
  leavemealone: { event: 'close call with Räikkönen · safety car restart', desc: 'Räikkönen: "Leave me alone, I know what I\'m doing."' },
  itsjames: { event: 'overtaking Bottas · team-mate pass', desc: '"Valtteri, it\'s James."' },
  multi21: { event: 'overtaking your team-mate', desc: 'Horner: "Multi 21, Seb. Multi 21."' },
  getinthere: { event: 'chequered flag', desc: 'Bono: "Get in there, Lewis!"' },
  wearechecking: { event: 'safety car deployed · botched pit stop', desc: 'Ferrari: "We are checking."' },
  safetycar: { event: 'safety car deployed', desc: '"Safety car, safety car."' },
  penalty: { event: '5 s penalty', desc: 'Any driver discovering a penalty. Loudly.' },
  thunder: { event: 'lightning', desc: 'A real thunder rumble.' },
  yesboys: { event: 'overtaking Norris', desc: 'Norris: "Yes boys!"' },
};

// Optional driver portraits live at assets/drivers/<driver id>.<png|jpg|webp>.
// If the file for the driver you crashed into exists, the retirement screen
// shows it instead of sad Greg; assets/drivers/you.* replaces sad Greg for
// solo crashes. The server lists what is present via /api/assets.
