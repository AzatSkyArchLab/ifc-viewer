// Copies the web-ifc WASM binary into public/ so Vite serves it as a static
// asset. Runs automatically on postinstall / predev / prebuild.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "web-ifc");
const dest = join(root, "public");

// The single-threaded binary is enough for a viewer and needs no COOP/COEP.
const files = ["web-ifc.wasm"];

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const f of files) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.warn(`[copy-wasm] not found ${from} — skipped`);
    continue;
  }
  copyFileSync(from, join(dest, f));
  copied++;
}
console.log(`[copy-wasm] copied files: ${copied} → public/`);
