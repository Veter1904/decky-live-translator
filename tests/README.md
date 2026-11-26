# Recorded-frame tests of the engine

The reading engine (`engine/vendor`, copied from Greenlight) is tested on real frames taken from the Steam Deck
(`tests/frames`, `tests/sets`: frames of commercial games, handheld 1280x800 and docked 1920x1080). **These frames are not in the repository** (they belong to the game publishers); the tests and numbers below are the author's record, and the harness needs a Greenlight checkout and onnxruntime-node (`GREENLIGHT`, `PPOCR_HOME` environment variables, see `tests/harness/build.cjs`). The tests that need neither (`i18ntest`, the Python tests) run in CI. `tests/synth/make_window_frames.py <frame.png> tests/synth/frames` makes the frames of the paragraph-window test (`windowtest.ts`) from any game frame. `truth.json` / `truth2.json` list what
is written on each frame; `evalset.ts` runs the engine on each frame for N seconds, with the real Tesseract in Node, and counts how
many of the expected strings were read (fuzzy match).

It needs a local Greenlight checkout (branch `deck-translator` of the fork `Veter1904/greenlight`; the path in the imports is `E:/Greenlight`, edit it) with its `node_modules` (esbuild, sharp,
tesseract.js). From `tests/harness`:

    ENTRY=evalset node build.cjs
    node evalset.cjs 25 ../frames truth2.json      # frames at 1920x1080
    node evalset.cjs 18 ../frames truth.json       # frames at 1280x800 / 1280x720

`scoutdbg.ts` + `mkdbg.py` + `mkdbg2.py` build a copy of the scout with debug hooks that say why a place of text was rejected.
Results on 2026-11-25: 43-44 of 52 expected strings (83-85 %), from 12 of 25 before the scout changes.


## Stage 0/1 (2026-11-25): repeatable measurements

All recorded frames are in `tests/sets/gt1..gt7` (each with a `truth.json`). From `tests/harness`, after `ENTRY=evalset node build.cjs`:

    node ../run-all.cjs           # every set, in IDLE mode: the engine runs until it is quiet, so the numbers are the same every run

Before this a fixed time per frame made the result vary by 10-20 %. Baseline: **82/102 expected texts (80 %), 66 extra readings**
(gt1 84 %, gt2 85 %, gt4 92 %, gt5 56 %, gt6 67 %; gt3 has no expected text: it counts false readings).

Other tests (build each with `ENTRY=<name> node build.cjs`):

* `seqtest.cjs <dir> <truth> <A.png> <B.png>`: the picture changes from A to B; prints how long A's plates stay (stale time). Before: 0.8-1.9 s, after the watch between the looks: 0.14-0.25 s for scene changes.
* `typetest.cjs <png> <x0> <x1> <y0> <y1> <text>`: a line of text is typed letter by letter; prints every text that was shown (a partial text is a fault).
* `cleantest.cjs`: the cleaning of the readings ("WHAT 15 IT?" -> "WHAT IS IT?", junk like "Qwy" is dropped).

A recording made on the Deck (panel button "Записати 10 с для розробника", saved in `~/dlt-records`) is fetched with
`python scripts/pull_record.py <ssh key>` into `tests/records/<time>/` (PNG frames, `plates.jsonl` = what the translator showed once per second).

## The local translator (0.3.0)

`src/local.ts` runs Bergamot (the Firefox translator, WASM) in a worker of the Steam UI; the backend downloads the models (`main.py`,
`models_status` / `install_models`, from the registry `assets/models-registry.json` made from Greenlight's `firefox.json`) and the helper serves
`/models` and `/assets/bergamot`. Test on the Deck without installing the plugin: `tests/deck/local_test.ts` (bundle it with esbuild as an IIFE)
and run it in the Steam UI with `scripts/cdp_eval.py` (Chromium debugging port 8080). Result on the Deck (Steam Deck Stable, Chrome 126, WASM SIMD):
start of the runtime 63 ms, loading en->uk 311 ms, a translation 10-80 ms (the online service: 300-1000 ms).

## The modern reader (0.4.0)

`engine/vendor/ppocr.ts` (from Greenlight `lib/translator/ppocr.ts`) runs PP-OCRv4 (detection + recognition, ONNX) with onnxruntime-web in the worker of the engine
(`assets/ort`, `assets/ocr`, bundled in the zip). The detector adds the places of text the scout misses; a place is read in its natural colours; the black-and-white
way of Tesseract is the fallback for places of the scout. English only for now (the recognizer is Chinese + English; the other languages are read by Tesseract).
Words the recognizer joins in stylized fonts ("TAKEIT") are split with an English word list (`assets/ocr/words-en.txt`, from the wordninja package, MIT).
Run the sets with it: `READER=both node ../run-all.cjs` (needs onnxruntime-node and the models, see `tests/harness/evalset.ts`).
Result: 87/102 (85 %) against 82/102 (80 %) with Tesseract alone; extra readings 139 against 66 (many of them real lines that the truth files do not list).
On the Deck (single-thread WASM): detection of a 960x544 picture 0.55 s, a line 0.1 s; a still scene costs almost nothing (the detector runs when the picture changes).

## Where gamescope puts the game (0.4.0)

`calibrateMapping` (worker) compares the frame of the game (Vulkan layer) with the base-plane screenshot of gamescope and decides between stretch / fit / fill / native /
integer. The Steam setting "Scaling mode" changes it (the Deck of the author was on "Stretch": a 1280x720 game on the 1280x800 screen was stretched, not framed).

## Scrolling text (0.4.15)

`playback.cjs <record dir> [hold]` (`ENTRY=playback node build.cjs`) plays a Deck recording through the engine at the times the frames were taken and prints what is
shown every `EVERY` seconds (`SLOW=3` stretches the times of the frames, so that the speed of the PC does not matter; `NOSCROLL=1` switches the scroll memory off:
an A/B comparison). At the end it prints `scroll stats` (texts followed, put back from the memory, remembered, and the scores of the matches: 0.77-1.0 for the same text).

## Motion, clipping, frame rate (0.4.16)

* The helper counts the frame rate of the game from the layer (two counts per frame): `/stats` `game_fps`, header `X-Fps`. The plugin shows it in the panel and lowers the
  automatic level when the rate falls well below its recent best (a game locked at 30 is left alone).
* The worker does not copy a frame that is byte for byte the previous one (`stillFrames` in the perf line).
* The engine measures how fast a text scrolls (`segment.motion`, fractions per second; `sustained` after two moves the same way) and follows lines that the edge of their window
  cuts (`segment.clip`: the visible part; found by the letters: the ink rows of the piece against the upper or the lower part of the remembered patch).
  The overlay slides the plates to the new place (Web Animations, 240 ms) and, for a sustained scroll, a little ahead; a cut plate is drawn inside a box of the visible part.
* `playback.cjs` prints `[CLIP y+h]` and `{vN}` (speed, `s` = sustained) next to a plate.

## 0.4.17: stale plates on the Deck

The recordings of 2026-11-25 (22:xx) showed plates of an earlier scroll position staying 10 s on a still screen. The perf lines of the log say why: single readings take 1-3 s, the
reader (onnxruntime-web, WASM, no proxy inside a worker) runs in the thread of the engine, so the looks that take stale plates away wait. Done: a pause between the lines of a reading,
stale elements go after one or two looks (not three), `lag` (longest time the thread was not free) and `looks` in the perf line. Not done (the real fix): the reader in a worker of its own.
`splittest.cjs` tests the splitting of joined words ("testyour'Iron'skill.Iron").

## 0.5.0: the reader in a worker of its own, layout, recordings

* `src/index.tsx` starts a second worker from the same bundle (`ocr-init`) and joins it to the engine worker by a `MessageChannel`; `engine/worker.ts` (`startOcrWorker`, `startRemoteReader`),
  `ppocr.ts` (`serveReader`, `useRemoteReader`, `abandonRemoteReader`). If the reader worker does not come up in 45 s or three calls in a row get no answer in 20 s, the engine worker loads the models itself (as before).
* `remotetest.cjs <png>`: the answers through a channel equal the local ones; a dead reader is given up and the local models take over.
* `tests/browser/ocrworker.html` (serve the repo root with `python -m http.server`): the real bundle in a Blob worker, onnxruntime-web, in Chromium: ready in 0.7 s, detect 0.4 s, a whole screen read in
  3.2 s, and the page was stalled for 1 ms during it.
* Layout (`src/render.ts`): `linesOf` (the number of lines from the text when the height says 2), `nextAbove`, margins shared with the neighbours, a single line may grow to 3.2x its width, floor of the font 9.5.
  `tests/preview` draws the plates of a recording over its frame (serve `tests/records` with `python -m http.server`, open `<record>/preview.html?n=8&note=8`).
* Notes of a recording (`plates.jsonl`) carry `fps`, `level`, `busy`, `perf` (looks, lag, reading ms, ...) and `mapping`.

## 0.5.1: tiny text (System Shock 2), and an error in Greenlight

* `fixNearWords` (ppocr.ts): a word that is not in the list but one confused letter away from a common word is put right ("Dycle" -> "Cycle", "Seroll" -> "Scroll", "Iist" -> "list"); names
  are left alone. `splittest.cjs` has the cases. The harness now loads the word list like the Deck does (`NOWORDS=1` for the old numbers): 112/129, extra readings 177 (was 201).
* `_continues` (engine.ts): a row shorter than 16 letters is an item of a menu, not the wrapped line of a paragraph ("Back to list" / "Close" were one plate).
* Greenlight: `isReaderShutdownError` (ocr.ts) drops the "Cannot read properties of null (reading 'postMessage')" rejection of tesseract.js that came a moment after the reader was shut down
  (it was shown by the alert of `_app.tsx`); `_app.tsx` also skips a rejection that was already handled and no longer breaks on an empty reason. `shutdowntest.cjs` tests the check.

## 0.5.3: tiny text (System Shock 2) part 2

* The detector (PP-OCR det) looked at the picture shrunk to 960 px: in the terminal of System Shock 2 it found 2 of the 11 lines of a paragraph; at 1280 px (the native width of the Deck) it
  finds all 11, and the lines of the Help window and the subtitles come out clean (`dettest.cjs <png> x y w h`, `SIDES=960,1280`). `setDetMaxSide` in ppocr.ts, default 1280. Reading a cleanly cut
  paragraph with the same reader is nearly perfect (`scaletest.cjs`, `MODE=plain|green|grey|stretch|clahe`): the reader was never the problem, the boxes were.
* When the detector runs in the worker of its own, the budget between two detections is 4x its time (was 10x), `ppocrRemote()`.
* Cut lines (`CLIP_*`): only for text that moves (or has moved lately); the width must match within 15 %; the score of the match 0.7.
* `fixNearWords`: "Ist" -> "list" (a capital I that is a small l, with the i lost), `splittest.cjs`.

## 0.5.4: the first reading of a new screen, the memory of translations

* New screen: the modern reader reads the natural picture without enlarging it (`COLOR_READ_SCALE` 1: 113/129 and 172 extra readings, better than at 2x: 112/129 and 188), a place that the detector found needs one look less before it is read
  (`_need`), a detected place that the modern reader cannot read does not get the three slow classic attempts, the mask of the letters is worked out only for a reading that is kept (`lazyInk`), the share of time for reading
  in the 12 s after a big change is 0.7 (was 0.45), two reader workers read two places at once (`readConcurrency`, `useRemoteReaders`).
* `playback.cjs`: `FREEZE=n` plays one frame, `WARM=6` after a warm start on a black picture, `SPEED=0.49` like a burst, `STATES=1` prints the states of the elements, `OLDNEED=1`, `OLDATTEMPTS=1` switch the new rules off. Prints when the plates first appeared.
* Memory of translations: `src/memory.ts` (`memorytest.cjs`), the backend `memory_get` / `memory_put` (`python tests/backend_memory_test.py`), documented in README.md.

## 0.5.5: no parasitic data

`tests/data_limits_test.py` (memory limits, usage report, clearing that spares the glossary), `tests/helper_retention_test.py` (recordings: keep, size, age; leftovers), `tests/harness/memorystale.ts` (old once-used texts are forgotten).
`bin/dlt_retention.py` holds the logic (the helper starts threads when imported, so it could not be tested). The worker blob addresses are given back when the translator stops; `changeTimes` is capped.

## 0.6.0: languages and the store

* `i18ntest.ts`: every language of the interface has every string with the same `{places}` as English; the language is chosen by the language of Steam (`interfaceLanguageFor`); names of languages come from `Intl.DisplayNames`. `tests/settings_test.py`: first start (fresh, private defaults) and the migration of an older install.
* The frames of games used by the engine tests (`tests/sets/`, `tests/frames/`) are no longer in the repository (`.gitignore`): they stay on the author's machine. The harness uses the author's paths (`GREENLIGHT`, `PPOCR_NODE`); the python tests and `i18ntest` work anywhere.
