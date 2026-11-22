import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { balaxTelemetryBridgePlugin } from "./telemetryBridgePlugin.ts";

export default defineConfig({
  plugins: [react(), balaxTelemetryBridgePlugin()],
  base: "./",
  server: {
    host: true,
    port: 5180,
    allowedHosts: ["balax-remote.local", ".local", "localhost"],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(import.meta.dirname, "node_modules/react"),
      "react-dom": path.resolve(import.meta.dirname, "node_modules/react-dom"),
    },
  },
});
