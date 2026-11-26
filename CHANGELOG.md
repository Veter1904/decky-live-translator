# Changelog

## 0.6.2

- **The plugin no longer reads its own plates** (the frames of the screen hold them): a line whose letters and digits take turns ("Bawa no3nuin!", "6epe3H9", a Ukrainian plate read as English) is not text, and a new piece of text found inside a plate that is drawn over the game is the plate, not a text of the game. Before, such readings made new elements and new plates over paragraphs.
- **Windows with long paragraphs (a story, a log, a description) are less noisy:** one text has one plate. A paragraph that is found at several sizes (the paragraph, its lines, a piece of a line) no longer gets a plate for each: the part that is inside a bigger plate and has its words goes, and so do broken pieces ("and cattlac", "ta An a") and the worse of two readings of the same text. On a test window of paragraphs (scrolled, closed, opened again) the extra plates of the regression set went from 164 to 131 with the same recall.
- **Recordings for the developer:** the last 12 (400 MB together, 7 days) are kept instead of 2. The limit of 2 removed recordings before they were looked at.

## 0.6.1

- **Fix (0.5.5-0.6.0): the frames of the game were lost after the translator was restarted while the game ran.** The helper removed the shared frame file when it stopped; a game that was running kept writing into the removed file, so the next start found no frames and fell back to the whole screen (with the plates and the Steam interface in it: stale plates, text of the Steam interface read). The file is no longer removed, and the Vulkan layer now notices when its file was removed or replaced and opens it again (a game started with this version recovers by itself; a game that is running now needs one restart).
- A panel hint (in orange) when the game frames are not available and the whole screen is read.
- Frames of the screen: a change of the picture is looked for in the picture without our own plates, and a clean picture is asked for within a second of a big change (before: up to 3.5 s), so stale plates go sooner.

## 0.6.0 (the first version prepared for the Decky store)

- **Interface in 13 languages** (English, Ukrainian, Russian, German, French, Spanish, Italian, Brazilian Portuguese, Polish, Turkish, Chinese, Japanese, Korean). The language follows Steam; a picker in *Advanced* changes it. The translations are machine-assisted and not yet reviewed by native speakers.
- **57 languages to translate into** (every language that has a local model); names of languages come in the language of the interface. A first start translates into the language of Steam.
- **Private by default:** a new install uses the local translator only. *Smart* and *Online* send the recognised text to Google Translate / MyMemory and are chosen by the player; the panel says so. Existing installs keep their choice and the Ukrainian interface.
- Store packaging: `plugin.json` (no debug flag), README (English, Ukrainian), `THIRD_PARTY_NOTICES.md`, `docs/BUILDING.md`, a build workflow, the store image.
- What the plugin keeps on the device is limited and can be cleared from the panel (recordings, memory of translations); see the README.

## 0.5.x

- A modern text reader (PP-OCR) in two workers of its own; plates that follow scrolling text and lines cut by the edge of a window; faster first reading of a new screen; memory of translations per game with a glossary; frame-rate guard; fewer wrong plates.

## 0.4.x and earlier

- Automatic mode, the local translator (Bergamot), the Vulkan layer for clean game frames, screen mapping, per-profile effort.
