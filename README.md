# Dodge the Circles

A tiny HTML5 Canvas game (plain JavaScript). Move your player with arrow keys or WASD and dodge the red enemy circles.

## Run (quick)
- Open `index.html` in your browser (double-click).
- Or run a simple dev server and open http://localhost:8080:

```powershell
npm start
```

(note: the `start` script uses `npx http-server` so no global install is strictly required.)

## Leaderboard server (hosted)
You can run a small local API that accepts and stores scores using plain Node (no extra packages required):

1) Start the leaderboard server in a separate terminal:
```powershell
npm run server
```
The server will run on http://localhost:3000 and expose `/leaderboard` for GET/POST.

2) Run the frontend server (existing `npm start`) and open http://localhost:8080. After a game over press Submit in the overlay to send your name and score to the leaderboard and then refresh the leaderboard display.

Tip: you can run both in separate terminals or install `concurrently` and use `npm run start:all`.

## Controls
- Arrow keys or WASD — move
- P or the Pause button — pause/resume
- Restart button — reset game
- Sound button or `M` — toggle background electronic beat (tempo and intensity increase with time). Music automatically follows pause/resume and scales difficulty.
- Upload SFX — use the Upload SFX button to provide a custom game-over sound. If no upload is provided the game will attempt to use `/assets/gameover.mp3` (if present in the `assets/` folder). When you first interact with audio (toggle Sound or upload), the game will try to decode `/assets/gameover.mp3` into a WebAudio buffer so the file plays reliably at Game Over.

## Files of interest
- `index.html` — entry + canvas
- `src/game.js` — main game loop and logic (player, enemies, collisions)
- `src/style.css` — simple layout and styling

## Viewport
The canvas now fills the entire browser viewport. HUD elements are overlaid on top of the canvas (title at top-center, hud controls at top-left, footer at bottom-center).

## Player visuals
The player is now rendered as a stylized, animated Formula‑1 car (no external images required) using canvas drawing primitives. The car visually rotates toward movement and features simple wheel rotation and a racing silhouette. Collision detection still uses a circular collision radius (see `player.r` in `src/game.js`) — edit the draw routine in `src/game.js` if you want to replace it with a sprite or more advanced hitbox.
You can now supply a sprite image named `ferrari f1.png` under `/assets/` and the game will automatically use it as the player car graphic (it will be loaded at startup and used instead of the vector drawing). This file is already present in `/assets/` (if you want a different image, replace that file or use the Upload SFX workflow described earlier for SFX).

Important: the game preprocesses that sprite on load to remove white backgrounds (pixels almost white are made transparent), performs a small denoising pass to remove stray pixels around the edge, and computes a tight convex hit polygon from the sprite alpha mask. The player collision now uses this polygon (so the hitbox matches the visible car). If the image is missing or processing fails the vector-drawn car and circular collision fallback will be used.

Note: smoke/exhaust is now emitted from the opposite side of the sprite by default (right side) so the effect visually matches the provided car artwork — this can be flipped or made configurable on request.

Music / Game Over behavior
- When a Game Over occurs the background electronic beat is stopped immediately and the soundtrack is suspended shortly after the game-over sound plays. This ensures the music does not continue playing after you lose while still allowing the game-over SFX to be heard.

Enemy visuals
- The red enemy circles were replaced by stylized Pirelli tyre compounds (Soft/Medium/Hard/Intermediate/Wet). Each enemy carries a compound type and a colored sidewall to visually communicate its type. Some compound types have small speed modifiers; tune these in `spawnEnemy()`.

## Notes
This project is intentionally small and dependency-free so you can edit the game logic quickly. Enjoy!
