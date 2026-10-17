// Builds the card page (spec 015 FR-1) into ONE self-contained dist/cards/cards.html — React, the
// MCP Apps client and the styles all inlined — which createCards() serves to Claude and ChatGPT.
// Named *.cards.ts (not vite.config.ts) so no vitest run picks it up as a test config; invoked
// explicitly by `npm run build`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("./src/cards/ui"),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: here("./dist/cards"),
    // Only dist/cards is wiped; tsc writes the server half there right after.
    emptyOutDir: true,
    rollupOptions: { input: here("./src/cards/ui/cards.html") },
  },
});
