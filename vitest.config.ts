import { defineConfig } from "vitest/config";

// The `opentimestamps` package.json `main` points at a file that doesn't exist
// (`open-timestamps.js`); its real entry is `index.js`. Node's require falls
// back to `index.js` automatically, but Vite/vitest's resolver honours `main`
// strictly and fails to load the whole suite. Alias it to the real entry.
export default defineConfig({
  resolve: {
    alias: {
      opentimestamps: "opentimestamps/index.js",
    },
  },
  test: {
    environment: "node",
  },
});
