import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Load and chaos runs are slow by design; `npm run test:load` opts in. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/load/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
