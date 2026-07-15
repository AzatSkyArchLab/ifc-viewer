/**
 * Central visibility model for the scene, independent of three.js and the DOM.
 *
 * Several IFC models share one scene (composite `key = modelId * KEY_BASE +
 * expressID`). Visibility is driven by one snapshot-able state so that model /
 * storey toggles, floor focus and undo/redo all read and write the same source
 * of truth. `resolve()` turns that state into the two sets the viewer needs:
 * which keys to hide, and which to draw as locked "ghost" context.
 */
import { modelOfKey } from "./types.ts";
import type { IfcStorey } from "./types.ts";

/** A snapshot of everything that affects element visibility. Cloneable for undo. */
export interface VisState {
  /** Whole models hidden (by modelId). */
  hiddenModels: Set<number>;
  /** Individual storeys hidden (by composite storey key). */
  hiddenStoreys: Set<number>;
  /**
   * Floor focus: in `modelId` show the focused storey and everything below it
   * (upper storeys hidden); every other model becomes ghosted context.
   */
  focus: { modelId: number; storeyKey: number } | null;
  /** Manually hidden elements (Isolate / Hide of the selection). */
  hiddenElems: Set<number>;
  /** Type "layers" hidden in the scene (lower-case IFC type names). */
  hiddenTypes: Set<string>;
  /**
   * Elements pinned visible regardless of any hide (a check finding clicked in
   * the list — e.g. a layer-hidden IfcSpace must still show without unhiding
   * the whole type). Highest priority in `resolve`.
   */
  forceShow: Set<number>;
}

export function emptyState(): VisState {
  return {
    hiddenModels: new Set(),
    hiddenStoreys: new Set(),
    focus: null,
    hiddenElems: new Set(),
    hiddenTypes: new Set(),
    forceShow: new Set(),
  };
}

/** Deep copy — history stores full snapshots, so states must not share sets. */
export function cloneState(s: VisState): VisState {
  return {
    hiddenModels: new Set(s.hiddenModels),
    hiddenStoreys: new Set(s.hiddenStoreys),
    focus: s.focus ? { ...s.focus } : null,
    hiddenElems: new Set(s.hiddenElems),
    hiddenTypes: new Set(s.hiddenTypes),
    forceShow: new Set(s.forceShow),
  };
}

/** Element→storey / storey→elevation / storey→model lookups, built once per load. */
export interface StoreyIndex {
  /** Composite element key → composite key of its storey. */
  elemStorey: Map<number, number>;
  /** Composite storey key → elevation (0 when unknown). */
  storeyElev: Map<number, number>;
  /** Composite storey key → owning modelId. */
  storeyModel: Map<number, number>;
}

export function buildStoreyIndex(storeys: IfcStorey[]): StoreyIndex {
  const elemStorey = new Map<number, number>();
  const storeyElev = new Map<number, number>();
  const storeyModel = new Map<number, number>();
  for (const s of storeys) {
    storeyElev.set(s.key, s.elevation ?? 0);
    storeyModel.set(s.key, modelOfKey(s.key));
    for (const e of s.elementIds) {
      // An element can be listed under several storeys (rare); first wins.
      if (!elemStorey.has(e)) elemStorey.set(e, s.key);
    }
  }
  return { elemStorey, storeyElev, storeyModel };
}

/**
 * Resolves the visibility state into concrete sets for the viewer:
 * `hidden` — not drawn; `ghost` — drawn as locked, translucent context.
 * Evaluated per element key in priority order (first match wins).
 */
export function resolve(
  allKeys: Iterable<number>,
  typeOf: (key: number) => string,
  s: VisState,
  idx: StoreyIndex,
): { hidden: Set<number>; ghost: Set<number> } {
  const hidden = new Set<number>();
  const ghost = new Set<number>();
  const focusElev =
    s.focus != null ? idx.storeyElev.get(s.focus.storeyKey) ?? 0 : 0;

  for (const key of allKeys) {
    // 0. Pinned visible (a clicked check finding) overrides every hide.
    if (s.forceShow.has(key)) continue;

    const model = modelOfKey(key);
    const storey = idx.elemStorey.get(key);

    // 1. Manual hide or a hidden type layer — always wins (e.g. IfcSpace stays
    //    hidden even inside a ghosted model).
    if (s.hiddenElems.has(key) || s.hiddenTypes.has(typeOf(key).toLowerCase())) {
      hidden.add(key);
      continue;
    }
    // 2. Whole-model hide (the focused model is exempt — focus always shows it).
    const isFocusModel = s.focus != null && model === s.focus.modelId;
    if (s.hiddenModels.has(model) && !isFocusModel) {
      hidden.add(key);
      continue;
    }
    // 3. Per-storey hide.
    if (storey != null && s.hiddenStoreys.has(storey)) {
      hidden.add(key);
      continue;
    }
    // 4. Floor focus.
    if (s.focus != null) {
      if (isFocusModel) {
        // Focused floor + everything below; storey-less elements stay visible.
        if (storey != null && (idx.storeyElev.get(storey) ?? 0) > focusElev) {
          hidden.add(key);
          continue;
        }
      } else {
        // Other models become ghosted, locked context.
        ghost.add(key);
        continue;
      }
    }
    // 5. Otherwise visible.
  }
  return { hidden, ghost };
}

/** A floor shared across models (for the "all models" section of the tree). */
export interface FloorGroup {
  label: string;
  /** Composite keys of the storeys that make up this floor across models. */
  storeyKeys: number[];
  /** Representative elevation (mean), for top-first ordering. */
  elev: number;
}

/**
 * Groups storeys across models into shared floors. Storeys are matched by name
 * (disciplines usually name floors identically); nameless storeys fall back to
 * an elevation bucket (~0.1 m). Returned top floor first.
 */
export function floorGroups(storeys: IfcStorey[]): FloorGroup[] {
  const byKey = new Map<
    string,
    { label: string; keys: number[]; elevs: number[] }
  >();
  for (const s of storeys) {
    const name = (s.name ?? "").trim();
    const gkey = name
      ? `n:${name.toLowerCase()}`
      : `e:${Math.round((s.elevation ?? 0) * 10)}`;
    const label = name || (s.elevation != null ? `отм. ${s.elevation}` : "этаж");
    const g = byKey.get(gkey) ?? { label, keys: [], elevs: [] };
    g.keys.push(s.key);
    g.elevs.push(s.elevation ?? 0);
    byKey.set(gkey, g);
  }
  const groups: FloorGroup[] = [];
  for (const g of byKey.values()) {
    const elev = g.elevs.reduce((a, b) => a + b, 0) / g.elevs.length;
    groups.push({ label: g.label, storeyKeys: g.keys, elev });
  }
  return groups.sort((a, b) => b.elev - a.elev);
}
