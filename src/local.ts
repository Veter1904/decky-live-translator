// The local translator: Bergamot / Marian (the translator of Firefox) in WASM, in a worker of the page. The worker, the engine and the models
// are served by the capture helper (/assets/bergamot, /models); the models are downloaded by the backend. A translation takes some
// milliseconds and needs no internet. The same engine as in Greenlight (MPL-2.0).

const PIVOT = "en";

export type LocalStatus = { state: "off" | "loading" | "ready" | "error"; message: string };

export class LocalTranslator {
  private worker: Worker | null = null;
  private serial = 0;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private starting: Promise<void> | null = null;
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  status: LocalStatus = { state: "off", message: "" };

  constructor(private base: string, private log: (message: string) => void = () => {}) {}

  private call(name: string, args: any[], transfer: Transferable[] = []): Promise<any> {
    return new Promise((ok, fail) => {
      const id = ++this.serial;
      this.waiting.set(id, { ok, fail });
      this.worker!.postMessage({ id, name, args }, transfer);
    });
  }

  /** Starts the worker (the WASM runtime). Safe to call again. */
  start(): Promise<void> {
    if (this.starting === null) {
      this.status = { state: "loading", message: "" };
      this.starting = (async () => {
        const root = `${this.base}/assets/bergamot/`;
        let code = await (await fetch(root + "translator-worker.js")).text();
        // The worker is made from a blob: the files it reads have to be named with their full address
        code = code.replace("new URL('./bergamot-translator-worker.wasm', self.location)", JSON.stringify(root + "bergamot-translator-worker.wasm"))
          .replace("self.importScripts('bergamot-translator-worker.js')", `self.importScripts(${JSON.stringify(root + "bergamot-translator-worker.js")})`);
        if (code.indexOf(root) < 0) {
          throw new Error("the worker of the local translator was not recognised");
        }
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        this.worker = new Worker(url);
        this.worker.onmessage = (event: MessageEvent) => {
          const { id, result, error } = event.data || {};
          const pending = this.waiting.get(id);
          if (pending === undefined) { return; }
          this.waiting.delete(id);
          if (error !== undefined) { pending.fail(new Error(error.message || String(error))); } else { pending.ok(result); }
        };
        this.worker.onerror = (event) => this.log("local translator worker error: " + event.message);
        await this.call("initialize", [{ useNativeIntGemm: false, cacheSize: 0 }]);
        this.status = { state: "ready", message: "" };
      })().catch((error) => {
        this.status = { state: "error", message: String(error) };
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  /** The models a translation needs: one direct pair or two through English. */
  static pairs(source: string, target: string, available: string[]): Array<[string, string]> {
    if (source === target) { return []; }
    if (available.includes(source + target)) { return [[source, target]]; }
    if (available.includes(source + PIVOT) && available.includes(PIVOT + target)) { return [[source, PIVOT], [PIVOT, target]]; }
    return [];
  }

  private async file(pair: string, part: string): Promise<ArrayBuffer> {
    const response = await fetch(`${this.base}/models/${pair}/${part}`);
    if (!response.ok) { throw new Error(`model file ${pair}/${part}: ${response.status}`); }
    return response.arrayBuffer();
  }

  /** Reads the files of one pair into the worker (once). */
  loadPair(from: string, to: string): Promise<void> {
    const key = from + to;
    if (this.loaded.has(key)) { return Promise.resolve(); }
    let pending = this.loading.get(key);
    if (pending === undefined) {
      pending = (async () => {
        await this.start();
        const [model, lex, vocab] = await Promise.all([this.file(key, "model"), this.file(key, "lex"), this.file(key, "vocab")]);
        await this.call("loadTranslationModel", [{ from, to }, { model, shortlist: lex, vocabs: [vocab], config: {} }]);
        this.loaded.add(key);
      })().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** Translates a text. `pairs` comes from LocalTranslator.pairs. Throws when the models are not loaded yet or the worker fails. */
  async translate(text: string, pairs: Array<[string, string]>): Promise<string> {
    if (pairs.length === 0) { throw new Error("no model for this language pair"); }
    for (const [from, to] of pairs) {
      if (!this.loaded.has(from + to)) { throw new Error("model not loaded: " + from + to); }
    }
    const answer = await this.call("translate", [{ models: pairs.map(([from, to]) => ({ from, to })), texts: [{ text, html: false }] }]);
    return String(answer?.[0]?.target?.text ?? "");
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
    this.loaded.clear();
    this.loading.clear();
    this.waiting.clear();
    this.status = { state: "off", message: "" };
  }
}
