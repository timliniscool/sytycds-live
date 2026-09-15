import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // A fresh mode is useful for dress rehearsals and migration-independent UI
    // checks. Its Durable Object and R2 state exist only for that dev process.
    cloudflare({ persistState: mode !== "fresh" }),
  ],
}));
