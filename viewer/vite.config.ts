import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The page is built once with kestrel; `kestrel view` serves it from dist/viewer. */
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/viewer", emptyOutDir: true },
  server: { proxy: { "/data.json": "http://127.0.0.1:4610", "/api": "http://127.0.0.1:4610" } },
});
