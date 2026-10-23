import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  build: {
    // Preserve the supported WebView targets when upgrading Vite.
    target: ["chrome107", "edge107", "firefox104", "safari16"],
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.engine/**"] },
  },
});
