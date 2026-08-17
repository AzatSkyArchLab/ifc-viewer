# IFC Viewer

Standalone, client-side IFC 3D viewer with an attribute inspector and an **IDS
checks** panel. IFC parsing and tessellation run **in the browser** via `web-ifc`
(WASM) + `three.js`. Validation is delegated to a backend: the viewer uploads the
opened `.ifc` to a checks API and visualises the returned findings on the model.

The set of checks is **not hard-coded** — the viewer renders whatever the API
returns, so adding a check on the backend surfaces it here with no frontend change.

**Live demo:** <https://azatskyarchlab.github.io/ifc-viewer/> — open your own
`.ifc` / `.bcf` right in the browser (parsing is client-side). The checks panel
needs a backend, so it is inactive on the static demo.

## UI

- **Left, top:** «Проверить модель» → runs the backend checks; each returned check
  becomes a collapsible section (verdict + findings). Geometry findings can be
  highlighted / isolated in 3D and clicked to select; model-level findings (e.g.
  units) are shown as read-only reasons.
- **Left, middle:** storey selector + element list (grouped by IFC type,
  filterable, multi-select, per-type visibility toggle).
- **Left, bottom:** full attributes + property/quantity sets of the selection.
- **Right:** 3D model — orbit, click to pick, Shift+click to multi-select.
- **Toolbar:** isolate / hide selection / show all, Open IFC (or drag-and-drop
  one or more `.ifc` files), Open TRM, Open BCF.
- **Sections:** plan and elevation cut planes (per-floor plan cut and a rotating
  vertical cut) with a filled poché cross-section.

### TRM drawings

«Открыть TRM» (or drag-and-drop a vitro TRM container) opens a full-screen
overlay listing the container's documents; selecting one previews it (PDF
drawings render via `pdf.js`, images inline). When a loaded model matches a TRM
drawing by filename, a «Вид модели (TRM)» button opens it directly. Parsing is
client-side (`fflate` + `pdfjs-dist`) and independent of the backend.

### BCF issues

«Открыть BCF» (or drag-and-drop a `.bcf` / `.bcfzip`) opens a full-screen overlay
listing the archive's topics, comments and viewpoint snapshots. Clicking a
viewpoint restores its saved view — the camera pose and section cuts — and
highlights the referenced elements in the model by `IfcGuid`. Parsing is
client-side (`fflate`) and independent of the backend.

## Backend contract

The viewer calls one endpoint:

```
POST {apiBase}/ifc_ids_validation
  Content-Type: multipart/form-data
  field "files": the .ifc file
→ 200: IfcIdsFileResult[]
```

Response shape (`src/core/checks-api.ts`):

```ts
IfcIdsFileResult { filename: string; checks: IfcCheckResult[] }
IfcCheckResult   { id, name, description, passed, counts, elements: IfcElementRef[] }
IfcElementRef    { global_id, express_id, name, ifc_class, status, reason, pickable? }
```

- `status` ∈ `"violation" | "review" | "ok"` drives colour and the verdict.
- `express_id` links a finding to its mesh in the scene (per uploaded model).
- `pickable` (default `true`) — set `false` for findings with no 3D geometry
  (e.g. unit-of-measure checks); such rows are informational only.

CORS: the backend must allow the viewer's origin (or serve the viewer itself).

## Configuration

The backend address (`apiBase`) is resolved once at startup, in priority order:

1. `window.__IFC_VIEWER_CONFIG__ = { apiBase: "…" }` — injected by a host page.
2. **`config.json`** next to `index.html` — copy `config.example.json` to
   `config.json` and edit it on deploy, **no rebuild** needed:
   ```json
   { "apiBase": "https://api.example.com" }
   ```
   Use `""` when the same server hosts both the viewer and the API (same-origin).
   `config.json` is git-ignored (it is environment-specific); the committed
   `config.example.json` is the template.
3. `VITE_API_BASE` in `.env` — baked in at build time (see `.env.example`), used
   when no `config.json` is present (handy for `npm run dev`).
4. same-origin (`""`) as the final fallback.

`apiBase` is an **origin** (`https://api.example.com`) or a **path prefix**
(`/api`, when a proxy fronts the backend under one) — no trailing slash, no
endpoint path.

## Develop

```bash
npm install          # postinstall copies web-ifc.wasm into public/
cp .env.example .env # point VITE_API_BASE at your backend
npm run dev          # http://localhost:5173
```

## Build & deploy

```bash
npm run build        # type-check + bundle → dist/
```

`dist/` is a static bundle — serve it with any static host (Nginx, GitLab Pages,
S3, or the API itself). After deploy, set the backend URL by editing
`dist/config.json` (no rebuild). To embed inside another page, host `dist/` and,
if needed, inject `window.__IFC_VIEWER_CONFIG__` before the bundle loads.

This repo also ships a GitHub Pages workflow (`.github/workflows/deploy.yml`):
every push to `main` builds and publishes `dist/` to Pages.

## Structure

```
src/
  core/
    config.ts       # resolves apiBase (window → config.json → env → same-origin)
    checks-api.ts   # backend contract + fetch; endpoint path only
    ifc-parser.ts   # web-ifc: multi-model parse, composite keys, meshes, storeys
    types.ts        # shared types + composite-key helpers
  ui/
    checks-panel.ts # renders whatever checks the API returns (dynamic)
    element-list.ts # grouped, filterable element list + visibility toggles
    properties-panel.ts
  viewer/
    viewer.ts       # three.js scene, picking, highlight, isolate/hide
  main.ts           # wiring + selection/visibility state
```

## Scope & limits

Client-side parsing suits reasonable files; it does not target the 500 MB upper
bound (browser-tab memory). Large-model support belongs to a server-side
tessellation pipeline, not this tool.
