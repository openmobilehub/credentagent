// Builds the storefront widget into a single self-contained mcp-app.html that the
// package ships (dist/ui/) and createStorefront() registers as the ui:// resource.
// Named *.ui.ts (not vite.config.ts) so the root vitest run never picks it up as a
// test config; invoked explicitly via `vite build --config vite.config.ui.ts`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: {
      // Entry at the package root → flat output: dist/ui/mcp-app.html.
      input: "mcp-app.html",
    },
    outDir: "dist/ui",
    // Only dist/ui is wiped (keeps it clean); the tsc output lives in dist/ and is
    // written by the subsequent `tsc` step, so it is unaffected.
    emptyOutDir: true,
  },
});
