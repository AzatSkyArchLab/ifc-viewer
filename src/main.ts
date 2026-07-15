import "./style.css";
import { loadConfig } from "./core/config.ts";
import { IfcParser } from "./core/ifc-parser.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";
import { TrmView } from "./ui/trm-view.ts";
import { ChecksPanel } from "./ui/checks-panel.ts";
import { ModelTree } from "./ui/model-tree.ts";
import { makeDetachable, makeVerticalResizer } from "./ui/pane-resizer.ts";
import { History } from "./core/history.ts";
import {
  buildStoreyIndex,
  cloneState,
  emptyState,
  resolve,
  type StoreyIndex,
  type VisState,
} from "./core/visibility.ts";

/**
 * Thin glue for the standalone IFC viewer: wires the parser, the three.js scene
 * and the panels, and owns the selection plus one central visibility state.
 * Several models share one scene (composite `key = modelId * KEY_BASE +
 * expressID`). All visibility — per-model / per-storey toggles, floor focus,
 * isolate / hide, type layers — is a single VisState resolved into hidden /
 * ghost sets and pushed to the viewer, the list and the model tree. Every
 * visibility change is one undoable action. IFC checks run against the backend
 * configured in config.json; their set is discovered from the API response.
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
const tree = new ModelTree(byId("model-tree"));
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
const btnView = byId<HTMLButtonElement>("btn-view");
const btnIsolate = byId<HTMLButtonElement>("btn-isolate");
const btnHide = byId<HTMLButtonElement>("btn-hide");
const btnShowAll = byId<HTMLButtonElement>("btn-showall");
const btnUndo = byId<HTMLButtonElement>("btn-undo");
const btnRedo = byId<HTMLButtonElement>("btn-redo");

/** Ordered selection of composite keys; the last is the most recent pick. */
let selection: number[] = [];
/** Loaded models (file + web-ifc model id), re-sent to the backend for checks. */
let loadedModels: { file: File; modelId: number }[] = [];
/** Base names of loaded models, matched to a TRM view. */
let loadedNames: string[] = [];

// ── Central visibility state ─────────────────────────────────────────────────
let vis: VisState = emptyState();
let idx: StoreyIndex = buildStoreyIndex([]);
let typeByKey = new Map<number, string>();
let allKeys: number[] = [];
const history = new History<VisState>(cloneState, 50);
/** True while seeding the initial default type-hides (IfcSpace) — no history. */
let seeding = false;

function typeOf(key: number): string {
  return typeByKey.get(key) ?? "";
}

/** Recompute visibility from `vis` and push it to the viewer, list and tree. */
function applyVis(): void {
  const { hidden, ghost } = resolve(allKeys, typeOf, vis, idx);
  viewer.render(hidden, ghost);
  list.setHidden([...hidden]);
  tree.setState(vis);
  updateButtons();
}

/** Runs a visibility mutation as one undoable action (snapshot → mutate → apply). */
function act(mutate: () => void): void {
  history.record(vis);
  mutate();
  applyVis();
}

function undo(): void {
  const prev = history.undo(vis);
  if (prev == null) return;
  vis = prev;
  list.setHiddenTypes(vis.hiddenTypes);
  applyVis();
}

function redo(): void {
  const next = history.redo(vis);
  if (next == null) return;
  vis = next;
  list.setHiddenTypes(vis.hiddenTypes);
  applyVis();
}

/** True when "Показать всё" has something to restore (type layers excluded). */
function hasAnyHidden(): boolean {
  return (
    vis.hiddenModels.size > 0 ||
    vis.hiddenStoreys.size > 0 ||
    vis.hiddenElems.size > 0 ||
    vis.forceShow.size > 0 ||
    vis.focus != null
  );
}

/** Highlight colours per check status (violation / review / ok). */
const STATUS_COLOR: Record<string, number> = {
  violation: 0xff3b30,
  review: 0xff9500,
  ok: 0x2563eb,
};

/**
 * Highlights (or isolates) a set of elements by scene key (a check category).
 * Pins them visible so a layer-hidden type (e.g. IfcSpace) still shows, drops
 * any active floor focus, and frames the camera on them.
 */
function focusElements(keys: number[], isolate: boolean, color?: number): void {
  act(() => {
    vis.focus = null;
    for (const k of keys) vis.forceShow.add(k);
    if (isolate) {
      const keep = new Set(keys);
      for (const k of allKeys) if (!keep.has(k)) vis.hiddenElems.add(k);
    }
  });
  selection = keys;
  viewer.setSelection(keys, color);
  list.setSelection(keys);
  viewer.fitTo(keys); // frame the category, not the whole model
  const last = keys[keys.length - 1];
  if (last != null) void showProps(last);
  updateButtons();
}

/**
 * Focus a single flagged element (from a check finding): pin it visible, tint
 * it, zoom to it, and expand all its attributes on the left. `isolate` hides
 * everything except this element.
 */
function focusElement(key: number, isolate: boolean, color?: number): void {
  act(() => {
    vis.focus = null;
    vis.forceShow.add(key);
    if (isolate) {
      for (const k of allKeys) if (k !== key) vis.hiddenElems.add(k);
    }
  });
  selection = [key];
  viewer.setSelection([key], color);
  list.setSelection([key]);
  viewer.fitTo([key]);
  void showProps(key, true);
  updateButtons();
}

/** Shows the "view model" button when a loaded model has a matching TRM drawing. */
function updateViewButton(): void {
  btnView.hidden = !loadedNames.some((n) => trm.viewIndexFor(n) >= 0);
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
  btnShowAll.disabled = !hasAnyHidden();
  btnUndo.disabled = !history.canUndo;
  btnRedo.disabled = !history.canRedo;
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
    const storeys = parser.getStoreys();
    // Load meshes first so the list's initial layer-hides (IfcSpace) apply.
    viewer.loadMeshes(parser.getMeshes());

    // Rebuild the central visibility model for this load.
    typeByKey = new Map(elements.map((e) => [e.key, e.typeName]));
    allKeys = elements.map((e) => e.key);
    idx = buildStoreyIndex(storeys);
    vis = emptyState();
    history.clear();
    tree.setData(parser.getModels(), storeys);

    // setElements seeds the default type-hides (IfcSpace) via the type handler;
    // record them as the baseline, not as an undoable action.
    seeding = true;
    list.setElements(elements);
    seeding = false;

    checks.setEnabled(true);
    applyVis();
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
list.setTypeVisibilityHandler((typeLower, visible) => {
  const mutate = () => {
    if (visible) vis.hiddenTypes.delete(typeLower);
    else vis.hiddenTypes.add(typeLower);
  };
  if (seeding) mutate();
  else act(mutate);
});
viewer.setSelectHandler((key, additive) => select(key, additive));

checks.setModelsGetter(() => loadedModels);
checks.setCategoryHandler((keys, status, isolate) =>
  focusElements(keys, isolate, STATUS_COLOR[status]),
);
checks.setElementHandler((key, status, isolate) =>
  focusElement(key, isolate, STATUS_COLOR[status]),
);

// Model tree: each control is one undoable visibility action.
tree.onModel((modelId, visible) =>
  act(() => {
    if (visible) vis.hiddenModels.delete(modelId);
    else vis.hiddenModels.add(modelId);
  }),
);
tree.onAllModels((visible) =>
  act(() => {
    vis.hiddenModels.clear();
    if (!visible) {
      for (const m of parser.getModels()) vis.hiddenModels.add(m.modelId);
    }
  }),
);
tree.onStorey((storeyKey, visible) =>
  act(() => {
    if (visible) vis.hiddenStoreys.delete(storeyKey);
    else vis.hiddenStoreys.add(storeyKey);
  }),
);
tree.onFloorGroup((storeyKeys, visible) =>
  act(() => {
    for (const k of storeyKeys) {
      if (visible) vis.hiddenStoreys.delete(k);
      else vis.hiddenStoreys.add(k);
    }
  }),
);
tree.onFocus((modelId, storeyKey) =>
  act(() => {
    const same =
      vis.focus?.modelId === modelId && vis.focus?.storeyKey === storeyKey;
    vis.focus = same ? null : { modelId, storeyKey };
  }),
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

btnView.addEventListener("click", () => {
  const name = loadedNames.find((n) => trm.viewIndexFor(n) >= 0);
  if (!name || !trm.focusView(name)) {
    setStatus("Для загруженных моделей нет вида в TRM");
  }
});

btnIsolate.addEventListener("click", () => {
  if (selection.length === 0) return;
  const keep = new Set(selection);
  act(() => {
    vis.focus = null;
    for (const k of allKeys) if (!keep.has(k)) vis.hiddenElems.add(k);
  });
});
btnHide.addEventListener("click", () => {
  if (selection.length === 0) return;
  const sel = selection.slice();
  act(() => {
    for (const k of sel) vis.hiddenElems.add(k);
  });
  setSelection([]);
});
btnShowAll.addEventListener("click", () => {
  act(() => {
    vis.hiddenModels.clear();
    vis.hiddenStoreys.clear();
    vis.hiddenElems.clear();
    vis.forceShow.clear();
    vis.focus = null;
    // Type layers are intentionally kept (IfcSpace stays hidden).
  });
});
btnUndo.addEventListener("click", () => undo());
btnRedo.addEventListener("click", () => redo());

// Undo / redo shortcuts (ignored while typing in a field).
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  ) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    redo();
  }
});

makeVerticalResizer(byId("pane-resizer"), byId("pane-list"), byId("sidebar"));

// Checks panel: resizable by the divider below it, and pop-out into a window.
const checksEl = byId("checks");
const checksResizer = byId("checks-resizer");
makeVerticalResizer(checksResizer, checksEl, byId("sidebar"));
makeDetachable(
  checksEl,
  checksEl.querySelector("summary")!,
  byId("checks-popout"),
  checksResizer,
);
// A collapsed docked panel should shrink back to just its header.
checksEl.addEventListener("toggle", () => {
  if (!(checksEl as HTMLDetailsElement).open && !checksEl.classList.contains("floating")) {
    checksEl.style.flex = "";
    checksEl.style.maxHeight = "";
  }
});

updateButtons();

// Resolve the backend URL before checks can run, then invite a file.
void loadConfig().then(() => setStatus("Откройте IFC-файл(ы)"));
