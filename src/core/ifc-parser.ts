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
      /** Mesh batches streamed in before the final reply (geometry only). */
      chunks: IfcMeshData[];
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
    const p = this.pending.get(msg?.id);
    if (!p) return;
    if (msg.cmd === "progress") {
      p.onProgress?.(msg.done, msg.total);
      return;
    }
    if (msg.cmd === "meshBatch") {
      // Geometry arrives in batches so the worker can free each one; collect
      // them here, where this thread's own address space holds them.
      for (const mesh of msg.meshes as IfcMeshData[]) p.chunks.push(mesh);
      p.onProgress?.(msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve({ result: msg.result, chunks: p.chunks });
    else p.reject(new Error(msg.message || "worker error"));
  }

  /** A fatal worker error (e.g. a hard WASM trap) — fail everything in flight. */
  private onCrash(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  /** Resolves with the worker's reply plus any batches streamed before it. */
  private call(
    cmd: string,
    args: Record<string, unknown> = {},
    transfer: Transferable[] = [],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ result: any; chunks: IfcMeshData[] }> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, chunks: [] });
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
    this.models = res.result.models;
    return res.result.model.modelId;
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

  async getElements(): Promise<IfcElement[]> {
    return (await this.call("elements")).result;
  }

  async getStoreys(): Promise<IfcStorey[]> {
    return (await this.call("storeys")).result;
  }

  /**
   * Collects the geometry the worker streams out in batches, then recentres it
   * on the model's bounding box (the worker can't do that — the box is only
   * complete once the last mesh is out, and by then the batches have left).
   * `onProgress` fires as batches arrive.
   */
  async getMeshes(
    onProgress?: (done: number, total: number) => void,
  ): Promise<IfcMeshData[]> {
    const { result: bbox, chunks } = await this.call("meshes", {}, [], onProgress);
    if (!Number.isFinite(bbox?.minX)) return chunks;
    const ox = (bbox.minX + bbox.maxX) / 2;
    const oy = (bbox.minY + bbox.maxY) / 2;
    const oz = (bbox.minZ + bbox.maxZ) / 2;
    for (const mesh of chunks) {
      const p = mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        p[i] -= ox;
        p[i + 1] -= oy;
        p[i + 2] -= oz;
      }
    }
    return chunks;
  }

  async getElementInfo(key: number): Promise<IfcElementInfo> {
    return (await this.call("elementInfo", { key })).result;
  }
}
