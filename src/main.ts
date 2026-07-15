import "./style.css";
import { loadConfig } from "./core/config.ts";
import { IfcParser } from "./core/ifc-parser.ts";
import type { IfcStorey } from "./core/types.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";
import { TrmView } from "./ui/trm-view.ts";
import { ChecksPanel } from "./ui/checks-panel.ts";
import { makeVerticalResizer } from "./ui/pane-resizer.ts";

/**
 * Thin glue for the standalone IFC viewer: wires the parser, the three.js scene
 * and the panels, and owns the selection / visibility state. Elements are keyed
 * by a composite scene key so several models can share one scene. IFC checks run
 * against the backend configured in config.json; their set is discovered from
 * the API response (nothing about individual checks is hard-coded here).
 */

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found`);
  return el as T;
}

const parser = new IfcParser();
const viewer = new Viewer(byId("viewer"));
const list = new ElementList(byId("element-list"));
const props = new PropertiesPanel(byId("properties"));
const trm = new TrmView(
  byId("trm-overlay"),
  byId("trm-title"),
  byId("trm-list"),
  byId("trm-content"),
  byId("trm-close"),
  byId<HTMLButtonElement>("trm-analyze"),
  byId("trm-analysis"),
);
const checks = new ChecksPanel(
  byId<HTMLButtonElement>("chk-run"),
  byId("chk-result"),
);

const statusEl = byId("status");
const fileInput = byId<HTMLInputElement>("file-input");
const trmInput = byId<HTMLInputElement>("trm-input");
const filterInput = byId<HTMLInputElement>("filter");
const storeySelect = byId<HTMLSelectElement>("storey");
const btnView = byId<HTMLButtonElement>("btn-view");
const btnIsolate = byId<HTMLButtonElement>("btn-isolate");
const btnHide = byId<HTMLButtonElement>("btn-hide");
const btnShowAll = byId<HTMLButtonElement>("btn-showall");

/** Ordered selection of composite keys; the last is the most recent pick. */
let selection: number[] = [];
/** Storeys of the loaded models, indexed by composite key. */
let storeys = new Map<number, IfcStorey>();
/** Loaded models (file + web-ifc model id), re-sent to the backend for checks. */
let loadedModels: { file: File; modelId: number }[] = [];
/** Base names of loaded models, matched to a TRM drawing. */
let loadedNames: string[] = [];

/** Highlight colours per check status (violation / review / ok). */
const STATUS_COLOR: Record<string, number> = {
  violation: 0xff3b30,
  review: 0xff9500,
  ok: 0x2563eb,
};

/** Highlights (or isolates) a set of elements by scene key, model-wide. */
function focusElements(keys: number[], isolate: boolean, color?: number): void {
  storeySelect.value = "";
  list.setScope(null);
  viewer.setScope(null);
  selection = keys;
  viewer.reveal(keys); // flagged elements (e.g. layer-hidden IfcSpace) must show
  viewer.setSelection(keys, color);
  list.setSelection(keys);
  if (isolate) {
    viewer.isolateSelected();
    refreshHidden();
  }
  viewer.fitTo(keys); // frame the category, not the whole model
  const last = keys[keys.length - 1];
  if (last != null) void showProps(last);
  updateButtons();
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function showProps(key: number, expandAll = false): Promise<void> {
  try {
    props.show(await parser.getElementInfo(key), expandAll);
  } catch (err) {
    console.error(err);
  }
}

/**
 * Focus a single flagged element (from a check finding): reveal it, tint it,
 * zoom the camera to it, and expand all its attributes on the left — WITHOUT
 * resetting scope/isolation. `isolate` hides everything except this element.
 */
function focusElement(key: number, isolate: boolean, color?: number): void {
  selection = [key];
  viewer.reveal([key]);
  viewer.setSelection([key], color);
  if (isolate) {
    viewer.isolateSelected();
    refreshHidden();
  }
  viewer.fitTo([key]);
  list.setSelection([key]);
  void showProps(key, true);
  updateButtons();
}

function setSelection(keys: number[]): void {
  selection = keys;
  viewer.setSelection(keys);
  list.setSelection(keys);
  const last = keys[keys.length - 1];
  if (last != null) void showProps(last);
  else props.clear();
  updateButtons();
}

/** Unified select from either the list or the scene. */
function select(key: number | null, additive: boolean): void {
  if (key === null) {
    if (!additive) setSelection([]);
    return;
  }
  if (additive) {
    setSelection(
      selection.includes(key)
        ? selection.filter((x) => x !== key)
        : [...selection, key],
    );
  } else {
    setSelection([key]);
  }
}

function updateButtons(): void {
  const hasSel = selection.length > 0;
  btnIsolate.disabled = !hasSel;
  btnHide.disabled = !hasSel;
  btnShowAll.disabled = !viewer.hasHidden();
}

function refreshHidden(): void {
  list.setHidden(viewer.getHiddenIds());
  updateButtons();
}

/** Fills the storey dropdown from the loaded models. */
function populateStoreys(items: IfcStorey[]): void {
  storeys = new Map(items.map((s) => [s.key, s]));
  storeySelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = `Все этажи (${items.length})`;
  storeySelect.appendChild(all);
  const multi = new Set(items.map((s) => s.modelName)).size > 1;
  for (const s of items) {
    const opt = document.createElement("option");
    opt.value = String(s.key);
    const prefix = multi ? `${s.modelName}: ` : "";
    const elev = s.elevation != null ? ` · ${s.elevation}` : "";
    opt.textContent = `${prefix}${s.name ?? "этаж"}${elev} (${s.elementIds.length})`;
    storeySelect.appendChild(opt);
  }
  storeySelect.disabled = items.length === 0;
}

/** Applies the chosen storey as a scope to both the list and the scene. */
function applyStorey(key: number | null): void {
  const ids = key != null ? storeys.get(key)?.elementIds ?? [] : null;
  list.setScope(ids);
  viewer.setScope(ids);
  setSelection([]);
}

/** Shows the "view model" button when a loaded model has a matching TRM drawing. */
function updateViewButton(): void {
  btnView.hidden = !loadedNames.some((n) => trm.viewIndexFor(n) >= 0);
}

async function openTrm(file: File): Promise<void> {
  setStatus(`Чтение TRM ${file.name}…`);
  try {
    trm.open(new Uint8Array(await file.arrayBuffer()));
    updateViewButton();
    setStatus(`TRM: ${file.name}`);
  } catch (err) {
    console.error(err);
    setStatus(`Ошибка чтения TRM: ${(err as Error).message}`);
  }
}

async function openFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  setStatus(`Загрузка ${files.length} файл(ов)…`);
  try {
    parser.clearAll();
    loadedModels = [];
    loadedNames = [];
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      const modelId = await parser.add(data, file.name);
      loadedModels.push({ file, modelId });
      loadedNames.push(
        file.name.replace(/\.ifc$/i, "").replace(/\s*\(\d+\)\s*$/, "").trim(),
      );
    }

    const elements = parser.getElements();
    // Load meshes first so the list's initial layer-hides (IfcSpace) apply.
    viewer.loadMeshes(parser.getMeshes());
    list.setElements(elements);
    populateStoreys(parser.getStoreys());
    storeySelect.value = "";
    checks.setEnabled(true);

    setSelection([]);
    props.clear();
    updateViewButton();
    const label = files.length === 1 ? files[0].name : `моделей: ${files.length}`;
    setStatus(`${label} · элементов: ${elements.length}`);
  } catch (err) {
    console.error(err);
    setStatus(`Ошибка загрузки: ${(err as Error).message}`);
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────

list.setSelectHandler((key, additive) => select(key, additive));
list.setTypeVisibilityHandler((keys, visible) =>
  viewer.setTypeHidden(keys, !visible),
);
viewer.setSelectHandler((key, additive) => select(key, additive));

checks.setModelsGetter(() => loadedModels);
checks.setCategoryHandler((keys, status, isolate) =>
  focusElements(keys, isolate, STATUS_COLOR[status]),
);
checks.setElementHandler((key, status, isolate) =>
  focusElement(key, isolate, STATUS_COLOR[status]),
);

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  if (files.length) void openFiles(files);
  fileInput.value = ""; // allow re-opening the same file
});

trmInput.addEventListener("change", () => {
  const file = trmInput.files?.[0];
  if (file) void openTrm(file);
  trmInput.value = "";
});

// Drag & drop: several .ifc → merged models; a single other file → TRM.
const appEl = byId("app");
appEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  appEl.classList.add("dragover");
});
appEl.addEventListener("dragleave", (e) => {
  if (e.target === appEl) appEl.classList.remove("dragover");
});
appEl.addEventListener("drop", (e) => {
  e.preventDefault();
  appEl.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files ?? [])];
  const ifc = files.filter((f) => f.name.toLowerCase().endsWith(".ifc"));
  if (ifc.length) void openFiles(ifc);
  else if (files[0]) void openTrm(files[0]);
});

filterInput.addEventListener("input", () => list.setFilter(filterInput.value));

storeySelect.addEventListener("change", () => {
  const v = storeySelect.value;
  applyStorey(v ? Number(v) : null);
});

btnView.addEventListener("click", () => {
  const name = loadedNames.find((n) => trm.viewIndexFor(n) >= 0);
  if (!name || !trm.focusView(name)) {
    setStatus("Для загруженных моделей нет вида в TRM");
  }
});

btnIsolate.addEventListener("click", () => {
  viewer.isolateSelected();
  refreshHidden();
});
btnHide.addEventListener("click", () => {
  viewer.hideSelected();
  refreshHidden();
});
btnShowAll.addEventListener("click", () => {
  viewer.showAll();
  refreshHidden();
});

makeVerticalResizer(byId("pane-resizer"), byId("pane-list"), byId("sidebar"));

updateButtons();

// Resolve the backend URL before checks can run, then invite a file.
void loadConfig().then(() => setStatus("Откройте IFC-файл(ы)"));
