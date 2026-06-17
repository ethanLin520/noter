import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies /api -> backend so the browser only talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 12345,
    proxy: {
      "/api": "http://localhost:23456",
    },
  },
});
