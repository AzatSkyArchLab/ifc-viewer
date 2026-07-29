/** IFC check results from the backend (POST /ifc_ids_validation). */

import { apiBase } from "./config.ts";

export type ElementStatus = "violation" | "review" | "ok";

export interface IfcElementRef {
  global_id: string | null;
  express_id: number;
  name: string | null;
  ifc_class: string;
  status: ElementStatus;
  reason: string;
  /** Whether the entity has a 3D mesh (highlightable). Units are false. */
  pickable?: boolean;
  /** Uploaded file the element lives in — set by cross-file checks, whose two
   *  sides sit in different models. */
  file?: string | null;
  /** Contact point of this side of a collision, in model coordinates. */
  point?: number[] | null;
  /** Ties the two sides of one collision together. */
  pair?: number | null;
}

export interface IfcCheckResult {
  id: string;
  name: string;
  description: string;
  passed: boolean;
  counts: Record<string, number>;
  elements: IfcElementRef[];
  /** 'batch' — computed once over the whole upload set (merge it once). */
  scope?: "file" | "batch";
  /** An Excel audit report exists for this check → show the export button. */
  report?: boolean;
}

export interface IfcIdsFileResult {
  filename: string;
  checks: IfcCheckResult[];
}

/** Endpoint path on the backend; the base comes from the runtime config. */
const CHECKS_PATH = "/ifc_ids_validation";

/**
 * The backend sends a slim shape — id, name, description, passed — with the
 * per-element data packed into `description` after this marker. The head is the
 * human text, the tail is a JSON payload with counts, scope, report, elements.
 * Keep this in sync with CHECK_DATA_MARKER in app/dto/ifc_ids_validation.py.
 */
const CHECK_DATA_MARKER = "⟦AGR⟧";

interface SlimCheck {
  id: string;
  name: string;
  description: string;
  passed: boolean;
}

interface SlimFileResult {
  filename: string;
  checks: SlimCheck[];
}

interface PackedData {
  counts?: Record<string, number>;
  scope?: "file" | "batch";
  report?: boolean;
  elements?: IfcElementRef[];
}

/** Splits `description` into its human head and the packed data (if present). */
function unpackCheck(slim: SlimCheck): IfcCheckResult {
  const at = slim.description.indexOf(CHECK_DATA_MARKER);
  let description = slim.description;
  let data: PackedData = {};
  if (at >= 0) {
    description = slim.description.slice(0, at).replace(/\s+$/, "");
    try {
      data = JSON.parse(slim.description.slice(at + CHECK_DATA_MARKER.length));
    } catch {
      data = {};
    }
  }
  return {
    id: slim.id,
    name: slim.name,
    description,
    passed: slim.passed,
    counts: data.counts ?? {},
    elements: data.elements ?? [],
    scope: data.scope ?? "file",
    report: data.report ?? false,
  };
}

/**
 * Uploads the IFC files (or a .zip of them) in ONE request and returns per-file
 * check results (same order as `files`). A single batch lets the backend run
 * cross-file checks (IFC-21/22) over the whole set. The slim wire shape is
 * unpacked back into the full result the UI works with.
 */
export async function runIfcIdsChecks(
  files: File[],
  checkIds?: string[],
): Promise<IfcIdsFileResult[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  if (checkIds && checkIds.length) form.append("checks", checkIds.join(","));
  const res = await fetch(`${apiBase()}${CHECKS_PATH}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.slice(0, 200));
  }
  const slim = (await res.json()) as SlimFileResult[];
  return slim.map((file) => ({
    filename: file.filename,
    checks: (file.checks ?? []).map(unpackCheck),
  }));
}

/** Metadata of one check (GET /ifc_ids_validation/checks). */
export interface IfcCheckInfo {
  id: string;
  name: string;
  description: string;
}

/** Lists the checks the backend offers, so the UI can show them before a run. */
export async function listIfcChecks(): Promise<IfcCheckInfo[]> {
  const res = await fetch(`${apiBase()}${CHECKS_PATH}/checks`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * Requests the Excel audit report for one check over the given files and
 * triggers a browser download. Reuses the same files the checks ran against.
 */
export async function exportIfcReport(files: File[], checkId: string): Promise<void> {
  const form = new FormData();
  form.append("check", checkId);
  for (const file of files) form.append("files", file, file.name);
  const res = await fetch(`${apiBase()}${CHECKS_PATH}/report`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.slice(0, 200));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${checkId}_audit.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * IFC-54 debug: fetches covering-vs-relief offsets and returns per-covering
 * sampled points. A developer overlay renders them on the geometry.
 */
export async function fetchCoveringOffsets(files: File[]): Promise<{
  relief: { flat: boolean; z_range_mm: number } | null;
  coverings: {
    express_id: number; name: string | null; rus_name: string | null;
    status: string; note: string; median_mm: number; std_mm: number;
    points: { p: number[]; offset_mm: number }[];
  }[];
}> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const res = await fetch(`${apiBase()}${CHECKS_PATH}/debug/covering-relief`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

