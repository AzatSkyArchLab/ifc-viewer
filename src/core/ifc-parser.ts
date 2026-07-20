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

/**
 * Thin modular wrapper around web-ifc. Holds several open models at once so
 * they share one 3D scene; everything is addressed by a composite key
 * (modelId * KEY_BASE + expressID). Framework-free — no three.js, no DOM.
 */
export class IfcParser {
  private api: IfcAPI;
  private ready = false;
  private models: IfcModel[] = [];

  constructor() {
    this.api = new IfcAPI();
  }

  /** Initialises the WASM module. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    this.api.SetWasmPath(import.meta.env.BASE_URL, true);
    await this.api.Init();
    // Surface web-ifc's own diagnostics: on a bad file it logs the offending
    // entity to the console before it may abort, which is our only clue.
    this.api.SetLogLevel(LogLevel.LOG_LEVEL_WARN);
    this.ready = true;
  }

  /**
   * Opens one model from raw bytes and registers it. Returns its model id.
   * `coordinateToOrigin` translates far-from-origin geometry (georeferenced /
   * МСК models) back to the origin — without it web-ifc's tessellation can hit
   * float-precision limits and call abort(); used on the safe-mode retry.
   */
  async add(
    data: Uint8Array,
    name: string,
    opts: { coordinateToOrigin?: boolean } = {},
  ): Promise<number> {
    await this.init();
    const modelId = opts.coordinateToOrigin
      ? this.api.OpenModel(data, { COORDINATE_TO_ORIGIN: true })
      : this.api.OpenModel(data);
    this.models.push({ modelId, name });
    return modelId;
  }

  /**
   * Rebuilds the WASM module. A web-ifc abort() leaves the module dead — every
   * later call throws — so after a failed load we recreate it, otherwise the
   * whole session is stuck until a page reload.
   */
  async recover(): Promise<void> {
    try {
      this.clearAll();
    } catch {
      /* module already aborted — nothing to close */
    }
    this.api = new IfcAPI();
    this.ready = false;
    this.models = [];
    await this.init();
  }

  /** Closes every open model. */
  clearAll(): void {
    for (const m of this.models) this.api.CloseModel(m.modelId);
    this.models = [];
  }

  getModels(): IfcModel[] {
    return [...this.models];
  }

  get isOpen(): boolean {
    return this.models.length > 0;
  }

  // ── Elements ───────────────────────────────────────────────────────────────

  /** All elements across all loaded models (IfcProduct subtypes). */
  getElements(): IfcElement[] {
    const out: IfcElement[] = [];
    for (const { modelId, name } of this.models) {
      const ids = this.api.GetLineIDsWithType(modelId, IFCPRODUCT, true);
      for (let i = 0; i < ids.size(); i++) {
        out.push(this.toElement(modelId, name, ids.get(i)));
      }
    }
    return out;
  }

  private toElement(
    modelId: number,
    modelName: string,
    expressID: number,
  ): IfcElement {
    const typeCode = this.api.GetLineType(modelId, expressID);
    let name: string | number | boolean | null = null;
    let globalId: string | number | boolean | null = null;
    try {
      const line = this.api.GetLine(modelId, expressID, false);
      name = this.scalar(line?.Name);
      globalId = this.scalar(line?.GlobalId);
    } catch {
      /* line without readable attributes — keep null */
    }
    return {
      key: makeKey(modelId, expressID),
      modelId,
      modelName,
      expressID,
      typeCode,
      typeName: this.typeName(typeCode),
      name: name != null ? String(name) : null,
      globalId: globalId != null ? String(globalId) : null,
    };
  }

  // ── Spatial structure (storeys) ────────────────────────────────────────────

  /** Building storeys across all models; elementIds are composite keys. */
  getStoreys(): IfcStorey[] {
    const result: IfcStorey[] = [];
    for (const { modelId, name: modelName } of this.models) {
      const storeys = new Map<number, IfcStorey>();

      const ids = this.api.GetLineIDsWithType(modelId, IFCBUILDINGSTOREY);
      for (let i = 0; i < ids.size(); i++) {
        const id = ids.get(i);
        let name: string | number | boolean | null = null;
        let elevation: string | number | boolean | null = null;
        try {
          const line = this.api.GetLine(modelId, id, false);
          name = this.scalar(line?.Name);
          elevation = this.scalar(line?.Elevation);
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

      // Physical elements: contained in the storey (walls, columns, ...).
      const rels = this.api.GetLineIDsWithType(
        modelId,
        IFCRELCONTAINEDINSPATIALSTRUCTURE,
      );
      for (let i = 0; i < rels.size(); i++) {
        const rel = this.api.GetLine(modelId, rels.get(i), false);
        const sid = rel?.RelatingStructure?.value;
        const storey = typeof sid === "number" ? storeys.get(sid) : undefined;
        if (!storey) continue;
        const related = rel?.RelatedElements;
        if (Array.isArray(related)) {
          for (const r of related) {
            const eid = r?.value;
            if (typeof eid === "number") {
              storey.elementIds.push(makeKey(modelId, eid));
            }
          }
        }
      }

      // IfcSpace is aggregated under the storey (decomposition), not contained.
      const aggs = this.api.GetLineIDsWithType(modelId, IFCRELAGGREGATES);
      for (let i = 0; i < aggs.size(); i++) {
        const rel = this.api.GetLine(modelId, aggs.get(i), false);
        const pid = rel?.RelatingObject?.value;
        const storey = typeof pid === "number" ? storeys.get(pid) : undefined;
        if (!storey) continue;
        const related = rel?.RelatedObjects;
        if (Array.isArray(related)) {
          for (const r of related) {
            const eid = r?.value;
            if (typeof eid === "number") {
              storey.elementIds.push(makeKey(modelId, eid));
            }
          }
        }
      }

      result.push(...storeys.values());
    }
    return result.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  }

  // ── Properties of the selected element ─────────────────────────────────────

  /** Full element card for a composite key: attributes + property/quantity sets. */
  async getElementInfo(key: number): Promise<IfcElementInfo> {
    const modelId = modelOfKey(key);
    const expressID = expressOfKey(key);
    const modelName = this.models.find((m) => m.modelId === modelId)?.name ?? "";
    const element = this.toElement(modelId, modelName, expressID);
    const attributes = this.readAttributes(modelId, expressID);
    const propertySets = await this.readPropertySets(modelId, expressID);
    return { element, attributes, propertySets };
  }

  /** Direct entity attributes (Name, ObjectType, Tag, PredefinedType, ...). */
  private readAttributes(modelId: number, expressID: number): IfcProperty[] {
    const line = this.api.GetLine(modelId, expressID, false);
    const out: IfcProperty[] = [];
    for (const key of Object.keys(line)) {
      if (key === "expressID" || key === "type") continue;
      const raw = line[key];
      const value = this.displayValue(raw);
      if (value === null && Array.isArray(raw) && raw.length === 0) continue;
      out.push({ name: key, value });
    }
    return out;
  }

  /** Property/quantity sets bound to the element (its own + type-level). */
  private async readPropertySets(
    modelId: number,
    expressID: number,
  ): Promise<IfcPropertySet[]> {
    const sets: IfcPropertySet[] = [];
    try {
      const direct = await this.api.properties.getPropertySets(
        modelId,
        expressID,
        true,
        false,
      );
      for (const ps of direct as Record<string, any>[]) this.pushSet(ps, sets, false);
    } catch {
      /* element has no properties */
    }
    try {
      const types = await this.api.properties.getTypeProperties(
        modelId,
        expressID,
        true,
      );
      for (const t of types as Record<string, any>[]) {
        const has = t?.HasPropertySets;
        if (Array.isArray(has)) for (const ps of has) this.pushSet(ps, sets, true);
      }
    } catch {
      /* element has no type — this is normal */
    }
    return sets;
  }

  private pushSet(
    ps: Record<string, any>,
    sets: IfcPropertySet[],
    fromType: boolean,
  ): void {
    if (!ps) return;
    const name = this.scalar(ps?.Name);
    if (Array.isArray(ps?.HasProperties)) {
      sets.push({
        expressID: ps.expressID,
        name: name != null ? String(name) : "(Pset без имени)",
        kind: fromType ? "type" : "pset",
        properties: ps.HasProperties.map((p: any) => this.toProperty(p)).filter(
          Boolean,
        ) as IfcProperty[],
      });
    } else if (Array.isArray(ps?.Quantities)) {
      sets.push({
        expressID: ps.expressID,
        name: name != null ? String(name) : "(Qto без имени)",
        kind: "qto",
        properties: ps.Quantities.map((q: any) => this.toQuantity(q)).filter(
          Boolean,
        ) as IfcProperty[],
      });
    }
  }

  private toProperty(p: Record<string, any>): IfcProperty | null {
    const name = this.scalar(p?.Name);
    if (name == null) return null;
    let value: IfcProperty["value"] = null;
    if (p.NominalValue !== undefined) value = this.primitive(p.NominalValue);
    else if (Array.isArray(p.EnumerationValues))
      value = p.EnumerationValues.map((v: any) => this.primitive(v)).join(", ");
    else if (Array.isArray(p.ListValues))
      value = p.ListValues.map((v: any) => this.primitive(v)).join(", ");
    const unit = this.scalar(p?.Unit);
    return {
      name: String(name),
      value,
      unit: unit != null ? String(unit) : undefined,
    };
  }

  private toQuantity(q: Record<string, any>): IfcProperty | null {
    const name = this.scalar(q?.Name);
    if (name == null) return null;
    const valueKey = [
      "LengthValue",
      "AreaValue",
      "VolumeValue",
      "CountValue",
      "WeightValue",
      "TimeValue",
    ].find((k) => q[k] !== undefined);
    const value = valueKey ? this.primitive(q[valueKey]) : null;
    return { name: String(name), value };
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  /**
   * Extracts geometry for all models in a common (recentred) world frame, so
   * they keep their relative positions. Each mesh is tagged with its composite
   * key and an `space` flag (IfcSpace → translucent).
   */
  getMeshes(): IfcMeshData[] {
    const meshes: IfcMeshData[] = [];
    const bbox = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    };

    for (const { modelId } of this.models) {
      const push = (mesh: any, isSpace: boolean): void => {
        const placed = mesh.geometries;
        for (let i = 0; i < placed.size(); i++) {
          const pg = placed.get(i);
          let geom;
          try {
            geom = this.api.GetGeometry(modelId, pg.geometryExpressID);
          } catch (err) {
            // A single malformed geometry is skipped, not fatal for the model.
            console.warn(
              `[web-ifc] пропущена геометрия #${pg.geometryExpressID}:`,
              err,
            );
            continue;
          }
          const verts = this.api.GetVertexArray(
            geom.GetVertexData(),
            geom.GetVertexDataSize(),
          );
          const indices = this.api.GetIndexArray(
            geom.GetIndexData(),
            geom.GetIndexDataSize(),
          );
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
            // Spaces sit inside the building, so they do not extend the bbox.
            if (!isSpace) {
              if (wx < bbox.minX) bbox.minX = wx;
              if (wy < bbox.minY) bbox.minY = wy;
              if (wz < bbox.minZ) bbox.minZ = wz;
              if (wx > bbox.maxX) bbox.maxX = wx;
              if (wy > bbox.maxY) bbox.maxY = wy;
              if (wz > bbox.maxZ) bbox.maxZ = wz;
            }
          }

          meshes.push({
            key: makeKey(modelId, mesh.expressID),
            space: isSpace,
            positions,
            normals,
            indices: new Uint32Array(indices),
            color: { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w },
          });
        }
      };

      // Default stream skips IfcSpace; add a second pass so rooms are shown.
      this.api.StreamAllMeshes(modelId, (mesh) => push(mesh, false));
      this.api.StreamAllMeshesWithTypes(modelId, [IFCSPACE], (mesh) =>
        push(mesh, true),
      );
    }

    const has = Number.isFinite(bbox.minX);
    const offset = has
      ? {
          x: (bbox.minX + bbox.maxX) / 2,
          y: (bbox.minY + bbox.maxY) / 2,
          z: (bbox.minZ + bbox.maxZ) / 2,
        }
      : { x: 0, y: 0, z: 0 };
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length; i += 3) {
        m.positions[i] -= offset.x;
        m.positions[i + 1] -= offset.y;
        m.positions[i + 2] -= offset.z;
      }
    }
    return meshes;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private typeName(typeCode: number): string {
    try {
      return this.api.GetNameFromTypeCode(typeCode);
    } catch {
      return `TYPE_${typeCode}`;
    }
  }

  private scalar(v: any): string | number | boolean | null {
    if (v == null) return null;
    if (typeof v === "object" && "value" in v) return v.value ?? null;
    if (typeof v === "object") return null;
    return v;
  }

  private primitive(v: any): string | number | boolean | null {
    return this.scalar(v);
  }

  private displayValue(v: any): string | number | boolean | null {
    if (v == null) return null;
    if (Array.isArray(v)) {
      const parts = v.map((x) => this.displayValue(x)).filter((x) => x != null);
      return parts.length ? parts.join(", ") : null;
    }
    if (typeof v === "object") {
      if (v.type === 5 && typeof v.value === "number") return `#${v.value}`;
      if ("value" in v) return v.value ?? null;
      return null;
    }
    return v;
  }
}
