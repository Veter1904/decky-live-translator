# Design: live screen translator as a Decky Loader plugin

Decision (2026-11-24): build our **own** plugin with an **automatic mode** (elements of the interface found and tracked by the engine) and
**manual fields** (the player draws windows, e.g. one for subtitles). Plugin name stays `decky-live-translator` (working title).

## 1. What the study of Decky Translator (GPL-3.0, read only) tells us

| Question | What it does | What it means for us |
|---|---|---|
| Capture | Backend (Python, not root): PipeWire (`gst-launch-1.0 pipewiresrc`, 2.5 s timeout, one process per frame), else Spectacle, else the xdg portal. PNG to the frontend as base64. Rejects too uniform frames ("warm-up garbage"). | One process per frame is far too slow for live use. We need **one long-lived capture pipeline** that writes frames continuously. Black/uniform first frames must be skipped. |
| Drawing over the game | Not a popup. `routerHook.addGlobalComponent` mounts a React layer in Steam's UI (`position: fixed`, `zIndex: 7002`, transparent). A hook found by `findModuleChild` (source contains `AddMinimumCompositionStateRequest`) asks Steam to composite its UI over the game (`UIComposition.Notification`); the request is released when the overlay hides. | Same mechanism for us. A *notification*-level composition should not take input, which is what a passive live overlay needs (to be proven in the spike). They use `pointerEvents: visible ? "auto" : "none"`: ours must always be `none` except while editing fields. |
| Input | Reads `/dev/hidraw*` itself (250 Hz) and switches off lizard mode and the Steam watchdog while running; the frontend polls it every 100 ms. | We should **not** do that (side effects on the whole system). Use a QAM toggle first; look for a safe chord through Steam's own input API in the spike. |
| OCR | RapidOCR (PP-OCRv5 ONNX) in a subprocess worker (JSON lines over stdin/stdout, images as files); Chrome Screen AI as another option. | PP-OCR *detects text itself* and handles stylised game fonts better than Tesseract. Keep OCR behind an interface (see 3.4). |
| Translation | Backend calls: Google, Gemini, local NLLB (CTranslate2, 1.4 GB). Cache of translations. | Online calls must go through the backend (CEF blocks cross-origin requests). Our local Bergamot (WASM, small models) is lighter than NLLB. |
| Limits they list | Black screen on capture, small text, no Desktop Mode, game keeps getting input while the overlay is shown. | Known risks for us too. |

## 2. Architecture

```
 Game Mode (gamescope)
   │  PipeWire video node of gamescope
   ▼
 BACKEND (Python, plugin main.py)                         FRONTEND (Steam UI, CEF)
 ├─ capture: one long-lived gst-launch pipeline  ───────▶ ├─ engine WORKER (all heavy work, off the UI thread)
 │   pipewiresrc ! videorate ! videoscale !               │    ├─ scout (text-like blocks)  ← scoutworker today
 │   video/x-raw,RGBA,1280x720 ! fdsink                   │    ├─ elements (memory, hysteresis, tracking)
 │   latest frame → /dev/shm + small local HTTP           │    ├─ OCR (Tesseract WASM, or backend RapidOCR)
 ├─ translation: online chain (free) + cache  ◀────────── │    └─ translation (Bergamot WASM / backend call)
 ├─ model downloads (Mozilla CDN: needs a UA)             ├─ overlay layer (React, global component, click-through)
 ├─ settings store (decky settings dir), per game         ├─ QAM panel (toggles, language, quality, fields)
 └─ logs                                                  └─ field editor (full-screen, input only while editing)
```

Why the engine goes into a worker: the frontend runs inside Steam's own UI process; anything heavy on its main thread makes the
whole Game Mode UI stutter. Greenlight showed this exactly (60-100 ms busy stretches felt as a dragging camera).

### 2.1 Capture and frame transport
- One `gst-launch-1.0 -q pipewiresrc ... ! fdsink` child process, started when translation is on, killed on off/suspend. 3-4 fps for
  scanning (adaptive), always the latest frame; 1280x720 RGBA = 3.7 MB, localhost transfer is no problem.
- The frontend asks `GET http://127.0.0.1:<port>/frame?after=<seq>` (long-poll) and gets an `ArrayBuffer` that is transferred to the worker
  without copying. If `gi`/GStreamer bindings turn out to be available in Decky's Python, use an `appsink` instead of a child process.
- Skip the first frames (black/uniform), detect "game paused / frame unchanged" by a cheap hash to save CPU.
- To prove in the spike: does `pipewiresrc` on gamescope give frames reliably, at what CPU cost, and what colour format.

### 2.2 Overlay
- Reuse our renderer (segments, plates that paint over the original, fitting into panels, covers). Port the React overlay as a Decky
  global component; always `pointer-events: none`.
- Composition request as in Decky Translator (find the hook, keep a request while there is something to show, release when empty).
- Hide on suspend (`SteamClient.User.RegisterForPrepareForSystemSuspendProgress`) and when the game/overlay (QAM, Steam menu) takes focus.

### 2.3 Automatic mode (the engine we already have)
- Elements with memory, hysteresis, dead (false alarm) memory with back-off, fast hide when text goes, joining of big titles, grey fallback
  for faint menus, coverage check for paragraphs, glossary of interface words.
- New: a `FrameSource` interface instead of `<video>` + canvas (`getFrame() → {data, width, height, seq}`), so the same code runs in a
  worker (OffscreenCanvas for crops) and in tests (our replay harness with recorded frames and real Tesseract).
- Per-game profile keyed by the Steam app id (`Router.MainRunningApp`): where text was found, language, quality.

### 2.4 Manual fields
- A field is a **pinned element**: a fixed rectangle the engine always watches (need = 1, never marked dead, subtitle role, own
  language/mode if wanted). This replaces the old "classic window" engine, so there is one engine, not two. The automatic mode leaves
  the places of fields alone (already how Greenlight works).
- Editor: a full-screen layer that takes input only while open; drag with touch or sticks, up to 3 fields, on/off per field in the QAM.

### 2.5 OCR providers (interface `OcrProvider`)
1. Tesseract WASM in the engine worker (what we have; free, offline, weak on stylised fonts).
2. RapidOCR/ONNX in the backend (better on game fonts; heavy dependencies: onnxruntime/numpy, a bundled or downloaded Python runtime,
   extra ~75 MB of models). Optional, second stage. Because it detects text itself, it can also be asked for just the regions that
   changed.

### 2.6 Translation
- Local: Bergamot WASM in a worker (small models, downloaded once, glossary first). Online: through the backend (free services,
  fallback chain), with a translation cache. Draft + better text as in Greenlight (`translate.ts`).

### 2.7 Settings and UI
- QAM panel with Decky UI components: on/off, automatic mode, fields, languages (game text, translation), quality/battery profile,
  overlay opacity/font, "forget what was learned". Settings in the plugin settings directory, per game overrides.

## 3. Performance and battery budget
- Target: under ~5-8 % of the CPU on average while a game runs, no stutter. Levers: scan rate (1-4 Hz), frame change detection,
  resolution (720p), OCR only for dirty elements, quality profiles, pause when the game is paused or the screen is static.
- The engine's own measurements from Greenlight (Deck): copying a video frame ~10 ms, text analysis ~35 ms (now in a worker),
  OCR of an element 100-400 ms (in a worker).

## 4. Reuse map (Greenlight, MIT)
- Take as is: `ink.ts`, `scout.ts`, `scoutworker.ts` (build script), `uiwords.ts` (glossary), `local.ts`/`translate.ts` (Bergamot
  and chain, adapted: online part to backend), `elements.ts` (+ `FrameSource`), `ocr.ts` (abort on terminate), overlay rendering.
- Replay harness (`replay.ts`, fake canvas with real pixels, Tesseract shim) becomes the test bench; a "record frame" debug button in the
  plugin stores frames for it.
- Keep the MIT notice of Greenlight for the copied files.

## 5. Plan
- **M0 Spike (prove or kill):** a minimal plugin: (a) start/stop the capture pipeline, (b) fetch one frame in the frontend and
  show it small in the QAM, (c) draw a test text over a running game without stealing input, (d) report capture CPU, frame time,
  transport time. Deployed over SSH or as a zip; CEF remote debugging on for live logs.
- **M1 Automatic mode in a worker:** FrameSource, engine worker, overlay, QAM toggle, one language pair, local reading.
- **M2 Manual fields + profiles** (editor, pinned elements, per-game settings).
- **M3 Translation stack** (Bergamot, backend chain, cache, model manager).
- **M4 Polish and store:** battery profiles, suspend/resume, logs, README, licences, store PR (check the runtime-download rules).
- Optional: RapidOCR provider, Desktop Mode is out of scope (Decky runs in Game Mode only).

## 6. Risks
1. Capture in Game Mode may be unreliable (black frames) or costly: the spike decides.
2. An overlay that is always on may interfere with input/focus on some SteamOS versions.
3. WASM in Steam's CEF (workers, memory, SharedArrayBuffer) may have limits: the spike checks Tesseract/Bergamot in a worker.
4. Store review of runtime downloads (models) and of the backend's capture subprocess.
5. Games with protected/HDR output, or when gamescope changes the stream format.

## 7. What we need on the Deck for development
Developer Mode in Decky (on), SSH (temporary), the CEF remote debugging switch (temporary, open to the LAN while on), a Game Mode game to
test with.

## 8. Spike M0 results (2026-11-25, Steam Deck, SteamOS 3.9.5, gamescope 3.16.30, GStreamer 1.28)

- **Capture works** without root: PipeWire node `gamescope` (Video/Source), first frame ~0.25 s, RGBA 1280x720 = 3.7 MB.
  `pipewiresrc do-timestamp=true ! valve ! videoconvert ! videoscale ! caps ! appsink drop=true max-buffers=1` taking one frame per
  period: 4 fps = ~5.5 % of one core, 8 fps = ~5-6 %, static screen ~1 % (gamescope sends frames only on damage, ~1 per 2 s).
  Unthrottled: 38.8 fps = 18 % of a core.
- **DANGER: gamescope crashes (SIGSEGV in libvulkan_radeon, render thread) when a consumer disconnects while buffers are starved.**
  Seen 3 times in 7 minutes with `videorate` pipelines, which hold PipeWire buffers (journal: `pipewire: warning: out of buffers`
  a few seconds earlier). The crash restarts the whole Game Mode session and kills the running game. Rules for the helper:
  1. never hold buffers (drop in a `valve`/`appsink drop=true`, copy and release at once, no `videorate`);
  2. ONE long-lived connection, connect/disconnect as rarely as possible (not one process per frame);
  3. disconnect only when the game is not rendering heavily if possible; 10 connect/disconnect cycles of the valve helper: no crash;
  4. never test captures with a game running unless the helper was already proven; develop with the game closed.
  The one-process-per-frame approach of Decky Translator is exposed to the same race.
- **The stream is the composited screen including Steam's own UI.** Our own overlay will be in the captured frame: the engine has to
  ignore regions covered by our plates (or compare with what was drawn) or it reads its own translation.
- Engine on a real captured frame (Among Us announcements, 1280x720): 12 elements, titles/subtitles read, paragraph needs tuning.

### M0 results on the Deck (plugin spike v0.0.1, 2026-11-25)
- **Plugin loads and runs**: backend runs as root (`flags: root`), spawns the capture helper as uid 1000 with the system `/usr/bin/python3`;
  helper is a long-lived process with a 127.0.0.1 HTTP server; frontend `fetch` from `https://steamloopback.host` to
  `http://127.0.0.1:47821` works (CORS header, no mixed-content block). Logs from the UI reach the plugin log through a `log` callable
  (no CEF remote debugging needed): `~/homebrew/logs/Live-Translator/`.
- **Steam's CEF is Chrome 126**: `Worker`, `OffscreenCanvas`, `WebAssembly` are available; `SharedArrayBuffer` is NOT (not cross-origin
  isolated), so no shared-memory threads for WASM (Tesseract/Bergamot single-threaded builds only). 8 cores, deviceMemory 8.
- **Frame transport**: helper->HTTP 3 ms for a 3.7 MB frame, frame age 3-10 ms, transfer of the buffer into a Worker 1.5 ms
  (transferable, no copy). Helper CPU 6.3 % of one core at 4 fps/720p, stable (0 restarts, no gamescope crash).
- **Overlay**: a global component (`routerHook.addGlobalComponent`, `position: fixed`, `zIndex 7002`, `pointer-events: none`) with the
  composition request found by `findModuleChild` appears over Steam's UI/game. Hook found on SteamOS 3.9.5.
- **The overlay IS in the captured frame** (confirmed: plate and test rectangle visible in the saved frame). The engine must not read
  its own plates. Options for M1: (1) keep a list of the rectangles we draw and treat those pixels as "unknown", elements under a
  plate keep their memory and translation until the pixels AROUND them change or a periodic short "peek" (hide plates for one capture
  frame) re-checks them; (2) compare captured pixels with the plate's known colours to recognise our own plate; (3) look for a
  game-only capture in gamescope. Start with (1).

### M1 findings (2026-11-25, engine running on the Deck)
- **Plugin runs end to end** (capture helper -> engine worker -> plates over the game, clean game screenshots every ~3.5 s for the
  engine's blind spots, plates take the colour of the original letters). Needs `Accept` of the translate backend using the SYSTEM
  CA bundle (`/etc/ssl/certs/ca-certificates.crt`): Decky's own Python has no root certificates (every online translation failed
  with CERTIFICATE_VERIFY_FAILED until this was fixed).
- **`valve` in the capture pipeline makes gamescope flip its PipeWire stream paused/streaming for every frame**: wireplumber 13 % of a
  core, pipewire 3.4 %, gamescope +13 %. A plain `pipewiresrc ! appsink caps=video/x-raw drop=true max-buffers=1` (frame pulled by a
  timer) gives wireplumber 0 %, pipewire 1 %, gamescope +4 % (it is the price of having one consumer, also at 1 fps), helper 2.5-3.7 %.
  The sink needs explicit `caps=video/x-raw` or no frames arrive. Frames are raw BGRx 1280x800 (4 MB); the worker swaps to RGBA.
- **Cost of a clean game screenshot** (`GAMESCOPECTRL_REQUEST_SCREENSHOT=1` on the X root of `:0`, file `/tmp/gamescope.png`, PNG
  encoded by gamescope): ~300 ms latency, gamescope from 20 % to ~100 % of a core at 3/s. Only usable rarely (every 3.5 s: ~7 %).
  Values 2 and 3 include Steam's layer (our plates). `gamescopectl screenshot <path>.png` also works (composite).
- **Engine cost**: scan 60-80 ms, a frame is taken in 4 ms, but OCR can run 20-50 % of a core while elements keep changing
  (a game menu that sways with the camera). A duty limit (`readDuty`, 25 % by default) now bounds it.
- **Coverage is the weak part**: on a clean Among Us menu the scout finds FRIENDS, MY ACCOUNT, SETTINGS, the version line but NOT
  PLAY, INVENTORY, SHOP, NEWS, CREDITS, QUIT (big condensed letters on striped buttons; MIN_ASPECT 2.2 drops short big words, the
  ring-ratio tests drop the rest). The Statistics window (small white text on black, ~12 px) is not read at all. Needs a set of
  recorded clean frames to tune the scout against, then a better reader (RapidOCR/PP-OCR) for stylised fonts.

### Night notes (2026-11-25)
- **Recorded-frame evaluation** (`evalset`): expected strings found on clean game frames, Among Us / Deadshot / KOTOR / Skyrim at
  1280x800 and 1920x1080 (the Deck docked outputs 1920x1080; gamescope's output size is the stream size). Recall 48 % -> 83 %.
  What moved it: nested blocks are no longer dropped by a big block of the other polarity; tall parts are cut into rows and wide parts
  at wide gaps; thresholds for short/big words and busy buttons; a 4th reading attempt (stretched grey, light letters inverted).
- **Gamescope's clean screenshot can be STALE**: before a game puts anything on screen the base plane returns an old picture from memory
  (another game's scoreboard, a dialogue). The worker compares it with the last live frame (64x40 grey, outside our plates) and drops
  it above a mean difference of 32 (same scene <= 27 with plates unmasked, stale 38-56).
- **Resolution follows the output**: handheld 1280x800, docked 1920x1080 (frames 8 MB BGRx); clean screenshots are the game's own
  resolution and are fitted into the frame like gamescope does.
- Plugin behaviour: translates only while a game runs (`Router.MainRunningApp`), capture stops after 20 s without a game, settings
  and the on/off state are kept in the plugin settings dir (`settings.json`), the helper is restarted when it dies.
