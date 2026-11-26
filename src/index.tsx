import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, Router, ToggleField, findModuleChild } from "@decky/ui";
import { callable, definePlugin, routerHook } from "@decky/api";
import { TranslationMemory, MemoryFile } from "./memory";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, UI_LANGUAGES, languageOptions, setUiLanguage, steamLanguage, t } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FaLanguage } from "react-icons/fa";
import { ElementResult, dropCovered, linesOf, nextAbove, nextBelow, segmentStyle, sideLimits, sizeCaps } from "./render";
import { LocalTranslator } from "./local";

const startCapture = callable<[fps: number, width: number, height: number, layer: boolean], { running: boolean; port?: number; error?: string }>("start_capture");
const stopCapture = callable<[], { running: boolean }>("stop_capture");
const captureStatus = callable<[], { running: boolean; port: number }>("capture_status");
const translateText = callable<[text: string, source: string, target: string], string>("translate");
type ModelsStatus = { state: "idle" | "downloading" | "ready" | "error" | "unsupported"; progress: number; error: string; pairs: string[]; installed: boolean; bytes: number };
const modelsStatus = callable<[source: string, target: string], ModelsStatus>("models_status");
const installModels = callable<[source: string, target: string], ModelsStatus>("install_models");
const logBackend = callable<[message: string], void>("log");
const getSettings = callable<[], Settings>("get_settings");
const memoryGet = callable<[game: string], MemoryFile>("memory_get");
const dataUsage = callable<[], { records_bytes: number; records_count: number; records_keep: number; memory_bytes: number; memory_games: number }>("data_usage");
const clearRecords = callable<[], boolean>("clear_records");
const pluginVersion = callable<[], string>("plugin_version");
const clearMemory = callable<[], boolean>("clear_memory");
const memoryPut = callable<[game: string, name: string, entries: Record<string, unknown>], boolean>("memory_put");
const setSettingsBackend = callable<[patch: Partial<Settings>], Settings>("set_settings");

type Settings = { enabled: boolean; source: string; target: string; profile: "auto" | "battery" | "balanced" | "quality"; debug: boolean; layer: boolean; translator: "smart" | "local" | "online"; reader: "modern" | "classic"; ui_language: string; developer?: boolean; fresh?: boolean; version?: number };
// How much the translator may take: capture rate, share of the time for reading, how often the clean picture of the game is asked for
const PROFILES = {
  // `burst`: the share of the time for reading in the 12 s after the picture has changed much (a new screen is read: the faster the better). The reader is in a thread of its own,
  // and the frame rate of the game guards the game (see autoStep), so a new screen may be read at a high share.
  battery: { fps: 2, duty: 0.15, burst: 0.3, peek: 6000, speed: 1 },
  balanced: { fps: 3, duty: 0.3, burst: 0.7, peek: 3500, speed: 0.7 },
  quality: { fps: 4, duty: 0.5, burst: 0.85, peek: 2500, speed: 0.5 },
};
type Level = "battery" | "balanced" | "quality";
// The automatic mode: how much text changes decides how hard the translator works (see autoStep)
let autoLevel: Level = "balanced";
let autoCalmSince = 0;
const changeTimes: number[] = [];
// How much of the time the engine's reading took in the last 5 seconds (1 = one whole core): the limit of the automatic mode
let busyShare = 0;
// The frame rate of the game (the helper counts it from the layer), the best it was lately, and since when it has been much lower than that
let gameFps = 0;
// The last report of the worker about its work, kept in the notes of a recording (the lag of the thread, how many looks, how long the reading took)
let lastPerf: Record<string, number> = {};
// The report of the worker comes every 5 s; it is written to the log every 30 s (a log file grows with it)
let perfLogCount = 0;
// When the worker last said that the picture changed much (frames of the screen: a clean picture is asked for at once, not at the usual time)
let sceneAt = 0;
let fpsTop = 0;
let fpsLowSince = 0;
let busyHighSince = 0;
let governorUntil = 0;
const LEVEL_ORDER: Record<Level, number> = { battery: 0, balanced: 1, quality: 2 };
/** What the engine says about itself, in the language of the interface. */
function engineStatus(status: string): string {
  if (status === "loading") return t("engine.loading");
  if (status === "ready") return t("engine.ready");
  if (status === "error") return t("engine.error");
  if (status === "modern reader ready") return t("engine.modern");
  return status;
}
function levelName(level: Level): string { return t(`level.${level}` as const); }
// How many readings may go on at the same time: two, unless the battery is to be spared or the game is slowing down
let readersNow = 2;
function readerCount(): number {
  const level = settings.profile === "auto" ? autoLevel : settings.profile;
  return level === "battery" || readersNow < 2 ? 1 : 2;
}
function megabytes(bytes: number): string { return bytes < 1e5 ? Math.max(1, Math.round(bytes / 1e3)) + " " + t("unit.kb") : (bytes / 1e6).toFixed(1) + " " + t("unit.mb"); }
function activeProfile() { return settings.profile === "auto" ? PROFILES[autoLevel] : (PROFILES[settings.profile as Level] || PROFILES.balanced); }
let settings: Settings = { enabled: false, source: "en", target: "uk", profile: "auto", debug: false, layer: true, translator: "smart", reader: "modern", ui_language: "auto", developer: false, version: 7 };

const BASE = "http://127.0.0.1:47821";
const FRAME_W = 1280;
const FRAME_H = 800;
const log = (m: string) => { console.log("[dlt] " + m); void logBackend(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the store the overlay and the panel share (module level) ----
type DebugFrame = { rect: { x: number; y: number; w: number; h: number }; state: string; role: string };
type Store = { results: ElementResult[]; running: boolean; status: string; elements: number; peek: boolean; frames: DebugFrame[]; frame: { w: number; h: number; source: string }; qam: boolean; localInfo: string; autoInfo: string; mapping: { key: string; area: { x: number; y: number; w: number; h: number } } | null };
let store: Store = { results: [], running: false, status: "", elements: 0, peek: false, frames: [], frame: { w: 0, h: 0, source: "" }, qam: false, localInfo: "", autoInfo: "", mapping: null };
const listeners = new Set<() => void>();
function setStore(patch: Partial<Store>) { store = { ...store, ...patch }; listeners.forEach((l) => l()); }
function useStore(): Store {
  const [s, set] = useState(store);
  useEffect(() => {
    const l = () => set(store);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  return s;
}

// The places of our own plates on screen (pixels): the engine must not read its own translation
let plateMasks: Array<[number, number, number, number]> = [];

// The hook that asks Steam to composite its UI over the running game
const useComposition: ((level: number) => void) | undefined = findModuleChild((m: any) => {
  if (typeof m !== "object") return undefined;
  for (const prop in m) {
    const f = m[prop];
    if (typeof f === "function") {
      const s = f.toString();
      if (s.includes("AddMinimumCompositionStateRequest") && s.includes("ChangeMinimumCompositionStateRequest") && s.includes("RemoveMinimumCompositionStateRequest") && !s.includes("m_mapCompositionStateRequests")) return f;
    }
  }
  return undefined;
});

/** The cover of a plate: a patch in the colour of the interface that hides the original text. */
function renderCover(item: { key: string; segment: any }, vp: { width: number; height: number }, mark: boolean) {
  const pad = Math.max(6, item.segment.rect.h * vp.height * 0.35);
  const [r, g, b] = item.segment.background;
  // The patch never hides the picture of a button or an icon next to the text
  const stopLeft = item.segment.stopLeft === undefined ? -Infinity : item.segment.stopLeft * vp.width + 1;
  const stopRight = item.segment.stopRight === undefined ? Infinity : item.segment.stopRight * vp.width - 1;
  const from = Math.max(item.segment.rect.x * vp.width - pad, stopLeft);
  const to = Math.min((item.segment.rect.x + item.segment.rect.w) * vp.width + pad + 8, stopRight);
  return (
    <div key={"cover-" + item.key} data-plate={mark ? "1" : undefined} data-key={"cover-" + item.key} style={{
      position: "absolute", pointerEvents: "none",
      left: from, top: item.segment.rect.y * vp.height - 5,
      width: to - from, height: item.segment.rect.h * vp.height + 10,
      background: `rgb(${r}, ${g}, ${b})`, borderRadius: 4,
    }} />
  );
}

function renderPlate(item: { key: string; segment: any; bounds?: any }, index: number, vp: { width: number; height: number }, all: any[], caps: Array<number | undefined>, mark: boolean) {
  return (
    <div key={item.key} data-plate={mark ? "1" : undefined} data-key={item.key} style={{
      position: "absolute", boxSizing: "border-box", display: "flex", alignItems: "center", padding: "2px 8px", borderRadius: 5,
      lineHeight: 1.2, fontWeight: linesOf(item.segment, vp) > 1 ? 500 : 600, overflowWrap: "break-word",
      ...segmentStyle(item.segment, vp, true, 26, 1, nextBelow(all, index), sideLimits(all, index), item.bounds, caps[index], nextAbove(all, index)),
    }}>{item.segment.translated}</div>
  );
}

// Where every plate was drawn the last time (a text that scrolls: the plate glides from there to the new place instead of jumping)
const drawnAt = new Map<string, { x: number; y: number; ex: number; ey: number }>();
// How far ahead a text that keeps scrolling is followed (seconds), and the most it is followed (fraction of the height of the screen)
const GLIDE_MS = 240;
const AHEAD_SECONDS = 0.22;
const AHEAD_MAX = 0.1;

function OverlayLayer() {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  // While the plugin's own panel is open nothing is drawn over the game when the frames are taken from the screen (the panel is in them)
  const hideForPanel = s.qam && s.frame.source !== "layer";
  const visible = s.running && s.results.length > 0 && !hideForPanel;
  const showFrames = s.running && s.frames.length > 0 && !hideForPanel;
  if (useComposition) useComposition(visible ? 1 : 0);

  // The size of the screen the plates are laid out on: measured on the layer itself (`window` here is not the window the layer is in)
  const [viewport, setViewport] = useState({ width: FRAME_W, height: FRAME_H });
  // Frames of the Vulkan layer are the game's own picture (its resolution and shape): the game sits in the screen like gamescope fits it
  const fw = s.frame.w, fh = s.frame.h;
  let area = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (s.frame.source === "layer" && fw > 0 && fh > 0) {
    // Where gamescope really puts the game's frame (stretched over the screen, fitted with bars ...) was found by calibrateMapping; until then: fitted
    const found = s.mapping !== null && s.mapping.key === `${fw}x${fh}` ? s.mapping.area : null;
    if (found !== null) {
      area = { x: found.x * viewport.width, y: found.y * viewport.height, width: found.w * viewport.width, height: found.h * viewport.height };
    } else {
      const k = Math.min(viewport.width / fw, viewport.height / fh);
      area = { x: (viewport.width - fw * k) / 2, y: (viewport.height - fh * k) / 2, width: fw * k, height: fh * k };
    }
  }
  const vp = { width: area.width, height: area.height };
  const items: Array<{ key: string; segment: any; shownAt?: number; rect: any; bounds?: any }> = [];
  s.results.forEach((item) => item.result.segments.forEach((segment, index) => items.push({ key: "el-" + item.id + "-" + index, segment, rect: segment.rect, shownAt: segment.shownAt, bounds: item.result.bounds })));
  // A plate whose text is the same as the original (a name, a number, a bit of a word at the edge of a picture) says nothing: it is not drawn
  const worthShowing = items.filter((i) => {
    const original = String(i.segment.original || "").trim().toLowerCase();
    const translated = String(i.segment.translated || "").trim().toLowerCase();
    return translated !== "" && translated !== original;
  });
  const shown = dropCovered(worthShowing);
  const all = shown.map((i) => i.segment);
  // First every plate gets the size it needs on its own, then plates of one kind (the same height of the original) are set in one size
  const ownStyles = shown.map((item, index) => segmentStyle(item.segment, vp, true, 26, 1, nextBelow(all, index), sideLimits(all, index), item.bounds, undefined, nextAbove(all, index)));
  const caps = sizeCaps(shown.map((item) => item.segment.lineHeight), ownStyles.map((st) => Number(String(st.fontSize).replace("px", "")) || 14));

  // Measure the plates that are really on screen (a translation may be bigger than the original) for the engine's mask
  useLayoutEffect(() => {
    const own = box.current?.getBoundingClientRect();
    if (own && own.width > 100 && own.height > 100) { viewportAspect = own.width / own.height; }
    if (own && own.width > 100 && own.height > 100 && (Math.abs(own.width - viewport.width) > 1 || Math.abs(own.height - viewport.height) > 1)) {
      log(`overlay viewport ${own.width}x${own.height} (window ${window.innerWidth}x${window.innerHeight})`);
      setViewport({ width: own.width, height: own.height });
    }
    const masks: Array<[number, number, number, number]> = [];
    box.current?.querySelectorAll("[data-plate]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const kx = frameW / Math.max(1, viewport.width);
      const ky = frameH / Math.max(1, viewport.height);
      masks.push([Math.floor((r.left - 4) * kx), Math.floor((r.top - 4) * ky), Math.ceil((r.right + 4) * kx), Math.ceil((r.bottom + 4) * ky)]);
    });
    plateMasks = masks;
  });

  // A text that scrolls: its plate slides to the new place (and, while the scrolling goes on, a little ahead of it) instead of jumping
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const seen = new Set<string>();
    try {
      shown.forEach((item) => {
        if (item.segment.clip) { return; }
        const x = item.segment.rect.x * vp.width, y = item.segment.rect.y * vp.height;
        const m = item.segment.motion;
        const fresh = m !== undefined && Date.now() - m.at < 1000;
        const clampAhead = (v: number, size: number) => Math.max(-AHEAD_MAX * size, Math.min(AHEAD_MAX * size, v * size * AHEAD_SECONDS));
        const ex = fresh && m.sustained ? clampAhead(m.vx, vp.width) : 0;
        const ey = fresh && m.sustained ? clampAhead(m.vy, vp.height) : 0;
        seen.add(item.key);
        const was = drawnAt.get(item.key);
        const nodes = root.querySelectorAll(`[data-key="${item.key}"],[data-key="cover-${item.key}"]`);
        nodes.forEach((node) => { (node as HTMLElement).getAnimations?.().forEach((a) => a.cancel()); });
        if (fresh && was !== undefined) {
          const fromX = was.x + was.ex - x, fromY = was.y + was.ey - y;
          if (Math.abs(fromX) + Math.abs(fromY) > 2 && Math.abs(fromX) + Math.abs(fromY) < 0.35 * vp.height) {
            nodes.forEach((node) => {
              (node as HTMLElement).animate?.([{ transform: `translate(${fromX}px, ${fromY}px)` }, { transform: `translate(${ex}px, ${ey}px)` }], { duration: GLIDE_MS, easing: "ease-out", fill: "forwards" });
            });
          }
        }
        drawnAt.set(item.key, { x, y, ex: fresh ? ex : 0, ey: fresh ? ey : 0 });
      });
    } catch (e) { /* the glide is only decoration: the plates are right without it */ }
    for (const key of Array.from(drawnAt.keys())) { if (!seen.has(key)) drawnAt.delete(key); }
  }, [s.results]);

  if (!visible) plateMasks = [];
  return (
    <div ref={box} style={{ position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", zIndex: 7002, pointerEvents: "none", background: "transparent", fontFamily: '"Motiva Sans", "Noto Sans", Arial, sans-serif', visibility: s.peek ? "hidden" : "visible" }}>
      <div style={{ position: "absolute", left: area.x, top: area.y, width: area.width, height: area.height }}>
      {showFrames ? s.frames.map((f, i) => {
        const color = ({ text: "#35d07f", reading: "#ffd23f", candidate: "#4aa8ff", rejected: "#ff5d5d", idle: "#aaaaaa" } as any)[f.state] || "#ffffff";
        return (
          <div key={"dbg-" + i} style={{ position: "absolute", pointerEvents: "none", left: f.rect.x * vp.width, top: f.rect.y * vp.height, width: f.rect.w * vp.width, height: f.rect.h * vp.height, border: `2px solid ${color}`, boxSizing: "border-box", opacity: f.state === "rejected" ? 0.45 : 0.9 }}>
            <span style={{ position: "absolute", left: 0, top: -14, fontSize: 11, lineHeight: "12px", color, background: "rgba(0,0,0,0.6)", padding: "0 3px" }}>{f.state}</span>
          </div>
        );
      }) : null}
      {(visible ? shown : []).map((item) => (item.segment.clip ? null : renderCover(item, vp, true)))}
      {(visible ? shown : []).map((item, index) => (item.segment.clip ? null : renderPlate(item, index, vp, all, caps, true)))}
      {/* A text that the edge of its window cuts (a list that scrolls): the plate is cut the same way, so that it goes in and out of sight with the text */}
      {(visible ? shown : []).map((item, index) => {
        const c = item.segment.clip;
        if (!c) return null;
        const cx = c.x * vp.width, cy = c.y * vp.height;
        return (
          <div key={"clip-" + item.key} data-plate="1" style={{ position: "absolute", pointerEvents: "none", left: cx, top: cy, width: c.w * vp.width, height: c.h * vp.height, overflow: "hidden" }}>
            <div style={{ position: "absolute", left: -cx, top: -cy, width: vp.width, height: vp.height }}>
              {renderCover(item, vp, false)}
              {renderPlate(item, index, vp, all, caps, false)}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

/** Is a game running? When this version of Decky cannot tell, the answer is yes (better to translate than to never start). */
let gameApiLogged = false;
function gameRunning(): boolean {
  const r: any = Router;
  const known = !!r && "MainRunningApp" in r;
  if (!gameApiLogged) { gameApiLogged = true; log(`game detection: ${known ? "available" : "NOT available, translating always"}`); }
  if (!known) return true;
  return !!r.MainRunningApp;
}

// ---- the translator: capture helper -> frames -> engine worker -> results ----
let worker: Worker | null = null;
let ocrWorkers: Worker[] = [];
// The addresses of the code of the workers (a page keeps what a blob address points to until the address is given back)
let blobUrls: string[] = [];
function blobUrl(code: string): string { const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" })); blobUrls.push(url); return url; }
function releaseBlobUrls() { blobUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* nothing */ } }); blobUrls = []; }
// How many readers of the text the plugin starts (they read in turns, and two at once while a new screen is read)
const READER_WORKERS = 2;
let running = false;
// Every start is a new generation: a loop of an older one that is still waiting on a request must stop, not go on after a new start
let generation = 0;
let ackResolve: (() => void) | null = null;
let lastSource = "";
let frameW = FRAME_W;
let frameH = FRAME_H;
let debugTimer: ReturnType<typeof setInterval> | undefined;

async function startTranslating(): Promise<void> {
  if (running) return;
  running = true;
  const gen = ++generation;
  setStore({ running: true, status: t("status.starting") });
  void prepareLocal();
  const profile = activeProfile();
  const st = await startCapture(profile.fps, FRAME_W, FRAME_H, settings.layer);
  if (!st.running) { running = false; setStore({ running: false, status: t("status.captureFailed", { error: st.error || "" }) }); return; }
  for (let i = 0; i < 20; i++) {
    try { const s = await (await fetch(`${BASE}/stats`)).json(); if (s.seq > 0) break; } catch { /* helper starting */ }
    await sleep(500);
  }
  let scoutCode = "";
  let engineCode = "";
  try {
    [engineCode, scoutCode] = await Promise.all([
      fetch(`${BASE}/assets/engine-worker.js`).then((r) => r.text()),
      fetch(`${BASE}/assets/scout/worker.js`).then((r) => r.text()),
    ]);
    worker = new Worker(blobUrl(engineCode));
  } catch (e) { running = false; setStore({ running: false, status: t("status.workerFailed", { error: String(e) }) }); log("worker start failed: " + e); return; }
  // The modern reader (English) lives in workers of its own, so that a long reading does not keep the engine from looking at the picture; two of them, so that a new screen
  // is read twice as fast. They are connected to the engine by channels.
  const ocrPorts: MessagePort[] = [];
  if (settings.reader !== "classic" && settings.source === "en" && typeof MessageChannel !== "undefined") {
    for (let i = 0; i < READER_WORKERS; i++) {
      try {
        const reader = new Worker(blobUrl(engineCode));
        const channel = new MessageChannel();
        reader.onmessage = (e: MessageEvent) => { const m = e.data; if (m.type === "error") log(`reader worker ${i + 1}: ${m.message}`); else if (m.type === "status") log(`reader worker ${i + 1} ${m.status}`); };
        reader.onerror = (e) => log(`reader worker ${i + 1} onerror: ${e.message}`);
        reader.postMessage({ type: "ocr-init", base: BASE, port: channel.port2 }, [channel.port2]);
        ocrWorkers.push(reader);
        ocrPorts.push(channel.port1);
      } catch (e) { log("reader worker not started (the engine reads itself): " + e); }
    }
  }

  const mine = worker;
  worker.onmessage = async (e: MessageEvent) => {
    if (worker !== mine) return;
    const m = e.data;
    if (m.type === "ack") { ackResolve?.(); ackResolve = null; }
    else if (m.type === "results") { setStore({ results: m.results }); changeTimes.push(Date.now()); if (changeTimes.length > 200) changeTimes.splice(0, changeTimes.length - 200); }
    else if (m.type === "status") { setStore({ status: engineStatus(String(m.status)) }); log("engine status " + m.status); }
    else if (m.type === "scene") { sceneAt = Date.now(); }
    else if (m.type === "debug") setStore({ elements: m.count });
    else if (m.type === "frames") setStore({ frames: m.frames });
    else if (m.type === "mapping") {
      log(`screen mapping: ${m.ok ? m.name : "not decided"} ${JSON.stringify(m.scores || m.reason || "")}`);
      if (m.ok) setStore({ mapping: { key: `${m.frame.w}x${m.frame.h}`, area: m.area } });
    }
    else if (m.type === "error") log("worker error: " + m.message);
    else if (m.type === "clean-rejected") log(m.difference < 0 ? "clean picture rejected (it contains our plates)" : `clean picture rejected (stale, difference ${m.difference})`);
    else if (m.type === "perf") { lastPerf = { scans: m.scans, lag: m.lagMax, scanMs: m.scanMs, ocrReads: m.ocrReads, ocrMs: m.ocrMs, detects: m.detects, detMs: m.detMs, elements: m.elements, still: m.stillFrames, frames: m.frames }; busyShare = Math.min(2, Number(m.ocrMs || 0) / (5000 * Math.max(1, ocrWorkers.length))); if (settings.debug || ++perfLogCount % 6 === 0) log(`perf: frames ${m.frames} (${m.applyMs} ms), scan ${m.scanMs} ms, ocr ${m.ocrReads} reads / ${m.ocrMs} ms, elements ${m.elements}, clean checks ${m.cleanChecked}/${m.cleanChanged} changed, looks ${m.scans}, lag ${m.lagMax} ms, still ${m.stillFrames}, reader thread ${m.ocrRemote}/${m.ocrFailed} failed`); }
    else if (m.type === "translate") {
      try { const r = await translateAny(m.text, m.source, m.target, m.id); worker?.postMessage({ type: "translated", id: m.id, text: r.text, better: r.better === true }); }
      catch (err) { log("translate failed: " + ((err as any)?.message || JSON.stringify(err))); worker?.postMessage({ type: "translated", id: m.id, text: "", failed: true }); }
    }
  };
  worker.onerror = (e) => log("worker onerror: " + e.message);
  worker.postMessage({ type: "init", base: BASE, scoutCode, ocrPorts, settings: { fit: "default", source: settings.source, target: settings.target, color: "light", panels: true, readDuty: profile.duty, burstDuty: profile.burst, speed: profile.speed, debug: settings.debug, reader: settings.reader, readers: readerCount() } }, ocrPorts);
  debugTimer = setInterval(() => worker?.postMessage({ type: "debug" }), 2000);
  log("translating started");
  void syncMemoryGame();
  autoLevel = "balanced"; autoCalmSince = 0; changeTimes.length = 0;
  clearInterval(autoTimer); autoTimer = setInterval(autoStep, 2000);

  let after = 0;
  let lastPeek = Date.now();
  let captureOn = true;
  let idleSince = 0;
  while (running && gen === generation) {
    try {
      // While plates cover the text the engine is blind there (our own plates are in the captured picture). Now and then it gets
      // a clean picture of the game (without Steam's layer), so it notices a text that changed or went away under a plate.
      // Nothing is translated while no game runs (the Steam library is not what this is for, and it saves the battery)
      if (!gameRunning()) {
        if (store.results.length) setStore({ results: [] });
        if (!idleSince) idleSince = Date.now();
        if (captureOn && Date.now() - idleSince > 20000) { await stopCapture(); captureOn = false; log("capture paused (no game)"); }
        await sleep(1500);
        continue;
      }
      idleSince = 0;
      if (store.qam && lastSource !== "layer") { await sleep(300); continue; }   // the panel is in the screen's picture: not read
      if (!captureOn) {
        await startCapture(profile.fps, FRAME_W, FRAME_H, settings.layer);
        captureOn = true;
        after = 0;
        log("capture resumed (a game runs)");
        await sleep(1000);
      }
      if (lastSource !== "layer" && plateMasks.length > 0 && (Date.now() - lastPeek > profile.peek || (sceneAt > lastPeek && Date.now() - lastPeek > 800))) {
        lastPeek = Date.now();
        const c = await fetch(`${BASE}/clean`);
        if (c.status === 200) {
          const png = await c.arrayBuffer();
          const ackClean = new Promise<void>((res) => { ackResolve = res; });
          worker?.postMessage({ type: "clean", png, w: frameW, h: frameH }, [png]);
          await Promise.race([ackClean, sleep(3000)]);
        }
        lastPeek = Date.now();
      }
      const r = await fetch(`${BASE}/frame?after=${after}`);
      if (r.status === 204) {
        // No new frame: the picture is still, or the helper was started again and counts from the beginning
        try { const h = await (await fetch(`${BASE}/stats`)).json(); if (h.seq < after) after = 0; } catch { /* helper not there */ }
        continue;
      }
      const buf = await r.arrayBuffer();
      after = Number(r.headers.get("X-Seq"));
      frameW = Number(r.headers.get("X-W")) || FRAME_W;
      frameH = Number(r.headers.get("X-H")) || FRAME_H;
      const source = r.headers.get("X-Source") || "pipewire";
      // The Scaling mode of gamescope comes with every frame (the helper follows it by itself): a change starts a series of quick looks at where the game lies on the screen
      const scalerNow = Number(r.headers.get("X-Scaler") ?? -1);
      gameFps = Number(r.headers.get("X-Fps") ?? 0) || 0;
      if (scalerNow >= 0) { if (lastScaler !== null && scalerNow !== lastScaler) { quickLooks = 3; log(`scaling mode changed ${lastScaler} -> ${scalerNow}`); } lastScaler = scalerNow; }
      if (source !== lastSource || frameW !== store.frame.w || frameH !== store.frame.h) {
        lastSource = source;
        setStore({ frame: { w: frameW, h: frameH, source } });
        log(`frame source: ${source} ${frameW}x${frameH}`);
        if (source === "layer") { void calibrateMapping(); }
      }
      const ack = new Promise<void>((res) => { ackResolve = res; });
      worker?.postMessage({ type: "frame", buf, w: frameW, h: frameH, fmt: r.headers.get("X-Format") || "RGBA", masks: source === "layer" ? [] : plateMasks }, [buf]);
      await Promise.race([ack, sleep(3000)]);
    } catch (err) {
      if (gen !== generation) return;
      setStore({ peek: false });
      log("frame loop: " + err);
      await sleep(1000);
      // The helper may have died (gamescope restarted): start it again
      try { const st = await captureStatus(); if (!st.running && captureOn) { await startCapture(profile.fps, FRAME_W, FRAME_H, settings.layer); after = 0; log("capture helper started again"); } } catch { /* try next time */ }
    }
  }
}

async function stopTranslating(): Promise<void> {
  void saveMemory();
  running = false;
  generation++;
  localGen++;
  localPairs = [];
  local.stop();
  clearInterval(autoTimer);
  clearInterval(debugTimer);
  worker?.postMessage({ type: "stop" });
  worker?.terminate();
  worker = null;
  ocrWorkers.forEach((w) => w.terminate());
  ocrWorkers = [];
  releaseBlobUrls();
  setStore({ running: false, results: [], status: "", elements: 0, peek: false, frames: [], frame: { w: 0, h: 0, source: "" }, localInfo: "", autoInfo: "", mapping: null });
  await stopCapture();
  log("translating stopped");
}

// ---- The local translator (Bergamot in a worker of the page): the models are downloaded once by the backend; until it is ready, the online one translates ----
const local = new LocalTranslator(BASE, (m) => log(m));
let localPairs: Array<[string, string]> = [];
let localGen = 0;

/** The capture helper serves the files of the local translator; it starts a moment after the translator is switched on: wait until it answers. */
async function waitForHelper(gen: number): Promise<boolean> {
  for (let i = 0; i < 40 && gen === localGen; i++) {
    try { const r = await fetch(`${BASE}/stats`); if (r.ok) { return true; } } catch { /* not there yet */ }
    await sleep(750);
  }
  return false;
}

async function prepareLocal(): Promise<void> {
  const gen = ++localGen;
  localPairs = [];
  if (settings.translator === "online") { setStore({ localInfo: "" }); return; }
  try {
    let st = await modelsStatus(settings.source, settings.target);
    if (st.state === "unsupported") { setStore({ localInfo: t("local.unsupported") }); return; }
    if (!st.installed) {
      st = await installModels(settings.source, settings.target);
      const mb = Math.round(st.bytes / 1e6);
      while (gen === localGen && st.state === "downloading") {
        setStore({ localInfo: t("local.downloading", { mb, pct: Math.round(st.progress * 100) }) });
        await sleep(1000);
        st = await modelsStatus(settings.source, settings.target);
      }
      if (gen !== localGen) { return; }
      if (!st.installed) { setStore({ localInfo: t("local.failed", { reason: st.error || t("local.noInternet") }) }); return; }
    }
    setStore({ localInfo: t("local.loading") });
    const pairs = st.pairs.map((k) => [k.slice(0, 2), k.slice(2, 4)] as [string, string]);
    // The first tries may come before the helper is up (it is started with the capture): wait for it and try again
    let lastError: any = null;
    for (let attempt = 0; attempt < 4 && gen === localGen; attempt++) {
      try {
        if (!(await waitForHelper(gen))) { throw new Error("the capture helper does not answer"); }
        for (const [from, to] of pairs) { await local.loadPair(from, to); }
        lastError = null;
        break;
      } catch (e) { lastError = e; log("local translator try " + (attempt + 1) + " failed: " + e); await sleep(2000); }
    }
    if (lastError !== null) { throw lastError; }
    if (gen !== localGen) { return; }
    localPairs = pairs;
    setStore({ localInfo: settings.translator === "smart" ? t("local.smart") : t("local.ready") });
    log("local translator ready: " + pairs.map((p) => p.join("")).join(" + "));
  } catch (e) {
    log("local translator failed: " + e);
    if (gen === localGen) { setStore({ localInfo: t("local.notStarted") }); }
  }
}

// How long the online service takes on average (a moving average): when it is slow, the local draft is not held back for it
let onlineAverage = 0;
const DRAFT_WAIT_MS = 250;
const SLOW_ONLINE_MS = 300;
const SLOW_WAIT_MS = 100;

function localReady(source: string, target: string): boolean {
  return localPairs.length > 0 && localPairs[0][0] === source && localPairs[localPairs.length - 1][1] === target;
}

async function translateOnlineTimed(text: string, source: string, target: string): Promise<string> {
  const asked = Date.now();
  const result = await translateText(text, source, target);
  const took = Date.now() - asked;
  onlineAverage = onlineAverage === 0 ? took : onlineAverage * 0.7 + took * 0.3;
  return result;
}

/**
 * The translation of a text. Smart (the default): the online one is better but needs a moment, the local one is there at once: both are asked; when the
 * online one does not come within a moment, the local draft is shown and replaced by the online one when it comes (if it differs). Without internet the
 * local one stays. Local: only the local one (the online one only for what it cannot do). Online: only the online one.
 * Answers {text, better: true} for a draft: the better text follows with sendBetter.
 */
// ---- The memory of translations of the game that runs (kept on disk between runs; the glossary of the game is a file the player may edit) ----
const memory = new TranslationMemory();
let memoryLoading = false;
let memorySavedAt = 0;
/** The game that runs now (null when Steam does not say). */
function currentGame(): { id: string; name: string } | null {
  const app: any = (Router as any)?.MainRunningApp;
  if (!app) return null;
  const id = String(app.appid ?? app.gameid ?? "");
  return id === "" ? null : { id, name: String(app.display_name ?? app.name ?? "") };
}
async function saveMemory(): Promise<void> {
  if (!memory.dirty || memory.game === "") return;
  memory.dirty = false;
  memorySavedAt = Date.now();
  try { if (!(await memoryPut(memory.game, memory.name, memory.snapshot().entries))) { memory.dirty = true; log("memory not saved"); } }
  catch (e) { memory.dirty = true; log("memory not saved: " + e); }
}
/** The memory follows the game: when another game runs, what was learned in the first is written and the memory of the second is read. */
async function syncMemoryGame(): Promise<void> {
  const game = currentGame();
  if (memoryLoading || game === null || game.id === memory.game) return;
  memoryLoading = true;
  try {
    await saveMemory();
    const file = await memoryGet(game.id);
    memory.load(game.id, game.name, file);
    log(`memory of the game ${game.name || game.id}: ${memory.entries.size} texts, glossary ${memory.glossary.size}`);
  } catch (e) { log("memory not loaded: " + e); }
  finally { memoryLoading = false; }
}

async function translateAny(text: string, source: string, target: string, id: number): Promise<{ text: string; better?: boolean }> {
  const known = memory.get(source, target, text);
  if (known !== null) return { text: known };
  const result = await translateFresh(text, source, target, id);
  if (!result.better) memory.put(source, target, text, result.text);
  return result;
}

async function translateFresh(text: string, source: string, target: string, id: number): Promise<{ text: string; better?: boolean }> {
  const mode = settings.translator;
  if (mode === "online" || !localReady(source, target)) {
    return { text: await translateText(text, source, target) };
  }
  if (mode === "local") {
    try { const r = await local.translate(text, localPairs); if (r) { return { text: r }; } } catch (e) { log("local translate failed (online instead): " + e); }
    return { text: await translateText(text, source, target) };
  }
  // smart
  const online = translateOnlineTimed(text, source, target);
  const quick = await Promise.race([online.then((v) => v, () => undefined), sleep(onlineAverage > SLOW_ONLINE_MS ? SLOW_WAIT_MS : DRAFT_WAIT_MS).then(() => null)]);
  if (typeof quick === "string" && quick !== "") { return { text: quick }; }
  let draft = "";
  try { draft = await local.translate(text, localPairs); } catch (e) { log("local translate failed: " + e); }
  if (draft === "") { return { text: await online }; }
  // The draft is kept at once; when the online translation comes it is the better text, and it is kept instead
  memory.put(source, target, text, draft);
  online.then((value) => { sendBetter(id, value !== "" && value !== draft ? value : null); if (value !== "") memory.put(source, target, text, value); }, () => sendBetter(id, null));
  return { text: draft, better: true };
}

function sendBetter(id: number, text: string | null) { worker?.postMessage({ type: "better", id, text }); }

// The shape of the screen the overlay lies on (width / height), measured by the overlay
let viewportAspect = 0;
let calibrating = false;
/** Finds how gamescope puts the game's frame on the screen (see calibrateMapping in the worker): some tries, the first when the game has settled. */
async function calibrateMapping(force = false): Promise<void> {
  if (calibrating) { return; }
  calibrating = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(force ? 400 : (attempt === 0 ? 1500 : 4000));
      if (!running || store.frame.source !== "layer") { break; }
      if (!force && store.mapping !== null && store.mapping.key === `${store.frame.w}x${store.frame.h}`) { break; }
      // The whole screen as it is shown (always the size of the screen; the base plane of the game is often the size of the game), and the Scaling mode of Steam
      const c = await fetch(`${BASE}/clean?kind=2`);
      if (c.status !== 200) { continue; }
      const png = await c.arrayBuffer();
      let scaler: number | null = null;
      try { const sj = await (await fetch(`${BASE}/scaler`)).json(); scaler = typeof sj.scaler === "number" ? sj.scaler : null; } catch { /* no hint */ }
      worker?.postMessage({ type: "calibrate", png, aspect: viewportAspect, scaler }, [png]);
      await sleep(1500);
      if (force) { break; }
    }
  } catch (e) { log("calibrate failed: " + e); } finally { calibrating = false; }
}

let autoTimer: ReturnType<typeof setInterval> | undefined;
let lastCalibration = 0;
let qamWasOpen = false;
// The Scaling mode of gamescope as it was at the last look, and how many quick looks are still to be made after a change
let lastScaler: number | null = null;
let quickLooks = 0;
function applyWorkerSettings() {
  const p = activeProfile();
  worker?.postMessage({ type: "settings", settings: { fit: "default", source: settings.source, target: settings.target, color: "light", panels: true, readDuty: p.duty, burstDuty: p.burst, speed: p.speed, debug: settings.debug, readers: readerCount() } });
}
/** The automatic mode: a text that changes often (dialogues, subtitles) gets the full power, a still screen with text the usual one, a screen without text the least. Down slowly, up at once. */
function autoStep() {
  // The scaling mode of the screen can be changed in the middle of a game: look again when the panel was closed, and now and then
  const nowMs = Date.now();
  const wantLook = (quickLooks > 0) || (qamWasOpen && !store.qam) || nowMs - lastCalibration > 20000;
  if (running && store.frame.source === "layer" && !store.qam && !calibrating && wantLook) {
    lastCalibration = nowMs;
    if (quickLooks > 0) { quickLooks--; }
    void calibrateMapping(true);
  }
  qamWasOpen = store.qam;
  if (running) {
    const game = currentGame();
    if (game !== null && game.id !== memory.game) void syncMemoryGame();
    else if (memory.dirty && nowMs - memorySavedAt > 30000) void saveMemory();
  }
  if (settings.profile !== "auto" || !running) { return; }
  const now = Date.now();
  while (changeTimes.length > 0 && now - changeTimes[0] > 12000) { changeTimes.shift(); }
  const wanted: Level = changeTimes.length >= 4 ? "quality" : (changeTimes.length >= 1 || store.results.length > 0 ? "balanced" : "battery");
  // The governor: when the reading takes too much of the processor (a heavy game needs it) the level is lowered, whatever the text does
  if (busyShare > 0.5) { if (busyHighSince === 0) { busyHighSince = now; } } else { busyHighSince = 0; }
  let cap: Level = "quality";
  if (busyShare > 0.9 || (busyHighSince !== 0 && now - busyHighSince > 14000)) { cap = "battery"; } else if (busyShare > 0.4) { cap = "balanced"; }
  // The game itself tells when it suffers: its frame rate falls well below what it has been lately (a game locked to 30 stays at 30 and is left alone)
  fpsTop = Math.max(gameFps, fpsTop * 0.995);
  const fpsRatio = gameFps > 0 && fpsTop >= 20 ? gameFps / fpsTop : 1;
  if (fpsRatio < 0.8 && gameFps < 50) { if (fpsLowSince === 0) { fpsLowSince = now; } } else { fpsLowSince = 0; }
  const fpsLow = fpsLowSince !== 0 ? now - fpsLowSince : 0;
  const readersWanted = fpsLow > 1500 ? 1 : 2;
  if (readersWanted !== readersNow) { readersNow = readersWanted; applyWorkerSettings(); }
  if (fpsRatio < 0.6 && fpsLow > 2000) { cap = "battery"; } else if (fpsLow > 3000 && LEVEL_ORDER[cap] > LEVEL_ORDER.balanced) { cap = "balanced"; }
  const limited: Level = LEVEL_ORDER[wanted] > LEVEL_ORDER[cap] ? cap : wanted;
  if (LEVEL_ORDER[limited] > LEVEL_ORDER[autoLevel] && now >= governorUntil) {
    autoLevel = limited; autoCalmSince = 0; applyWorkerSettings();
  } else if (LEVEL_ORDER[limited] < LEVEL_ORDER[autoLevel]) {
    // down at once when the processor is needed, slowly when only the text has calmed down
    if (autoCalmSince === 0) { autoCalmSince = now; }
    if (now - autoCalmSince > (limited !== wanted ? 1500 : 10000)) { if (limited !== wanted) { governorUntil = now + 30000; } autoLevel = limited; autoCalmSince = 0; applyWorkerSettings(); }
  } else { autoCalmSince = 0; }
  setStore({ autoInfo: t("auto.info", { level: levelName(autoLevel) }) + (memory.game !== "" ? t("auto.memory", { n: memory.entries.size }) : "") + (gameFps > 0 ? t("auto.fps", { fps: Math.round(gameFps) }) + (fpsLow > 2000 ? t("auto.sparing") : "") : "") });
}

async function changeSetting(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  try { await setSettingsBackend(patch); } catch (e) { log("settings not saved: " + e); }
  if ("debug" in patch) {
    worker?.postMessage({ type: "settings", settings: { fit: "default", source: settings.source, target: settings.target, color: "light", panels: true, readDuty: activeProfile().duty, burstDuty: activeProfile().burst, speed: activeProfile().speed, debug: settings.debug, readers: readerCount() } });
    if (!patch.debug) setStore({ frames: [] });
  }
  if ("translator" in patch && !running) { void prepareLocal(); }
  // A language or a profile changes how everything runs: start again with it
  if ("profile" in patch && running && !("source" in patch || "target" in patch)) { applyWorkerSettings(); setStore({ autoInfo: settings.profile === "auto" ? t("auto.info", { level: levelName(autoLevel) }) : "" }); }
  if (running && ("source" in patch || "target" in patch || "layer" in patch || "translator" in patch || "reader" in patch)) {
    await stopTranslating();
    await sleep(1500);
    await startTranslating();
  }
}

let recording = false;
/** Saves the frames of the next seconds (on the card of the Deck, ~/dlt-records) and, once per second, what the translator shows: for the developer. */
async function recordSession(seconds: number): Promise<string> {
  if (recording) { return ""; }
  recording = true;
  try {
    const started = await (await fetch(`${BASE}/record/start?seconds=${seconds}`)).json();
    log("recording to " + started.dir);
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const note = { t: Date.now(), source: store.frame.source, elements: store.elements, fps: gameFps, level: settings.profile === "auto" ? autoLevel : settings.profile, busy: Math.round(busyShare * 100) / 100, perf: lastPerf, mapping: store.mapping === null ? null : store.mapping.area, results: store.results.map((r: any) => ({ id: r.id, segments: r.result.segments.map((g: any) => ({ o: g.original, t: g.translated, r: g.rect, lh: g.lineHeight, c: g.centered, bg: g.background, fg: g.foreground })) })) };
      await fetch(`${BASE}/record/note`, { method: "POST", body: JSON.stringify(note) });
      await sleep(700);
    }
    await sleep(1500);
    const st = await (await fetch(`${BASE}/record/status`)).json();
    log(`recording done: ${st.saved} frames in ${started.dir}`);
    return String(started.dir);
  } catch (e) {
    log("recording failed: " + e);
    return "";
  } finally {
    recording = false;
  }
}

function Content() {
  const s = useStore();
  const [cfg, setCfg] = useState<Settings>(settings);
  const [info, setInfo] = useState("");
  const [rec, setRec] = useState("");
  // What the plugin keeps on the card: the recordings for the developer, the memory of translations
  const [usage, setUsage] = useState({ records_bytes: 0, records_count: 0, records_keep: 12, memory_bytes: 0, memory_games: 0 });
  const refreshUsage = () => { dataUsage().then(setUsage).catch(() => { /* backend not there */ }); };
  useEffect(() => { refreshUsage(); }, []);
  // while this panel is open the plates are hidden and the screen's picture is not read (the panel itself would be translated)
  useEffect(() => { setStore({ qam: true }); return () => setStore({ qam: false }); }, []);
  useEffect(() => {
    if (!s.running) { setInfo(""); return; }
    const timer = setInterval(async () => {
      try { const h = await (await fetch(`${BASE}/stats`)).json(); setInfo(t("info.stats", { source: h.source === "layer" ? t("info.layer") : t("info.screen"), w: h.w, h: h.h, fps: h.fps, cpu: h.cpu_pct })); } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [s.running]);
  const update = (patch: Partial<Settings>) => { setCfg({ ...settings, ...patch }); void changeSetting(patch); };
  // The tools of the developer (diagnostics, recordings, the numbers of the engine) are hidden from players: the version at the bottom, pressed
  // seven times in a row, shows them (and hides them again)
  const [version, setVersion] = useState("");
  useEffect(() => { pluginVersion().then(setVersion).catch(() => { /* backend not there */ }); }, []);
  const taps = useRef({ count: 0, at: 0 });
  const tapVersion = () => {
    const now = Date.now();
    // a touch may come as a click and as an activation at once: one tap
    if (now - taps.current.at < 80) return;
    taps.current = { count: now - taps.current.at < 1500 ? taps.current.count + 1 : 1, at: now };
    if (taps.current.count >= 7) {
      taps.current.count = 0;
      update(cfg.developer ? { developer: false, debug: false } : { developer: true });
      refreshUsage();
    }
  };
  const developer = cfg.developer === true;
  return (
    <>
      <PanelSection title="Live Translator">
        <PanelSectionRow>
          <ToggleField label={t("toggle.label")} description={t("toggle.desc")} checked={s.running}
            onChange={(on: boolean) => { update({ enabled: on }); if (!on) { void stopTranslating(); } else if (!running) { void startTranslating(); } }} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label={t("source.label")} rgOptions={languageOptions(SOURCE_LANGUAGES)} selectedOption={cfg.source} onChange={(o: any) => update({ source: o.data })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label={t("target.label")} rgOptions={languageOptions(TARGET_LANGUAGES)} selectedOption={cfg.target} onChange={(o: any) => update({ target: o.data })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label={t("mode.label")} rgOptions={[{ data: "auto", label: t("mode.auto") }, ...Object.keys(PROFILES).map((data) => ({ data, label: t(`mode.${data}` as "mode.battery") }))]} selectedOption={cfg.profile}
            onChange={(o: any) => update({ profile: o.data })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label={t("translator.label")} rgOptions={[{ data: "smart", label: t("translator.smart") }, { data: "local", label: t("translator.local") }, { data: "online", label: t("translator.online") }]} selectedOption={cfg.translator} onChange={(o: any) => update({ translator: o.data })} />
        </PanelSectionRow>
        <PanelSectionRow><div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-word" }}>{t("translator.privacy")}</div></PanelSectionRow>
        <PanelSectionRow><div style={{ fontSize: 12, wordBreak: "break-word" }}>{s.localInfo}{developer && s.autoInfo ? <><br />{s.autoInfo}</> : null}</div></PanelSectionRow>
        {s.running && cfg.layer && s.frame.source === "pipewire" ? <PanelSectionRow><div style={{ fontSize: 12, color: "#ffb74d", wordBreak: "break-word" }}>{t("layer.missing")}</div></PanelSectionRow> : null}
        <PanelSectionRow><div style={{ fontSize: 12, wordBreak: "break-word" }}>{developer && s.running ? <>{t("status.found", { found: s.elements, shown: s.results.length })}<br />{info}</> : s.status}</div></PanelSectionRow>
      </PanelSection>
      <PanelSection title={t("section.advanced")}>
        <PanelSectionRow>
          <ToggleField label={t("layer.label")} description={t("layer.desc")} checked={cfg.layer} onChange={(on: boolean) => update({ layer: on })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label={t("language.label")} rgOptions={[{ data: "auto", label: t("language.auto") }, ...UI_LANGUAGES.map((l) => ({ data: l.code, label: l.name }))]} selectedOption={cfg.ui_language} onChange={(o: any) => { setUiLanguage(o.data); update({ ui_language: o.data }); }} />
        </PanelSectionRow>
        {usage.memory_bytes > 0 ? (
          <PanelSectionRow>
            <ButtonItem layout="below" description={t("memory.desc", { games: usage.memory_games, size: megabytes(usage.memory_bytes) })} onClick={async () => { await clearMemory(); memory.load("", "", null); refreshUsage(); }}>{t("memory.clear")}</ButtonItem>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
      {developer ? <PanelSection title={t("section.diag")}>
        <PanelSectionRow>
          <ToggleField label={t("debug.label")} description={t("debug.desc")} checked={cfg.debug} onChange={(on: boolean) => update({ debug: on })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!s.running || rec === "..."} description={rec && rec !== "..." ? t("record.saved", { dir: rec }) : t("record.desc")} onClick={async () => { setRec("..."); const dir = await recordSession(10); setRec(dir); refreshUsage(); }}>
            {rec === "..." ? t("record.busy") : t("record.button")}
          </ButtonItem>
        </PanelSectionRow>
        {usage.records_bytes > 0 ? (
          <PanelSectionRow>
            <ButtonItem layout="below" description={t("records.desc", { count: usage.records_count, size: megabytes(usage.records_bytes), keep: usage.records_keep })} onClick={async () => { await clearRecords(); refreshUsage(); }}>{t("records.clear")}</ButtonItem>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!s.running} onClick={async () => { try { log("save: " + JSON.stringify(await (await fetch(`${BASE}/save`)).json())); } catch (e) { log("save failed: " + e); } }}>
            {t("saveFrame")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection> : null}
      <PanelSection>
        <PanelSectionRow>
          <Field focusable={true} bottomSeparator="none" onActivate={tapVersion} onClick={tapVersion}>
            <div style={{ fontSize: 11, opacity: 0.5 }}>Live Translator {version}</div>
          </Field>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  routerHook.addGlobalComponent("DltOverlay", OverlayLayer);
  log("plugin loaded, composition hook " + (useComposition ? "found" : "NOT found"));
  // What the player left on last time: the settings, and the translator itself when it was on
  setUiLanguage("auto");
  void getSettings().then((saved) => {
    if (!saved.developer) saved.debug = false;
    settings = saved;
    setUiLanguage(saved.ui_language);
    // A first start: the translation goes into the language of Steam (the game is read in English, or in Russian when Steam is English)
    if (saved.fresh) {
      const mine = steamLanguage();
      const target = TARGET_LANGUAGES.includes(mine) ? mine : "en";
      void changeSetting({ target, source: target === "en" ? "ru" : "en" });
    }
    if (saved.enabled) void startTranslating();
  }).catch((e) => log("settings not loaded: " + e));
  return {
    name: "Live Translator",
    titleView: <div>Live Translator</div>,
    content: <Content />,
    icon: <FaLanguage />,
    onDismount() {
      routerHook.removeGlobalComponent("DltOverlay");
      void stopTranslating();
    },
  };
});
