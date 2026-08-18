import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "studio"),
  base: "/studio/v1/",
  publicDir: false,
  plugins: [react()],
  server: {
    port: 3100,
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist-studio"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
