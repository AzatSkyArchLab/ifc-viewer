import { defineConfig } from "vite";

// Relative base ('./') keeps the build portable: it works both at the domain
// root and when served from a sub-path (FastAPI mounts it under /viewer/).
// WASM binaries live in public/ and resolve via import.meta.env.BASE_URL.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000, // web-ifc + three are large chunks, that is fine
  },
  // web-ifc pulls its .wasm as an asset — exclude it from dep optimization.
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
});
