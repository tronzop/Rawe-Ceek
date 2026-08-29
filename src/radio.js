// Pit-wall radio. Short, deadpan Ferrari strategy energy.
import { pick } from './logic.js';

const LINES = {
  closeCall: ['Careful, careful.', 'That was close.', 'Leave the space!', 'Mind the debris.', '{d} is not happy about that.', 'Stewards are looking at you and {d}.', 'You have to leave the space!'],
  start: ['Radio check, radio check.', 'Rawe Ceek, baby.', 'Push now, push now.', 'Plan A. For now.', 'Lights out and away we go.', 'It is race week. Rawe ceek.', 'Remember: we are the team. We are checking.'],
  overtake: ['Good move.', 'DRS was available.', 'Nice, keep it up.', 'Clean overtake.', 'That is {d} behind you now.', 'Good job on {d}.', 'Get in there!', 'Fantastic, fantastic.'],
  oil: ['Oil on track, oil on track.', 'You are on the oil!', 'Yellow flag, sector 2.'],
  debris: ['Front wing damage, checking.', 'Some debris on your car.', 'We are checking.'],
  puncture: ['Puncture, puncture! Box box.', 'The tyre is gone.', 'Bring the car back slowly.'],
  pitIn: ['Copy, boxing.', 'Pit entry confirmed.', 'Pit lane speed limit.'],
  pitSlow: ['We have a problem with the rear left.', 'Stay in the box... stay.', 'Wheel gun. Wheel gun!'],
  pitOut: ['New tyres, go go go.', 'Clean stop, push now.', 'Warm up the tyres.'],
  rainStart: ['It is starting to rain.', 'Rain in turn 3. Stay out.', 'Light rain now. Inters? We are checking.'],
  rainStop: ['Track is drying.', 'Dry line coming through.', 'Rain has stopped.'],
  drs: ['DRS enabled.', 'Battery full.', 'Overtake mode.'],
  milestone: ['P2 is 1.2 ahead. Or behind.', 'Good lap, good lap.', 'This is the pace, keep it.', 'Sector one purple.'],
  crash: ['We are checking.', 'No, Charles. No.', 'Copy. We box... no.', 'That is so not right.', 'No Michael, no! That was so not right.', 'Is that Glock?! No. That is you, in the wall.', 'I am stupid. I am stupid.', 'Are you OK? ... Copy.'],
  pushing: ['Pushing like an animal.', 'Great job, keep pushing.', 'That is the pace we need.', 'It is hammer time.', 'Push push push. Now. Push.'],
  tyresHot: ['Tyres are going away.', 'Manage the rears.', 'Box this lap? We will let you know.', 'Bono, my tyres are gone. Wrong team. Same problem.', 'The rears are like ice.'],
  pitOpen: ['Pit window is open.', 'Box box, box box.', 'Box now, confirm.', 'Box this lap. Or the next.', 'Box, box. Or stay out. Box.', 'We are going to Plan D.'],
  compound: ['Copy, we will fit the {c}.', '{c} for the next stop, confirm.', 'Plan changed: {c}.'],
  venue: ['Welcome to {v}.', 'Next round: {v}. Plan A again.', '{v}. New strategy. Same as the old one.'],
  chequered: ['Chequered flag! P... we are checking.', 'That is 25 points. Probably.', 'Great race. Now do it again.'],
  scDeployed: ['Safety car, safety car.', 'Safety car deployed. Do not overtake.', 'Yellow flags. Stay behind the safety car.', 'Safety car. Box? No. Stay out. Box. No.'],
  scEnding: ['Safety car in this lap.', 'Restart coming, get ready.', 'Safety car in, warm the tyres.'],
  scRestart: ['Green flag, green flag, push!', 'Go go go!', 'Restart. Use the tow.'],
  penalty: ['Five second penalty. Overtaking under safety car.', 'The stewards are not happy.', 'That is a penalty. We are checking why.'],
  scClean: ['Good job behind the safety car.', 'Clean restart, clean restart.'],
  teammate: ['Copy, we will discuss it after the race.', 'Multi 21. Multi... never mind.', 'He was faster than you. Was.', 'Team orders? What team orders.'],
  teammateClose: ['Leave the space! That is your team-mate!', 'Both cars, both cars!', 'Do not touch, do not touch.'],
  tow: ['You have the tow, use it.', 'Slipstream. Battery is charging.', 'Stay in the tow.'],
  thunder: ['Lightning. Keep it on the island.', 'It is a monsoon out there.', 'Full wets? We are checking the radar.'],
  coldTyres: ['Tyres are cold, careful in the first corners.', 'Warm up the tyres. Weave a bit.'],
  night: ['Lights on. Sparkly.', 'Night race. The car looks fantastic under the lights.'],
};

export function radioLine(kind, ctx = {}) {
  // driver-specific quips take priority half the time
  const d = ctx.driver;
  const own = d?.lines?.[kind === 'overtake' || kind === 'teammate' ? 'overtake' : kind === 'closeCall' || kind === 'teammateClose' ? 'close' : null];
  if (own?.length && Math.random() < 0.6) return pick(own);
  const list = LINES[kind];
  if (!list) return null;
  return pick(list).replace('{c}', ctx.compound || 'mediums').replace('{v}', ctx.venue || 'the track').replace('{d}', d?.name || 'him');
}
