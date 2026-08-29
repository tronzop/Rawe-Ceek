// Pit-wall radio. Short, deadpan Ferrari strategy energy.
import { pick } from './logic.js';

const LINES = {
  start: ['Radio check, radio check.', 'Rawe Ceek, baby.', 'Push now, push now.', 'Plan A. For now.'],
  pushing: ['Pushing like an animal.', 'Great job, keep pushing.', 'That is the pace we need.'],
  closeCall: ['Careful, careful.', 'That was close.', 'Leave the space!', 'Mind the debris.'],
  overtake: ['Good move.', 'DRS was available.', 'Nice, keep it up.', 'Clean overtake.'],
  oil: ['Oil on track, oil on track.', 'You are on the oil!', 'Yellow flag, sector 2.'],
  debris: ['Front wing damage, checking.', 'Some debris on your car.', 'We are checking.'],
  tyresHot: ['Tyres are going away.', 'Manage the rears.', 'Box this lap? We will let you know.'],
  puncture: ['Puncture, puncture! Box box.', 'The tyre is gone.', 'Bring the car back slowly.'],
  pitOpen: ['Pit window is open.', 'Box box, box box.', 'Box now, confirm.', 'Box this lap. Or the next.'],
  pitIn: ['Copy, boxing.', 'Pit entry confirmed.', 'Pit lane speed limit.'],
  pitSlow: ['We have a problem with the rear left.', 'Stay in the box... stay.', 'Wheel gun. Wheel gun!'],
  pitOut: ['New tyres, go go go.', 'Clean stop, push now.', 'Warm up the tyres.'],
  rainStart: ['It is starting to rain.', 'Rain in turn 3. Stay out.', 'Light rain now. Inters? We are checking.'],
  rainStop: ['Track is drying.', 'Dry line coming through.', 'Rain has stopped.'],
  drs: ['DRS enabled.', 'Battery full.', 'Overtake mode.'],
  milestone: ['P2 is 1.2 ahead. Or behind.', 'Good lap, good lap.', 'This is the pace, keep it.', 'Sector one purple.'],
  crash: ['We are checking.', 'No, Charles. No.', 'Copy. We box... no.', 'That is so not right.'],
  compound: ['Copy, we will fit the {c}.', '{c} for the next stop, confirm.', 'Plan changed: {c}.'],
};

export function radioLine(kind, ctx = {}) {
  const list = LINES[kind];
  if (!list) return null;
  return pick(list).replace('{c}', ctx.compound || 'mediums');
}
