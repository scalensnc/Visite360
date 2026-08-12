import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "static-viewer"),
  base: "/Visite360/",
  publicDir: "public",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist-github"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
