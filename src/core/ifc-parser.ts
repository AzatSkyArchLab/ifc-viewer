import type {
  IfcElement,
  IfcElementInfo,
  IfcMeshData,
  IfcModel,
  IfcStorey,
} from "./types.ts";

/**
 * Main-thread proxy to the web-ifc worker. The model and all WASM memory live
 * in the worker (see ifc-worker.ts), so parsing and geometry never block the
 * tab and get their own address space. This class keeps the same public shape
 * the app used before; the heavy calls are now async round-trips, while
 * `getModels` stays synchronous by caching what the worker returns from `add`.
 */
export class IfcParser {
  private worker!: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      onProgress?: (done: number, total: number) => void;
    }
  >();
  private models: IfcModel[] = [];

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(new URL("./ifc-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.onCrash(e.message || "worker error");
    this.worker.onmessageerror = () => this.onCrash("worker message error");
  }

  private onMessage(msg: any): void {
    if (msg?.cmd === "progress") {
      this.pending.get(msg.id)?.onProgress?.(msg.done, msg.total);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.message || "worker error"));
  }

  /** A fatal worker error (e.g. a hard WASM trap) — fail everything in flight. */
  private onCrash(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  private call(
    cmd: string,
    args: Record<string, unknown> = {},
    transfer: Transferable[] = [],
    onProgress?: (done: number, total: number) => void,
  ): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, cmd, ...args }, transfer);
    });
  }

  /**
   * Opens one model in the worker. `data`'s buffer is transferred (not copied),
   * so a 300 MB upload does not double in memory; `data` must not be reused
   * after this call.
   */
  async add(
    data: Uint8Array,
    name: string,
    opts: { coordinateToOrigin?: boolean } = {},
  ): Promise<number> {
    // Resolve the wasm directory here (main thread), where the app's base URL is
    // known; the worker can't derive it from its own script location.
    const wasmBase = new URL(import.meta.env.BASE_URL, location.href).href;
    const res = await this.call(
      "open",
      {
        data: data.buffer,
        name,
        coordinateToOrigin: !!opts.coordinateToOrigin,
        wasmBase,
      },
      [data.buffer],
    );
    this.models = res.models;
    return res.model.modelId;
  }

  /** Discards the worker and its dead WASM module, then starts a fresh one. */
  async recover(): Promise<void> {
    this.worker.terminate();
    this.onCrash("recovering");
    this.models = [];
    this.spawn();
  }

  /** Closes every open model in the worker; the cache is cleared immediately. */
  clearAll(): void {
    this.models = [];
    void this.call("clear").catch(() => {});
  }

  /** Cached — set from the worker's `add` replies, so this stays synchronous. */
  getModels(): IfcModel[] {
    return [...this.models];
  }

  get isOpen(): boolean {
    return this.models.length > 0;
  }

  getElements(): Promise<IfcElement[]> {
    return this.call("elements");
  }

  getStoreys(): Promise<IfcStorey[]> {
    return this.call("storeys");
  }

  /** Streams geometry from the worker; `onProgress` fires as meshes are built. */
  getMeshes(onProgress?: (done: number, total: number) => void): Promise<IfcMeshData[]> {
    return this.call("meshes", {}, [], onProgress);
  }

  getElementInfo(key: number): Promise<IfcElementInfo> {
    return this.call("elementInfo", { key });
  }
}
