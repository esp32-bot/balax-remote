export type RuntimeTransportMode = "unknown" | "bridge" | "standalone";

let currentMode: RuntimeTransportMode = "unknown";
let probeInFlight: Promise<RuntimeTransportMode> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function hasWebSerial(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function getRuntimeMode(): RuntimeTransportMode {
  return currentMode;
}

export function isBridgeAvailable(): boolean {
  return currentMode === "bridge";
}

export function isStandaloneMode(): boolean {
  return currentMode === "standalone";
}

export function setRuntimeMode(next: RuntimeTransportMode): void {
  if (currentMode === next) return;
  currentMode = next;
  notify();
}

export function subscribeRuntimeMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Probes once whether the local Vite dev bridge (/api/bridge/status) exists.
 * On static hosting (e.g. GitHub Pages), /api/bridge/status returns 404 or non-JSON
 * and we cleanly lock into "standalone" browser-direct mode without spamming 404s.
 */
export async function detectRuntimeMode(force = false): Promise<RuntimeTransportMode> {
  if (!force && currentMode !== "unknown") return currentMode;
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    try {
      const res = await fetch("/api/bridge/status", {
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (res.ok && ct.includes("application/json")) {
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body.connected === "boolean" && typeof body.robotIp === "string") {
          setRuntimeMode("bridge");
          return "bridge";
        }
      }
    } catch {
      // No local bridge — static / GitHub Pages mode
    }
    setRuntimeMode("standalone");
    return "standalone";
  })();
  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
}
