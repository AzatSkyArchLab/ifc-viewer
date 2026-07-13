import type { IfcElementInfo, IfcProperty } from "../core/types.ts";

/**
 * Attributes panel: all attributes of the selected element + property/quantity
 * sets.
 */
export class PropertiesPanel {
  constructor(private root: HTMLElement) {
    this.clear();
  }

  clear(): void {
    this.root.innerHTML = `<div class="props-empty">Выберите элемент в списке или в 3D-сцене</div>`;
  }

  show(info: IfcElementInfo): void {
    this.root.innerHTML = "";

    const header = document.createElement("div");
    header.className = "props-header";
    const title = info.element.name ?? info.element.typeName;
    header.innerHTML = `
      <div class="props-title">${escapeHtml(title)}</div>
      <div class="props-sub">${info.element.typeName} · #${info.element.expressID}</div>
      ${
        info.element.globalId
          ? `<div class="props-guid">GUID: ${escapeHtml(info.element.globalId)}</div>`
          : ""
      }
    `;
    this.root.appendChild(header);

    this.root.appendChild(this.section("Атрибуты", info.attributes, true));

    if (info.propertySets.length === 0) {
      const note = document.createElement("div");
      note.className = "props-note";
      note.textContent = "Property sets не найдены";
      this.root.appendChild(note);
    }

    for (const pset of info.propertySets) {
      const badge =
        pset.kind === "qto" ? "Qto" : pset.kind === "type" ? "Type" : "Pset";
      this.root.appendChild(
        this.section(`${pset.name}`, pset.properties, false, badge),
      );
    }
  }

  private section(
    title: string,
    props: IfcProperty[],
    open: boolean,
    badge?: string,
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "pset";
    details.open = open;

    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="pset-name">${escapeHtml(title)}</span>${
      badge ? `<span class="pset-badge">${badge}</span>` : ""
    }`;
    details.appendChild(summary);

    if (props.length === 0) {
      const empty = document.createElement("div");
      empty.className = "prop-row empty";
      empty.textContent = "—";
      details.appendChild(empty);
      return details;
    }

    const table = document.createElement("div");
    table.className = "prop-table";
    for (const p of props) {
      const row = document.createElement("div");
      row.className = "prop-row";
      const value = formatValue(p.value);
      row.innerHTML = `<span class="prop-key">${escapeHtml(p.name)}</span><span class="prop-val">${escapeHtml(value)}${
        p.unit ? ` <span class="prop-unit">${escapeHtml(p.unit)}</span>` : ""
      }</span>`;
      table.appendChild(row);
    }
    details.appendChild(table);
    return details;
  }
}

function formatValue(v: IfcProperty["value"]): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof v === "boolean") return v ? "Да" : "Нет";
  return String(v);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
