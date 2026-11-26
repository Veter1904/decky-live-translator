import asyncio
import json
import os
import pwd
import shutil
import ssl
import subprocess
import time
import urllib.parse
import urllib.request

import decky
import sys

CAPTURE_PORT = 47821
HELPER = os.path.join(decky.DECKY_PLUGIN_DIR, "bin", "dlt_capture.py")
sys.path.insert(0, os.path.join(decky.DECKY_PLUGIN_DIR, "bin"))
import dlt_retention  # noqa: E402

# What the memory of translations may take together (a file is kept for every game): the least lately used files go first
MEMORY_MAX_FILES = 40
MEMORY_MAX_BYTES = 40 * 1000 * 1000


_cache: dict = {}

LAYER_SO = os.path.join(decky.DECKY_PLUGIN_DIR, "bin", "libVkLayer_dlt.so")


def _layer_paths() -> tuple:
    home = decky.DECKY_USER_HOME
    return (os.path.join(home, ".local", "share", "dlt"), os.path.join(home, ".local", "share", "vulkan", "implicit_layer.d", "dlt_capture.json"))


def install_layer() -> bool:
    """The Vulkan layer that hands the game's frames to the helper: a library and a manifest in the user's Vulkan layer folder (the same
    place Steam keeps its own layers). It only does something in a game started by Steam, while the helper asks for frames."""
    if not os.path.exists(LAYER_SO):
        return False
    folder, manifest = _layer_paths()
    try:
        uid = pwd.getpwnam(decky.DECKY_USER).pw_uid
    except KeyError:
        uid = -1
    try:
        os.makedirs(folder, exist_ok=True)
        os.makedirs(os.path.dirname(manifest), exist_ok=True)
        target = os.path.join(folder, "libVkLayer_dlt.so")
        shutil.copyfile(LAYER_SO, target + ".new")
        os.chmod(target + ".new", 0o755)
        os.replace(target + ".new", target)   # a running game keeps its mapped copy of the old file
        with open(manifest, "w", encoding="utf-8") as f:
            json.dump({"file_format_version": "1.0.0", "layer": {
                "name": "VK_LAYER_DLT_capture", "type": "GLOBAL", "library_path": target, "api_version": "1.3.0", "implementation_version": "1",
                "description": "Decky Live Translator: hands the game's frames to the translator",
                "functions": {"vkNegotiateLoaderLayerInterfaceVersion": "vkNegotiateLoaderLayerInterfaceVersion"},
                "disable_environment": {"DLT_DISABLE": "1"}}}, f, indent=1)
        if uid >= 0:
            for path in (folder, target, manifest):
                os.chown(path, uid, -1)
        return True
    except OSError as e:
        decky.logger.warning("layer not installed: %s", e)
        return False


def remove_layer() -> None:
    folder, manifest = _layer_paths()
    for path in (manifest, os.path.join(folder, "libVkLayer_dlt.so")):
        try:
            os.remove(path)
        except OSError:
            pass

# A new install translates on the device only ("local": nothing leaves it but the download of the model); "smart" and "online" send the recognised text to online translators and are chosen by the player.
# `ui_language`: "auto" is the language of Steam.
DEFAULT_SETTINGS = {"enabled": False, "source": "en", "target": "uk", "profile": "auto", "debug": False, "layer": True, "translator": "local", "reader": "modern", "ui_language": "auto", "version": 7}


def _ssl_context() -> ssl.SSLContext:
    """Decky's own Python has no root certificates: use the ones of the system (SteamOS keeps them in /etc/ssl)."""
    for cafile in ("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/ca-certificates/extracted/tls-ca-bundle.pem"):
        if os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


_SSL = _ssl_context()


def _http_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) LiveTranslator"})
    with urllib.request.urlopen(request, timeout=8, context=_SSL) as response:
        return json.loads(response.read().decode("utf-8"))


def _google(text: str, source: str, target: str) -> str:
    query = urllib.parse.urlencode({"client": "gtx", "sl": source, "tl": target, "dt": "t", "q": text})
    data = _http_json("https://translate.googleapis.com/translate_a/single?" + query)
    return "".join(part[0] or "" for part in data[0]).strip()  # type: ignore[index]


def _mymemory(text: str, source: str, target: str) -> str:
    query = urllib.parse.urlencode({"q": text[:480], "langpair": source + "|" + target})
    data = _http_json("https://api.mymemory.translated.net/get?" + query)
    translated = data["responseData"]["translatedText"]  # type: ignore[index]
    if not translated or translated.upper().startswith("MYMEMORY WARNING"):
        raise RuntimeError("mymemory quota")
    return translated


def _translate_sync(text: str, source: str, target: str) -> str:
    text = (text or "").strip()[:1500]
    if not text or source == target:
        return text
    key = source + "|" + target + "|" + text
    if key in _cache:
        return _cache[key]
    errors = []
    for attempt in range(2):
        for service in (_google, _mymemory):
            try:
                result = service(text, source, target)
                if result:
                    if len(_cache) > 800:
                        _cache.pop(next(iter(_cache)))
                    _cache[key] = result
                    return result
                errors.append("%s: empty" % service.__name__)
            except Exception as e:  # noqa: BLE001
                errors.append("%s: %s: %s" % (service.__name__, type(e).__name__, e))
        time.sleep(0.4)
    raise RuntimeError("translation failed for %r: %s" % (text[:40], "; ".join(errors[-4:])))


# ---- The local translator: models of Bergamot / Marian (the Firefox translator), downloaded once, ~35 MB for a language pair ----
import hashlib
import threading

REGISTRY_PATH = os.path.join(decky.DECKY_PLUGIN_DIR, "assets", "models-registry.json")
PIVOT = "en"
_models = {"state": "idle", "progress": 0.0, "error": "", "pairs": []}
_models_lock = threading.Lock()


def models_dir() -> str:
    return os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "models")


def _registry() -> dict:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def pairs_for(source: str, target: str) -> list:
    """The model pairs a translation needs: one direct pair, or two through English; [] when the languages have no models."""
    registry = _registry()
    if not source or not target or source == target:
        return []
    if source + target in registry:
        return [source + target]
    if source + PIVOT in registry and PIVOT + target in registry:
        return [source + PIVOT, PIVOT + target]
    return []


def _pair_files(pair: str) -> dict:
    entry = _registry().get(pair, {})
    out = {}
    for part, (url, size, sha) in entry.items():
        out["vocab" if part in ("vocab", "srcvocab") else part] = (url, size, sha)
    return out


def _pair_installed(pair: str) -> bool:
    files = _pair_files(pair)
    return bool(files) and all(os.path.isfile(os.path.join(models_dir(), pair, part)) for part in files)


def _download(url: str, dest: str, sha: str, done) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) LiveTranslator"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=30, context=_SSL) as response, open(dest + ".part", "wb") as out:
        while True:
            chunk = response.read(1 << 18)
            if not chunk:
                break
            out.write(chunk)
            digest.update(chunk)
            done(len(chunk))
    if sha and digest.hexdigest().lower() != sha.lower():
        os.remove(dest + ".part")
        raise RuntimeError("the downloaded file is damaged: " + os.path.basename(dest))
    os.chmod(dest + ".part", 0o644)
    os.replace(dest + ".part", dest)


def _install_models_sync(pairs: list) -> None:
    try:
        todo = [(pair, part, info) for pair in pairs if not _pair_installed(pair) for part, info in _pair_files(pair).items()
                if not os.path.isfile(os.path.join(models_dir(), pair, part))]
        total = sum(info[1] for _, _, info in todo) or 1
        loaded = [0]

        def done(n: int) -> None:
            loaded[0] += n
            _models["progress"] = min(1.0, loaded[0] / total)

        os.makedirs(models_dir(), exist_ok=True)
        os.chmod(models_dir(), 0o755)
        for pair, part, (url, _size, sha) in todo:
            _download(url, os.path.join(models_dir(), pair, part), sha, done)
            os.chmod(os.path.join(models_dir(), pair), 0o755)
        _models.update(state="ready", progress=1.0, error="")
    except Exception as e:  # noqa: BLE001
        decky.logger.error("models download failed: %s", e)
        _models.update(state="error", error="%s: %s" % (type(e).__name__, e))


class Plugin:
    proc = None

    def _settings_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    async def get_settings(self) -> dict:
        settings = dict(DEFAULT_SETTINGS)
        saved: dict = {}
        try:
            with open(self._settings_path(), "r", encoding="utf-8") as f:
                saved = json.load(f)
            settings.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
        except (OSError, ValueError):
            pass
        if not saved:
            # a first start: the plugin sets the language of the translation from the language of Steam
            settings["fresh"] = True
        if saved and saved.get("version", 1) < 6:
            # settings of older builds: the Vulkan layer is on (version 2), the local translator is the default (version 3)
            if saved.get("version", 1) < 2:
                settings["layer"] = True
            if saved.get("version", 1) < 5 and saved.get("profile", "balanced") == "balanced":
                settings["profile"] = "auto"
            if saved.get("version", 1) < 6 and saved.get("translator", "local") == "local":
                settings["translator"] = "smart"
            settings["version"] = 6
            try:
                os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
                with open(self._settings_path(), "w", encoding="utf-8") as f:
                    json.dump(settings, f)
            except OSError:
                pass
        if saved and saved.get("version", 1) < 7:
            # an install that was made before the languages of the interface: it keeps the language it showed (Ukrainian) and the translator it used
            if "ui_language" not in saved:
                settings["ui_language"] = "uk"
            if "translator" not in saved:
                settings["translator"] = "smart"
            settings["version"] = 7
            try:
                os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
                with open(self._settings_path(), "w", encoding="utf-8") as f:
                    json.dump({k: v for k, v in settings.items() if k in DEFAULT_SETTINGS}, f)
            except OSError:
                pass
        return settings

    async def set_settings(self, patch: dict) -> dict:
        settings = await self.get_settings()
        settings.pop("fresh", None)
        settings.update({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
        try:
            os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
            with open(self._settings_path(), "w", encoding="utf-8") as f:
                json.dump(settings, f)
        except OSError as e:
            decky.logger.warning("settings not saved: %s", e)
        return settings

    # ---- The memory of translations of a game: what was translated is kept, so that the same text is translated at once and the same way next time ----
    @staticmethod
    def _memory_path(game: str) -> str:
        safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in str(game))[:40] or "unknown"
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "memory", safe + ".json")

    @staticmethod
    def _read_memory(path: str) -> dict:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
        return {}

    async def memory_get(self, game: str) -> dict:
        """What is kept for a game: {name, entries, glossary}. The glossary is a file the player may edit by hand."""
        data = self._read_memory(self._memory_path(game))
        entries = data.get("entries") if isinstance(data.get("entries"), dict) else {}
        glossary = data.get("glossary") if isinstance(data.get("glossary"), dict) else {}
        return {"name": str(data.get("name", "")), "entries": entries, "glossary": glossary}

    async def memory_put(self, game: str, name: str, entries: dict) -> bool:
        """Writes the translations of a game; the glossary that is in the file stays as it is (it is not ours to change)."""
        path = self._memory_path(game)
        try:
            folder = os.path.dirname(path)
            os.makedirs(folder, exist_ok=True)
            data = self._read_memory(path)
            glossary = data.get("glossary") if isinstance(data.get("glossary"), dict) else {}
            payload = {"name": name, "glossary": glossary, "entries": entries}
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, path)
            dlt_retention.prune_files(folder, MEMORY_MAX_FILES, MEMORY_MAX_BYTES, keep=path)
            # the player edits the glossary: the folder and the file are his
            try:
                shutil.chown(folder, user=decky.DECKY_USER)
                shutil.chown(path, user=decky.DECKY_USER)
            except Exception:
                pass
            return True
        except OSError as e:
            decky.logger.error("memory not saved: %s" % e)
            return False

    @staticmethod
    def _records_dir() -> str:
        return os.path.join(decky.DECKY_USER_HOME, "dlt-records")

    async def data_usage(self) -> dict:
        """What the plugin keeps on the card besides itself: the recordings made for the developer, and the memory of translations."""
        folder = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "memory")
        memory_bytes, memory_files = dlt_retention.folder_usage(folder)
        return {"records_bytes": dlt_retention.dir_bytes(self._records_dir()), "records_count": dlt_retention.count_recordings(self._records_dir()), "records_keep": dlt_retention.RECORD_KEEP,
                "memory_bytes": memory_bytes, "memory_games": memory_files}

    async def clear_records(self) -> bool:
        dlt_retention.clear_recordings(self._records_dir())
        return True

    async def clear_memory(self) -> bool:
        """The kept translations are removed; a glossary that the player wrote stays (a file without a glossary is removed)."""
        folder = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "memory")
        try:
            names = os.listdir(folder)
        except OSError:
            return True
        for name in names:
            path = os.path.join(folder, name)
            if not os.path.isfile(path):
                continue
            data = self._read_memory(path)
            glossary = data.get("glossary") if isinstance(data.get("glossary"), dict) else {}
            try:
                if glossary:
                    with open(path, "w", encoding="utf-8") as f:
                        json.dump({"name": data.get("name", ""), "glossary": glossary, "entries": {}}, f, ensure_ascii=False)
                else:
                    os.remove(path)
            except OSError:
                pass
        return True

    async def translate(self, text: str, source: str = "en", target: str = "uk") -> str:
        """Free key-less online translation (Google, MyMemory as fallback); the frontend cannot call them itself (CORS)."""
        try:
            return await asyncio.get_event_loop().run_in_executor(None, _translate_sync, text, source, target)
        except Exception as e:  # noqa: BLE001
            decky.logger.warning("translate: %s", e)
            raise

    def _running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def models_status(self, source: str = "en", target: str = "uk") -> dict:
        """Which models the language pair needs, and whether they are on the device (state: idle / downloading / ready / error / unsupported)."""
        pairs = pairs_for(source, target)
        have = bool(pairs) and all(_pair_installed(pair) for pair in pairs)
        state = _models["state"]
        if not pairs:
            state = "unsupported"
        elif have:
            state = "ready"
        elif state == "ready":
            state = "idle"
        return {"state": state, "progress": _models["progress"], "error": _models["error"], "pairs": pairs, "installed": have,
                "bytes": sum(info[1] for pair in pairs for info in _pair_files(pair).values())}

    async def install_models(self, source: str = "en", target: str = "uk") -> dict:
        """Starts the download of the models of a language pair (in a thread; progress through models_status)."""
        pairs = pairs_for(source, target)
        with _models_lock:
            if pairs and _models["state"] != "downloading" and not all(_pair_installed(pair) for pair in pairs):
                _models.update(state="downloading", progress=0.0, error="")
                threading.Thread(target=_install_models_sync, args=(pairs,), daemon=True).start()
        return await self.models_status(source, target)

    async def start_capture(self, fps: float = 4, width: int = 1280, height: int = 720, layer: bool = False) -> dict:
        """Starts the capture helper (system python3, as the normal user so it can reach the user's PipeWire)."""
        if self._running():
            return {"running": True, "port": CAPTURE_PORT, "already": True}
        # A helper left over from an older version (or from before a restart of Decky) would hold the port: ask it to stop
        def stop_stale() -> None:
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/quit" % CAPTURE_PORT, timeout=1).read()
                time.sleep(0.5)
            except Exception:  # noqa: BLE001
                pass
        await asyncio.get_event_loop().run_in_executor(None, stop_stale)
        # The game's own frames through the Vulkan layer (a game started after this takes the layer; one that runs already uses PipeWire)
        if layer:
            installed = install_layer()
            decky.logger.info("vulkan layer %s", "installed" if installed else "NOT installed")
        else:
            remove_layer()
        kwargs = {}
        if os.getuid() == 0:
            kwargs.update(user=1000, group=1000, extra_groups=[])
        env = dict(os.environ, XDG_RUNTIME_DIR="/run/user/1000", HOME=decky.DECKY_USER_HOME, DLT_MODELS=models_dir())
        try:
            self.proc = subprocess.Popen(
                ["/usr/bin/python3", HELPER, str(CAPTURE_PORT), str(fps), str(width), str(height)],
                stdout=open(os.path.join(decky.DECKY_PLUGIN_LOG_DIR, "capture.log"), "ab"),
                stderr=subprocess.STDOUT, env=env, **kwargs)
        except Exception as e:  # noqa: BLE001
            decky.logger.error("capture start failed: %s", e)
            return {"running": False, "error": str(e)}
        decky.logger.info("capture helper started pid=%s fps=%s %sx%s", self.proc.pid, fps, width, height)
        return {"running": True, "port": CAPTURE_PORT, "pid": self.proc.pid}

    async def stop_capture(self) -> dict:
        if self._running():
            self.proc.terminate()
            try:
                await asyncio.get_event_loop().run_in_executor(None, lambda: self.proc.wait(timeout=5))
            except Exception:  # noqa: BLE001
                self.proc.kill()
            decky.logger.info("capture helper stopped")
        self.proc = None
        return {"running": False}

    async def capture_status(self) -> dict:
        return {"running": self._running(), "port": CAPTURE_PORT}

    async def log(self, message: str) -> None:
        """Frontend diagnostics (no remote debugging needed): written to the plugin log."""
        decky.logger.info("[ui] %s", message)

    async def _main(self):
        decky.logger.info("Live translator loaded (uid=%s)", os.getuid())
        # The Vulkan layer is in place before any game starts (it does nothing while the helper is not running), so a game that is
        # started first and translated later still gives its own frames
        settings = await self.get_settings()
        if settings.get("layer", True):
            decky.logger.info("vulkan layer %s", "installed" if install_layer() else "NOT installed")
        else:
            remove_layer()

    async def _unload(self):
        await self.stop_capture()
        decky.logger.info("Live translator spike unloaded")

    async def _uninstall(self):
        await self.stop_capture()
        remove_layer()
