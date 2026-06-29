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
  },
});
