# Third-party components

Live Translator is MIT-licensed (see `LICENSE`). It includes or downloads the components below. None of them is modified here except where it says so.

## Included in the plugin

| Component | What it is used for | License | Source |
|---|---|---|---|
| **onnxruntime-web** 1.20.1 | runs the text-recognition models in WebAssembly (`assets/ort/`) | MIT (Microsoft) | https://github.com/microsoft/onnxruntime |
| **PP-OCRv4 detection and recognition models**, in the ONNX form of RapidOCR; `keys.txt` is `ppocr_keys_v1.txt` | finds and reads text (`assets/ocr/det.onnx`, `rec.onnx`, `keys.txt`) | Apache-2.0 (PaddlePaddle / PaddleOCR) | https://github.com/PaddlePaddle/PaddleOCR , https://huggingface.co/SWHL/RapidOCR |
| **Tesseract.js** 6.0.1, the Tesseract core (WebAssembly) and `eng.traineddata` (tessdata_fast) | reads text that PP-OCR cannot, and other languages (`assets/tesseract/`) | Apache-2.0 | https://github.com/naptha/tesseract.js , https://github.com/tesseract-ocr/tesseract , https://github.com/tesseract-ocr/tessdata_fast |
| **Bergamot translator** 0.4.9 (WebAssembly build from the npm package `@browsermt/bergamot-translator`) | translation on the device (`assets/bergamot/`) | MPL-2.0 | https://github.com/browsermt/bergamot-translator |
| **English word list** from the `wordninja` package | splits words that were read joined, scores how word-like a reading is, puts right confused letters (`assets/ocr/words-en.txt`) | MIT | https://github.com/keredson/wordninja |
| **Greenlight** (the screen translator: scout, elements, plates, readers), files in `engine/vendor/` | the engine of the plugin began as, and is kept in step with, Greenlight's translator | MIT (unknownskl) | https://github.com/unknownskl/greenlight |
| **react-icons** | the icon of the plugin | MIT | https://github.com/react-icons/react-icons |
| **@decky/api**, **@decky/ui**, tslib | the Decky Loader frontend API (provided by Decky Loader at run time) | see their packages | https://github.com/SteamDeckHomebrew |
| **decky-plugin-template** | the scaffolding (`plugin.json`, `rollup.config.js` and so on) | BSD-3-Clause, notice kept in `LICENSE` | https://github.com/SteamDeckHomebrew/decky-plugin-template |

## Downloaded when you use the plugin

| What | From | Notes |
|---|---|---|
| Translation models of a language pair (Firefox Translations / Bergamot) | `firefox-settings-attachments.cdn.mozilla.net` (Mozilla Remote Settings), listed in `assets/models-registry.json` | Made and licensed by Mozilla and its partners; see https://github.com/mozilla/firefox-translations-models for the license of each model. They are downloaded to your device, not redistributed in this repository. |
| Tesseract reading data for a language other than English | `tessdata.projectnaptha.com` | Apache-2.0 (tessdata_fast) |

## Online translators (only in the *Smart* and *Online* modes)

The recognised text is sent to `translate.googleapis.com` (the public web endpoint of Google Translate) and, when it does not answer, to `api.mymemory.translated.net` (MyMemory). These are third-party services under their own terms; the plugin has no key for either.

## Used to build, not shipped

- **Vulkan-Headers** (Apache-2.0 / MIT, https://github.com/KhronosGroup/Vulkan-Headers) to compile `layer/dlt_layer.c` into `bin/libVkLayer_dlt.so` (see `docs/BUILDING.md`).
- Build tools: pnpm, rollup, esbuild, TypeScript.

## The binary in `bin/`

`bin/libVkLayer_dlt.so` is built from `layer/dlt_layer.c` in this repository (a Vulkan layer that copies the game's frames into shared memory). The command that builds it, and the compiler it was built with, are in `docs/BUILDING.md`; `scripts/build-layer.py` runs it.

## Images

`docs/store-image.png` is drawn by `scripts/make_store_image.py`; it shows no game.
