import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "static-viewer"),
  base: "/viewer/v1/",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist-static"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
