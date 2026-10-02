import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: the goose admin API sets no CORS headers, so the browser
// cannot call it cross-origin. Proxy /api to the engine's admin listener
// (override with GOOSE_API_URL when the engine listens elsewhere).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.GOOSE_API_URL ?? "http://127.0.0.1:9090",
        changeOrigin: false,
      },
    },
  },
});
