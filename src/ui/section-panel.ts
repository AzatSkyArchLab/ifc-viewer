import type { SectionConfig } from "../core/types.ts";

/**
 * One storey offered in the plan-cut floor dropdown. `z` is the storey's cut
 * base in *scene* units (scene-Y, where the slab actually sits in the viewer),
 * already converted from the authored IFC elevation by the caller — the panel
 * works purely in scene space so its sliders line up with the geometry.
 */
export interface FloorOption {
  /** Storey name (label); null falls back to "этаж". */
  name: string | null;
  /** Authored elevation (label only), model units. */
  elevation: number | null;
  /** Cut base in scene units (scene-Y). */
  z: number;
}

/** Where a plan cut sits above the chosen slab — the standard architectural cut
 *  height, ~1.5 m off the storey's zero level (windows/doors are caught). */
const PLAN_CUT_HEIGHT = 1.5;

/**
 * Sidebar panel driving the two section (cutting) planes. It owns the
 * SectionConfig state and fires a single onChange on any control change; the
 * viewer turns that config into three.js clipping planes. No 3D gizmo — the
 * panel is the only control surface (MVP).
 *
 * The scene is Y-up, so "horizontal" is a plan cut along scene-Y (`z`) and
 * "vertical" is a section whose normal rotates in the ground (XZ) plane. All
 * slider ranges come from the model bounds via setBounds; the floor dropdown is
 * populated via setFloors with scene-space storey heights.
 */
export class SectionPanel {
  private cfg: SectionConfig = {
    horizontal: { on: false, z: 0, flip: false },
    vertical: { on: false, offset: 0, angleDeg: 0, flip: false },
  };
  private onChange: (cfg: SectionConfig) => void = () => {};

  // Controls, built once in the constructor.
  private hOn!: HTMLInputElement;
  private hFloor!: HTMLSelectElement;
  private hZ!: HTMLInputElement;
  private hZOut!: HTMLElement;
  private hFlip!: HTMLInputElement;
  private hBody!: HTMLElement;
  private vOn!: HTMLInputElement;
  private vOffset!: HTMLInputElement;
  private vAngle!: HTMLInputElement;
  private vAngleOut!: HTMLElement;
  private vFlip!: HTMLInputElement;
  private vBody!: HTMLElement;

  /** Current plan-cut range (scene-Y), so a floor pick can clamp into it. */
  private minZ = 0;
  private maxZ = 0;
  /** Seed the plan cut to mid-height once per model (before the user moves it). */
  private zSeeded = false;

  constructor(private root: HTMLElement) {
    this.render();
    this.syncEnabled();
  }

  setChangeHandler(fn: (cfg: SectionConfig) => void): void {
    this.onChange = fn;
  }

  /** Populates the floor dropdown; storeys carry their scene-Y cut base. */
  setFloors(floors: FloorOption[]): void {
    this.hFloor.replaceChildren();
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = floors.length ? "— выбрать этаж —" : "нет этажей";
    this.hFloor.appendChild(custom);
    for (const f of floors) {
      const opt = document.createElement("option");
      opt.value = String(f.z);
      const name = f.name ?? "этаж";
      const elev = f.elevation != null ? ` · отм. ${formatNum(f.elevation)}` : "";
      opt.textContent = `${name}${elev}`;
      this.hFloor.appendChild(opt);
    }
    this.hFloor.value = ""; // "free" until a floor is picked
  }

  /**
   * Sets the slider ranges from the model bounds (scene space). `minZ`/`maxZ`
   * bound the plan cut (scene-Y); `halfExtent` is the model's XZ half-diagonal,
   * so the vertical section slides fully across at any rotation (−half..+half).
   */
  setBounds(minZ: number, maxZ: number, halfExtent: number): void {
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.hZ.min = String(minZ);
    this.hZ.max = String(maxZ);
    this.hZ.step = "any";
    // First model: seed mid-height so enabling the cut shows something sensible.
    // Later loads keep the user's height if it still fits the new range.
    const mid = (minZ + maxZ) / 2;
    const z = this.zSeeded ? clamp(this.cfg.horizontal.z, minZ, maxZ) : mid;
    this.zSeeded = true;
    this.cfg.horizontal.z = z;
    this.hZ.value = String(z);
    this.updateZOut();

    const half = Math.max(halfExtent, 1e-3);
    this.vOffset.min = String(-half);
    this.vOffset.max = String(half);
    this.vOffset.step = "any";
    const off = clamp(this.cfg.vertical.offset, -half, half);
    this.cfg.vertical.offset = off;
    this.vOffset.value = String(off);

    this.vAngle.min = "0";
    this.vAngle.max = "360";
    this.vAngle.step = "1";
    this.vAngle.value = String(this.cfg.vertical.angleDeg);
    this.updateAngleOut();
  }

  /**
   * Turns both sections off and reports the cleared state — called on a fresh /
   * failed load so a stale plane never keeps clipping a different model.
   */
  reset(): void {
    this.cfg = {
      horizontal: { on: false, z: 0, flip: false },
      vertical: { on: false, offset: 0, angleDeg: 0, flip: false },
    };
    this.zSeeded = false;
    this.hOn.checked = false;
    this.hFlip.checked = false;
    this.hFloor.value = "";
    this.vOn.checked = false;
    this.vFlip.checked = false;
    this.vAngle.value = "0";
    this.updateAngleOut();
    this.updateZOut();
    this.syncEnabled();
    this.fire();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    this.root.replaceChildren();

    // HORIZONTAL — plan cut.
    const hGroup = div("sec-group");
    const hCheck = checkRow("Горизонтальное сечение (план)");
    this.hOn = hCheck.input;
    this.hOn.addEventListener("change", () => {
      this.cfg.horizontal.on = this.hOn.checked;
      this.syncEnabled();
      this.fire();
    });

    this.hBody = div("sec-body");
    const floor = selectRow("Этаж");
    this.hFloor = floor.select;
    this.hFloor.addEventListener("change", () => {
      if (this.hFloor.value === "") return; // "free" — leave the slider alone
      const z = clamp(Number(this.hFloor.value) + PLAN_CUT_HEIGHT, this.minZ, this.maxZ);
      this.cfg.horizontal.z = z;
      this.hZ.value = String(z);
      this.updateZOut();
      this.fire();
    });

    const zField = rangeRow("Высота");
    this.hZ = zField.input;
    this.hZOut = zField.out;
    this.hZ.addEventListener("input", () => {
      this.cfg.horizontal.z = Number(this.hZ.value);
      this.hFloor.value = ""; // moving the slider drops out of floor-snap mode
      this.updateZOut();
      this.fire();
    });

    const hFlip = checkRow("Перевернуть", true);
    this.hFlip = hFlip.input;
    this.hFlip.addEventListener("change", () => {
      this.cfg.horizontal.flip = this.hFlip.checked;
      this.fire();
    });

    this.hBody.append(floor.row, zField.row, hFlip.row);
    hGroup.append(hCheck.row, this.hBody);

    // VERTICAL — section cut.
    const vGroup = div("sec-group");
    const vCheck = checkRow("Вертикальное сечение (разрез)");
    this.vOn = vCheck.input;
    this.vOn.addEventListener("change", () => {
      this.cfg.vertical.on = this.vOn.checked;
      this.syncEnabled();
      this.fire();
    });

    this.vBody = div("sec-body");
    const offField = rangeRow("Смещение");
    this.vOffset = offField.input;
    this.vOffset.addEventListener("input", () => {
      this.cfg.vertical.offset = Number(this.vOffset.value);
      this.fire();
    });

    const angField = rangeRow("Поворот");
    this.vAngle = angField.input;
    this.vAngleOut = angField.out;
    this.vAngle.addEventListener("input", () => {
      this.cfg.vertical.angleDeg = Number(this.vAngle.value);
      this.updateAngleOut();
      this.fire();
    });

    const vFlip = checkRow("Перевернуть", true);
    this.vFlip = vFlip.input;
    this.vFlip.addEventListener("change", () => {
      this.cfg.vertical.flip = this.vFlip.checked;
      this.fire();
    });

    this.vBody.append(offField.row, angField.row, vFlip.row);
    vGroup.append(vCheck.row, this.vBody);

    this.root.append(hGroup, vGroup);
    this.updateZOut();
    this.updateAngleOut();
  }

  /** Greys out a section's controls while it is switched off. */
  private syncEnabled(): void {
    setDisabled(this.hBody, !this.hOn.checked);
    setDisabled(this.vBody, !this.vOn.checked);
  }

  private updateZOut(): void {
    this.hZOut.textContent = formatNum(this.cfg.horizontal.z);
  }

  private updateAngleOut(): void {
    this.vAngleOut.textContent = `${Math.round(this.cfg.vertical.angleDeg)}°`;
  }

  private fire(): void {
    this.onChange({
      horizontal: { ...this.cfg.horizontal },
      vertical: { ...this.cfg.vertical },
    });
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/** Checkbox + text, as a clickable <label>. `sub` indents a nested option. */
function checkRow(
  text: string,
  sub = false,
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = sub ? "sec-check sec-sub" : "sec-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  const span = document.createElement("span");
  span.textContent = text;
  row.append(input, span);
  return { row, input };
}

/** Labelled range with a live value readout. */
function rangeRow(text: string): {
  row: HTMLLabelElement;
  input: HTMLInputElement;
  out: HTMLSpanElement;
} {
  const row = document.createElement("label");
  row.className = "sec-field";
  const name = document.createElement("span");
  name.className = "sec-name";
  name.textContent = text;
  const input = document.createElement("input");
  input.type = "range";
  input.className = "sec-range";
  const out = document.createElement("span");
  out.className = "sec-val";
  row.append(name, input, out);
  return { row, input, out };
}

/** Labelled dropdown. */
function selectRow(text: string): {
  row: HTMLLabelElement;
  select: HTMLSelectElement;
} {
  const row = document.createElement("label");
  row.className = "sec-field";
  const name = document.createElement("span");
  name.className = "sec-name";
  name.textContent = text;
  const select = document.createElement("select");
  select.className = "sec-select";
  row.append(name, select);
  return { row, select };
}

/** Disables every input/select inside a group and dims it. */
function setDisabled(group: HTMLElement, disabled: boolean): void {
  group.classList.toggle("sec-off", disabled);
  for (const control of group.querySelectorAll("input, select")) {
    (control as HTMLInputElement | HTMLSelectElement).disabled = disabled;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Short numeric label: whole numbers plain, otherwise two decimals. */
function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
