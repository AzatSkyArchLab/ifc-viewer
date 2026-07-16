import type { IfcElement } from "../core/types.ts";
import { typeKey } from "../core/visibility.ts";

/** additive === true — click with Shift (multi-select). The id is a scene key. */
export type ElementSelectHandler = (key: number, additive: boolean) => void;

/**
 * Called when a type "layer" is toggled for ONE model: its modelId, the
 * (lower-case) type and the new visibility. Layers are per-model, like storeys —
 * hiding IfcWall in the arch model leaves the struct model's walls alone.
 */
export type TypeVisibilityHandler = (
  modelId: number,
  typeLower: string,
  visible: boolean,
) => void;

/** IFC types hidden on load (lower-case type names). */
const DEFAULT_HIDDEN = new Set(["ifcspace"]);

/**
 * Left panel: elements grouped by model → IFC type. With several models loaded
 * each file is a collapsible group, so attributes stay separated per model.
 * Supports filtering, multi-selection and dimming of hidden elements.
 */
export class ElementList {
  private elements: IfcElement[] = [];
  private filter = "";
  /** Active storey scope (null = whole model), by composite key. */
  private scope: Set<number> | null = null;
  private selected = new Set<number>();
  private hidden = new Set<number>();
  /** Type "layers" hidden per model — keys from typeKey(modelId, typeLower). */
  private hiddenTypes = new Set<string>();
  private onSelect: ElementSelectHandler = () => {};
  private onTypeVisibility: TypeVisibilityHandler = () => {};

  constructor(private root: HTMLElement) {}

  setSelectHandler(handler: ElementSelectHandler): void {
    this.onSelect = handler;
  }

  setTypeVisibilityHandler(handler: TypeVisibilityHandler): void {
    this.onTypeVisibility = handler;
  }

  setElements(elements: IfcElement[]): void {
    this.elements = elements;
    this.scope = null;
    this.selected.clear();
    this.hidden.clear();
    // Hide the default-hidden types (IfcSpace) from the start — in every model
    // that actually has them, since layers are per-model.
    const seed: { modelId: number; typeLower: string }[] = [];
    this.hiddenTypes = new Set();
    for (const e of elements) {
      const t = e.typeName.toLowerCase();
      if (!DEFAULT_HIDDEN.has(t)) continue;
      const k = typeKey(e.modelId, t);
      if (this.hiddenTypes.has(k)) continue;
      this.hiddenTypes.add(k);
      seed.push({ modelId: e.modelId, typeLower: t });
    }
    this.render();
    for (const s of seed) this.onTypeVisibility(s.modelId, s.typeLower, false);
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    this.render();
  }

  setScope(ids: number[] | null): void {
    this.scope = ids ? new Set(ids) : null;
    this.render();
  }

  setSelection(ids: number[]): void {
    this.selected = new Set(ids);
    for (const el of this.root.querySelectorAll(".item")) {
      const id = Number((el as HTMLElement).dataset.id);
      el.classList.toggle("active", this.selected.has(id));
    }
    const last = ids[ids.length - 1];
    if (last != null) {
      this.root
        .querySelector(`.item[data-id="${last}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  setHidden(ids: number[]): void {
    this.hidden = new Set(ids);
    for (const el of this.root.querySelectorAll(".item")) {
      const id = Number((el as HTMLElement).dataset.id);
      el.classList.toggle("hidden-item", this.hidden.has(id));
    }
  }

  /** Resync the hidden type "layers" from the outside (undo / redo). */
  setHiddenTypes(types: Set<string>): void {
    this.hiddenTypes = new Set(types);
    this.refreshTypeIcons();
  }

  /** Toggles one type "layer" of ONE model (the eye inside that model's group). */
  private toggleType(modelId: number, typeLower: string): void {
    const k = typeKey(modelId, typeLower);
    const nowVisible = this.hiddenTypes.has(k);
    if (nowVisible) this.hiddenTypes.delete(k);
    else this.hiddenTypes.add(k);
    this.onTypeVisibility(modelId, typeLower, nowVisible);
    this.refreshTypeIcons(); // update in place — a full render would collapse groups
  }

  /**
   * Reflects hiddenTypes onto every group's eye icon + dimming in place, so a
   * layer toggle (or undo/redo, or an "all models" toggle from the tree) never
   * re-renders the list — which would reset every <details> group to its
   * default open state and collapse the panel.
   */
  private refreshTypeIcons(): void {
    for (const group of this.root.querySelectorAll<HTMLElement>(".group")) {
      const type = group.dataset.type;
      const model = group.dataset.model;
      if (type == null || model == null) continue;
      const hidden = this.hiddenTypes.has(typeKey(Number(model), type));
      group.classList.toggle("type-hidden", hidden);
      const eye = group.querySelector(".eye");
      if (eye) eye.textContent = hidden ? "🚫" : "👁";
    }
  }

  private match(e: IfcElement): boolean {
    if (this.scope && !this.scope.has(e.key)) return false;
    if (!this.filter) return true;
    const hay = `${e.modelName} ${e.typeName} ${e.name ?? ""} ${e.expressID} ${
      e.globalId ?? ""
    }`.toLowerCase();
    return hay.includes(this.filter);
  }

  private render(): void {
    this.root.innerHTML = "";
    const visible = this.elements.filter((e) => this.match(e));

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = this.elements.length
        ? "Ничего не найдено"
        : "Откройте или перетащите IFC-файл(ы)";
      this.root.appendChild(empty);
      return;
    }

    // Group by modelId, not by file name: two files may share a name, and a
    // type group must belong to exactly one model (layers are per-model).
    const modelIds = [...new Set(visible.map((e) => e.modelId))];
    if (modelIds.length <= 1) {
      this.renderTypes(this.root, visible, true);
      return;
    }

    // Several models → a collapsible group per file.
    for (const modelId of modelIds) {
      const items = visible.filter((e) => e.modelId === modelId);
      const model = document.createElement("details");
      model.className = "model-group";
      model.open = modelIds.length <= 3 || !!this.filter;
      const summary = document.createElement("summary");
      summary.innerHTML =
        `<span class="model-name">${escapeHtml(items[0].modelName)}</span>` +
        `<span class="count">${items.length}</span>`;
      model.appendChild(summary);
      this.renderTypes(model, items, false);
      this.root.appendChild(model);
    }
  }

  private renderTypes(
    parent: HTMLElement,
    items: IfcElement[],
    openByDefault: boolean,
  ): void {
    const groups = new Map<string, IfcElement[]>();
    for (const e of items) {
      const arr = groups.get(e.typeName) ?? [];
      arr.push(e);
      groups.set(e.typeName, arr);
    }
    const sortedTypes = [...groups.keys()].sort();
    for (const typeName of sortedTypes) {
      const groupItems = groups.get(typeName)!;
      const typeLower = typeName.toLowerCase();
      // A group always sits inside exactly one model (render splits by modelId).
      const modelId = groupItems[0].modelId;
      const isHidden = this.hiddenTypes.has(typeKey(modelId, typeLower));
      const group = document.createElement("details");
      group.className = isHidden ? "group type-hidden" : "group";
      group.dataset.type = typeLower; // for in-place eye/dimming updates
      group.dataset.model = String(modelId);
      group.open = (openByDefault && sortedTypes.length <= 8) || !!this.filter;

      const summary = document.createElement("summary");
      summary.innerHTML =
        `<button class="eye" type="button" title="Показать/скрыть в 3D (только эта модель)">${isHidden ? "🚫" : "👁"}</button>` +
        `<span class="type">${escapeHtml(typeName)}</span>` +
        `<span class="count">${groupItems.length}</span>`;
      summary.querySelector(".eye")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleType(modelId, typeLower);
      });
      group.appendChild(summary);

      for (const e of groupItems) {
        const item = document.createElement("div");
        item.className = "item";
        item.dataset.id = String(e.key);
        if (this.selected.has(e.key)) item.classList.add("active");
        if (this.hidden.has(e.key)) item.classList.add("hidden-item");
        const label = e.name ?? `#${e.expressID}`;
        item.innerHTML = `<span class="name">${escapeHtml(label)}</span><span class="eid">#${e.expressID}</span>`;
        item.addEventListener("click", (ev) => this.onSelect(e.key, ev.shiftKey));
        group.appendChild(item);
      }
      parent.appendChild(group);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
