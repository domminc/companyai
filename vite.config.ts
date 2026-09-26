import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    // Keep the browser's Host so the server's same-site check sees the page's own origin.
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 8787}`, changeOrigin: false } },
  },
});
