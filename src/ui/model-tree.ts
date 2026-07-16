import type { IfcStorey } from "../core/types.ts";
import { modelOfKey } from "../core/types.ts";
import {
  floorGroups,
  typeKey,
  type FloorGroup,
  type TypeGroup,
  type VisState,
} from "../core/visibility.ts";

/** One loaded model in the tree. */
export interface TreeModel {
  modelId: number;
  name: string;
}

const EYE = "👁";
const EYE_OFF = "🚫";

/**
 * Sidebar "Models → Floors" visibility tree. One row per IFC model (eye =
 * show/hide the whole model) expands to its storeys (eye = show/hide that floor;
 * ◎ = focus: show this floor and everything below, ghost the other models). A
 * top section groups floors shared across models so one click toggles a floor
 * everywhere ("together"). The tree only fires handlers — main owns VisState and
 * pushes the authoritative state back via setState().
 */
export class ModelTree {
  private models: TreeModel[] = [];
  private storeys: IfcStorey[] = [];
  private groups: FloorGroup[] = [];
  private types: TypeGroup[] = [];
  private vis: VisState | null = null;

  // Rendered handles, updated in-place by setState (no re-render on every change).
  private masterEye: HTMLElement | null = null;
  private groupEye = new Map<number, HTMLElement>(); // group index → eye
  private layerEye = new Map<string, HTMLElement>(); // typeLower → eye
  private modelEye = new Map<number, HTMLElement>(); // modelId → eye
  private modelRow = new Map<number, HTMLElement>(); // modelId → <details>
  private storeyEye = new Map<number, HTMLElement>(); // storeyKey → eye
  private storeyFocus = new Map<number, HTMLElement>(); // storeyKey → ◎

  private onModelCb: (modelId: number, visible: boolean) => void = () => {};
  private onAllModelsCb: (visible: boolean) => void = () => {};
  private onStoreyCb: (storeyKey: number, visible: boolean) => void = () => {};
  private onFloorGroupCb: (storeyKeys: number[], visible: boolean) => void =
    () => {};
  private onLayerGroupCb: (
    modelIds: number[],
    typeLower: string,
    visible: boolean,
  ) => void = () => {};
  private onFocusCb: (modelId: number, storeyKey: number) => void = () => {};

  constructor(private root: HTMLElement) {}

  onModel(cb: (modelId: number, visible: boolean) => void): void {
    this.onModelCb = cb;
  }
  onAllModels(cb: (visible: boolean) => void): void {
    this.onAllModelsCb = cb;
  }
  onStorey(cb: (storeyKey: number, visible: boolean) => void): void {
    this.onStoreyCb = cb;
  }
  onFloorGroup(cb: (storeyKeys: number[], visible: boolean) => void): void {
    this.onFloorGroupCb = cb;
  }
  onLayerGroup(
    cb: (modelIds: number[], typeLower: string, visible: boolean) => void,
  ): void {
    this.onLayerGroupCb = cb;
  }
  onFocus(cb: (modelId: number, storeyKey: number) => void): void {
    this.onFocusCb = cb;
  }

  setData(models: TreeModel[], storeys: IfcStorey[], types: TypeGroup[]): void {
    this.models = models;
    this.storeys = storeys;
    this.groups = floorGroups(storeys);
    this.types = types;
    this.render();
  }

  clear(): void {
    this.models = [];
    this.storeys = [];
    this.groups = [];
    this.types = [];
    this.vis = null;
    this.root.innerHTML = "";
  }

  /** Re-derive every icon/active state from the authoritative VisState. */
  setState(vis: VisState): void {
    this.vis = vis;

    if (this.masterEye) {
      const allHidden =
        this.models.length > 0 &&
        this.models.every((m) => vis.hiddenModels.has(m.modelId));
      this.masterEye.textContent = allHidden ? EYE_OFF : EYE;
    }
    this.groups.forEach((g, i) => {
      const eye = this.groupEye.get(i);
      if (!eye) return;
      const allHidden = g.storeyKeys.every((k) => vis.hiddenStoreys.has(k));
      eye.textContent = allHidden ? EYE_OFF : EYE;
    });
    for (const t of this.types) {
      const eye = this.layerEye.get(t.typeLower);
      if (!eye) continue;
      // "Off" only once the layer is hidden in every model that has it.
      const allHidden = t.modelIds.every((m) =>
        vis.hiddenTypes.has(typeKey(m, t.typeLower)),
      );
      eye.textContent = allHidden ? EYE_OFF : EYE;
    }
    for (const m of this.models) {
      const eye = this.modelEye.get(m.modelId);
      if (eye) eye.textContent = vis.hiddenModels.has(m.modelId) ? EYE_OFF : EYE;
      const row = this.modelRow.get(m.modelId);
      if (row) {
        // In focus mode the other models are ghosted context — mark the row.
        row.classList.toggle(
          "mt-ghost",
          vis.focus != null && vis.focus.modelId !== m.modelId,
        );
      }
    }
    for (const s of this.storeys) {
      const eye = this.storeyEye.get(s.key);
      if (eye) eye.textContent = vis.hiddenStoreys.has(s.key) ? EYE_OFF : EYE;
      const focus = this.storeyFocus.get(s.key);
      if (focus) focus.classList.toggle("active", vis.focus?.storeyKey === s.key);
    }
  }

  private render(): void {
    this.root.innerHTML = "";
    this.masterEye = null;
    this.groupEye.clear();
    this.layerEye.clear();
    this.modelEye.clear();
    this.modelRow.clear();
    this.storeyEye.clear();
    this.storeyFocus.clear();

    if (this.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mt-empty";
      empty.textContent = "Модели не загружены";
      this.root.appendChild(empty);
      return;
    }

    // Master: show / hide every model at once.
    const master = document.createElement("div");
    master.className = "mt-master";
    const mEye = eyeButton();
    mEye.addEventListener("click", () => {
      if (!this.vis) return;
      const allHidden = this.models.every((m) =>
        this.vis!.hiddenModels.has(m.modelId),
      );
      this.onAllModelsCb(allHidden); // all hidden → show all, else hide all
    });
    const mLabel = label("Все модели");
    master.append(mEye, mLabel);
    this.masterEye = mEye;
    this.root.appendChild(master);

    // Floors shared across models ("together").
    if (this.groups.length > 0) {
      this.root.appendChild(sectionHeader("Этажи (все модели)"));
      this.groups.forEach((g, i) => {
        const row = document.createElement("div");
        row.className = "mt-floor";
        const eye = eyeButton();
        eye.addEventListener("click", () => {
          if (!this.vis) return;
          const allHidden = g.storeyKeys.every((k) =>
            this.vis!.hiddenStoreys.has(k),
          );
          this.onFloorGroupCb(g.storeyKeys, allHidden);
        });
        row.append(eye, label(g.label), count(g.storeyKeys.length));
        this.groupEye.set(i, eye);
        this.root.appendChild(row);
      });
    }

    // Layers shared across models ("together") — the per-model layer toggle is
    // the eye on each type group inside the element list. Collapsed by default:
    // a model easily carries 20+ types, which would bury the Models section.
    if (this.types.length > 0) {
      const box = document.createElement("details");
      box.className = "mt-layers";
      const head = document.createElement("summary");
      head.className = "mt-section";
      head.textContent = `Слои (все модели) · ${this.types.length}`;
      box.appendChild(head);
      for (const t of this.types) {
        const row = document.createElement("div");
        row.className = "mt-floor";
        const eye = eyeButton();
        eye.title = "Показать / скрыть слой во всех моделях";
        eye.addEventListener("click", () => {
          if (!this.vis) return;
          const allHidden = t.modelIds.every((m) =>
            this.vis!.hiddenTypes.has(typeKey(m, t.typeLower)),
          );
          this.onLayerGroupCb(t.modelIds, t.typeLower, allHidden);
        });
        row.append(eye, label(t.label), count(t.count));
        this.layerEye.set(t.typeLower, eye);
        box.appendChild(row);
      }
      this.root.appendChild(box);
    }

    // Per-model section, each expandable to its storeys (top floor first).
    this.root.appendChild(sectionHeader("Модели"));
    const byModel = new Map<number, IfcStorey[]>();
    for (const s of this.storeys) {
      const mid = modelOfKey(s.key);
      const arr = byModel.get(mid) ?? [];
      arr.push(s);
      byModel.set(mid, arr);
    }
    for (const arr of byModel.values()) {
      arr.sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0));
    }

    for (const m of this.models) {
      const storeysOfModel = byModel.get(m.modelId) ?? [];
      const details = document.createElement("details");
      details.className = "mt-model";
      details.open = this.models.length <= 3;

      const summary = document.createElement("summary");
      const eye = eyeButton();
      eye.addEventListener("click", (ev) => {
        ev.preventDefault(); // do not toggle the <details>
        ev.stopPropagation();
        if (!this.vis) return;
        this.onModelCb(m.modelId, this.vis.hiddenModels.has(m.modelId));
      });
      summary.append(eye, label(m.name), count(storeysOfModel.length));
      details.appendChild(summary);
      this.modelEye.set(m.modelId, eye);
      this.modelRow.set(m.modelId, details);

      const wrap = document.createElement("div");
      wrap.className = "mt-storeys";
      for (const s of storeysOfModel) {
        const row = document.createElement("div");
        row.className = "mt-storey";
        const sEye = eyeButton();
        sEye.addEventListener("click", () => {
          if (!this.vis) return;
          this.onStoreyCb(s.key, this.vis.hiddenStoreys.has(s.key));
        });
        const elev =
          s.elevation != null ? ` · ${Math.round(s.elevation * 100) / 100}` : "";
        const focus = document.createElement("button");
        focus.type = "button";
        focus.className = "mt-focus";
        focus.textContent = "◎";
        focus.title = "Фокус: этот этаж и нижние; остальные модели — контекст";
        focus.addEventListener("click", () => this.onFocusCb(m.modelId, s.key));
        row.append(sEye, label(`${s.name ?? "этаж"}${elev}`), focus);
        this.storeyEye.set(s.key, sEye);
        this.storeyFocus.set(s.key, focus);
        wrap.appendChild(row);
      }
      details.appendChild(wrap);
      this.root.appendChild(details);
    }
  }
}

function eyeButton(): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mt-eye";
  b.textContent = EYE;
  b.title = "Показать / скрыть в 3D";
  return b;
}

function label(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "mt-label";
  el.textContent = text;
  return el;
}

function count(n: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "count";
  el.textContent = String(n);
  return el;
}

function sectionHeader(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "mt-section";
  el.textContent = text;
  return el;
}
