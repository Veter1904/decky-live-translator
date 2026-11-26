// The memory of translations of one game: what was translated is kept (on disk, by the backend), so that the same text is translated at once and the same way the next time,
// in this run and in the next ones. The glossary of the game is a file that the player may edit by hand: it wins over everything and is never changed by the program.

export interface MemoryEntry { t: string; n: number; at: number }
export interface MemoryFile { name?: string; entries: Record<string, MemoryEntry>; glossary: Record<string, string> }

// A text is looked up as it was read, only with the white space made even ("Back  to list" and "Back to list" are one text)
export function memoryKey(source: string, target: string, text: string): string {
  return `${source}>${target}|${text.trim().replace(/\s+/g, " ")}`;
}

export class TranslationMemory {
  game = "";
  name = "";
  entries = new Map<string, MemoryEntry>();
  glossary = new Map<string, string>();
  // Something was added or used since the last save
  dirty = false;
  hits = 0;
  misses = 0;
  // The most texts that are kept for one game (the least used and oldest go first)
  static readonly MAX_ENTRIES = 5000;
  // A text longer than this is not kept (a long text hardly comes again, and it takes room)
  static readonly MAX_LENGTH = 700;
  // A text that was used once is forgotten when it has not been used for this many days
  static readonly STALE_DAYS = 60;

  /** Starts a game: what was kept for it replaces what is in memory now. */
  load(game: string, name: string, file: Partial<MemoryFile> | null): void {
    this.game = game;
    this.name = name;
    // A text that was seen once and not for a long time is a reading mistake or a one-time text: it is not taken along (the memory must not fill up with them)
    const stale = Date.now() - TranslationMemory.STALE_DAYS * 86400000;
    this.entries = new Map(Object.entries(file?.entries ?? {}).filter(([, e]) => e && typeof e.t === "string" && !(e.n <= 1 && e.at < stale)));
    this.glossary = new Map(Object.entries(file?.glossary ?? {}).filter(([, t]) => typeof t === "string"));
    this.dirty = false;
    this.hits = 0;
    this.misses = 0;
  }

  /** The translation that was kept for the text, or null. The glossary of the game comes first. */
  get(source: string, target: string, text: string): string | null {
    const normal = text.trim().replace(/\s+/g, " ");
    const fixed = this.glossary.get(normal);
    if (fixed !== undefined && fixed !== "") {
      this.hits++;
      return fixed;
    }
    const entry = this.entries.get(memoryKey(source, target, text));
    if (entry === undefined || entry.t === "") {
      this.misses++;
      return null;
    }
    entry.n++;
    entry.at = Date.now();
    this.hits++;
    // Use is counted, but the file is not written for it alone (only when something was added or a minute has passed: see the caller)
    return entry.t;
  }

  /** Keeps a translation (a better one replaces an older one). Nothing is kept for an empty or unchanged text. */
  put(source: string, target: string, text: string, translated: string): void {
    const normal = text.trim().replace(/\s+/g, " ");
    if (this.game === "" || normal === "" || translated.trim() === "" || normal.length > TranslationMemory.MAX_LENGTH || translated.trim() === normal) {
      return;
    }
    if (this.glossary.has(normal)) {
      return;
    }
    const key = memoryKey(source, target, text);
    const old = this.entries.get(key);
    if (old !== undefined && old.t === translated) {
      return;
    }
    this.entries.set(key, { t: translated, n: old === undefined ? 1 : old.n, at: Date.now() });
    this.dirty = true;
    if (this.entries.size > TranslationMemory.MAX_ENTRIES + 200) {
      this.prune();
    }
  }

  /** Drops the least used (then the oldest) texts down to the limit. */
  prune(): void {
    if (this.entries.size <= TranslationMemory.MAX_ENTRIES) {
      return;
    }
    const order = Array.from(this.entries.entries()).sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at);
    this.entries = new Map(order.slice(0, TranslationMemory.MAX_ENTRIES));
  }

  /** What is written to the file (the glossary is left to the backend: it is not changed by the program). */
  snapshot(): { name: string; entries: Record<string, MemoryEntry> } {
    this.prune();
    return { name: this.name, entries: Object.fromEntries(this.entries) };
  }
}
