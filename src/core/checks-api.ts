/** IDS check results from the backend (POST /ifc_ids_validation). */

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
export async function runIfcIdsChecks(files: File[]): Promise<IfcIdsFileResult[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
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
