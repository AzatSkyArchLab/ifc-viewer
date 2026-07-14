import {
  runIfcIdsChecks,
  type ElementStatus,
  type IfcCheckResult,
} from "../core/checks-api.ts";
import { makeKey } from "../core/types.ts";

/** Highlights (or isolates) a status category by its scene keys. */
export type CategoryHandler = (
  keys: number[],
  status: ElementStatus,
  isolate: boolean,
) => void;

/** A loaded model the check runs against. */
export interface CheckModel {
  file: File;
  modelId: number;
}

const CATEGORIES: { status: ElementStatus; icon: string; label: string }[] = [
  { status: "violation", icon: "❌", label: "Нарушения" },
  { status: "review", icon: "⚠️", label: "На проверку" },
  { status: "ok", icon: "✅", label: "Допустимо" },
];

/** One flagged element, with the scene key needed to select it. */
interface FlaggedElement {
  key: number;
  label: string;
  reason: string;
  /** Element maps to a 3D mesh → can be highlighted / isolated. */
  pickable: boolean;
}

/** Aggregated state of one check across all loaded models. */
interface CheckAgg {
  id: string;
  name: string;
  description: string;
  counts: Record<ElementStatus, number>;
  byStatus: Map<ElementStatus, FlaggedElement[]>;
}

/**
 * IDS checks panel. Runs the backend endpoint for every loaded model and renders
 * whatever checks it returns — the set of checks is discovered from the response,
 * not hard-coded, so a new backend check appears here without any frontend change.
 */
export class ChecksPanel {
  private getModels: () => CheckModel[] = () => [];
  private onCategory: CategoryHandler = () => {};

  constructor(
    private runBtn: HTMLButtonElement,
    private resultEl: HTMLElement,
  ) {
    runBtn.addEventListener("click", () => void this.run());
  }

  setModelsGetter(fn: () => CheckModel[]): void {
    this.getModels = fn;
  }

  setCategoryHandler(fn: CategoryHandler): void {
    this.onCategory = fn;
  }

  setEnabled(enabled: boolean): void {
    this.runBtn.disabled = !enabled;
    if (!enabled) this.resultEl.innerHTML = "";
  }

  private async run(): Promise<void> {
    const models = this.getModels();
    if (models.length === 0) return;
    this.resultEl.innerHTML = `<div class="chk-note">Проверка на сервере…</div>`;

    const order: string[] = [];
    const checks = new Map<string, CheckAgg>();
    const multi = models.length > 1;
    try {
      // One request with the whole set so cross-file checks (IFC-21/22) see
      // every file; the response is per-file, in upload order.
      const results = await runIfcIdsChecks(models.map((m) => m.file));
      results.forEach((fileResult, i) => {
        const model = models[i];
        if (!model) return;
        for (const check of fileResult.checks ?? []) {
          // Batch-scoped checks are attached to every file — merge them once.
          if (check.scope === "batch" && i > 0) continue;
          this.mergeCheck(checks, order, check, model.file, model.modelId, multi);
        }
      });
    } catch (err) {
      this.resultEl.innerHTML =
        `<div class="chk-note err">Ошибка запроса: ${escapeHtml((err as Error).message)}` +
        `<br>Доступен ли бэкенд и верно ли задан apiBase в config.json?</div>`;
      return;
    }

    if (order.length === 0) {
      this.resultEl.innerHTML = `<div class="chk-note">Бэкенд не вернул ни одной проверки.</div>`;
      return;
    }
    this.render(order.map((id) => checks.get(id)!));
  }

  /** Folds one check result of one model into the cross-model aggregate. */
  private mergeCheck(
    checks: Map<string, CheckAgg>,
    order: string[],
    check: IfcCheckResult,
    file: File,
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
      };
      checks.set(check.id, agg);
      order.push(check.id);
    }
    for (const s of ["violation", "review", "ok"] as ElementStatus[]) {
      agg.counts[s] += check.counts[s] ?? 0;
    }
    const prefix = multi ? `${file.name.replace(/\.ifc$/i, "")}: ` : "";
    for (const el of check.elements) {
      const list = agg.byStatus.get(el.status) ?? [];
      // Model-level findings (units, coordination facts) carry express_id 0 —
      // show just their name, without a meaningless "#0" / filename prefix.
      const label = el.express_id
        ? `${prefix}${el.name ?? el.ifc_class} #${el.express_id}`
        : el.name ?? el.ifc_class;
      list.push({
        key: makeKey(modelId, el.express_id),
        label,
        reason: el.reason,
        pickable: el.pickable !== false,
      });
      agg.byStatus.set(el.status, list);
    }
  }

  private render(checks: CheckAgg[]): void {
    this.resultEl.innerHTML = checks.map((c) => this.renderCheck(c)).join("");
    this.bindActions(checks);
  }

  private renderCheck(check: CheckAgg): string {
    const passed = check.counts.violation === 0;
    const verdict = passed
      ? `<span class="chk-verdict ok">✅ Нарушений нет</span>`
      : `<span class="chk-verdict bad">❌ ${check.counts.violation}</span>`;

    const rows = CATEGORIES.filter((c) => check.counts[c.status] > 0)
      .map((c) => this.renderCategory(check, c))
      .join("");

    return `
      <details class="chk-check" open>
        <summary class="chk-check-head">
          <span class="chk-check-id">${escapeHtml(check.id)}</span>
          <span class="chk-check-name">${escapeHtml(check.name)}</span>
          ${verdict}
        </summary>
        <div class="chk-check-body" title="${escapeHtml(check.description)}">
          ${rows}
        </div>
      </details>`;
  }

  private renderCategory(
    check: CheckAgg,
    cat: { status: ElementStatus; icon: string; label: string },
  ): string {
    const items = check.byStatus.get(cat.status) ?? [];
    const list = items
      .map(
        (el, i) => `
        <div class="chk-el${el.pickable ? " chk-el-pick" : ""}" data-c="${escapeHtml(check.id)}" data-s="${cat.status}" data-i="${i}" title="${escapeHtml(el.reason)}">
          <span class="chk-el-name">${escapeHtml(el.label)}</span>
          <span class="chk-el-reason">${escapeHtml(el.reason)}</span>
        </div>`,
      )
      .join("");
    // Show / isolate only when the category has highlightable geometry.
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
          <span class="chk-cat-label">${cat.icon} ${cat.label}: ${check.counts[cat.status]}</span>
          ${acts}
        </summary>
        <div class="chk-el-list">${list}</div>
      </details>`;
  }

  private bindActions(checks: CheckAgg[]): void {
    const byId = new Map(checks.map((c) => [c.id, c]));
    const pick = (checkId: string, status: ElementStatus) =>
      (byId.get(checkId)?.byStatus.get(status) ?? []).filter((el) => el.pickable);

    for (const btn of this.resultEl.querySelectorAll<HTMLButtonElement>(".chk-mini")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const status = btn.dataset.s as ElementStatus;
        const keys = pick(btn.dataset.c!, status).map((el) => el.key);
        this.onCategory(keys, status, btn.dataset.a === "iso");
      });
    }
    for (const row of this.resultEl.querySelectorAll<HTMLElement>(".chk-el-pick")) {
      row.addEventListener("click", () => {
        const status = row.dataset.s as ElementStatus;
        const el = (byId.get(row.dataset.c!)?.byStatus.get(status) ?? [])[
          Number(row.dataset.i)
        ];
        if (el) this.onCategory([el.key], status, false);
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
