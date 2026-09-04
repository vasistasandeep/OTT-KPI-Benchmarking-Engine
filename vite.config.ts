/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  worker: {
    format: "es",
  },
  test: {
    // jsdom provides a DOM for @testing-library/react and axe accessibility scans.
    environment: "jsdom",
    globals: true,
    // Registers jsdom matchers (jest-dom) and fake-indexeddb/auto before each suite.
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
