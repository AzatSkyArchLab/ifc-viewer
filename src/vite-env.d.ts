/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin baked in at build time; overridden by config.json at runtime. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
