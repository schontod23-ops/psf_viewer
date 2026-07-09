import { defineConfig } from "vite";

// Tauri serves the dev server and embeds the production build in the binary.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // Keep the embedded bundle lean.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Optional runtime dependency (see src/geometry3d.js) — not a project
      // dependency, so don't let Rollup try to resolve it at build time.
      external: ["three-gpu-pathtracer"],
    },
  },
});
