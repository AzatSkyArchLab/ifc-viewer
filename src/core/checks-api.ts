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

/** Endpoint path on the backend; the origin comes from the runtime config. */
const CHECKS_PATH = "/ifc_ids_validation";

/**
 * Uploads the IFC files in ONE request and returns per-file check results
 * (same order as `files`). A single batch lets the backend run cross-file
 * checks (IFC-21/22) over the whole set.
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
  return res.json();
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
