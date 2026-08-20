import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  ssr: {
    target: "webworker",
    noExternal: true,
  },
  build: {
    ssr: "src/pages-worker.ts",
    outDir: "dist-worker",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "_worker.js",
        format: "es",
        inlineDynamicImports: true,
      },
    },
  },
});
