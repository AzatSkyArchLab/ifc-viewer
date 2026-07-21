import {
  exportIfcReport,
  listIfcChecks,
  runIfcIdsChecks,
  type ElementStatus,
  type IfcCheckResult,
} from "../core/checks-api.ts";
import { makeKey } from "../core/types.ts";

/** Highlights (or isolates) a status category. Findings carry the contact point
 *  and pair number when they come from a cross-file collision check. */
export type CategoryHandler = (
  findings: CheckFinding[],
  status: ElementStatus,
  isolate: boolean,
) => void;

/** One flagged element as the app sees it. */
export interface CheckFinding {
  key: number;
  label: string;
  reason: string;
  pickable: boolean;
  /** Contact point in model coordinates — set for collision findings. */
  point?: number[] | null;
  /** Ties the two sides of one cross-file collision together. */
  pair?: number | null;
  /** File the element belongs to — set only when the check spans files. */
  file?: string | null;
  /** File whose result carried this finding (a zip member has no model). */
  source?: string;
}

/** A loaded model the check runs against. */
export interface CheckModel {
  file: File;
  modelId: number;
}

const CATEGORIES: { status: ElementStatus; label: string }[] = [
  { status: "violation", label: "Нарушения" },
  { status: "review", label: "На проверку" },
  { status: "ok", label: "Допустимо" },
];

/** Aggregated state of one check across all loaded models. */
interface CheckAgg {
  id: string;
  name: string;
  description: string;
  counts: Record<ElementStatus, number>;
  byStatus: Map<ElementStatus, CheckFinding[]>;
  report: boolean;
}

/**
 * IFC checks panel. Shows the full list of checks the backend offers; each can
 * be run on its own or all at once. Results render inline per check. The check
 * set is discovered from the backend — a new backend check appears here with no
 * frontend change.
 */
export class ChecksPanel {
  private getModels: () => CheckModel[] = () => [];
  private onCategory: CategoryHandler = () => {};
  private onElement: (key: number, status: ElementStatus, isolate: boolean) => void =
    () => {};
  private list: { id: string; name: string; description: string }[] = [];
  private results = new Map<string, CheckAgg>();
  private running = new Set<string>();
  /** Check ids the user has expanded — preserved across re-renders. */
  private openChecks = new Set<string>();

  constructor(
    private runAllBtn: HTMLButtonElement,
    private resultEl: HTMLElement,
  ) {
    runAllBtn.addEventListener("click", () => void this.runAll());
  }

  setModelsGetter(fn: () => CheckModel[]): void {
    this.getModels = fn;
  }

  setCategoryHandler(fn: CategoryHandler): void {
    this.onCategory = fn;
  }

  /** Handles a click on a single flagged element (focus) or its isolate button. */
  setElementHandler(
    fn: (key: number, status: ElementStatus, isolate: boolean) => void,
  ): void {
    this.onElement = fn;
  }

  setEnabled(enabled: boolean): void {
    this.runAllBtn.disabled = !enabled;
    this.results.clear();
    this.running.clear();
    this.openChecks.clear();
    if (!enabled) {
      this.list = [];
      this.resultEl.innerHTML = "";
      return;
    }
    void this.loadList();
  }

  /** Fetches the available checks so the user can pick one before running. */
  private async loadList(): Promise<void> {
    this.resultEl.innerHTML = `<div class="chk-note">Загрузка списка проверок…</div>`;
    try {
      this.list = await listIfcChecks();
    } catch {
      this.list = [];
      this.resultEl.innerHTML =
        `<div class="chk-note err">Не удалось получить список проверок. Доступен ли бэкенд?</div>`;
      return;
    }
    this.render();
  }

  private async runAll(): Promise<void> {
    const models = this.getModels();
    if (models.length === 0 || this.list.length === 0) return;
    for (const c of this.list) this.running.add(c.id);
    this.render();
    try {
      const results = await runIfcIdsChecks(models.map((m) => m.file));
      this.ingest(results, models);
    } catch (err) {
      this.flash(err);
    }
    this.running.clear();
    this.render();
  }

  private async runOne(checkId: string): Promise<void> {
    const models = this.getModels();
    if (models.length === 0) return;
    this.running.add(checkId);
    this.render();
    try {
      const results = await runIfcIdsChecks(models.map((m) => m.file), [checkId]);
      this.ingest(results, models, checkId);
    } catch (err) {
      this.flash(err);
    }
    this.running.delete(checkId);
    this.render();
  }

  /** Folds backend results (one or all checks) into this.results. */
  private ingest(
    results: Awaited<ReturnType<typeof runIfcIdsChecks>>,
    models: CheckModel[],
    onlyId?: string,
  ): void {
    // A zip goes up as one file and comes back as one result per IFC inside it,
    // so results and models line up only when nothing was unpacked. Matching by
    // name keeps every member's checks; a member with no model of its own is
    // still shown, hosted by the archive it arrived in.
    const byName = new Map(models.map((m) => [m.file.name, m]));
    const multi = results.length > 1 || models.length > 1;
    const built = new Map<string, CheckAgg>();
    const order: string[] = [];
    results.forEach((fileResult, i) => {
      const model = byName.get(fileResult.filename) ?? models[i] ?? models[0];
      if (!model) return;
      const name = fileResult.filename || model.file.name;
      for (const check of fileResult.checks ?? []) {
        if (check.scope === "batch" && i > 0) continue; // merge cross-file once
        if (onlyId && check.id !== onlyId) continue;
        this.mergeCheck(built, order, check, name, model.modelId, multi);
      }
    });
    for (const [id, agg] of built) {
      this.results.set(id, agg);
      this.openChecks.add(id); // a freshly-run check opens to show its result
    }
  }

  private flash(err: unknown): void {
    this.resultEl.insertAdjacentHTML(
      "afterbegin",
      `<div class="chk-note err">Ошибка запроса: ${escapeHtml((err as Error).message)}</div>`,
    );
  }

  /** Folds one check result of one model into the cross-model aggregate. */
  private mergeCheck(
    checks: Map<string, CheckAgg>,
    order: string[],
    check: IfcCheckResult,
    fileName: string,
    modelId: number,
    multi: boolean,
  ): void {
    let agg = checks.get(check.id);
    if (!agg) {
      agg = {
        id: check.id,
        name: check.name,
        description: check.description,
        counts: { violation: 0, review: 0, ok: 0 },
        byStatus: new Map(),
        report: check.report === true,
      };
      checks.set(check.id, agg);
      order.push(check.id);
    }
    for (const s of ["violation", "review", "ok"] as ElementStatus[]) {
      agg.counts[s] += check.counts[s] ?? 0;
    }
    const prefix = multi ? `${fileName.replace(/\.ifc$/i, "")}: ` : "";
    for (const el of check.elements) {
      const list = agg.byStatus.get(el.status) ?? [];
      // A cross-file finding names its own file: its two sides live in
      // different models, so the result's own file is the wrong home for it.
      const owner = el.file ? this.modelIdOf(el.file) : null;
      const home = owner ?? modelId;
      const ownerName = el.file ? el.file.replace(/\.ifc$/i, "") : null;
      const shownPrefix = ownerName ? `${ownerName}: ` : prefix;
      const label = el.express_id
        ? `${shownPrefix}${el.name ?? el.ifc_class} #${el.express_id}`
        : el.name ?? el.ifc_class;
      list.push({
        key: makeKey(home, el.express_id),
        label,
        reason: el.reason,
        pickable: el.pickable !== false,
        point: el.point,
        pair: el.pair,
        file: el.file,
        source: fileName,
      });
      agg.byStatus.set(el.status, list);
    }
  }

  /** modelId of an uploaded file by name, or null when it is not loaded. */
  private modelIdOf(filename: string): number | null {
    const found = this.getModels().find((m) => m.file.name === filename);
    return found ? found.modelId : null;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    if (this.list.length === 0) {
      this.resultEl.innerHTML = `<div class="chk-note">Проверки не найдены.</div>`;
      return;
    }
    this.resultEl.innerHTML = this.list.map((c) => this.renderCheck(c)).join("");
    this.bindActions();
  }

  private renderCheck(meta: { id: string; name: string }): string {
    const agg = this.results.get(meta.id);
    const running = this.running.has(meta.id);
    const state = running
      ? "run"
      : !agg
        ? "idle"
        : agg.counts.violation > 0
          ? "violation"
          : agg.counts.review > 0
            ? "review"
            : "ok";

    const status = running
      ? `<span class="chk-n run">проверка…</span>`
      : !agg
        ? `<span class="chk-n idle">не выполнена</span>`
        : agg.counts.violation > 0
          ? `<span class="chk-n bad">${agg.counts.violation}</span>`
          : agg.counts.review > 0
            ? `<span class="chk-n warn">${agg.counts.review}</span>`
            : `<span class="chk-n ok">нет замечаний</span>`;

    const report =
      agg?.report
        ? `<button class="chk-report" data-report="${escapeHtml(meta.id)}" type="button" title="Полный список элементов проверки в Excel">Excel</button>`
        : "";
    const runBtn = `<button class="chk-one" data-run="${escapeHtml(meta.id)}" type="button" ${running ? "disabled" : ""}>${agg ? "Повторить" : "Выполнить"}</button>`;

    const body = agg
      ? CATEGORIES.filter((c) => agg.counts[c.status] > 0)
          .map((c) => this.renderCategory(agg, c))
          .join("") || `<div class="chk-note">Замечаний нет.</div>`
      : `<div class="chk-note">Проверка ещё не выполнялась.</div>`;

    return `
      <details class="chk-check chk-s-${state}" data-check="${escapeHtml(meta.id)}" ${this.openChecks.has(meta.id) ? "open" : ""}>
        <summary class="chk-check-head">
          <span class="chk-check-id">${escapeHtml(meta.id)}</span>
          <span class="chk-check-name">${escapeHtml(meta.name)}</span>
          ${status}
          ${report}
          ${runBtn}
        </summary>
        <div class="chk-check-body" title="${escapeHtml(agg?.description ?? "")}">
          ${body}
        </div>
      </details>`;
  }

  private renderCategory(
    check: CheckAgg,
    cat: { status: ElementStatus; label: string },
  ): string {
    const items = check.byStatus.get(cat.status) ?? [];
    const list = items
      .map(
        (el, i) => `
        <div class="chk-el${el.pickable ? " chk-el-pick" : ""}" data-c="${escapeHtml(check.id)}" data-s="${cat.status}" data-i="${i}" title="${escapeHtml(el.reason)}">
          <span class="chk-el-name">${escapeHtml(el.label)}</span>
          <span class="chk-el-reason">${escapeHtml(el.reason)}</span>
          ${el.pickable ? `<button class="chk-el-iso" data-c="${escapeHtml(check.id)}" data-s="${cat.status}" data-i="${i}" type="button" title="Изолировать только этот элемент">изолировать</button>` : ""}
        </div>`,
      )
      .join("");
    const hasPickable = items.some((el) => el.pickable);
    const acts = hasPickable
      ? `<span class="chk-cat-acts">
          <button class="chk-mini" data-c="${escapeHtml(check.id)}" data-s="${cat.status}" data-a="show" type="button">Показать</button>
          <button class="chk-mini" data-c="${escapeHtml(check.id)}" data-s="${cat.status}" data-a="iso" type="button">Изолировать</button>
        </span>`
      : "";
    return `
      <details class="chk-cat chk-${cat.status}" open>
        <summary>
          <span class="chk-cat-label">${cat.label}: ${check.counts[cat.status]}</span>
          ${acts}
        </summary>
        <div class="chk-el-list">${list}</div>
      </details>`;
  }

  private bindActions(): void {
    // Track expand/collapse so a re-render keeps each check as the user left it.
    for (const d of this.resultEl.querySelectorAll<HTMLDetailsElement>(".chk-check")) {
      d.addEventListener("toggle", () => {
        const id = d.dataset.check;
        if (!id) return;
        if (d.open) this.openChecks.add(id);
        else this.openChecks.delete(id);
      });
    }
    for (const btn of this.resultEl.querySelectorAll<HTMLButtonElement>(".chk-one")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.runOne(btn.dataset.run!);
      });
    }
    for (const btn of this.resultEl.querySelectorAll<HTMLButtonElement>(".chk-report")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.exportReport(btn);
      });
    }

    const pick = (checkId: string, status: ElementStatus) =>
      (this.results.get(checkId)?.byStatus.get(status) ?? []).filter((el) => el.pickable);

    for (const btn of this.resultEl.querySelectorAll<HTMLButtonElement>(".chk-mini")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const status = btn.dataset.s as ElementStatus;
        this.onCategory(
          pick(btn.dataset.c!, status),
          status,
          btn.dataset.a === "iso",
        );
      });
    }
    const elAt = (c: string, s: ElementStatus, i: string) =>
      (this.results.get(c)?.byStatus.get(s) ?? [])[Number(i)];

    for (const btn of this.resultEl.querySelectorAll<HTMLButtonElement>(".chk-el-iso")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const status = btn.dataset.s as ElementStatus;
        const el = elAt(btn.dataset.c!, status, btn.dataset.i!);
        if (el) this.onElement(el.key, status, true); // isolate just this one
      });
    }
    for (const row of this.resultEl.querySelectorAll<HTMLElement>(".chk-el-pick")) {
      row.addEventListener("click", () => {
        const status = row.dataset.s as ElementStatus;
        const el = elAt(row.dataset.c!, status, row.dataset.i!);
        if (el) this.onElement(el.key, status, false); // focus: colour + zoom + attrs
      });
    }
  }

  /** Downloads the Excel audit report for one check over the loaded models. */
  private async exportReport(btn: HTMLButtonElement): Promise<void> {
    const checkId = btn.dataset.report!;
    const files = this.getModels().map((m) => m.file);
    if (files.length === 0) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await exportIfcReport(files, checkId);
      btn.textContent = label;
    } catch (err) {
      btn.textContent = "ошибка";
      console.error("Экспорт отчёта не удался:", err);
      window.setTimeout(() => (btn.textContent = label), 2000);
    } finally {
      btn.disabled = false;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
