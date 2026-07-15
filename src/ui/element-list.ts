import type { IfcElement } from "../core/types.ts";

/** additive === true — click with Shift (multi-select). The id is a scene key. */
export type ElementSelectHandler = (key: number, additive: boolean) => void;

/** Called when a type "layer" is toggled: the (lower-case) type and its new visibility. */
export type TypeVisibilityHandler = (typeLower: string, visible: boolean) => void;

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
  /** Type "layers" hidden in the scene (lower-case type names). */
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
    // Hide the default-hidden types (IfcSpace) in the scene from the start.
    const present = new Set(elements.map((e) => e.typeName.toLowerCase()));
    this.hiddenTypes = new Set([...DEFAULT_HIDDEN].filter((t) => present.has(t)));
    this.render();
    for (const t of this.hiddenTypes) this.onTypeVisibility(t, false);
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
    this.render();
  }

  private toggleType(typeLower: string): void {
    const nowVisible = this.hiddenTypes.has(typeLower);
    if (nowVisible) this.hiddenTypes.delete(typeLower);
    else this.hiddenTypes.add(typeLower);
    this.onTypeVisibility(typeLower, nowVisible);
    this.render();
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

    const models = [...new Set(visible.map((e) => e.modelName))];
    if (models.length <= 1) {
      this.renderTypes(this.root, visible, true);
      return;
    }

    // Several models → a collapsible group per file.
    for (const modelName of models) {
      const items = visible.filter((e) => e.modelName === modelName);
      const model = document.createElement("details");
      model.className = "model-group";
      model.open = models.length <= 3 || !!this.filter;
      const summary = document.createElement("summary");
      summary.innerHTML =
        `<span class="model-name">${escapeHtml(modelName)}</span>` +
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
      const isHidden = this.hiddenTypes.has(typeLower);
      const group = document.createElement("details");
      group.className = isHidden ? "group type-hidden" : "group";
      group.open = (openByDefault && sortedTypes.length <= 8) || !!this.filter;

      const summary = document.createElement("summary");
      summary.innerHTML =
        `<button class="eye" type="button" title="Показать/скрыть в 3D">${isHidden ? "🚫" : "👁"}</button>` +
        `<span class="type">${escapeHtml(typeName)}</span>` +
        `<span class="count">${groupItems.length}</span>`;
      summary.querySelector(".eye")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleType(typeLower);
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
