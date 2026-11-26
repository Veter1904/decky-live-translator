# Submitting Live Translator to the Decky Plugin Store

What the Decky team asks for is on https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins and https://wiki.deckbrew.xyz/en/plugin-dev/review-and-testing (read on 2026-11-26). This file says where the plugin stands against it.

## Blockers (decide before submitting)

1. ~~**The repository must be public.**~~ Done on 2026-11-26: `Veter1904/decky-live-translator` is public (with a fresh, single-commit history; see below).
2. **The LLM rule.** The wiki says: *"No. We do not accept any plugin that uses any LLM based code ... Any LLM focused plugins will be rejected outright and there will be no appeals."*
   - The plugin does not use a large language model at run time: text is read by PP-OCR (a small recognition network) and Tesseract, translated by Bergamot (a neural machine-translation engine) or by Google/MyMemory.
   - But the plugin was written with the help of an AI coding assistant (the commit history carries `Co-Authored-By: Claude` trailers, and the README says so). The rule's wording ("uses any LLM based code") can be read as covering that. **Ask the Decky team (their Discord, or an issue in decky-plugin-database) before spending a review slot**, say plainly how the code was made, and abide by the answer. Do not hide it.
3. **Testing on SteamOS Preview.** The plugin has a custom pre-built binary with dynamic dependencies (`bin/libVkLayer_dlt.so`, glibc) and a custom Python helper using the system GStreamer: that is "Plugin Backend Checklist" case A, which must be tested without breaking problems on the **Preview** branch at least (Stable and Beta too if possible). Someone with a Deck must do it and comment on the testing PR.
4. **The `root` flag.** `plugin.json` has `"flags": ["root"]`. The backend runs the capture helper in the user's session (it drops to the user), installs the Vulkan layer manifest in the user's home and gives the user the files it makes. It has **not** been tested whether the plugin works without root. Try removing the flag on a Deck (install the zip, translate a game, use the memory buttons); if it works, remove the flag: a plugin that does not need root is easier to approve.

## Checklist from the review process

| Step | Status |
|---|---|
| Submodule in `.gitmodules` and `plugins/<name>` of a fork of decky-plugin-database | to do at submission |
| `package.json`: no `remote-binary`; the package name follows npm rules | ok (`decky-live-translator`, no remote-binary) |
| `pnpm-lock.yaml` has `lockfileVersion: '9.0'` | ok |
| No remote code; every URL is explained | ok: see "Privacy and network" in the README (Mozilla CDN for models, Google and MyMemory for online translation, tessdata server for other reading languages, 127.0.0.1 for the helper) |
| Files the plugin needs that are not in `defaults/` | none: it has no `defaults/` |
| Unused `backend/`, `assets/`, `defaults/` | `assets/` is used (models, workers, wasm); there is no `backend/` or `defaults/` |
| License file | `LICENSE` (MIT, with the template's BSD-3-Clause notice kept) |
| Pre-built binaries have source and build instructions | `bin/libVkLayer_dlt.so` from `layer/dlt_layer.c` (`docs/BUILDING.md`, `scripts/build-layer.py`, CI builds it). The WebAssembly files and models are third-party builds listed in `THIRD_PARTY_NOTICES.md` with their sources and licenses |
| Obfuscation | none; `assets/engine-worker.js` and `dist/index.js` are bundles made by `pnpm run build` from the sources in the repository (the minified third-party files are named in the notices) |
| Version bumped in `package.json` | 0.6.2 |
| Monetization | none |
| Ethical items (keyshops) | none |

## When the repository was made public (2026-11-26)

- The old history held frames of commercial games (`tests/sets`, `tests/frames`, about 48 MB) and the author's LAN address and test paths, so the public repository starts from **one new commit** with the current tree (no frames, no one-off patch scripts, no machine paths). The old history is kept by the author in a git bundle on their machine. The `Co-Authored-By: Claude` trailer is kept on the commits made from then on; the README says how the plugin was made.
- Test frames of games are not published; see `tests/README.md`.

## Text for the pull request to `decky-plugin-database`

> **Live Translator** - automatic, live translation of on-screen game text.
> Reads the game's own frames (a small Vulkan layer built from `layer/dlt_layer.c`), finds text with PP-OCR / Tesseract (WebAssembly in the Steam UI workers) and translates it on the device with Bergamot models (downloaded once from Mozilla's CDN); online translation is optional. 13 interface languages.
>
> - Custom backend: Python (`main.py`) plus a helper `bin/dlt_capture.py` that runs with the system `python3` (GStreamer, PipeWire); a pre-built Vulkan layer `bin/libVkLayer_dlt.so` (glibc, dynamic), source `layer/dlt_layer.c`, build in `docs/BUILDING.md` and in CI. So it needs testing on **Preview**.
> - Network: see the README "Privacy and network" table. Pictures never leave the device.
> - `root` flag: (state the result of the test above).
> - **AI disclosure:** the code was written with an AI coding assistant under the author's direction and testing; the plugin does not use an LLM at run time. We know about the store's LLM rule and ask the team to decide.
> - Data kept on the device and its limits: README, "What the plugin keeps on the device".
