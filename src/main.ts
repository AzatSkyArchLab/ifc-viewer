import "./style.css";
import { loadConfig } from "./core/config.ts";
import { IfcParser } from "./core/ifc-parser.ts";
import { modelOfKey } from "./core/types.ts";
import type { IfcStorey } from "./core/types.ts";
import { Viewer } from "./viewer/viewer.ts";
import { ElementList } from "./ui/element-list.ts";
import { PropertiesPanel } from "./ui/properties-panel.ts";
import { TrmView } from "./ui/trm-view.ts";
import { ChecksPanel, type CheckFinding } from "./ui/checks-panel.ts";
import { fetchCoveringOffsets } from "./core/checks-api.ts";
import { ModelTree } from "./ui/model-tree.ts";
import { makeDetachable, makeVerticalResizer } from "./ui/pane-resizer.ts";
import { History } from "./core/history.ts";
import {
  buildStoreyIndex,
  cloneState,
  emptyState,
  resolve,
  typeGroups,
  typeKey,
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
const loadingEl = byId("loading");
const loadingTextEl = byId("loading-text");
const loadingBarEl = byId("loading-bar");
const loadingBarFillEl = byId("loading-bar-fill");
const clashPopEl = byId("clash-pop");
const clashPopTitleEl = byId("clash-pop-title");
const clashPopBodyEl = byId("clash-pop-body");
const noticeEl = byId("viewer-notice");
const noticeTextEl = byId("viewer-notice-text");

/** Shows / hides the blocking overlay shown while an IFC is parsed. */
function setLoading(on: boolean, text?: string): void {
  if (text) loadingTextEl.textContent = text;
  loadingEl.hidden = !on;
  if (!on) setProgress(null);
}

/**
 * Drives the progress bar. A number 0..1 fills it (determinate — used per file
 * in a multi-file load); `null` makes it indeterminate (a sliding animation
 * that keeps moving even while web-ifc blocks the main thread, since it runs on
 * the compositor).
 */
function setProgress(fraction: number | null): void {
  if (fraction == null) {
    loadingBarEl.classList.add("indeterminate");
    loadingBarFillEl.style.width = "";
  } else {
    loadingBarEl.classList.remove("indeterminate");
    loadingBarFillEl.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }
}

/** A static notice over the empty viewport (e.g. a zip can't be visualised). */
function setNotice(text: string | null): void {
  if (text) noticeTextEl.textContent = text;
  noticeEl.hidden = !text;
}

/**
 * Resolves once the browser has actually painted. web-ifc parsing blocks the
 * main thread, so the spinner has to reach the screen *before* it starts —
 * a single rAF still fires before the paint, hence the double hop.
 *
 * The timer is not a nicety: rAF never fires in a hidden tab, and switching
 * away mid-load is exactly what people do, so waiting on rAF alone would stall
 * the parse forever. Whichever comes first wins.
 */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}

/** What the status line says at rest — restored after a transient message. */
let modelSummary = "";

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
/** Storey key → storey, to name the level an element sits on (props panel). */
let storeyByKey = new Map<number, IfcStorey>();
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
 * A collision is shown in three colours: one file's element, the other file's
 * element, and the contact point. Neither side may be orange — that is the
 * selection highlight, and a collision must never read as "this is selected".
 */
const COLLISION_A = 0x2563eb; // первая сторона — синий
const COLLISION_B = 0x9333ea; // вторая сторона — фиолетовый
const COLLISION_HIT = 0xff0000; // само пересечение — красный

/** One collision as the UI holds it: two sides plus the number shown to the user. */
interface ClashSides {
  a?: CheckFinding;
  b?: CheckFinding;
  /** What the marker is labelled with — the same «№ точки» the report prints. */
  label: string;
}

/** Collisions currently on screen, keyed by marker id (unique across files). */
let clashPairs = new Map<number, ClashSides>();

/**
 * Puts the collisions on screen as markers only — a red dot at every contact
 * point, nothing recoloured yet. Which two elements met is answered on demand,
 * by clicking a dot: colouring every pair at once turns the model into noise
 * once there are more than a handful.
 */
function showCollisions(findings: CheckFinding[], isolate: boolean): void {
  clashPairs = new Map();
  // A within-file check numbers from 1 in every model, so its numbers repeat
  // across a set and the model has to be part of the grouping key. A cross-file
  // check numbers the whole set once, and its two sides live in *different*
  // models — there the number alone is the key. Either way the marker gets its
  // own id, and the number stays what the user reads.
  const byGroup = new Map<string, number>();
  let markerId = 0;
  for (const f of findings) {
    if (f.pair == null) continue;
    const group = f.file
      ? `set:${f.pair}`
      : `${f.source ?? modelOfKey(f.key)}:${f.pair}`;
    let id = byGroup.get(group);
    if (id === undefined) {
      id = ++markerId;
      byGroup.set(group, id);
      clashPairs.set(id, { label: String(f.pair) });
    }
    const sides = clashPairs.get(id)!;
    if (sides.a === undefined) sides.a = f;
    else sides.b = f;
  }

  const keys: number[] = [];
  const points: { x: number; y: number; z: number; pair: number; label: string }[] = [];
  for (const [pair, sides] of clashPairs) {
    for (const side of [sides.a, sides.b]) if (side) keys.push(side.key);
    const at = sides.a?.point ?? sides.b?.point;
    if (at && at.length === 3) {
      points.push({ ...parser.toScenePoint(at), pair, label: sides.label });
    }
  }

  if (!parser.isOpen) {
    // Zip-режим: 3D нет вообще, и точки повисли бы в пустоте на сырых
    // координатах модели. Номера остаются в списке находок и в Excel.
    setStatus(`Коллизий: ${clashPairs.size} — визуализация недоступна для архива`);
    return;
  }
  act(() => {
    vis.focus = null;
    // Pin both sides visible so a click can always reveal them, even if their
    // type layer is hidden.
    for (const k of keys) vis.forceShow.add(k);
    if (isolate) {
      const keep = new Set(keys);
      for (const k of allKeys) if (!keep.has(k)) vis.hiddenElems.add(k);
    }
  });
  viewer.setKeyColors(null);
  viewer.setMarkers(points, COLLISION_HIT);
  viewer.fitTo(keys);
  closeClashPopup();
  setStatus(
    `Коллизий: ${points.length} — номер у точки совпадает с «№ точки» в Excel; ` +
      `кликните точку, чтобы увидеть пару`,
  );
}

/** Colours one pair's two elements and names them in the popup. */
function openClashPopup(pair: number): void {
  const sides = clashPairs.get(pair);
  if (!sides?.a) return;

  const colors = new Map<number, number>();
  colors.set(sides.a.key, COLLISION_A);
  if (sides.b) colors.set(sides.b.key, COLLISION_B);
  viewer.setKeyColors(colors);
  viewer.setActiveMarker(pair);

  const side = (finding: CheckFinding | undefined, color: number): string => {
    if (!finding) return "";
    const [file, ...rest] = finding.label.split(": ");
    const name = rest.length ? rest.join(": ") : finding.label;
    return `
      <button class="clash-side" type="button" data-key="${finding.key}"
              title="Показать элемент в модели">
        <span class="clash-swatch" style="background:#${color.toString(16).padStart(6, "0")}"></span>
        <span>
          ${rest.length ? `<span class="clash-side-file">${escapeHtml(file)}</span><br />` : ""}
          <span class="clash-side-name">${escapeHtml(name)}</span>
        </span>
      </button>`;
  };

  clashPopTitleEl.textContent = `Коллизия №${sides.label}`;
  clashPopBodyEl.innerHTML =
    side(sides.a, COLLISION_A) +
    side(sides.b, COLLISION_B) +
    `<div class="clash-depth">${escapeHtml(sides.a.reason)}</div>`;
  for (const row of clashPopBodyEl.querySelectorAll<HTMLElement>(".clash-side")) {
    row.addEventListener("click", () => showClashSide(Number(row.dataset.key), row));
  }
  clashPopEl.hidden = false;
}

/**
 * Picks one side of the open collision: the element gets selected (so the
 * attributes panel and the list follow it) and the camera flies to it, while
 * the pair keeps its two colours — the row itself marks which side is being
 * looked at. Selection colour matches the swatch, so the element does not
 * change colour under the cursor and stays identifiable as "this side".
 */
function showClashSide(key: number, row: HTMLElement): void {
  if (!Number.isFinite(key)) return;
  for (const other of clashPopBodyEl.querySelectorAll(".clash-side")) {
    other.classList.toggle("active", other === row);
  }
  const color = row === clashPopBodyEl.firstElementChild ? COLLISION_A : COLLISION_B;
  act(() => {
    vis.focus = null;
    vis.forceShow.add(key); // страховка: сторона могла быть скрыта слоем типа
  });
  selection = [key];
  viewer.setSelection([key], color);
  list.setSelection([key]);
  viewer.fitTo([key]);
  void showProps(key);
}

/**
 * Drops the collision markers. Numbered dots belong to one check run: left on
 * screen while another check is shown, they read as findings of *that* check
 * and their numbers point into the wrong report.
 */
function clearCollisions(): void {
  if (clashPairs.size === 0) return;
  closeClashPopup();
  clashPairs = new Map();
  viewer.setMarkers([]);
  setStatus(modelSummary);
}

function closeClashPopup(): void {
  clashPopEl.hidden = true;
  viewer.setKeyColors(null);
  viewer.setActiveMarker(null);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlights (or isolates) a set of elements by scene key (a check category).
 * Pins them visible so a layer-hidden type (e.g. IfcSpace) still shows, drops
 * any active floor focus, and frames the camera on them.
 */
function focusElements(keys: number[], isolate: boolean, color?: number): void {
  clearCollisions();
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
  clearCollisions();
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

/**
 * The storey an element sits on. The link is the IFC spatial containment
 * (IfcRelContainedInSpatialStructure → IfcBuildingStorey), resolved once per
 * load into `idx`; there is no per-element attribute for it. Null when the
 * element is not directly contained in a storey (site, or a hosted sub-element).
 */
function levelLabel(key: number): string | null {
  const storeyKey = idx.elemStorey.get(key);
  if (storeyKey == null) return null;
  const storey = storeyByKey.get(storeyKey);
  if (!storey) return null;
  const parts: string[] = [];
  if (storey.name) parts.push(storey.name);
  if (storey.elevation != null) {
    const e = storey.elevation;
    parts.push(`отм. ${Number.isInteger(e) ? e : e.toFixed(3).replace(/\.?0+$/, "")}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

async function showProps(key: number, expandAll = false): Promise<void> {
  try {
    props.show(await parser.getElementInfo(key), expandAll, levelLabel(key));
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

/** A web-ifc WASM abort — the module is dead and must be rebuilt to recover. */
function isAbort(err: unknown): boolean {
  return /abort/i.test((err as Error)?.message ?? "");
}

/**
 * Above this upload size the browser's 3D is skipped. Parsing and geometry run
 * in a worker (its own ~4 GB, and the tab never freezes), so this can be far
 * higher than a main-thread limit — only genuinely huge models that would
 * exhaust even the worker's 4 GB fall back to list/tree/checks without 3D.
 * Tunable.
 */
const HEAVY_3D_BYTES = 700 * 1024 * 1024;

/**
 * Below this size, an abort is retried once with COORDINATE_TO_ORIGIN (the
 * likely cause is far-from-origin geometry, which that fixes). Above it, an
 * abort is the 4 GB memory ceiling — no point re-parsing to fail again.
 */
const RETRY_BYTES = 120 * 1024 * 1024;

/**
 * How many individually-too-heavy elements to drop before giving up on 3D.
 * Each retry costs one re-parse, which is seconds even for a 256 MB model.
 */
const GEOMETRY_RETRIES = 8;

/**
 * Loads and displays one or more IFC files. `safe` re-runs with
 * COORDINATE_TO_ORIGIN after a first-attempt abort (the common cause is a
 * georeferenced model whose far-from-origin coordinates overflow web-ifc's
 * tessellation). A progress bar tracks parsing: determinate per file for a
 * multi-file load, indeterminate (animated) for a single file.
 */
async function openFiles(files: File[], safe = false): Promise<void> {
  if (files.length === 0) return;
  const multi = files.length > 1;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const totalMB = Math.round(totalBytes / (1024 * 1024));
  const heavy = totalBytes > HEAVY_3D_BYTES;
  setNotice(null);
  setStatus(`Загрузка ${files.length} файл(ов)…`);
  setLoading(true, safe ? "Повторная загрузка (безопасный режим)…" : "Загрузка IFC…");
  setProgress(multi ? 0 : null);
  await painted();
  try {
    parser.clearAll();
    loadedModels = [];
    loadedNames = [];
    const tParse = performance.now();
    for (const [i, file] of files.entries()) {
      setLoading(true, multi ? `Разбор ${i + 1}/${files.length}: ${file.name}` : `Разбор ${file.name}…`);
      if (multi) setProgress(i / files.length);
      await painted();
      const data = new Uint8Array(await file.arrayBuffer());
      const modelId = await parser.add(data, file.name, { coordinateToOrigin: safe });
      loadedModels.push({ file, modelId });
      loadedNames.push(
        file.name.replace(/\.ifc$/i, "").replace(/\s*\(\d+\)\s*$/, "").trim(),
      );
    }
    console.info(`[viewer] разбор ${totalMB} МБ: ${Math.round(performance.now() - tParse)} мс`);

    const elements = await parser.getElements();
    const storeys = await parser.getStoreys();
    storeyByKey = new Map(storeys.map((s) => [s.key, s]));

    if (heavy) {
      // Beyond even the worker's ~4 GB — skip 3D tessellation. List, tree and
      // checks stay; 3D of a model this size belongs in a desktop viewer.
      viewer.loadMeshes([]);
      setNotice(
        `Модель ${totalMB} МБ — трёхмерный вид в браузере пропущен, чтобы не ` +
          "переполнить память. Список, дерево и проверки доступны. Для 3D " +
          "используйте настольный просмотрщик.",
      );
    } else {
      setLoading(true, "Построение геометрии…");
      setProgress(0);
      await painted();
      const tGeom = performance.now();
      // Geometry runs in the worker; progress paints because the main thread is
      // free. Load meshes first so the list's initial layer-hides (IfcSpace) apply.
      //
      // One pathological element can demand more than the WASM heap has and its
      // abort() kills the module, taking the whole model's geometry with it.
      // So: note which element did it, restart the worker, re-open (the parse is
      // seconds) and run again without it. A handful of such elements is worth
      // dropping to get the rest of the model on screen.
      const skip: number[] = [];
      for (let attempt = 0; ; attempt++) {
        try {
          const meshes = await parser.getMeshes(
            (done, total) => setProgress(total > 0 ? done / total : null),
            skip,
          );
          viewer.loadMeshes(meshes);
          if (skip.length > 0) {
            setNotice(
              `Пропущено тяжёлых элементов: ${skip.length} — их геометрия не ` +
                "помещается в память браузера. Остальная модель показана.",
            );
          }
          break;
        } catch (err) {
          const bad = (err as Error & { failedGeometry?: number }).failedGeometry;
          if (bad == null || attempt >= GEOMETRY_RETRIES) throw err;
          console.warn(`[viewer] геометрия #${bad} не влезла — пропускаю и повторяю`);
          skip.push(bad);
          setLoading(true, `Пропускаю тяжёлую геометрию (${skip.length})…`);
          setProgress(null);
          await painted();
          await parser.recover();
          for (const file of files) {
            const data = new Uint8Array(await file.arrayBuffer());
            await parser.add(data, file.name, { coordinateToOrigin: safe });
          }
        }
      }
      console.info(`[viewer] геометрия: ${Math.round(performance.now() - tGeom)} мс`);
    }

    // Rebuild the central visibility model for this load.
    typeByKey = new Map(elements.map((e) => [e.key, e.typeName]));
    allKeys = elements.map((e) => e.key);
    idx = buildStoreyIndex(storeys);
    vis = emptyState();
    history.clear();
    tree.setData(parser.getModels(), storeys, typeGroups(elements));

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
    setProgress(1);
    modelSummary = `${label} · элементов: ${elements.length}`;
    setStatus(modelSummary);
  } catch (err) {
    console.error("Загрузка IFC не удалась:", err);
    // A moderate-sized abort is usually far-from-origin geometry — rebuild the
    // (now-dead) worker and retry once translated to the origin. Skip the retry
    // for big files: there the abort is the 4 GB WASM ceiling, and re-parsing
    // hundreds of MB just to fail again wastes a minute.
    if (!safe && isAbort(err) && totalBytes < RETRY_BYTES) {
      console.warn("web-ifc прервал обработку — повтор в безопасном режиме (COORDINATE_TO_ORIGIN).");
      await parser.recover();
      setLoading(false);
      return openFiles(files, true);
    }
    await parser.recover(); // rebuild so the next load works without a page reload
    if (isAbort(err)) {
      // Can't render in the browser (too big for 4 GB WASM, or bad geometry) —
      // fall back to checks-only so the file is still usable. The checks run on
      // the backend, which handles a 300 MB model natively.
      checksOnly(
        files,
        `Не удалось отрисовать модель ${totalMB} МБ в браузере (предел памяти ` +
          "~4 ГБ). Проверки доступны — откройте панель «Проверки». Для 3D " +
          "используйте настольный просмотрщик.",
        `${files[0]?.name ?? "модель"} · только проверки`,
      );
    } else {
      setStatus(`Ошибка загрузки: ${(err as Error).message}`);
    }
  } finally {
    setLoading(false);
  }
}

/**
 * Sets the app up to run checks on `files` without a browser 3D view: the scene
 * and side panels are cleared, a notice explains why, and the files are kept so
 * the checks (which run on the backend) still work. Used for zip archives and
 * as the fallback when a model is too big for the browser to render.
 */
function checksOnly(files: File[], notice: string, status: string): void {
  parser.clearAll();
  loadedModels = files.map((file) => ({ file, modelId: -1 }));
  loadedNames = files.map((f) => f.name.replace(/\.(ifc|zip)$/i, "").trim());

  viewer.loadMeshes([]);
  typeByKey = new Map();
  allKeys = [];
  storeyByKey = new Map();
  idx = buildStoreyIndex([]);
  vis = emptyState();
  history.clear();
  tree.setData(parser.getModels(), [], []);
  seeding = true;
  list.setElements([]);
  seeding = false;

  checks.setEnabled(true);
  applyVis();
  setSelection([]);
  props.clear();
  updateViewButton();
  setNotice(notice);
  setStatus(status);
}

function openArchive(archives: File[]): void {
  if (archives.length === 0) return;
  const label =
    archives.length === 1 ? archives[0].name : `архивов: ${archives.length}`;
  checksOnly(
    archives,
    "Визуализация ZIP-архива недоступна. Проверки доступны — откройте панель «Проверки».",
    `${label} · архив, только проверки`,
  );
}

/** Routes a dropped/selected set: .ifc → visualise; .zip → checks-only. */
function openDropped(files: File[]): void {
  const ifc = files.filter((f) => /\.ifc$/i.test(f.name));
  const zip = files.filter((f) => /\.zip$/i.test(f.name));
  if (ifc.length) void openFiles(ifc);
  else if (zip.length) openArchive(zip);
  else if (files[0]) void openTrm(files[0]);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

list.setSelectHandler((key, additive) => select(key, additive));
// A layer eye in the element list toggles that type for ONE model only.
list.setTypeVisibilityHandler((modelId, typeLower, visible) => {
  const k = typeKey(modelId, typeLower);
  const mutate = () => {
    if (visible) vis.hiddenTypes.delete(k);
    else vis.hiddenTypes.add(k);
  };
  if (seeding) mutate();
  else act(mutate);
});
viewer.setSelectHandler((key, additive) => select(key, additive));

checks.setModelsGetter(() => loadedModels);
viewer.setMarkerHandler((pair) => openClashPopup(pair));
byId<HTMLButtonElement>("clash-pop-close").addEventListener("click", closeClashPopup);

checks.setCategoryHandler((findings, status, isolate) => {
  // Cross-file collisions carry a pair number and a contact point — those get
  // the two-colour + red-marker treatment instead of one flat highlight.
  const collisions = findings.filter((f) => f.pair != null && f.point);
  if (collisions.length > 0) {
    // Цвет точки не несёт вердикта: красный — это «здесь тела пересеклись»,
    // а нарушение это или мелкое пересечение, говорят категория и окно пары.
    // Оранжевый под это не годится — он занят выделением элемента.
    showCollisions(collisions, isolate);
    return;
  }
  focusElements(findings.filter((f) => f.pickable).map((f) => f.key), isolate,
                STATUS_COLOR[status]);
});
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
// "All models" layer toggle — flips the layer in every model that has it.
tree.onLayerGroup((modelIds, typeLower, visible) => {
  act(() => {
    for (const m of modelIds) {
      const k = typeKey(m, typeLower);
      if (visible) vis.hiddenTypes.delete(k);
      else vis.hiddenTypes.add(k);
    }
  });
  list.setHiddenTypes(vis.hiddenTypes); // resync the element list's eyes
});
tree.onFocus((modelId, storeyKey) =>
  act(() => {
    const same =
      vis.focus?.modelId === modelId && vis.focus?.storeyKey === storeyKey;
    vis.focus = same ? null : { modelId, storeyKey };
  }),
);

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  if (files.length) openDropped(files);
  fileInput.value = ""; // allow re-opening the same file
});

trmInput.addEventListener("change", () => {
  const file = trmInput.files?.[0];
  if (file) void openTrm(file);
  trmInput.value = "";
});

// Drag & drop: several .ifc → merged models; a .zip → checks-only;
// a single other file → TRM.
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
  openDropped([...(e.dataTransfer?.files ?? [])]);
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

// ── IFC-54 debug hook ─────────────────────────────────────────────────────────
// Раскрашивает точки покрытий по смещению над рельефом: зелёные — постоянная
// высота (идёт по рельефу), красные — отклонение. Вызов из консоли:
//   await window.__coverings()
(window as unknown as { __coverings: () => Promise<unknown> }).__coverings =
  async () => {
    const data = await fetchCoveringOffsets(loadedModels.map((m) => m.file));
    const pts: { x: number; y: number; z: number; label: string; color: number }[] = [];
    for (const cover of data.coverings) {
      for (const sample of cover.points) {
        const dev = Math.abs(sample.offset_mm - cover.median_mm);
        pts.push({
          ...parser.toScenePoint(sample.p),
          label: String(sample.offset_mm),
          color: dev < 30 ? 0x22c55e : 0xef4444,
        });
      }
    }
    viewer.setDebugPoints(pts);
    setStatus(
      `IFC-54 дебаг: рельеф ${data.relief?.flat ? "плоский" : `перепад ${data.relief?.z_range_mm} мм`}` +
        ` · покрытий ${data.coverings.length} · точек ${pts.length}`,
    );
    return data.coverings.map((c) => ({
      name: c.name, rus: c.rus_name, status: c.status,
      std: c.std_mm, median: c.median_mm, note: c.note,
    }));
  };
