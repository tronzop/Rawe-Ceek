// Pit-wall radio. Short, deadpan Ferrari strategy energy.
// Lines are grouped by event; a few events pick a different group depending on
// context (tyre state, weather vs compound) so the wall reacts to the actual race.
import { pick } from './logic.js';

const LINES = {
  closeCall: ['Careful, careful.', 'That was close.', 'Leave the space!', '{d} is not happy about that.', 'Stewards are looking at you and {d}.', 'You have to leave the space!'],
  start: ['Radio check, radio check.', 'Rawe Ceek, baby.', 'Push now, push now.', 'Plan A. For now.', 'Lights out and away we go.', 'It is race week. Rawe ceek.', 'Remember: we are the team. We are checking.'],
  overtake: ['Good move.', 'DRS was available.', 'Nice, keep it up.', 'Clean overtake.', 'That is {d} behind you now.', 'Good job on {d}.', 'Get in there!', 'Fantastic, fantastic.'],
  oil: ['Oil on track, oil on track.', 'You are on the oil!', 'Yellow flag, sector 2.'],
  debris: ['Front wing damage, checking.', 'Some debris on your car.', 'We are checking.'],
  puncture: ['Puncture, puncture! Box box.', 'The tyre is gone.', 'Bring the car back slowly.'],
  pitIn: ['Copy, boxing.', 'Pit entry confirmed.', 'Pit lane speed limit.'],
  pitGame: ['Stop on the marks. Guns ready.', 'Wheel guns, wait for the marker.', 'Fire when it is in the green.'],
  pitMiss: ['Cross-threaded on the {w}!', '{w}, {w}! Problem!', 'That is so not right.', 'We are checking the wheel gun.'],
  pitLate: ['Too slow on the {w}.', 'Wake up! Wheel gun!', 'The mechanic did the {w} for you. Slowly.'],
  pitRecord: ['That is a record stop! Who are we?!', 'Sub two! Unbelievable.', 'Fastest stop of the season. For us.'],
  pitRequested: ['Box box, confirm. Box box.', 'Copy, we are ready with the tyres.', 'Box now, box now.'],
  pitDenied: ['Negative, pit lane is closed.', 'Stay out, stay out. Window is not open.', 'Not yet. We will let you know.'],
  pitSlow: ['We lost time in the stop. Recover it.', 'The wheel gun let us down. Push now.', 'We will talk about that stop later.'],
  pitOut: ['New tyres, go go go.', 'Clean stop, push now.', 'Warm up the tyres.'],
  // it started raining and your tyres suit the water
  rainStart: ['It is starting to rain. Good call on the tyres.', 'Rain falling. Your tyres like it.', 'Light rain now. You are on the right rubber.'],
  // it started raining on slicks
  rainStartSlicks: ['Rain, rain. You are on slicks — think about inters.', 'It is raining and those are dry tyres. Watch the window.', 'Rain in turn 3. Inters at the next stop?'],
  rainStop: ['Track is drying.', 'Dry line coming through.', 'Rain has stopped.'],
  // it stopped raining and you are still on inters or wets
  rainStopWets: ['Track is drying — those tyres will not last.', 'Dry line coming. Plan a stop for slicks.', 'Rain has stopped. The wets are overheating.'],
  drs: ['DRS enabled.', 'Battery full.', 'Overtake mode.'],
  milestone: ['{k} kilometres. You are {p}.', 'Good lap, good lap. {p}.', 'This is the pace, keep it.', 'Sector one purple. {p} on the screens.'],
  // milestone reached with the tyres past the cliff
  milestoneWorn: ['{k} km, but the tyres are going away.', 'The pace is good. The tyres are not. Box soon.', '{p} — now manage those tyres.'],
  crash: ['We are checking.', 'No, Charles. No.', 'Copy. We box... no.', 'That is so not right.', 'No Michael, no! That was so not right.', 'Is that Glock?! No. That is you, in the wall.', 'I am stupid. I am stupid.', 'Are you OK? ... Copy.'],
  pushing: ['Pushing like an animal.', 'Great job, keep pushing.', 'That is the pace we need.', 'It is hammer time.', 'Push push push. Now. Push.'],
  tyresHot: ['Tyres are going away.', 'Manage the rears.', 'You are past the cliff. Box when you can.', 'Bono, my tyres are gone. Wrong team. Same problem.'],
  // window open, tyres still healthy: no pressure
  pitOpen: ['Pit window is open.', 'Window is open if you need it.', 'Box this lap. Or the next.', 'Box, box. Or stay out. Box.', 'We are going to Plan D.'],
  // window open and the car actually needs the stop (wear, damage, wrong tyres)
  pitOpenUrgent: ['Box box, box box. The tyres are done.', 'Window open — box now, box now.', 'Box this lap. Do not argue.', 'The window is open and you need this stop.'],
  compound: ['Copy, we will fit the {c}.', '{c} for the next stop, confirm.', 'Plan changed: {c}.'],
  venue: ['Welcome to {v}.', 'Next round: {v}. Plan A again.', '{v}. New strategy. Same as the old one.'],
  chequered: ['Chequered flag at {v}! P... we are checking.', 'That is 25 points from {v}. Probably.', '{v} done. Great race. Now do it again.'],
  scDeployed: ['Safety car, safety car.', 'Safety car deployed. Do not overtake.', 'Yellow flags. Stay behind the safety car.', 'Safety car. Box? No. Stay out. Box. No.'],
  scEnding: ['Safety car in this lap.', 'Restart coming, get ready.', 'Safety car in, warm the tyres.'],
  scRestart: ['Green flag, green flag, push!', 'Go go go!', 'Restart. Use the tow.'],
  penalty: ['Five second penalty. Overtaking under safety car.', 'The stewards are not happy.', 'That is a penalty. We are checking why.'],
  scClean: ['Clean behind the safety car — that is +50. Now push!', 'Good job behind the safety car. Green flag, go!'],
  teammate: ['Copy, we will discuss it after the race.', 'Multi 21. Multi... never mind.', 'He was faster than you. Was.', 'Team orders? What team orders.'],
  teammateClose: ['Leave the space! That is your team-mate!', 'Both cars, both cars!', 'Do not touch, do not touch.'],
  tow: ['You have the tow, use it.', 'Slipstream. Battery is charging.', 'Stay in the tow.'],
  thunder: ['Lightning. Keep it on the island.', 'It is a monsoon out there.', 'Full wets? We are checking the radar.'],
  coldTyres: ['Tyres are cold, careful in the first corners.', 'Warm up the tyres. Weave a bit.', 'The tyres are like ice. Careful.'],
  night: ['Lights on. Sparkly.', 'Night race. The car looks fantastic under the lights.'],
};

// Events whose line group depends on what is actually happening in the car.
const VARIANTS = {
  pitOpen: (ctx) => (ctx.urgent ? 'pitOpenUrgent' : 'pitOpen'),
  milestone: (ctx) => (ctx.wear > 60 ? 'milestoneWorn' : 'milestone'),
  rainStart: (ctx) => (ctx.onSlicks ? 'rainStartSlicks' : 'rainStart'),
  rainStop: (ctx) => (ctx.onWets ? 'rainStopWets' : 'rainStop'),
};

function fill(template, ctx) {
  return template
    .replaceAll('{c}', ctx.compound || 'mediums')
    .replaceAll('{v}', ctx.venue || 'the track')
    .replaceAll('{d}', ctx.driver?.name || 'him')
    .replaceAll('{w}', ctx.wheel || 'wheel gun')
    .replaceAll('{p}', ctx.position || 'P?')
    .replaceAll('{k}', String(ctx.km ?? '?'));
}

export function radioLine(kind, ctx = {}) {
  // driver-specific quips take priority half the time
  const d = ctx.driver;
  const own = d?.lines?.[kind === 'overtake' || kind === 'teammate' ? 'overtake' : kind === 'closeCall' || kind === 'teammateClose' ? 'close' : null];
  if (own?.length && Math.random() < 0.6) return pick(own);
  const list = LINES[VARIANTS[kind] ? VARIANTS[kind](ctx) : kind];
  if (!list) return null;
  return fill(pick(list), ctx);
}
