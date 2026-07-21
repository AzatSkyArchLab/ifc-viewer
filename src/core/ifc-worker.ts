/// <reference lib="webworker" />
//
// web-ifc host running off the main thread. The whole model (WASM memory)
// lives here, so a big file neither freezes the tab nor competes with three.js
// for the main thread's address space — the worker gets its own ~4 GB. The
// main thread talks to it through the IfcParser proxy; every heavy web-ifc call
// (parse, geometry, property reads) happens here and results are transferred
// back. Geometry buffers are sent as Transferables (zero-copy).

import {
  IfcAPI,
  LogLevel,
  IFCPRODUCT,
  IFCSPACE,
  IFCBUILDINGSTOREY,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCRELAGGREGATES,
} from "web-ifc";
import {
  makeKey,
  modelOfKey,
  expressOfKey,
  type IfcElement,
  type IfcElementInfo,
  type IfcMeshData,
  type IfcModel,
  type IfcProperty,
  type IfcPropertySet,
  type IfcStorey,
} from "./types.ts";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let api = new IfcAPI();
let ready = false;
let models: IfcModel[] = [];

async function init(wasmBase: string): Promise<void> {
  if (ready) return;
  // Absolute URL of the directory holding web-ifc.wasm, computed on the main
  // thread (a relative path would resolve against the worker script's URL, not
  // the app's, and miss the file).
  api.SetWasmPath(wasmBase, true);
  await api.Init();
  api.SetLogLevel(LogLevel.LOG_LEVEL_WARN);
  ready = true;
}

/** Past this upload size, coarser curves — tessellation is what runs out of memory. */
const COARSE_CURVES_BYTES = 120 * 1024 * 1024;

function open(data: Uint8Array, name: string, coordinateToOrigin: boolean): IfcModel {
  const settings: {
    MEMORY_LIMIT: number;
    CIRCLE_SEGMENTS?: number;
    COORDINATE_TO_ORIGIN?: boolean;
  } = { MEMORY_LIMIT: 3_000_000_000 };
  // Big models die with bad_alloc inside GetGeometry; halving the segments per
  // circle (web-ifc's default is 12) cuts the tessellation these produce, which
  // is the difference between a rough model and none at all.
  if (data.byteLength > COARSE_CURVES_BYTES) settings.CIRCLE_SEGMENTS = 6;
  if (coordinateToOrigin) settings.COORDINATE_TO_ORIGIN = true;
  const modelId = api.OpenModel(data, settings);
  const model = { modelId, name };
  models.push(model);
  return model;
}

function clearAll(): void {
  for (const m of models) {
    try {
      api.CloseModel(m.modelId);
    } catch {
      /* module already aborted */
    }
  }
  models = [];
}

// ── Elements ─────────────────────────────────────────────────────────────────

function getElements(): IfcElement[] {
  const out: IfcElement[] = [];
  for (const { modelId, name } of models) {
    const ids = api.GetLineIDsWithType(modelId, IFCPRODUCT, true);
    for (let i = 0; i < ids.size(); i++) {
      out.push(toElement(modelId, name, ids.get(i)));
    }
  }
  return out;
}

function toElement(modelId: number, modelName: string, expressID: number): IfcElement {
  const typeCode = api.GetLineType(modelId, expressID);
  let name: string | number | boolean | null = null;
  let globalId: string | number | boolean | null = null;
  try {
    const line = api.GetLine(modelId, expressID, false);
    name = scalar(line?.Name);
    globalId = scalar(line?.GlobalId);
  } catch {
    /* line without readable attributes */
  }
  return {
    key: makeKey(modelId, expressID),
    modelId,
    modelName,
    expressID,
    typeCode,
    typeName: typeName(typeCode),
    name: name != null ? String(name) : null,
    globalId: globalId != null ? String(globalId) : null,
  };
}

// ── Spatial structure (storeys) ──────────────────────────────────────────────

function getStoreys(): IfcStorey[] {
  const result: IfcStorey[] = [];
  for (const { modelId, name: modelName } of models) {
    const storeys = new Map<number, IfcStorey>();

    const ids = api.GetLineIDsWithType(modelId, IFCBUILDINGSTOREY);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      let name: string | number | boolean | null = null;
      let elevation: string | number | boolean | null = null;
      try {
        const line = api.GetLine(modelId, id, false);
        name = scalar(line?.Name);
        elevation = scalar(line?.Elevation);
      } catch {
        /* storey without readable attributes */
      }
      storeys.set(id, {
        key: makeKey(modelId, id),
        modelName,
        name: name != null ? String(name) : null,
        elevation: typeof elevation === "number" ? elevation : null,
        elementIds: [],
      });
    }

    const rels = api.GetLineIDsWithType(modelId, IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelId, rels.get(i), false);
      const sid = rel?.RelatingStructure?.value;
      const storey = typeof sid === "number" ? storeys.get(sid) : undefined;
      if (!storey) continue;
      const related = rel?.RelatedElements;
      if (Array.isArray(related)) {
        for (const r of related) {
          const eid = r?.value;
          if (typeof eid === "number") storey.elementIds.push(makeKey(modelId, eid));
        }
      }
    }

    const aggs = api.GetLineIDsWithType(modelId, IFCRELAGGREGATES);
    for (let i = 0; i < aggs.size(); i++) {
      const rel = api.GetLine(modelId, aggs.get(i), false);
      const pid = rel?.RelatingObject?.value;
      const storey = typeof pid === "number" ? storeys.get(pid) : undefined;
      if (!storey) continue;
      const related = rel?.RelatedObjects;
      if (Array.isArray(related)) {
        for (const r of related) {
          const eid = r?.value;
          if (typeof eid === "number") storey.elementIds.push(makeKey(modelId, eid));
        }
      }
    }

    result.push(...storeys.values());
  }
  return result.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
}

// ── Geometry (streamed, with progress) ───────────────────────────────────────

/** How many meshes to accumulate before shipping them out of the worker. */
const MESH_BATCH = 300;

/**
 * Extracts all meshes and ships them to the main thread in batches.
 *
 * Batching is what makes a big model possible: holding every mesh here until
 * the end piles hundreds of MB of typed arrays next to web-ifc's WASM heap and
 * starves it (`bad_alloc` inside GetGeometry). Sending each batch with its
 * buffers as Transferables hands the bytes to the main thread and frees them
 * here, so the worker only ever holds the model plus one batch.
 *
 * Coordinates stay in the world frame — the common recentring offset is only
 * known once every mesh is seen, so the final bbox is returned and the main
 * thread applies it.
 */
function getMeshes(id: number): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  let batch: IfcMeshData[] = [];
  const bbox = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  let done = 0;
  let seenTotal = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const transfer: ArrayBuffer[] = [];
    for (const mesh of batch) {
      transfer.push(
        mesh.positions.buffer as ArrayBuffer,
        mesh.normals.buffer as ArrayBuffer,
        mesh.indices.buffer as ArrayBuffer,
      );
    }
    ctx.postMessage(
      { cmd: "meshBatch", id, meshes: batch, done, total: seenTotal },
      transfer,
    );
    batch = []; // buffers are gone from this thread now
  };

  for (const { modelId } of models) {
    const push = (mesh: any, isSpace: boolean, total: number): void => {
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        let geom;
        try {
          geom = api.GetGeometry(modelId, pg.geometryExpressID);
        } catch (err) {
          console.warn(`[web-ifc] пропущена геометрия #${pg.geometryExpressID}:`, err);
          continue;
        }
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const m = pg.flatTransformation;

        const vertexCount = verts.length / 6;
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        for (let v = 0; v < vertexCount; v++) {
          const lx = verts[v * 6], ly = verts[v * 6 + 1], lz = verts[v * 6 + 2];
          const nx = verts[v * 6 + 3], ny = verts[v * 6 + 4], nz = verts[v * 6 + 5];
          const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          positions[v * 3] = wx;
          positions[v * 3 + 1] = wy;
          positions[v * 3 + 2] = wz;
          normals[v * 3] = m[0] * nx + m[4] * ny + m[8] * nz;
          normals[v * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
          normals[v * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
          if (!isSpace) {
            if (wx < bbox.minX) bbox.minX = wx;
            if (wy < bbox.minY) bbox.minY = wy;
            if (wz < bbox.minZ) bbox.minZ = wz;
            if (wx > bbox.maxX) bbox.maxX = wx;
            if (wy > bbox.maxY) bbox.maxY = wy;
            if (wz > bbox.maxZ) bbox.maxZ = wz;
          }
        }

        batch.push({
          key: makeKey(modelId, mesh.expressID),
          space: isSpace,
          positions,
          normals,
          indices: new Uint32Array(indices),
          color: { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w },
        });
      }
      done++;
      seenTotal = total;
      // Ship the batch out (and free it here) as soon as it is full. This also
      // drives the progress bar, which paints because the main thread is free.
      if (batch.length >= MESH_BATCH) flush();
    };

    api.StreamAllMeshes(modelId, (mesh, _i, total) => push(mesh, false, total));
    api.StreamAllMeshesWithTypes(modelId, [IFCSPACE], (mesh, _i, total) =>
      push(mesh, true, total),
    );
  }

  flush(); // whatever is left after the last full batch
  return bbox;
}

// ── Properties of one element ─────────────────────────────────────────────────

async function getElementInfo(key: number): Promise<IfcElementInfo> {
  const modelId = modelOfKey(key);
  const expressID = expressOfKey(key);
  const modelName = models.find((m) => m.modelId === modelId)?.name ?? "";
  const element = toElement(modelId, modelName, expressID);
  const attributes = readAttributes(modelId, expressID);
  const propertySets = await readPropertySets(modelId, expressID);
  return { element, attributes, propertySets };
}

function readAttributes(modelId: number, expressID: number): IfcProperty[] {
  const line = api.GetLine(modelId, expressID, false);
  const out: IfcProperty[] = [];
  for (const k of Object.keys(line)) {
    if (k === "expressID" || k === "type") continue;
    const raw = line[k];
    const value = displayValue(raw);
    if (value === null && Array.isArray(raw) && raw.length === 0) continue;
    out.push({ name: k, value });
  }
  return out;
}

async function readPropertySets(
  modelId: number,
  expressID: number,
): Promise<IfcPropertySet[]> {
  const sets: IfcPropertySet[] = [];
  try {
    const direct = await api.properties.getPropertySets(modelId, expressID, true, false);
    for (const ps of direct as Record<string, any>[]) pushSet(ps, sets, false);
  } catch {
    /* element has no properties */
  }
  try {
    const types = await api.properties.getTypeProperties(modelId, expressID, true);
    for (const t of types as Record<string, any>[]) {
      const has = t?.HasPropertySets;
      if (Array.isArray(has)) for (const ps of has) pushSet(ps, sets, true);
    }
  } catch {
    /* element has no type — normal */
  }
  return sets;
}

function pushSet(ps: Record<string, any>, sets: IfcPropertySet[], fromType: boolean): void {
  if (!ps) return;
  const name = scalar(ps?.Name);
  if (Array.isArray(ps?.HasProperties)) {
    sets.push({
      expressID: ps.expressID,
      name: name != null ? String(name) : "(Pset без имени)",
      kind: fromType ? "type" : "pset",
      properties: ps.HasProperties.map((p: any) => toProperty(p)).filter(
        Boolean,
      ) as IfcProperty[],
    });
  } else if (Array.isArray(ps?.Quantities)) {
    sets.push({
      expressID: ps.expressID,
      name: name != null ? String(name) : "(Qto без имени)",
      kind: "qto",
      properties: ps.Quantities.map((q: any) => toQuantity(q)).filter(
        Boolean,
      ) as IfcProperty[],
    });
  }
}

function toProperty(p: Record<string, any>): IfcProperty | null {
  const name = scalar(p?.Name);
  if (name == null) return null;
  let value: IfcProperty["value"] = null;
  if (p.NominalValue !== undefined) value = primitive(p.NominalValue);
  else if (Array.isArray(p.EnumerationValues))
    value = p.EnumerationValues.map((v: any) => primitive(v)).join(", ");
  else if (Array.isArray(p.ListValues))
    value = p.ListValues.map((v: any) => primitive(v)).join(", ");
  const unit = scalar(p?.Unit);
  return { name: String(name), value, unit: unit != null ? String(unit) : undefined };
}

function toQuantity(q: Record<string, any>): IfcProperty | null {
  const name = scalar(q?.Name);
  if (name == null) return null;
  const valueKey = [
    "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue",
  ].find((k) => q[k] !== undefined);
  const value = valueKey ? primitive(q[valueKey]) : null;
  return { name: String(name), value };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function typeName(typeCode: number): string {
  try {
    return api.GetNameFromTypeCode(typeCode);
  } catch {
    return `TYPE_${typeCode}`;
  }
}

function scalar(v: any): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  if (typeof v === "object") return null;
  return v;
}

function primitive(v: any): string | number | boolean | null {
  return scalar(v);
}

function displayValue(v: any): string | number | boolean | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => displayValue(x)).filter((x) => x != null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    if (v.type === 5 && typeof v.value === "number") return `#${v.value}`;
    if ("value" in v) return v.value ?? null;
    return null;
  }
  return v;
}

// ── Message dispatch ──────────────────────────────────────────────────────────

interface Msg {
  id: number;
  cmd: string;
  data?: ArrayBuffer;
  name?: string;
  coordinateToOrigin?: boolean;
  wasmBase?: string;
  key?: number;
}

ctx.onmessage = async (event: MessageEvent<Msg>): Promise<void> => {
  const msg = event.data;
  try {
    switch (msg.cmd) {
      case "open": {
        await init(msg.wasmBase ?? "/");
        const bytes = new Uint8Array(msg.data!);
        // Guard against a non-IFC or truncated upload: without this web-ifc
        // fails deep in OpenModel with an opaque "reading 'arguments'".
        const head = String.fromCharCode(...bytes.slice(0, 16));
        if (bytes.byteLength < 20 || !head.includes("ISO-10303")) {
          throw new Error("файл не похож на IFC (нет заголовка ISO-10303-21)");
        }
        const model = open(bytes, msg.name!, !!msg.coordinateToOrigin);
        ctx.postMessage({ id: msg.id, ok: true, result: { model, models } });
        break;
      }
      case "elements":
        ctx.postMessage({ id: msg.id, ok: true, result: getElements() });
        break;
      case "storeys":
        ctx.postMessage({ id: msg.id, ok: true, result: getStoreys() });
        break;
      case "meshes":
        // Meshes stream out in batches; the reply carries only the final bbox,
        // which the main thread uses to recentre what it collected.
        ctx.postMessage({ id: msg.id, ok: true, result: getMeshes(msg.id) });
        break;
      case "elementInfo":
        ctx.postMessage({ id: msg.id, ok: true, result: await getElementInfo(msg.key!) });
        break;
      case "clear":
        clearAll();
        ctx.postMessage({ id: msg.id, ok: true, result: null });
        break;
      default:
        ctx.postMessage({ id: msg.id, ok: false, message: `unknown cmd ${msg.cmd}` });
    }
  } catch (err) {
    ctx.postMessage({
      id: msg.id,
      ok: false,
      message: `[${msg.cmd}] ${(err as Error)?.message ?? String(err)}`,
    });
  }
};
