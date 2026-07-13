import * as pdfjs from "pdfjs-dist";

const PT_TO_MM = 25.4 / 72;

const SCALE_RE = /(?:М\s*)?1\s*[:：]\s*(\d{1,4})/;
const LEVEL_RE = /^[+\-−±]?\s*\d{1,3}[.,]\d{3}$/; // +16.109 / +0,000
const MSSK_RE = /^(ЭЛ|ПЗ|СПП)\b/;
const AXIS_LETTER_RE = /^[А-ЯЁ]$/;
const INT_RE = /^\d{1,5}$/;

/** One drawing-element category with a count and a few examples. */
export interface PdfCategory {
  key: string;
  label: string;
  count: number;
  examples: string[];
}

/** Deterministic analysis of a vector drawing PDF (no CV, no LLM). */
export interface PdfAnalysis {
  pages: number;
  pageSizeMm: [number, number];
  producer: string;
  creator: string;
  scalePresent: boolean;
  scales: string[];
  categories: PdfCategory[];
  textHeightsMm: { mm: number; count: number }[];
  paths: number;
  fills: number;
  strokes: number;
}

const LABELS: Record<string, string> = {
  axis_number: "Оси — цифры",
  axis_letter: "Оси — буквы",
  dimension: "Размеры, мм",
  level_mark: "Отметки уровня",
  mssk_code: "Коды МССК / помещений",
  scale: "Масштаб",
  number_other: "Прочие числа",
  short_label: "Короткие метки",
  text_label: "Текст-подписи",
};

function classify(text: string): string {
  const t = text.trim();
  if (!t) return "empty";
  if (SCALE_RE.test(t)) return "scale";
  if (LEVEL_RE.test(t)) return "level_mark";
  if (MSSK_RE.test(t)) return "mssk_code";
  if (AXIS_LETTER_RE.test(t)) return "axis_letter";
  if (INT_RE.test(t)) {
    const v = Number(t);
    if (v <= 27 && t.length <= 2) return "axis_number";
    if (v >= 100) return "dimension";
    return "number_other";
  }
  return t.length <= 2 ? "short_label" : "text_label";
}

export async function analyzePdf(bytes: Uint8Array): Promise<PdfAnalysis> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const meta = (await pdf.getMetadata().catch(() => null))?.info as
    | Record<string, string>
    | undefined;

  const counts = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const scales = new Set<string>();
  const heights = new Map<number, number>();
  let paths = 0;
  let fills = 0;
  let strokes = 0;
  let pageSize: [number, number] = [0, 0];

  const OPS = pdfjs.OPS;

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    if (n === 1) {
      const vp = page.getViewport({ scale: 1 });
      pageSize = [
        Math.round(vp.width * PT_TO_MM),
        Math.round(vp.height * PT_TO_MM),
      ];
    }

    const tc = await page.getTextContent();
    for (const item of tc.items as Array<{ str: string; height: number }>) {
      const txt = item.str.trim();
      if (!txt) continue;
      const c = classify(txt);
      counts.set(c, (counts.get(c) ?? 0) + 1);
      const ex = examples.get(c) ?? [];
      if (ex.length < 6 && !ex.includes(txt)) ex.push(txt);
      examples.set(c, ex);
      const mm = Math.round(item.height * PT_TO_MM * 10) / 10;
      if (mm > 0) heights.set(mm, (heights.get(mm) ?? 0) + 1);
      if (c === "scale") {
        const m = SCALE_RE.exec(txt);
        if (m) scales.add("1:" + m[1]);
      }
    }

    const ops = await page.getOperatorList();
    for (const fn of ops.fnArray) {
      if (fn === OPS.constructPath) paths++;
      else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke) fills++;
      else if (fn === OPS.stroke || fn === OPS.closePath) strokes++;
    }
  }

  const categories: PdfCategory[] = [...counts.entries()]
    .filter(([k]) => k !== "empty")
    .map(([key, count]) => ({
      key,
      label: LABELS[key] ?? key,
      count,
      examples: examples.get(key) ?? [],
    }))
    .sort((a, b) => b.count - a.count);

  const textHeightsMm = [...heights.entries()]
    .map(([mm, count]) => ({ mm, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  await pdf.destroy();

  return {
    pages: pdf.numPages,
    pageSizeMm: pageSize,
    producer: meta?.Producer ?? "—",
    creator: meta?.Creator ?? "—",
    scalePresent: scales.size > 0,
    scales: [...scales],
    categories,
    textHeightsMm,
    paths,
    fills,
    strokes,
  };
}
