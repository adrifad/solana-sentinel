import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env["SENTINEL_API_TARGET"] ?? "http://127.0.0.1:8787";
const apiProxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    proxy: apiProxy,
  },
});
