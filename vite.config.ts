import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  test: { include: ["src/**/*.test.{ts,tsx}"] },
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
