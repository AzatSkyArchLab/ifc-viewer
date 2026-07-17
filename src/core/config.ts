/**
 * Runtime configuration for the viewer.
 *
 * The backend URL is resolved once at startup, in priority order:
 *   1. `window.__IFC_VIEWER_CONFIG__` — injected by the host page (embedding).
 *   2. `./config.json` next to index.html — edited on deploy, no rebuild needed.
 *   3. `VITE_API_BASE` — baked in at build time (`.env`).
 *   4. same origin ("") — when the viewer is served by the API itself.
 *
 * `apiBase` is an origin (e.g. "https://api.example.com") or "" for same-origin;
 * it must NOT end with a slash and must NOT include the endpoint path.
 */
export interface ViewerConfig {
  apiBase: string;
}

interface WindowConfig {
  __IFC_VIEWER_CONFIG__?: Partial<ViewerConfig>;
}

let resolved: ViewerConfig | null = null;

function normalize(base: string | undefined | null): string {
  return (base ?? "").replace(/\/+$/, "");
}

/** Loads and caches the runtime config. Safe to call more than once. */
export async function loadConfig(): Promise<ViewerConfig> {
  if (resolved) return resolved;

  const injected = (window as unknown as WindowConfig).__IFC_VIEWER_CONFIG__;
  if (injected && injected.apiBase !== undefined) {
    resolved = { apiBase: normalize(injected.apiBase) };
    return resolved;
  }

  try {
    const url = new URL("config.json", document.baseURI);
    const res = await fetch(url.href, { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as Partial<ViewerConfig>;
      if (json.apiBase !== undefined) {
        resolved = { apiBase: normalize(json.apiBase) };
        return resolved;
      }
    }
  } catch {
    // no config.json shipped — fall through to build-time / same-origin
  }

  resolved = { apiBase: normalize(import.meta.env.VITE_API_BASE) };
  return resolved;
}

/** The resolved backend origin. Call only after `loadConfig()` has completed. */
export function apiBase(): string {
  return "/api"//resolved?.apiBase ?? "";
}
