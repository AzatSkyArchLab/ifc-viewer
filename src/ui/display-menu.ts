/**
 * "Отображение" dropdown in the top bar. Hides the optional graphics behind one
 * menu: a "Графика" section with edge contours and directional lighting toggles,
 * plus a small floating "Настройки освещения" card (shadow on/off and the sun's
 * azimuth/altitude). Everything is OFF by default — the plain shaded model. The
 * menu owns a DisplayConfig and fires one onChange on any change; the host maps
 * it onto the viewer. Open/close is the project's `hidden`-attribute convention.
 */
export interface DisplayConfig {
  edges: boolean; // element contour lines
  lighting: boolean; // directional sun (off = flat even fill)
  shadows: boolean; // contact shadow
  sunAzimuthDeg: number; // 0..360
  sunAltitudeDeg: number; // 0..90
}

export class DisplayMenu {
  private cfg: DisplayConfig = {
    edges: false,
    lighting: false,
    shadows: false,
    sunAzimuthDeg: 135,
    sunAltitudeDeg: 55,
  };
  private onChange: (cfg: DisplayConfig) => void = () => {};

  private trigger!: HTMLButtonElement;
  private menu!: HTMLElement;
  private modal!: HTMLElement;
  private sunBody!: HTMLElement;
  private azimOut!: HTMLElement;
  private altOut!: HTMLElement;

  constructor(private root: HTMLElement) {
    this.render();
    this.syncEnabled();
    this.updateOut();
    // A click anywhere outside closes the dropdown (the settings card stays put,
    // so the model can still be orbited/picked while the sun is being adjusted).
    document.addEventListener("click", (e) => {
      if (!this.root.contains(e.target as Node)) this.toggleMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.toggleMenu(false);
        this.closeModal();
      }
    });
  }

  setChangeHandler(fn: (cfg: DisplayConfig) => void): void {
    this.onChange = fn;
  }

  private render(): void {
    this.root.replaceChildren();

    // Trigger.
    this.trigger = button("Отображение ▾", "btn");
    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Dropdown — Графика.
    this.menu = div("disp-menu");
    this.menu.hidden = true;
    this.menu.append(title("Графика"));

    const edges = checkRow("Рёбра");
    edges.input.checked = this.cfg.edges;
    edges.input.addEventListener("change", () => {
      this.cfg.edges = edges.input.checked;
      this.fire();
    });

    const light = checkRow("Освещение");
    light.input.checked = this.cfg.lighting;
    light.input.addEventListener("change", () => {
      this.cfg.lighting = light.input.checked;
      this.syncEnabled();
      if (light.input.checked) this.openModal();
      this.fire();
    });

    const settings = button("Настройки освещения…", "disp-link");
    settings.addEventListener("click", () => this.openModal());

    this.menu.append(edges.row, light.row, settings);

    // Floating settings card.
    this.modal = div("disp-modal");
    this.modal.hidden = true;

    const close = button("×", "clash-pop-close");
    close.title = "Закрыть";
    close.addEventListener("click", () => this.closeModal());

    const heading = div("disp-modal-title");
    heading.textContent = "Настройки освещения";

    const shadows = checkRow("Тени");
    shadows.input.checked = this.cfg.shadows;
    shadows.input.addEventListener("change", () => {
      this.cfg.shadows = shadows.input.checked;
      this.syncEnabled();
      this.fire();
    });

    this.sunBody = div("sec-body");
    const azim = rangeRow("Азимут");
    this.azimOut = azim.out;
    azim.input.min = "0";
    azim.input.max = "360";
    azim.input.step = "1";
    azim.input.value = String(this.cfg.sunAzimuthDeg);
    azim.input.addEventListener("input", () => {
      this.cfg.sunAzimuthDeg = Number(azim.input.value);
      this.updateOut();
      this.fire();
    });
    const alt = rangeRow("Высота");
    this.altOut = alt.out;
    alt.input.min = "0";
    alt.input.max = "90";
    alt.input.step = "1";
    alt.input.value = String(this.cfg.sunAltitudeDeg);
    alt.input.addEventListener("input", () => {
      this.cfg.sunAltitudeDeg = Number(alt.input.value);
      this.updateOut();
      this.fire();
    });
    this.sunBody.append(azim.row, alt.row);

    const done = button("Готово", "btn");
    done.addEventListener("click", () => this.closeModal());

    this.modal.append(close, heading, shadows.row, this.sunBody, done);

    this.root.append(this.trigger, this.menu, this.modal);
  }

  private toggleMenu(open = this.menu.hidden): void {
    this.menu.hidden = !open;
    this.trigger.setAttribute("aria-expanded", String(open));
  }

  private openModal(): void {
    this.toggleMenu(false);
    this.modal.hidden = false;
  }

  private closeModal(): void {
    this.modal.hidden = true;
  }

  /** Sun sliders matter only when something uses the sun direction. */
  private syncEnabled(): void {
    setDisabled(this.sunBody, !(this.cfg.lighting || this.cfg.shadows));
  }

  private updateOut(): void {
    this.azimOut.textContent = `${this.cfg.sunAzimuthDeg}°`;
    this.altOut.textContent = `${this.cfg.sunAltitudeDeg}°`;
  }

  private fire(): void {
    this.onChange({ ...this.cfg });
  }
}

// ── DOM helpers (local, mirroring section-panel.ts) ──────────────────────────

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function button(text: string, className: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  return el;
}

function title(text: string): HTMLDivElement {
  const el = div("disp-title");
  el.textContent = text;
  return el;
}

function checkRow(text: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "sec-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  const span = document.createElement("span");
  span.textContent = text;
  row.append(input, span);
  return { row, input };
}

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

function setDisabled(group: HTMLElement, disabled: boolean): void {
  group.classList.toggle("sec-off", disabled);
  for (const control of group.querySelectorAll("input")) {
    (control as HTMLInputElement).disabled = disabled;
  }
}
