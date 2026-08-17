import { parseBcf, type BcfTopic, type BcfViewpoint } from "../core/bcf.ts";

/**
 * Called to act on a BCF selection. `guids` are the IfcGuids to highlight;
 * `viewpoint` is present when a specific viewpoint was clicked — the host then
 * also restores its camera and clipping planes. The "highlight all" button
 * aggregates components across viewpoints and passes no single viewpoint.
 */
export type BcfSelectHandler = (
  guids: string[],
  viewpoint?: BcfViewpoint,
) => void;

/** Status → colour of the pill in the topic list (BCF has free-text statuses). */
function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (/(closed|resolved|закры|решен)/.test(s)) return "ok";
  if (/(progress|active|open|assigned|работ|откры)/.test(s)) return "active";
  return "";
}

/**
 * Full-screen BCF overlay: lists the archive's topics and, for the selected one,
 * shows its metadata, comments and viewpoint snapshots. Clicking a viewpoint
 * asks the host to jump to it — restore its camera and section cuts and
 * highlight its components; the "highlight all" button only highlights the
 * topic's components. Independent of the 3D viewer.
 */
export class BcfView {
  private topics: BcfTopic[] = [];
  private onSelect: BcfSelectHandler = () => {};

  constructor(
    private overlay: HTMLElement,
    private titleEl: HTMLElement,
    private listEl: HTMLElement,
    private contentEl: HTMLElement,
    closeBtn: HTMLElement,
  ) {
    closeBtn.addEventListener("click", () => this.close());
  }

  /** Select handler: receives the IfcGuids and, for a viewpoint click, its data. */
  setSelectHandler(fn: BcfSelectHandler): void {
    this.onSelect = fn;
  }

  /** Parses a BCF and opens the overlay on its first topic. */
  open(data: Uint8Array): void {
    const archive = parseBcf(data);
    this.topics = archive.topics;
    const ver = archive.version ? ` · BCF ${archive.version}` : "";
    this.titleEl.textContent = `Замечания: ${this.topics.length}${ver}`;

    this.listEl.innerHTML = "";
    this.topics.forEach((topic, i) => {
      const btn = document.createElement("button");
      btn.className = "bcf-topic";
      btn.type = "button";
      const pill = topic.status
        ? `<span class="bcf-pill ${statusClass(topic.status)}">${escapeHtml(topic.status)}</span>`
        : "";
      btn.innerHTML =
        `<span class="bcf-topic-title">${escapeHtml(topic.title)}</span>${pill}`;
      btn.addEventListener("click", () => this.select(i));
      this.listEl.appendChild(btn);
    });

    this.overlay.hidden = false;
    this.select(0);
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private select(index: number): void {
    const topic = this.topics[index];
    if (!topic) return;

    for (const [i, btn] of this.listEl.querySelectorAll(".bcf-topic").entries()) {
      btn.classList.toggle("active", i === index);
    }

    const meta = [
      ["Тип", topic.type],
      ["Статус", topic.status],
      ["Приоритет", topic.priority],
      ["Автор", topic.author],
      ["Создано", formatDate(topic.date)],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join("");

    const allGuids = [...new Set(topic.viewpoints.flatMap((v) => v.components))];
    const highlightAll = allGuids.length
      ? `<button class="btn bcf-highlight" type="button" data-all="1">
           Выделить элементы в модели (${allGuids.length})
         </button>`
      : "";

    const comments = topic.comments.length
      ? topic.comments
          .map(
            (c) => `
            <div class="bcf-comment">
              <div class="bcf-comment-head">
                <span class="bcf-comment-author">${escapeHtml(c.author || "—")}</span>
                <span class="bcf-comment-date">${escapeHtml(formatDate(c.date))}</span>
              </div>
              <div class="bcf-comment-text">${escapeHtml(c.text)}</div>
            </div>`,
          )
          .join("")
      : `<div class="bcf-empty">Комментариев нет</div>`;

    const viewpoints = topic.viewpoints
      .map((v, i) => {
        const parts = [];
        if (v.camera) parts.push("камера");
        if (v.clippingPlanes.length) parts.push("разрез");
        if (v.components.length) parts.push(`компонентов: ${v.components.length}`);
        const caption = `${parts.length ? parts.join(" · ") + " · " : ""}клик — перейти к виду`;
        return `
        <figure class="bcf-vp" data-vp="${i}">
          ${v.snapshot ? `<img class="bcf-vp-img" src="${v.snapshot}" alt="viewpoint" />` : `<div class="bcf-empty">Нет снимка</div>`}
          <figcaption>${caption}</figcaption>
        </figure>`;
      })
      .join("");

    this.contentEl.innerHTML = `
      <h2 class="bcf-title">${escapeHtml(topic.title)}</h2>
      <dl class="bcf-meta">${meta}</dl>
      ${highlightAll}
      <h3 class="bcf-section">Комментарии</h3>
      ${comments}
      ${viewpoints ? `<h3 class="bcf-section">Точки обзора</h3><div class="bcf-vps">${viewpoints}</div>` : ""}
    `;

    this.contentEl
      .querySelector<HTMLButtonElement>(".bcf-highlight")
      ?.addEventListener("click", () => this.onSelect(allGuids));
    for (const fig of this.contentEl.querySelectorAll<HTMLElement>(".bcf-vp")) {
      fig.addEventListener("click", () => {
        const vp = topic.viewpoints[Number(fig.dataset.vp)];
        if (vp) this.onSelect(vp.components, vp);
      });
    }
  }
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ru-RU");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
