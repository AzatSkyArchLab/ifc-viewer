import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { parseTrm, type TrmDoc } from "../core/trm.ts";
import { analyzePdf, type PdfAnalysis } from "../core/pdf-analysis.ts";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const PDF_SCALE = 2; // rasterisation scale for crisp vector drawings

/**
 * Full-screen TRM overlay: lists the container's documents and previews them.
 * PDF drawings are rasterised to canvas with PDF.js (so no browser download
 * prompt); images render via a blob URL; encrypted/other blobs show a
 * placeholder. Independent of the 3D viewer.
 */
export class TrmView {
  private urls: string[] = [];
  private docs: TrmDoc[] = [];
  private currentIndex = -1;
  /** Bumped on every select() to cancel an in-flight PDF render. */
  private renderToken = 0;

  constructor(
    private overlay: HTMLElement,
    private titleEl: HTMLElement,
    private listEl: HTMLElement,
    private contentEl: HTMLElement,
    closeBtn: HTMLElement,
    private analyzeBtn: HTMLButtonElement,
    private analysisEl: HTMLElement,
  ) {
    closeBtn.addEventListener("click", () => this.close());
    analyzeBtn.addEventListener("click", () => this.toggleAnalysis());
  }

  /** Parses a TRM and builds the document list. Does not open the overlay. */
  load(data: Uint8Array): number {
    const trm = parseTrm(data);
    this.revoke();
    this.docs = trm.documents;
    this.titleEl.textContent = trm.project;
    this.listEl.innerHTML = "";
    this.contentEl.innerHTML = "";

    this.docs.forEach((doc, i) => {
      const btn = document.createElement("button");
      btn.className = "trm-doc";
      btn.type = "button";
      btn.innerHTML =
        `<span class="trm-doc-name">${escapeHtml(doc.title)}</span>` +
        `<span class="trm-doc-ext">${escapeHtml(doc.ext)}</span>`;
      btn.addEventListener("click", () => this.select(i));
      this.listEl.appendChild(btn);
    });
    return this.docs.length;
  }

  /** Loads a TRM and opens the overlay on its first drawing. */
  open(data: Uint8Array): void {
    this.load(data);
    this.overlay.hidden = false;
    if (this.docs.length === 0) {
      this.contentEl.innerHTML = `<div class="trm-empty">В контейнере нет документов</div>`;
      return;
    }
    const first = this.docs.findIndex((d) => d.ext === "pdf");
    this.select(first >= 0 ? first : 0);
  }

  /** Index of the PDF drawing whose filename matches `key`, or -1. */
  viewIndexFor(key: string): number {
    const k = key.toLowerCase();
    return this.docs.findIndex(
      (d) => d.ext === "pdf" && d.filename.toLowerCase().includes(k),
    );
  }

  /** Opens the overlay focused on the drawing matching `key`. */
  focusView(key: string): boolean {
    const i = this.viewIndexFor(key);
    if (i < 0) return false;
    this.overlay.hidden = false;
    this.select(i);
    return true;
  }

  close(): void {
    this.overlay.hidden = true;
    this.contentEl.innerHTML = "";
    this.hideAnalysis();
    this.revoke();
  }

  private select(index: number): void {
    for (const [i, el] of [...this.listEl.children].entries()) {
      el.classList.toggle("active", i === index);
    }
    const doc = this.docs[index];
    this.currentIndex = index;
    this.contentEl.innerHTML = "";
    this.hideAnalysis();
    this.analyzeBtn.hidden = doc.ext !== "pdf";
    const token = ++this.renderToken;

    if (doc.ext === "pdf") {
      void this.renderPdf(doc.bytes, token);
    } else if (IMAGE_EXT.includes(doc.ext)) {
      const img = document.createElement("img");
      img.className = "trm-img";
      img.src = this.url(doc);
      this.contentEl.appendChild(img);
    } else {
      const msg = document.createElement("div");
      msg.className = "trm-empty";
      msg.textContent =
        doc.ext === "enc"
          ? "Зашифрованный документ — предпросмотр недоступен"
          : `Нет предпросмотра для .${doc.ext}`;
      this.contentEl.appendChild(msg);
    }
  }

  /** Rasterises every page of a PDF to canvas (no browser download prompt). */
  private async renderPdf(bytes: Uint8Array, token: number): Promise<void> {
    const pages = document.createElement("div");
    pages.className = "trm-pdf";
    this.contentEl.appendChild(pages);
    const note = document.createElement("div");
    note.className = "trm-empty";
    note.textContent = "Загрузка чертежа…";
    pages.appendChild(note);

    try {
      // Copy the bytes: PDF.js may transfer/detach the underlying buffer.
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      if (token !== this.renderToken) {
        await pdf.destroy();
        return;
      }
      note.remove();
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (token !== this.renderToken) {
          await pdf.destroy();
          return;
        }
        const viewport = page.getViewport({ scale: PDF_SCALE });
        const canvas = document.createElement("canvas");
        canvas.className = "trm-page";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        pages.appendChild(canvas);
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    } catch (err) {
      if (token !== this.renderToken) return;
      pages.innerHTML = `<div class="trm-empty">Не удалось открыть PDF: ${(err as Error).message}</div>`;
    }
  }

  // ── Разбор чертежа (детерминированный, pdf.js) ───────────────────────────────

  private hideAnalysis(): void {
    this.analysisEl.hidden = true;
    this.analyzeBtn.classList.remove("active");
  }

  private async toggleAnalysis(): Promise<void> {
    if (!this.analysisEl.hidden) {
      this.hideAnalysis();
      return;
    }
    const doc = this.docs[this.currentIndex];
    if (!doc || doc.ext !== "pdf") return;
    this.analysisEl.hidden = false;
    this.analyzeBtn.classList.add("active");
    this.analysisEl.innerHTML = `<div class="trm-empty">Разбор чертежа…</div>`;
    try {
      this.renderAnalysis(await analyzePdf(doc.bytes), doc.title);
    } catch (err) {
      this.analysisEl.innerHTML = `<div class="trm-empty">Ошибка разбора: ${(err as Error).message}</div>`;
    }
  }

  private renderAnalysis(a: PdfAnalysis, title: string): void {
    const yn = (ok: boolean) => (ok ? "✅" : "⚠️");
    const heights = a.textHeightsMm.map((h) => `${h.mm}`).join(" / ");
    const rows = a.categories
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.label)}</td><td class="n">${c.count}</td>` +
          `<td class="ex">${escapeHtml(c.examples.slice(0, 4).join(", "))}</td></tr>`,
      )
      .join("");

    this.analysisEl.innerHTML = `
      <div class="an-head">Разбор чертежа</div>
      <div class="an-sub">${escapeHtml(title)}</div>

      <div class="an-section">Характеристики</div>
      <table class="an-table">
        <tr><td>Страниц</td><td class="n" colspan="2">${a.pages}</td></tr>
        <tr><td>Лист, мм</td><td class="n" colspan="2">${a.pageSizeMm[0]}×${a.pageSizeMm[1]}</td></tr>
        <tr><td>Масштаб</td><td colspan="2">${yn(a.scalePresent)} ${a.scalePresent ? escapeHtml(a.scales.join(", ")) : "не найден"}</td></tr>
        <tr><td>Высоты текста, мм</td><td colspan="2">${escapeHtml(heights) || "—"}</td></tr>
        <tr><td>Ген. PDF</td><td colspan="2">${escapeHtml(a.producer)}</td></tr>
        <tr><td>Векторы</td><td colspan="2">пути ${a.paths} · заливки ${a.fills} · обводки ${a.strokes}</td></tr>
      </table>

      <div class="an-section">Виды элементов</div>
      <table class="an-table">
        <thead><tr><th>Элемент</th><th class="n">Кол-во</th><th>Примеры</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private url(doc: TrmDoc, type?: string): string {
    const blob = new Blob([doc.bytes as BlobPart], type ? { type } : undefined);
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return url;
  }

  private revoke(): void {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
