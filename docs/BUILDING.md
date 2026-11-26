# Building Live Translator from source

## The plugin (what the Decky store builds)

Needs Node.js 18+ and pnpm 9 (the lockfile is version 9.0).

```
pnpm i
pnpm run build        # = node scripts/build-worker.cjs && rollup -c
```

`scripts/build-worker.cjs` bundles the engine worker (`engine/worker.ts` with the engine files in `engine/vendor/`) into `assets/engine-worker.js` with esbuild; `rollup -c` builds the Steam UI part (`src/index.tsx`) into `dist/index.js`.
Everything the build needs is in the repository (the engine files in `engine/vendor/` are committed; see "Keeping the engine in step with Greenlight" below).

To make an installable zip:

```
python scripts/make_zip.py        # checks main.py/bin with pyflakes, types with tsc, then writes out/Live-Translator-vX.Y.Z.zip
```

## The Vulkan layer (`bin/libVkLayer_dlt.so`)

The layer is a small C program (`layer/dlt_layer.c`) that sits in the game's process and copies the swapchain image into shared memory (`/dev/shm/dlt-<uid>/frame`). It does nothing unless the plugin turns it on, and only in games started by Steam. Its output format is documented at the top of the file.

Build it on Linux x86_64 with gcc and the Vulkan headers (any recent `libvulkan-dev` or Vulkan-Headers):

```
gcc -shared -fPIC -O2 -std=gnu11 -Wall -Wextra -Wno-unused-parameter -fvisibility=hidden \
    layer/dlt_layer.c -o bin/libVkLayer_dlt.so -lpthread
```

The committed binary was built with `scripts/build-layer.py`, which does the same with the zig compiler (`pip install ziglang`) targeting glibc 2.28 so that it runs on SteamOS, and the Vulkan-Headers 1.4.328 release:

```
python scripts/build-layer.py
```

The CI workflow (`.github/workflows/build.yml`) builds the layer from source on every push to show that it compiles; a binary built there is not byte-for-byte equal to the committed one (compilers differ), but it is built from the same file.

The layer's dependencies are glibc and libpthread (dynamic): the plugin therefore needs testing on the SteamOS *Preview* branch as well as Stable (the Decky store rule for pre-built binaries).

## Keeping the engine in step with Greenlight (developers only)

`engine/vendor/*.ts` are copies of the files of Greenlight's screen translator (`packages/desktop/renderer/lib/translator/`), patched for a worker by `scripts/sync-engine.cjs`:

```
node scripts/sync-engine.cjs     # needs a Greenlight checkout next to this one (E:/Greenlight in the author's setup; edit the path in the script)
```

Users and the store never run this: the copies are in the repository.

## Tests

```
python tests/backend_memory_test.py        # memory of translations: the backend
python tests/data_limits_test.py           # limits of what is kept on the card
python tests/helper_retention_test.py      # recordings and leftovers
python tests/settings_test.py              # settings and their migration
cd tests/harness && ENTRY=i18ntest node build.cjs && node i18ntest.cjs     # every language has every string
```

The engine is tested on frames recorded on a Steam Deck: see `tests/README.md` (`run-all`, `playback`, `seqtest` and others). The recorded frames of games are **not** part of the public repository.
