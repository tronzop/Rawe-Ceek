# Rawe Ceek

A Ferrari-fan survival racer in plain HTML5 Canvas + JavaScript. No build step, no runtime dependencies.

You are the red car. The track scrolls under you at ever-increasing speed. Dodge Pirelli tyres, rival cars, oil and debris; manage your tyre wear; box in the pit window when the wall lets you; and trust the strategy. (Don't.)

## Play

```sh
npm start          # serves the game + leaderboard API on http://localhost:8080
```

Or open `index.html` straight from disk — everything works offline except the shared leaderboard (scores fall back to this browser's localStorage).

### Controls

| Key | Action |
| --- | --- |
| `▲ ▼` / `W S` | Steer across the track |
| `▶` / `D` | Push (faster, more tyre wear) — hold for a while and you'll hear about it |
| `◀` / `A` | Lift and coast (slower, saves tyres) |
| `Space` / `Shift` | ERS boost (drains the battery; DRS gates refill it) |
| `1`–`5` / `Tab` | Choose the compound for your next stop (Soft / Medium / Hard / Inter / Wet) |
| `▲` into the green gap | Enter the pit lane when the window is open |
| `P` / `Esc` | Pause · `R` restart · `M` music · `N` sound effects |
| Touch / mouse | Drag to steer; press on the right quarter of the screen to boost |

### How it works

- **Crash** into a tyre or a rival car and the race is over. **Oil** spins you and adds wear; **debris** damages the front wing (a little less top speed until you pit).
- **Tyre wear** grows with the square of your speed. Past ~65 % grip falls off a cliff — you turn slower and can't use full throttle. At 100 % you puncture and limp until you pit.
- **Compounds**: softs are quick and short-lived, hards are slow and last, mediums are mediums. Inters and wets only grip when it **rains**, and it will rain.
- **Pit window** opens every ~26 s for 7 s. Steer up into the flashing green gap in the pit wall. The stop fits whatever compound you selected. Sometimes the wheel gun jams. This is Ferrari.
- **Score** = metres travelled + 60 per overtake + 25 per close call. Every kilometre and every sustained push gets a radio message from the pit wall.

### Sounds

The four meme clips in `assets/` are used as they were intended: *pushing like an animal* when you push, the scream on a close call, *so not right* on oil / a botched pit stop, and the game-over clip on retirement. Everything else — engine, gear shifts, wheel guns, and the soundtrack whose tempo follows your speed — is synthesised live with WebAudio. Music and SFX toggles are remembered.

## Project layout

```
index.html          markup for the title / pause / game-over screens + the canvas
src/
  main.js           bootstrap, state machine, DOM wiring, main loop
  world.js          the simulation: player, hazards, tyres, pit, weather (no DOM)
  logic.js          pure gameplay maths (tested)
  config.js         every tunable in one place
  render.js         canvas renderer + HUD
  audio.js          samples, synth soundtrack, engine drone
  input.js          keyboard + pointer
  radio.js          pit-wall lines
  leaderboard.js    localStorage + server API client
  style.css
server/index.js     zero-dependency static + leaderboard server
test/               node:test unit tests (`npm test`)
assets/             sprite sheet, sad Greg, meme clips
```

## Deploy

```sh
docker compose up -d --build      # game on http://localhost:3732, scores persisted in a volume
```

`PORT` and `LEADERBOARD_FILE` are honoured by the server.

## Tuning

Everything that changes how the game feels — speeds, wear rates, pit timing, rain frequency, hazard weights — is in `src/config.js`. `npm test` checks the maths in `src/logic.js` still holds after you fiddle.
