/**
 * Domain types of the IFC parser.
 * Deliberately independent of web-ifc and three.js — this is the contract
 * between the core, the viewer and the UI panels.
 */

/**
 * Several models share one 3D scene, but expressIDs collide across files, so
 * every element/mesh is addressed by a composite `key = modelId * KEY_BASE +
 * expressID`. KEY_BASE exceeds any real expressID (models stay under ~50M lines).
 */
export const KEY_BASE = 100_000_000;

export function makeKey(modelId: number, expressID: number): number {
  return modelId * KEY_BASE + expressID;
}

export function modelOfKey(key: number): number {
  return Math.floor(key / KEY_BASE);
}

export function expressOfKey(key: number): number {
  return key % KEY_BASE;
}

/** One loaded model. */
export interface IfcModel {
  modelId: number;
  name: string;
}

/** Short element record (for the list / tree). */
export interface IfcElement {
  /** Composite scene key (modelId * KEY_BASE + expressID). */
  key: number;
  /** web-ifc model id this element belongs to. */
  modelId: number;
  /** File name of the owning model (for grouping in the list). */
  modelName: string;
  /** express ID — line number inside its IFC file (for display). */
  expressID: number;
  /** Numeric web-ifc type code (e.g. the IFCWALL code). */
  typeCode: number;
  /** Human-readable type name, e.g. "IFCWALL". */
  typeName: string;
  /** Name attribute, if present. */
  name: string | null;
  /** GlobalId (GUID), if present. */
  globalId: string | null;
}

/** A building storey (IfcBuildingStorey) with the elements it contains. */
export interface IfcStorey {
  /** Composite key of the storey. */
  key: number;
  modelName: string;
  name: string | null;
  /** Elevation attribute, if present (model units). */
  elevation: number | null;
  /** Composite keys of elements directly contained in this storey. */
  elementIds: number[];
}

/**
 * State of the two section (cutting) planes, owned by the section panel and
 * handed to the viewer. Plain data — no three.js types — so it stays part of the
 * core↔viewer↔UI contract.
 *
 * The scene is Y-up (web-ifc emits Y-up geometry; see IfcParser.toScenePoint), so
 * the "horizontal" plan cut runs along scene-Y and `z` is that cut height in
 * scene units; the "vertical" section is a plane containing the Y axis whose
 * normal rotates in the ground (XZ) plane.
 */
export interface SectionConfig {
  /** Plan cut — a horizontal plane; `z` is the cut height along the scene up-axis. */
  horizontal: { on: boolean; z: number; flip: boolean };
  /** Section cut — a vertical plane; `offset` slides it, `angleDeg` rotates its normal. */
  vertical: { on: boolean; offset: number; angleDeg: number; flip: boolean };
}

/** A single property inside a property set. */
export interface IfcProperty {
  name: string;
  value: string | number | boolean | null;
  /** Unit / value type, if it could be extracted. */
  unit?: string;
}

/** A property set (Pset) or a quantity set (Qto). */
export interface IfcPropertySet {
  expressID: number;
  name: string;
  /** "pset" — IfcPropertySet, "qto" — IfcElementQuantity, "type" — type properties. */
  kind: "pset" | "qto" | "type";
  properties: IfcProperty[];
}

/** Full information about the selected element. */
export interface IfcElementInfo {
  element: IfcElement;
  /** Direct entity attributes (Name, ObjectType, Tag, PredefinedType, ...). */
  attributes: IfcProperty[];
  /** Property sets and quantity sets. */
  propertySets: IfcPropertySet[];
}

/**
 * Geometry of one placed mesh — raw input for three.js.
 * Positions are recentred around the model bbox centre so the numbers stay
 * small for float32. The placement matrix is already baked into the vertices.
 * web-ifc vertices are de-interleaved into [x,y,z] + [nx,ny,nz] per vertex.
 */
export interface IfcMeshData {
  /** Composite scene key (modelId * KEY_BASE + expressID). */
  key: number;
  /** True for IfcSpace — rendered translucent so rooms stay visible. */
  space: boolean;
  positions: Float32Array; // xyz, 3 per vertex
  normals: Float32Array; // xyz, 3 per vertex
  indices: Uint32Array;
  /** RGBA colour from the IFC material, components 0..1. */
  color: { r: number; g: number; b: number; a: number };
}
