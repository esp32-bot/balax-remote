import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import zlib from "node:zlib";
import type { Connect, Plugin } from "vite";
import { decodeBxz1Stream, type TraceSample } from "./src/bxz1.ts";
import { parseFlashPartitions, type FlashSnapshot } from "./src/flashProtocol.ts";
import type { UsbFlashInfo, UsbFlashJob, UsbFlashLayout, UsbLayoutReadiness } from "./src/usbProtocol.ts";
import type { OtaJobPhase, OtaJobSnapshot } from "./src/otaProtocol.ts";
import { CamBridgeManager, type CamTransportPreference } from "./camBridge.ts";
import {
  filterStickCUsbPorts,
  reconcileStickCPowerMode,
  resolveStickCSleepProbeMiss,
  type UsbSleepOrigin,
} from "./src/deviceControls.ts";
import {
  espIdfPython, isLocalUsbRequest, isSameOriginUsbRequest, loadUsbFlashPlan, usbFlashArgs, usbPowerArgs,
  usbSerialPortKinds, usbSerialPorts, usbWriteProgress, verifyUsbFlashDevice, type UsbFlashImage,
} from "./usbFlash.ts";

export interface RobotHealth {
  pmicC: number | null;
  imuC: number | null;
  batteryPct: number | null;
  batteryV: number | null;
  batteryMa: number | null;
  usbV: number | null;
  usbMa: number | null;
  cpuMhz: number | null;
  cpu0Load: number | null;
  cpu1Load: number | null;
  tickMs: number | null;
  overruns: number | null;
  uptimeS: number | null;
  ramUsedKb: number | null;
  ramTotalKb: number | null;
  ramFreeKb: number | null;
  ramMinKb: number | null;
  brightness: number | null;
  wifiPs: string | null;
  wifiTxDbm: number | null;
  wifiRssi: number | null;
  wifiChannel: number | null;
  wifiPhase: string | null;
  wifiSsid: string | null;
  wifiIp: string | null;
  apSsid: string | null;
  apClients: number | null;
  remoteLive: boolean | null;
  remoteMsgs: number | null;
  remoteFailed: number | null;
  streamActive: boolean | null;
  streamRamChunks: number | null;
  streamRamBytes: number | null;
  streamFlashChunks: number | null;
  streamFlashBytes: number | null;
  streamSamplesSent: number | null;
  streamCompressedBytes: number | null;
  flashErases: number | null;
  otaErased: number | null;
  otaSkipped: number | null;
  progRunning: boolean;
  cacheHits: number | null;
  cacheMisses: number | null;
  cacheKb: number | null;
  cacheEntries: number | null;
  powerMode: string | null;
  idleS: number | null;
  idleSleepS: number | null;
  updatedAtMs: number;
}

function parseKeyValues(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z0-9_]+)(?:\s+|=)(.+)$/);
    if (m) map.set(m[1]!, m[2]!.trim());
  }
  return map;
}

function parseHealthStatus(raw: string, streamRaw?: string): RobotHealth {
  const kv = parseKeyValues(raw);
  const num = (key: string): number | null => {
    const v = kv.get(key);
    if (v === undefined) return null;
    const first = v.split(/\s+/)[0]!;
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  };
  const str = (key: string): string | null => kv.get(key) ?? null;

  let streamActive: boolean | null = null;
  let streamRamChunks: number | null = null;
  let streamRamBytes: number | null = null;
  let streamFlashChunks: number | null = null;
  let streamFlashBytes: number | null = null;
  let streamSamplesSent: number | null = null;
  let streamCompressedBytes: number | null = null;

  if (streamRaw) {
    const skv = parseKeyValues(streamRaw);
    const act = skv.get("active");
    if (act === "yes" || act === "no") streamActive = act === "yes";
    const parseChunkBytes = (val?: string): [number | null, number | null] => {
      if (!val) return [null, null];
      const m = val.match(/^(\d+)\s+\((\d+)\s+bytes\)/);
      return m ? [Number(m[1]), Number(m[2])] : [null, null];
    };
    [streamRamChunks, streamRamBytes] = parseChunkBytes(skv.get("ram_chunks"));
    [streamFlashChunks, streamFlashBytes] = parseChunkBytes(skv.get("flash_chunks"));
    const ss = Number(skv.get("samples_sent"));
    if (Number.isFinite(ss)) streamSamplesSent = ss;
    const cb = Number(skv.get("compressed_bytes"));
    if (Number.isFinite(cb)) streamCompressedBytes = cb;
  }

  return {
    pmicC: num("pmic_c"),
    imuC: num("imu_c"),
    batteryPct: num("battery_pct"),
    batteryV: num("battery_v"),
    batteryMa: num("battery_ma"),
    usbV: num("usb_v"),
    usbMa: num("usb_ma"),
    cpuMhz: num("cpu_mhz"),
    cpu0Load: num("cpu0_load"),
    cpu1Load: num("cpu1_load"),
    tickMs: num("tick_ms"),
    overruns: num("overruns"),
    uptimeS: num("uptime_s"),
    ramUsedKb: num("ram_used_kb"),
    ramTotalKb: num("ram_total_kb"),
    ramFreeKb: num("ram_free_kb"),
    ramMinKb: num("ram_min_kb"),
    brightness: num("brightness"),
    wifiPs: str("wifi_ps"),
    wifiTxDbm: num("wifi_tx_dbm"),
    wifiRssi: num("wifi_rssi"),
    wifiChannel: num("wifi_channel"),
    wifiPhase: str("wifi"),
    wifiSsid: str("wifi_ssid"),
    wifiIp: str("wifi_ip"),
    apSsid: str("ap_ssid"),
    apClients: num("ap_clients"),
    remoteLive: kv.has("remote_live") ? kv.get("remote_live") === "yes" : null,
    remoteMsgs: num("remote_msgs"),
    remoteFailed: num("remote_failed"),
    streamActive,
    streamRamChunks,
    streamRamBytes,
    streamFlashChunks,
    streamFlashBytes,
    streamSamplesSent,
    streamCompressedBytes,
    flashErases: num("flash_erases"),
    otaErased: num("ota_erased"),
    otaSkipped: num("ota_skipped"),
    progRunning: str("prog_running") === "yes",
    cacheHits: num("cache_hits"),
    cacheMisses: num("cache_misses"),
    cacheKb: num("cache_kb"),
    cacheEntries: num("cache_entries"),
    powerMode: str("power_mode"),
    idleS: num("idle_s"),
    idleSleepS: num("idle_sleep_s"),
    updatedAtMs: Date.now(),
  };
}

const OTA_MIN_BATTERY_PCT = 30;
const OTA_MAX_PMIC_C = 46;
const OTA_MAX_IMU_C = 58;
const OTA_RESTART_WAIT_MS = 500; // The app and factory stub wait 350 ms after sending success.
const FLASH_CACHE_MS = 30_000;
type FlashResult = Pick<FlashSnapshot, "status" | "live" | "error">;

function checkHealthBlockers(h: RobotHealth | null, minBatteryPct = OTA_MIN_BATTERY_PCT): string[] {
  if (!h) return [];
  const blockers: string[] = [];
  if (h.batteryPct !== null && h.batteryPct < minBatteryPct) {
    blockers.push(`Battery is ${h.batteryPct.toFixed(0)}% (minimum ${minBatteryPct}% required)`);
  }
  if (h.pmicC !== null && h.pmicC >= OTA_MAX_PMIC_C) {
    blockers.push(`PMIC temp is ${h.pmicC.toFixed(1)}°C (limit < ${OTA_MAX_PMIC_C}°C)`);
  }
  if (h.imuC !== null && h.imuC >= OTA_MAX_IMU_C) {
    blockers.push(`IMU temp is ${h.imuC.toFixed(1)}°C (limit < ${OTA_MAX_IMU_C}°C)`);
  }
  return blockers;
}

function getBinaryMeta(binPath: string) {
  if (!fs.existsSync(binPath)) {
    return { exists: false, sizeBytes: 0, modifiedAtMs: 0, sha256Short: "" };
  }
  const st = fs.statSync(binPath);
  const data = fs.readFileSync(binPath);
  const sha = crypto.createHash("sha256").update(data).digest("hex").slice(0, 12);
  return {
    exists: true,
    sizeBytes: st.size,
    modifiedAtMs: st.mtimeMs,
    sha256Short: sha,
  };
}

function parseCurlProgressPct(line: string): number | null {
  const m = line.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

function stripCurlProgressLines(text: string): string {
  return text
    .split(/[\r\n]+/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^[#=\-\s]*\d{1,3}(?:\.\d+)?%$/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function runProcessAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (line: string) => void } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutPartial = "";
    let stderrPartial = "";
    function reportLines(content: string): string {
      const lines = content.split(/[\r\n]+/);
      const partial = lines.pop() ?? "";
      for (const line of lines) opts.onLine?.(line);
      return partial;
    }
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
            reject(new Error(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
          }
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      if (opts.onLine) stdoutPartial = reportLines(stdoutPartial + chunk);
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      if (opts.onLine) stderrPartial = reportLines(stderrPartial + chunk);
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        opts.onLine?.(stdoutPartial);
        opts.onLine?.(stderrPartial);
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

interface WifiSecrets {
  last_ip?: string;
  lan_auth?: {
    key_hex?: string;
  };
}

/**
 * A bridge request that throws is logged and, if nothing was sent yet,
 * answered with a 500; it must not reject unhandled and end the dev server.
 */
function catchBridgeRequestFailures(
  handle: (...args: Parameters<Connect.NextHandleFunction>) => Promise<void>
): Connect.NextHandleFunction {
  // Connect ignores the returned promise; tests await it to read the response.
  return (req, res, next) =>
    handle(req, res, next).catch((error: unknown) => {
      console.error(`[balax bridge] ${req.method ?? "?"} ${req.url ?? "?"} failed:`, error);
      if (res.headersSent || res.writableEnded) return;
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
}

export function telemetryBridgePlugin(): Plugin {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const balaxDir = path.resolve(repoRoot, "balax");
  const balaxSecretsPath = path.resolve(repoRoot, "balax/secrets/wifi.json");
  const recordingsDir = path.resolve(import.meta.dirname, "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  const hilDir = path.resolve(recordingsDir, "hil");
  fs.mkdirSync(hilDir, { recursive: true });
  const sessionGzipPath = path.join(
    recordingsDir,
    `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.gz`
  );

  let robotIp = "balax.local";
  let fallbackIp: string | null = null;
  let authKey: Buffer | null = null;

  try {
    if (fs.existsSync(balaxSecretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(balaxSecretsPath, "utf8")) as WifiSecrets;
      if (secrets.last_ip) fallbackIp = secrets.last_ip;
      if (secrets.lan_auth?.key_hex) {
        authKey = Buffer.from(secrets.lan_auth.key_hex, "hex");
      }
    }
  } catch {
    // fallback to manual connection
  }

  let cachedHost = "";
  let cachedResolvedIp = "";
  let cachedResolveMs = 0;
  let cachedResolvedVia: "ip" | "mdns" | "fallback" = "mdns";

  async function lookupIpv4WithTimeout(host: string, timeoutMs: number): Promise<string> {
    return await Promise.race([
      dns.lookup(host, { family: 4 }).then((r) => r.address),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`DNS lookup timeout for ${host}`)), timeoutMs)
      ),
    ]);
  }

  async function resolveTargetIp(host: string): Promise<string> {
    const trimmed = host.trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) {
      cachedHost = trimmed;
      cachedResolvedIp = trimmed;
      cachedResolvedVia = "ip";
      cachedResolveMs = Date.now();
      return trimmed;
    }
    const now = Date.now();
    if (cachedHost === trimmed && cachedResolvedIp && now - cachedResolveMs < 60_000) {
      return cachedResolvedIp;
    }
    // Use IPv4-only lookup with a short timeout (750 ms) so macOS mDNSResponder never stalls polling for 5s.
    try {
      const addr = await lookupIpv4WithTimeout(trimmed, 750);
      // Guard against bogus 0.x.x.x mDNS responses
      if (addr.startsWith("0.")) throw new Error(`Invalid mDNS IP ${addr}`);
      cachedHost = trimmed;
      cachedResolvedIp = addr;
      cachedResolvedVia = "mdns";
      cachedResolveMs = now;
      if (trimmed === "balax.local") fallbackIp = addr;
      return addr;
    } catch (err) {
      if (trimmed === "balax.local" && fallbackIp) {
        // Cache fallback IP for 60s so subsequent polls incur 0 ms DNS overhead!
        cachedHost = trimmed;
        cachedResolvedIp = fallbackIp;
        cachedResolvedVia = "fallback";
        cachedResolveMs = now;
        return fallbackIp;
      }
      throw err;
    }
  }

  // Serialize requests to the robot so /api/challenge nonces are never clobbered by concurrent poll & cmd requests
  let mutexChain: Promise<unknown> = Promise.resolve();
  function withRobotLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = mutexChain.then(fn, fn);
    mutexChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  const samples: TraceSample[] = [];
  const MAX_HISTORY_SAMPLES = 360_000; // 1 hour at 100 Hz
  let lastAckTick = 0;
  let connected = false;
  let manuallyDisconnected = false;
  type NormalizedPowerMode = "awake" | "wifi-sleep" | "usb-sleep" | "unknown";
  let powerMode: NormalizedPowerMode = "unknown";
  let usbSleepOrigin: UsbSleepOrigin = null;
  let usbSleepPort: string | null = null;
  let getCamConfirmedUsbPort: () => string | null = () => null;
  function normalizePowerMode(raw: string | null | undefined): NormalizedPowerMode {
    const v = (raw ?? "").trim().toLowerCase();
    if (v === "awake") return "awake";
    if (v === "wifi-sleep" || v === "sleep") return "wifi-sleep";
    if (v === "usb-sleep" || v === "off") return "usb-sleep";
    return "unknown";
  }
  let cachedUsbPorts: string[] = [];
  let cachedUsbPortsAtMs = 0;
  function getCachedUsbPorts(): string[] {
    const now = Date.now();
    if (now - cachedUsbPortsAtMs > 2000) {
      cachedUsbPortsAtMs = now;
      try {
        cachedUsbPorts = usbSerialPorts();
      } catch {
        cachedUsbPorts = [];
      }
    }
    return cachedUsbPorts;
  }
  function getStickCUsbPorts(): string[] {
    const all = getCachedUsbPorts();
    return filterStickCUsbPorts(all, getCamConfirmedUsbPort(), usbSerialPortKinds(all));
  }
  function reconcilePowerMode(): string[] {
    const stickCPorts = getStickCUsbPorts();
    const next = reconcileStickCPowerMode({
      connected,
      powerMode,
      usbSleepOrigin,
      usbSleepPort,
      stickCUsbPorts: stickCPorts,
    });
    powerMode = next.powerMode;
    usbSleepOrigin = next.usbSleepOrigin;
    usbSleepPort = next.usbSleepPort;
    return stickCPorts;
  }
  let lastError: string | null = null;
  let totalBytesCompressed = 0;
  let totalSamplesReceived = 0;
  let streamPoll: Promise<void> | null = null;
  let streamUnavailable = false;
  let emptyPollsSinceSample = 0;
  let health: RobotHealth | null = null;
  const healthHistory: RobotHealth[] = [];
  const MAX_HEALTH_HISTORY = 120;
  const SLEEP_HEALTH_INTERVAL_MS = 15_000;
  let lastHealthPollMs = 0;
  let lastSleepPollMs = 0;
  let sleepProbeMisses = 0;
  let driveSeq = 0;
  let lastDrive: { forward: number; turn: number; atMs: number } | null = null;
  let lastUptime: { seconds: number; observedMs: number } | null = null;
  let healthPolling = false;
  let otaBusy = false;
  let streamResumeAtMs = 0;
  let buildBusy = false;
  let otaJob: OtaJobSnapshot | null = null;
  let usbJob: UsbFlashJob | null = null;

  function startOtaJob(phase: OtaJobPhase, message: string, rawBytes = 0): OtaJobSnapshot {
    const now = Date.now();
    otaJob = {
      id: crypto.randomUUID(),
      active: true,
      status: "running",
      phase,
      progress: phase === "building" ? 5 : 2,
      wireBytes: 0,
      totalBytes: rawBytes,
      rawBytes,
      compressed: false,
      partition: null,
      message,
      error: null,
      startedAtMs: now,
      updatedAtMs: now,
    };
    return otaJob;
  }

  function updateOtaJob(patch: Partial<OtaJobSnapshot>): void {
    if (!otaJob) return;
    otaJob = {
      ...otaJob,
      ...patch,
      updatedAtMs: Date.now(),
    };
  }

  function publicOtaJob(): OtaJobSnapshot | null {
    if (!otaJob) return null;
    if (!otaJob.active && Date.now() - otaJob.updatedAtMs > 120_000) return null;
    return otaJob;
  }
  let flashRevision = Date.now();
  let flashCache: { result: FlashResult; expiresAtMs: number } | null = null;
  let flashPending: Promise<FlashResult> | null = null;

  function invalidateFlash(): void {
    flashRevision++;
    flashCache = null;
    flashPending = null;
  }

  function clearRobotReadings(): void {
    invalidateFlash();
    health = null;
    healthHistory.length = 0;
    lastHealthPollMs = 0;
    lastUptime = null;
  }

  function setRobotConnected(next: boolean, preserveHealth = false): void {
    if (connected === next) return;
    const savedHealth = preserveHealth ? health : null;
    connected = next;
    clearRobotReadings();
    if (preserveHealth && savedHealth) {
      health = savedHealth;
    }
    if (!next) streamUnavailable = false;
  }

  function resetRobotTelemetry(): void {
    lastAckTick = 0;
    emptyPollsSinceSample = 0;
    lastSampleReceivedMs = 0;
    samples.length = 0;
    recentPolls.length = 0;
  }

  function requireCurrentSession(revision: number): void {
    if (revision !== flashRevision) throw new Error("Robot connection changed.");
  }

  // --- Configurable Target Update Rate, 1-RTT Nonce Pipelining & Live Metrics ---
  let targetHz = 20; // Default 20 Hz (smooth 3D motion, gentle ESP32 thermal load)
  let healthIntervalMs = 3000;
  let healthPollSeq = 0;
  let pipelinedNonce: string | null = null;
  let pipelinedNonceAtMs = 0;
  let lastUsedPipelinedNonce = false;
  let lastPollOkMs = 0;
  let lastSampleReceivedMs = 0;
  let lastRttMs = 0;
  let ewmaRttMs = 0;
  const recentPolls: Array<{ ts: number; samples: number; rttMs: number }> = [];
  let rescheduleLoopFn: (() => void) | null = null;

  // Async buffered disk recording (never blocks the telemetry polling loop!)
  let pendingLogChunk = "";
  let logFlushing = false;
  async function flushLogBuffer(): Promise<void> {
    if (logFlushing || !pendingLogChunk) return;
    const chunk = pendingLogChunk;
    pendingLogChunk = "";
    logFlushing = true;
    try {
      const gz = await new Promise<Buffer>((resolve, reject) =>
        zlib.gzip(Buffer.from(chunk, "utf8"), (err, out) => (err ? reject(err) : resolve(out)))
      );
      await fs.promises.appendFile(sessionGzipPath, gz);
    } catch {
      // non-fatal recording error
    } finally {
      logFlushing = false;
    }
  }

  function getStreamMetrics() {
    const now = Date.now();
    const cutoff = now - 2500;
    while (recentPolls.length > 0 && recentPolls[0]!.ts < cutoff) {
      recentPolls.shift();
    }
    let actualPollHz = 0;
    let sampleRateHz = 0;
    if (connected && recentPolls.length > 0 && now - lastPollOkMs <= 2500) {
      const spanSec =
        recentPolls.length >= 2
          ? Math.max(0.4, (now - recentPolls[0]!.ts) / 1000)
          : Math.max(0.5, (now - recentPolls[0]!.ts) / 1000);
      actualPollHz = Number((recentPolls.length / spanSec).toFixed(1));
      const totalInWindow = recentPolls.reduce((acc, p) => acc + p.samples, 0);
      sampleRateHz = Number((totalInWindow / spanSec).toFixed(1));
    }
    return {
      targetHz,
      actualPollHz,
      sampleRateHz,
      rttMs: Number(lastRttMs.toFixed(1)),
      avgRttMs: Number(ewmaRttMs.toFixed(1)),
      lastSampleAgeMs: lastSampleReceivedMs > 0 ? Math.max(0, now - lastSampleReceivedMs) : null,
      pipelinedNonce: lastUsedPipelinedNonce,
      resolvedIp: cachedResolvedIp || fallbackIp || robotIp,
      resolvedVia: cachedResolvedVia,
      healthIntervalMs,
    };
  }

  function captureNextNonce(res: Response): void {
    const next = res.headers.get("x-next-nonce");
    if (next && /^[0-9a-f]{32}$/i.test(next)) {
      pipelinedNonce = next;
      pipelinedNonceAtMs = Date.now();
    }
  }

  async function getChallenge(ip: string): Promise<string> {
    pipelinedNonce = null; // Older firmware keeps only one active nonce.
    const res = await fetch(`http://${ip}/api/challenge`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`challenge HTTP ${res.status}`);
    const data = (await res.json()) as { nonce: string };
    return data.nonce;
  }

  async function acquireNonce(ip: string): Promise<{ nonce: string; pipelined: boolean }> {
    if (pipelinedNonce && Date.now() - pipelinedNonceAtMs < 40_000) {
      const nonce = pipelinedNonce;
      pipelinedNonce = null;
      return { nonce, pipelined: true };
    }
    return { nonce: await getChallenge(ip), pipelined: false };
  }

  function signPayload(nonceHex: string, payload: Buffer): string {
    if (!authKey) throw new Error("Missing LAN auth key in secrets/wifi.json");
    const hmac = crypto.createHmac("sha256", authKey);
    hmac.update(Buffer.from(nonceHex, "hex"));
    if (payload.length > 0) hmac.update(payload);
    return hmac.digest("hex");
  }

  async function fetchStreamWithAck(
    ackTick: number, revision: number,
  ): Promise<{ buf: Uint8Array; rttMs: number; powerMode: string | null } | null> {
    return withRobotLock(async () => {
      requireCurrentSession(revision);
      const ip = await resolveTargetIp(robotIp);
      requireCurrentSession(revision);
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = performance.now();
        const { nonce, pipelined } = await acquireNonce(ip);
        requireCurrentSession(revision);
        const sig = signPayload(nonce, Buffer.alloc(0));
        const res = await fetch(`http://${ip}/api/stream?ack=${ackTick}`, {
          headers: {
            "X-Nonce": nonce,
            "X-Signature": sig,
          },
          signal: AbortSignal.timeout(2500),
        });
        requireCurrentSession(revision);
        if (res.status === 401 && pipelined && attempt === 0) {
          pipelinedNonce = null;
          continue;
        }
        if (!res.ok) {
          pipelinedNonce = null;
          if (res.status === 404) return null;
          throw new Error(`stream HTTP ${res.status}`);
        }
        captureNextNonce(res);
        const buf = new Uint8Array(await res.arrayBuffer());
        requireCurrentSession(revision);
        const rttMs = performance.now() - t0;
        lastUsedPipelinedNonce = pipelined;
        return { buf, rttMs, powerMode: res.headers.get("x-power-mode") };
      }
      throw new Error("stream HTTP 401");
    });
  }

  async function pollStreamOnce(): Promise<void> {
    if (streamPoll) return streamPoll;
    if (otaBusy || usbJob?.status === "running" || Date.now() < streamResumeAtMs || manuallyDisconnected || !authKey || !robotIp ||
        streamUnavailable) return;
    streamPoll = pollRobotStream(flashRevision).finally(() => { streamPoll = null; });
    return streamPoll;
  }

  async function pollRobotStream(revision: number): Promise<void> {
    try {
      let reply = await fetchStreamWithAck(lastAckTick, revision);
      requireCurrentSession(revision);

      // If the robot rebooted, its tick counter reset to < lastAckTick, so ack=lastAckTick
      // would discard its entire queue and return 0 bytes. Probe with ack=0 after 3 empty polls.
      if (reply?.buf.byteLength === 0 && lastAckTick > 0) {
        emptyPollsSinceSample++;
        if (emptyPollsSinceSample >= 3) {
          emptyPollsSinceSample = 0;
          reply = await fetchStreamWithAck(0, revision);
          requireCurrentSession(revision);
        }
      } else {
        emptyPollsSinceSample = 0;
      }

      if (!reply) {
        // Firmware without /api/stream still supports authenticated console commands.
        // Confirm it with status and then use the health poll to track reachability.
        await runRobotCommand("status", revision);
        requireCurrentSession(revision);
        setRobotConnected(true);
        streamUnavailable = true;
        lastError = null;
        return;
      }

      const replyPm = normalizePowerMode(reply.powerMode);
      if (replyPm === "wifi-sleep" || replyPm === "usb-sleep") {
        powerMode = replyPm;
        if (replyPm === "usb-sleep") {
          const sp = getStickCUsbPorts();
          usbSleepOrigin = sp.length > 0 ? "host-usb" : "lan-wall";
          usbSleepPort = sp[0] ?? null;
        } else {
          usbSleepOrigin = null;
          usbSleepPort = null;
        }
        manuallyDisconnected = true;
        setRobotConnected(false, replyPm === "wifi-sleep");
        lastSleepPollMs = Date.now() - SLEEP_HEALTH_INTERVAL_MS + 1500;
        sleepProbeMisses = 0;
        lastError = null;
        return;
      }
      if (replyPm === "awake") {
        powerMode = "awake";
        usbSleepOrigin = null;
        usbSleepPort = null;
      }
      const { buf, rttMs } = reply;
      setRobotConnected(true);
      lastError = null;
      const now = Date.now();
      lastPollOkMs = now;
      lastRttMs = rttMs;
      ewmaRttMs = ewmaRttMs === 0 ? rttMs : ewmaRttMs * 0.78 + rttMs * 0.22;

      let addedCount = 0;
      if (buf.byteLength > 0) {
        totalBytesCompressed += buf.byteLength;
        const decoded = decodeBxz1Stream(buf);
        if (decoded.length > 0) {
          const newestInBatch = decoded[decoded.length - 1]!.tick;
          if (newestInBatch < lastAckTick) {
            // The robot's tick counter restarted from 1.
            resetRobotTelemetry();
            clearRobotReadings();
          }
          let jsonlChunk = "";
          for (const s of decoded) {
            if (s.tick > lastAckTick) {
              samples.push(s);
              lastAckTick = s.tick;
              totalSamplesReceived++;
              addedCount++;
              jsonlChunk += JSON.stringify(s) + "\n";
            }
          }
          if (addedCount > 0) {
            lastSampleReceivedMs = now;
          }
          if (samples.length > MAX_HISTORY_SAMPLES) {
            samples.splice(0, samples.length - MAX_HISTORY_SAMPLES);
          }
          if (jsonlChunk.length > 0) {
            pendingLogChunk += jsonlChunk;
          }
        }
      }
      recentPolls.push({ ts: now, samples: addedCount, rttMs });
    } catch (err) {
      if (revision !== flashRevision) return;
      setRobotConnected(false);
      pipelinedNonce = null;
      // Only invalidate DNS cache if it's older than 5s so we don't thrash mDNS on transient drops
      if (Date.now() - cachedResolveMs > 5000) {
        cachedResolveMs = 0;
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  async function runRobotCommand(cmd: string, revision = flashRevision): Promise<string> {
    return withRobotLock(async () => {
      requireCurrentSession(revision);
      const ip = await resolveTargetIp(robotIp);
      requireCurrentSession(revision);
      const body = Buffer.from(cmd, "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        const { nonce, pipelined } = await acquireNonce(ip);
        requireCurrentSession(revision);
        const sig = signPayload(nonce, body);
        const res = await fetch(`http://${ip}/api/cmd`, {
          method: "POST",
          headers: {
            "X-Nonce": nonce,
            "X-Signature": sig,
            "Content-Type": "text/plain",
          },
          body,
          signal: AbortSignal.timeout(4000),
        });
        requireCurrentSession(revision);
        if (res.status === 401 && pipelined && attempt === 0) {
          pipelinedNonce = null;
          continue;
        }
        if (!res.ok) {
          pipelinedNonce = null;
          throw new Error(`cmd HTTP ${res.status}`);
        }
        captureNextNonce(res);
        const output = await res.text();
        requireCurrentSession(revision);
        return output;
      }
      throw new Error("cmd HTTP 401");
    });
  }

  async function pollHealthIfDue(force = false): Promise<void> {
    if (healthPolling || otaBusy || usbJob?.status === "running" || manuallyDisconnected || !connected || !authKey || !robotIp) return;
    const now = Date.now();
    if (!force && now - lastHealthPollMs < healthIntervalMs) return;
    healthPolling = true;
    const revision = flashRevision;
    try {
      const raw = await runRobotCommand("status", revision);
      const observedMs = performance.now();
      let streamRaw: string | undefined;
      if (!streamUnavailable && (force || healthPollSeq % 3 === 0)) {
        try {
          streamRaw = await runRobotCommand("stream", revision);
        } catch {
          // stream command optional on older firmware
        }
      }
      if (revision !== flashRevision) return;
      healthPollSeq++;
      const parsed = parseHealthStatus(raw, streamRaw);
      const healthPm = normalizePowerMode(parsed.powerMode);
      if (healthPm === "wifi-sleep" || healthPm === "usb-sleep") {
        powerMode = healthPm;
        if (healthPm === "usb-sleep") {
          const sp = getStickCUsbPorts();
          usbSleepOrigin = sp.length > 0 ? "host-usb" : "lan-wall";
          usbSleepPort = sp[0] ?? null;
        } else {
          usbSleepOrigin = null;
          usbSleepPort = null;
        }
        manuallyDisconnected = true;
        setRobotConnected(false, healthPm === "wifi-sleep");
        if (healthPm === "wifi-sleep") {
          health = parsed;
          lastSleepPollMs = Date.now();
          sleepProbeMisses = 0;
        }
        lastError = null;
        return;
      }
      if (healthPm === "awake") {
        powerMode = "awake";
      }
      if (parsed.uptimeS !== null) {
        if (lastUptime && (parsed.uptimeS < lastUptime.seconds ||
            observedMs - lastUptime.observedMs - (parsed.uptimeS - lastUptime.seconds) * 1000 > 2500)) {
          resetRobotTelemetry();
          clearRobotReadings();
          streamUnavailable = false;
        }
        lastUptime = { seconds: parsed.uptimeS, observedMs };
      }
      if (
        parsed.pmicC !== null ||
        parsed.imuC !== null ||
        parsed.batteryPct !== null ||
        parsed.cpuMhz !== null
      ) {
        health = parsed;
        healthHistory.push(parsed);
        if (healthHistory.length > MAX_HEALTH_HISTORY) {
          healthHistory.splice(0, healthHistory.length - MAX_HEALTH_HISTORY);
        }
      }
      lastHealthPollMs = Date.now();
    } catch (err) {
      // With old firmware the console is the only available reachability check.
      if (revision === flashRevision && streamUnavailable) {
        setRobotConnected(false);
        lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      healthPolling = false;
    }
  }

  const SLEEP_PROBE_CMD =
    "probe power_mode pmic_c battery_pct battery_v battery_ma usb_v usb_ma cpu_mhz uptime_s ram_free_kb ram_used_kb ram_total_kb wifi wifi_rssi wifi_ps wifi_channel ap_ssid ap_clients remote_live remote_msgs remote_failed idle_s idle_sleep_s";

  async function pollSleepHealthIfDue(force = false): Promise<void> {
    if (
      healthPolling ||
      otaBusy ||
      usbJob?.status === "running" ||
      connected ||
      powerMode !== "wifi-sleep" ||
      !authKey ||
      !robotIp
    ) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastSleepPollMs < SLEEP_HEALTH_INTERVAL_MS) return;
    healthPolling = true;
    lastSleepPollMs = now;
    const revision = flashRevision;
    try {
      const raw = await runRobotCommand(SLEEP_PROBE_CMD, revision);
      if (revision !== flashRevision || powerMode !== "wifi-sleep") return;
      const parsed = parseHealthStatus(raw);
      sleepProbeMisses = 0;
      const pm = normalizePowerMode(parsed.powerMode);
      if (pm === "awake") {
        powerMode = "awake";
        manuallyDisconnected = false;
        streamUnavailable = false;
        health = parsed;
        rescheduleLoopFn?.();
        return;
      }
      if (pm === "usb-sleep") {
        const sp = getStickCUsbPorts();
        powerMode = "usb-sleep";
        usbSleepOrigin = sp.length > 0 ? "host-usb" : "lan-wall";
        usbSleepPort = sp[0] ?? null;
        return;
      }
      if (
        parsed.pmicC !== null ||
        parsed.batteryPct !== null ||
        parsed.batteryV !== null ||
        parsed.usbV !== null ||
        parsed.uptimeS !== null
      ) {
        health = health
          ? {
              ...health,
              ...Object.fromEntries(
                Object.entries(parsed).filter(([, v]) => v !== null)
              ),
              powerMode: parsed.powerMode ?? "wifi-sleep",
              updatedAtMs: Date.now(),
            }
          : { ...parsed, powerMode: parsed.powerMode ?? "wifi-sleep" };
        healthHistory.push(health);
        if (healthHistory.length > MAX_HEALTH_HISTORY) {
          healthHistory.splice(0, healthHistory.length - MAX_HEALTH_HISTORY);
        }
      }
    } catch {
      if (revision !== flashRevision || powerMode !== "wifi-sleep") return;
      sleepProbeMisses++;
      const missNext = resolveStickCSleepProbeMiss({
        sleepProbeMisses,
        stickCUsbPorts: getStickCUsbPorts(),
        lastUsbV: health?.usbV ?? null,
      });
      powerMode = missNext.powerMode;
      usbSleepOrigin = missNext.usbSleepOrigin;
      usbSleepPort = missNext.usbSleepPort;
    } finally {
      healthPolling = false;
    }
  }

  async function sendRobotDrive(
    forward: number,
    turn: number,
    seq: number,
    revision = flashRevision
  ): Promise<{ superseded?: boolean }> {
    return withRobotLock(async () => {
      if (seq !== driveSeq) return { superseded: true };
      requireCurrentSession(revision);
      const ip = await resolveTargetIp(robotIp);
      if (seq !== driveSeq) return { superseded: true };
      requireCurrentSession(revision);
      const fwd = Math.max(-1, Math.min(1, forward));
      const trn = Math.max(-1, Math.min(1, turn));
      const payload = `${fwd.toFixed(3)} ${trn.toFixed(3)}`;
      const body = Buffer.from(payload, "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        const { nonce, pipelined } = await acquireNonce(ip);
        requireCurrentSession(revision);
        const sig = signPayload(nonce, body);
        const res = await fetch(`http://${ip}/api/drive`, {
          method: "POST",
          headers: {
            "X-Nonce": nonce,
            "X-Signature": sig,
            "Content-Type": "text/plain",
          },
          body,
          signal: AbortSignal.timeout(1500),
        });
        requireCurrentSession(revision);
        if (res.status === 401 && pipelined && attempt === 0) {
          pipelinedNonce = null;
          continue;
        }
        if (res.status === 404) {
          pipelinedNonce = null;
          const fb = await acquireNonce(ip);
          const fbBody = Buffer.from(`drive ${payload}`, "utf8");
          const fbRes = await fetch(`http://${ip}/api/cmd`, {
            method: "POST",
            headers: {
              "X-Nonce": fb.nonce,
              "X-Signature": signPayload(fb.nonce, fbBody),
              "Content-Type": "text/plain",
            },
            body: fbBody,
            signal: AbortSignal.timeout(1500),
          });
          if (fbRes.ok) captureNextNonce(fbRes);
          return {};
        }
        if (!res.ok) {
          pipelinedNonce = null;
          throw new Error(`drive HTTP ${res.status}`);
        }
        captureNextNonce(res);
        return {};
      }
      throw new Error("drive HTTP 401");
    });
  }

  function unavailableFlash(): FlashResult | null {
    if (otaBusy || usbJob?.status === "running") {
      return { status: "busy", live: null, error: "Firmware update in progress." };
    }
    if (!connected) {
      return { status: "offline", live: null, error: "Offline — connect robot to inspect live flash" };
    }
    return null;
  }

  function usbReadiness(layout: UsbFlashLayout, python: string | null): UsbLayoutReadiness {
    if (!python) return { ready: false, error: "Install the BalaX ESP-IDF tools to enable USB flashing." };
    try {
      loadUsbFlashPlan(balaxDir, layout);
      return { ready: true, error: null };
    } catch (err) {
      const failure = err as NodeJS.ErrnoException;
      return {
        ready: false,
        error: failure.code === "ENOENT"
          ? `Build the BalaX firmware${layout === "compact" ? " and factory updater" : ""} before flashing over USB.`
          : failure.message,
      };
    }
  }

  function getUsbInfo(local: boolean): UsbFlashInfo {
    const ports = local ? usbSerialPorts() : [];
    const python = local ? espIdfPython() : null;
    const unavailable = { ready: false, error: "Open BalaX Remote on the bridge computer to flash over USB." };
    const layouts = local
      ? { standard: usbReadiness("standard", python), compact: usbReadiness("compact", python) }
      : { standard: unavailable, compact: unavailable };
    return { local, ports, ready: ports.length > 0 && (layouts.standard.ready || layouts.compact.ready),
      layouts, job: local ? usbJob : null };
  }

  function logUsbLine(job: UsbFlashJob, raw: string): string {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (line && !line.startsWith("Writing at")) {
      job.log.push(line.slice(0, 300));
      if (job.log.length > 30) job.log.shift();
    }
    return line;
  }

  async function runUsbFlash(job: UsbFlashJob, python: string, images: UsbFlashImage[]): Promise<void> {
    let jobDir: string | null = null;
    try {
      const env = { ...process.env, PYTHONUNBUFFERED: "1", NO_COLOR: "1" };
      const preflight = await runProcessAsync(python, usbFlashArgs(job.port), {
        env, timeoutMs: 30_000, onLine: (line) => { logUsbLine(job, line); },
      });
      if (preflight.code !== 0) throw new Error("USB preflight failed. Check the port and cable and try again.");
      verifyUsbFlashDevice(preflight.stdout);
      if (!usbSerialPorts().includes(job.port)) throw new Error("The USB device was disconnected.");

      jobDir = fs.mkdtempSync(path.join(balaxDir, "build/usb-flash-"));
      const staged = images.map((image) => {
        const file = path.join(jobDir!, `${image.offset.toString(16)}.bin`);
        fs.copyFileSync(image.file, file);
        if (fs.statSync(file).size !== image.size) throw new Error(`${image.label} changed during USB preflight.`);
        return { ...image, file };
      });
      job.phase = "writing";
      job.progress = 10;
      logUsbLine(job, "Writing verified layout at 115200 baud.");
      const write = await runProcessAsync(python, usbFlashArgs(job.port, staged), {
        env, onLine: (raw) => {
          const progress = usbWriteProgress(logUsbLine(job, raw), staged);
          if (progress !== null) job.progress = Math.max(job.progress, progress);
        },
      });
      if (write.code !== 0) throw new Error("USB write stopped before completion. Check the flash messages and retry.");
      job.phase = "done";
      job.status = "succeeded";
      job.progress = 100;
      logUsbLine(job, "USB flash verified. BalaX is rebooting.");
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (jobDir) {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* staged build files */ }
      }
      pipelinedNonce = null;
      clearRobotReadings();
      rescheduleLoopFn?.();
    }
  }

  function flashResponse(result: FlashResult): FlashSnapshot {
    return { ...result, connected, revision: flashRevision };
  }

  async function fetchFlash(revision: number): Promise<FlashResult> {
    try {
      const output = await runRobotCommand("partitions", revision);
      if (/^unrecognized command:\s*partitions$/i.test(output.trim())) {
        return { status: "unsupported", live: null, error: "Update BalaX firmware to inspect live flash." };
      }
      return { status: "live", live: parseFlashPartitions(output), error: null };
    } catch (err) {
      return { status: "error", live: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function readFlash(refresh: boolean): Promise<FlashSnapshot> {
    const unavailable = unavailableFlash();
    if (unavailable) return flashResponse(unavailable);
    if (!refresh && flashCache && flashCache.expiresAtMs > Date.now()) {
      return flashResponse(flashCache.result);
    }

    const revision = flashRevision;
    if (!flashPending) {
      flashCache = null;
      flashPending = fetchFlash(revision).then((result) => {
        if (revision === flashRevision) {
          flashPending = null;
          if (result.status === "live" || result.status === "unsupported") {
            flashCache = { result, expiresAtMs: Date.now() + FLASH_CACHE_MS };
          }
        }
        return result;
      });
    }

    const result = await flashPending;
    if (revision !== flashRevision) {
      return flashResponse(unavailableFlash() ?? {
        status: "error", live: null, error: "Robot connection changed. Refresh Flash to inspect it.",
      });
    }
    return flashResponse(result);
  }


  return {
    name: "balax-telemetry-bridge",
    configureServer(server) {
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let serverClosed = false;
      const schedulePoll = (delayMs: number) => {
        if (serverClosed) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => void runPollLoop(), Math.max(4, delayMs));
      };
      // A bug in one background poll is logged, at most every 10 s per poll;
      // it must not end the dev server.
      const pollFailureLoggedAtMs = new Map<string, number>();
      const logPollFailure = (poll: string) => (error: unknown) => {
        const now = Date.now();
        if (now - (pollFailureLoggedAtMs.get(poll) ?? 0) < 10_000) return;
        pollFailureLoggedAtMs.set(poll, now);
        console.error(`[balax bridge] ${poll} failed:`, error);
      };
      const runPollLoop = async () => {
        const periodMs = Math.max(15, Math.round(1000 / Math.max(1, targetHz)));
        const t0 = Date.now();
        try {
          reconcilePowerMode();
          if (!manuallyDisconnected && !otaBusy) {
            await pollStreamOnce();
            void pollHealthIfDue().catch(logPollFailure("health poll"));
          } else if (powerMode === "wifi-sleep" && !otaBusy && usbJob?.status !== "running") {
            void pollSleepHealthIfDue().catch(logPollFailure("sleep health poll"));
          }
        } catch (error) {
          logPollFailure("stream poll")(error);
        }
        const elapsed = Date.now() - t0;
        const nextDelay = connected && !streamUnavailable
          ? Math.max(4, periodMs - elapsed)
          : Math.max(500, periodMs);
        schedulePoll(nextDelay);
      };
      rescheduleLoopFn = () => schedulePoll(4);
      schedulePoll(50);
      const logFlushTimer = setInterval(() => void flushLogBuffer(), 1000);
      // Advertise balax-remote.local over mDNS (macOS Bonjour dns-sd) for phone/tablet/LAN access
      const bridgeStartedAtMs = Date.now();
      let bridgeLanIp = "";
      let bridgePort = 5180;
      let mdnsActive = false;
      let mdnsChild: ChildProcess | null = null;
      const detectBridgeLanIp = () => {
        for (const nets of Object.values(os.networkInterfaces())) {
          for (const n of nets ?? []) {
            if (n.family === "IPv4" && !n.internal) {
              return n.address;
            }
          }
        }
        return "";
      };
      bridgeLanIp = detectBridgeLanIp();
      const stopMdns = () => {
        if (mdnsChild && !mdnsChild.killed) {
          try { mdnsChild.kill("SIGTERM"); } catch { /* ignore */ }
        }
        mdnsChild = null;
        mdnsActive = false;
      };
      const startMdns = () => {
        const addr = server.httpServer?.address();
        bridgePort = typeof addr === "object" && addr ? addr.port : 5180;
        bridgeLanIp = detectBridgeLanIp();
        if (process.platform !== "darwin") return;
        if (!bridgeLanIp) return;
        try {
          mdnsChild = spawn(
            "dns-sd",
            ["-P", "balax-remote", "_http._tcp", "local", String(bridgePort), "balax-remote.local", bridgeLanIp],
            { stdio: "ignore" }
          );
          mdnsActive = true;
          mdnsChild.on("error", () => { mdnsChild = null; mdnsActive = false; });
          mdnsChild.on("exit", () => { mdnsActive = false; });
          const url = bridgePort === 80 ? "http://balax-remote.local/" : `http://balax-remote.local:${bridgePort}/`;
          console.log(`  ➜  mDNS:    ${url}  (${bridgeLanIp})`);
        } catch {
          mdnsChild = null;
          mdnsActive = false;
        }
      };
      server.httpServer?.once("listening", startMdns);
      const camBridge = new CamBridgeManager();
      getCamConfirmedUsbPort = () => camBridge.getConfirmedUsbPort();
      server.httpServer?.once("close", () => {
        serverClosed = true;
        if (pollTimer) clearTimeout(pollTimer);
        clearInterval(logFlushTimer);
        void flushLogBuffer();
        stopMdns();
        camBridge.close();
      });
      process.once("exit", stopMdns);

      server.middlewares.use(catchBridgeRequestFailures(async (req, res, next) => {
        if (!req.url?.startsWith("/api/bridge/")) {
          return next();
        }
        const url = new URL(req.url, "http://localhost");

        if (url.pathname.startsWith("/api/bridge/usb/")) {
          const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (url.pathname === "/api/bridge/usb/info" && req.method === "GET") {
            res.end(JSON.stringify(getUsbInfo(local)));
            return;
          }
          const fail = (status: number, error: string) => {
            res.statusCode = status;
            res.end(JSON.stringify({ error }));
          };
          if (url.pathname !== "/api/bridge/usb/flash" || req.method !== "POST") {
            fail(404, "USB route not found.");
            return;
          }
          if (!local || !isSameOriginUsbRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"])) {
            fail(403, "USB flashing requires this app on the bridge computer.");
            return;
          }
          if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
            fail(415, "USB flash requires a JSON confirmation.");
            return;
          }
          let port: string;
          let layout: UsbFlashLayout;
          try {
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const chunk of req) {
              const bytes = Buffer.from(chunk);
              length += bytes.length;
              if (length > 4096) throw new Error("USB flash request is too large.");
              chunks.push(bytes);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<{
              confirmed: boolean; layout: UsbFlashLayout; port: string;
            }>;
            if (body.confirmed !== true || (body.layout !== "standard" && body.layout !== "compact") ||
                typeof body.port !== "string" || !usbSerialPorts().includes(body.port)) {
              throw new Error("Confirm the USB flash and select a connected USB serial port and layout.");
            }
            ({ port, layout } = body as { port: string; layout: UsbFlashLayout });
          } catch (err) {
            fail(400, err instanceof Error ? err.message : "Invalid USB flash request.");
            return;
          }
          if (otaBusy || buildBusy || usbJob?.status === "running") {
            fail(409, "Another firmware build or flash is in progress.");
            return;
          }
          const python = espIdfPython();
          const readiness = usbReadiness(layout, python);
          if (!python || !readiness.ready) {
            fail(412, readiness.error ?? "USB flash artifacts are unavailable.");
            return;
          }
          let images: UsbFlashImage[];
          try {
            images = loadUsbFlashPlan(balaxDir, layout);
          } catch {
            fail(412, "USB flash artifacts changed. Build the selected layout and try again.");
            return;
          }

          usbJob = { id: crypto.randomUUID(), layout, port, status: "running", phase: "preflight", progress: 0,
            log: ["Checking the connected ESP32 and flash size."], error: null };
          connected = false;
          streamUnavailable = false;
          pipelinedNonce = null;
          resetRobotTelemetry();
          clearRobotReadings();
          void runUsbFlash(usbJob, python, images);
          res.statusCode = 202;
          res.end(JSON.stringify({ job: usbJob }));
          return;
        }

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (url.pathname === "/api/bridge/status") {
          const latest = samples.length > 0 ? samples[samples.length - 1] : null;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              connected,
              ...(() => {
                const stickCPorts = reconcilePowerMode();
                return {
                  powerMode,
                  usbAvailable: stickCPorts.length > 0,
                  usbPort: stickCPorts[0] ?? null,
                };
              })(),
              telemetryAvailable: connected && !streamUnavailable,
              flashRevision,
              robotIp,
              resolvedIp: cachedResolvedIp || robotIp,
              lastAckTick,
              bufferedSamples: samples.length,
              totalSamplesReceived,
              totalBytesCompressed,
              bytesPerSample:
                totalSamplesReceived > 0
                  ? Number((totalBytesCompressed / totalSamplesReceived).toFixed(2))
                  : 0,
              recordingFile: sessionGzipPath,
              lastError,
              health: (connected || powerMode === "wifi-sleep") ? health : null,
              latest,
              otaJob: publicOtaJob(),
              lastDrive: lastDrive && Date.now() - lastDrive.atMs < 600 ? lastDrive : null,
              streamMetrics: getStreamMetrics(),
            })
          );
          return;
        }

        if (url.pathname === "/api/bridge/comms" && req.method === "GET") {
          const refresh = url.searchParams.get("refresh") === "1";
          const probeCam = url.searchParams.get("probeCam") === "1";
          if (refresh) {
            if (connected) {
              await pollHealthIfDue(true);
            } else if (powerMode === "wifi-sleep") {
              await pollSleepHealthIfDue(true);
            }
          }
          const usbPorts = reconcilePowerMode();
          const camStatus = await camBridge.getStatus(probeCam);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            JSON.stringify({
              updatedAtMs: Date.now(),
              bridge: {
                mdnsHost: "balax-remote.local",
                mdnsActive,
                lanIp: bridgeLanIp || null,
                port: bridgePort,
                uptimeS: Math.max(0, Math.floor((Date.now() - bridgeStartedAtMs) / 1000)),
              },
              robot: {
                host: robotIp,
                resolvedIp: cachedResolvedIp || robotIp,
                resolvedVia: cachedResolvedVia,
                connected,
                powerMode,
                telemetryAvailable: connected && !streamUnavailable,
                lastError,
                lastAckTick,
              },
              stream: {
                ...getStreamMetrics(),
                totalSamplesReceived,
                totalBytesCompressed,
                bytesPerSample:
                  totalSamplesReceived > 0
                    ? Number((totalBytesCompressed / totalSamplesReceived).toFixed(2))
                    : 0,
              },
              usb: {
                available: usbPorts.length > 0,
                port: usbPorts[0] ?? null,
                ports: usbPorts,
              },
              health: (connected || powerMode === "wifi-sleep") ? health : null,
              lastDrive: lastDrive && Date.now() - lastDrive.atMs < 1500 ? lastDrive : null,
              cam: camStatus,
            })
          );
          return;
        }

        if (url.pathname === "/api/bridge/trace") {
          const since = Number(url.searchParams.get("since") || "0");
          const limit = Math.min(Number(url.searchParams.get("limit") || "500"), 10000);
          const format = url.searchParams.get("format") || "json";

          const effectiveSince = since > lastAckTick ? 0 : since;
          let slice =
            effectiveSince > 0
              ? samples.filter((s) => s.tick > effectiveSince)
              : samples.slice(-limit);
          if (slice.length > limit) {
            slice = slice.slice(-limit);
          }

          if (format === "csv") {
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            const header =
              "tick,state,fault,pitch_deg,pitch_dps,angle_i,rate_i,speed,distance,power,motor_l,motor_r,accel_x_g,accel_y_g,accel_z_g,gyro_x_dps,gyro_y_dps,gyro_z_dps,yaw_deg\n";
            const rows = slice
              .map(
                (s) =>
                  `${s.tick},${s.state},${s.fault},${s.pitchDeg.toFixed(2)},${s.pitchDps.toFixed(1)},${s.angleI.toFixed(1)},${s.rateI.toFixed(1)},${s.speed.toFixed(2)},${s.distance.toFixed(1)},${s.power.toFixed(1)},${s.motorL},${s.motorR},${(s.accelXG ?? 0).toFixed(2)},${(s.accelYG ?? 0).toFixed(2)},${(s.accelZG ?? 0).toFixed(2)},${(s.gyroXDps ?? 0).toFixed(1)},${(s.gyroYDps ?? 0).toFixed(1)},${(s.gyroZDps ?? 0).toFixed(1)},${(s.yawDeg ?? 0).toFixed(1)}`
              )
              .join("\n");
            res.end(header + rows + (rows ? "\n" : ""));
            return;
          }

          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              robotIp,
              connected,
              ...(() => {
                const stickCPorts = reconcilePowerMode();
                return {
                  powerMode,
                  usbAvailable: stickCPorts.length > 0,
                  usbPort: stickCPorts[0] ?? null,
                };
              })(),
              telemetryAvailable: connected && !streamUnavailable,
              flashRevision,
              disconnected: manuallyDisconnected,
              lastAckTick,
              totalSamplesReceived,
              totalBytesCompressed,
              health: (connected || powerMode === "wifi-sleep") ? health : null,
              otaJob: publicOtaJob(),
              streamMetrics: getStreamMetrics(),
              samples: slice,
            })
          );
          return;
        }

        if (url.pathname === "/api/bridge/rate" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
              targetHz?: number;
              healthIntervalMs?: number;
            };
            if (typeof body.targetHz === "number" && Number.isFinite(body.targetHz)) {
              targetHz = Math.max(1, Math.min(50, Math.round(body.targetHz)));
            }
            if (typeof body.healthIntervalMs === "number" && Number.isFinite(body.healthIntervalMs)) {
              healthIntervalMs = Math.max(1000, Math.min(30000, Math.round(body.healthIntervalMs)));
            }
            if (rescheduleLoopFn) rescheduleLoopFn();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, streamMetrics: getStreamMetrics() }));
          } catch (err) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/system" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              robotIp,
              connected,
              powerMode,
              health: (connected || powerMode === "wifi-sleep") ? health : null,
              healthHistory: (connected || powerMode === "wifi-sleep") ? healthHistory : [],
            })
          );
          return;
        }

        if (url.pathname === "/api/bridge/flash" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(await readFlash(url.searchParams.get("refresh") === "1")));
          return;
        }

        if (url.pathname === "/api/bridge/ota/info" && req.method === "GET") {
          const binPath = path.resolve(repoRoot, "balax/build/balax.bin");
          const binary = getBinaryMeta(binPath);
          let robotPartition: string | null = null;
          let robotVersion: string | null = null;
          if (connected && !otaBusy) {
            try {
              const info = await withRobotLock(async () => {
                pipelinedNonce = null;
                const ip = await resolveTargetIp(robotIp);
                const r = await fetch(`http://${ip}/api/challenge`, {
                  signal: AbortSignal.timeout(2000),
                });
                if (!r.ok) return null;
                return (await r.json()) as { partition?: string; version?: string };
              });
              robotPartition = info?.partition ?? null;
              robotVersion = info?.version ?? null;
            } catch {
              // ignore transient challenge lookup error
            }
          }
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              robotIp,
              connected,
              otaBusy,
              buildBusy,
              otaJob: publicOtaJob(),
              robotPartition,
              robotVersion,
              binary,
              health,
              limits: {
                minBatteryPct: OTA_MIN_BATTERY_PCT,
                maxPmicC: OTA_MAX_PMIC_C,
                maxImuC: OTA_MAX_IMU_C,
              },
            })
          );
          return;
        }

        if (url.pathname === "/api/bridge/ota/build" && req.method === "POST") {
          if (buildBusy || otaBusy || usbJob?.status === "running") {
            res.statusCode = 409;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Another firmware build or flash is in progress." }));
            return;
          }
          buildBusy = true;
          const t0 = Date.now();
          startOtaJob("building", "Compiling BalaX firmware...");
          try {
            const balaxDir = path.resolve(repoRoot, "balax");
            const proc = await runProcessAsync(
              path.join(balaxDir, "tools/bx"),
              ["build"],
              {
                cwd: balaxDir,
                env: { ...process.env, BX_QUIET: "1" },
                timeoutMs: 240_000,
              }
            );
            const binPath = path.resolve(balaxDir, "build/balax.bin");
            const output = (proc.stdout + proc.stderr).trim();
            const meta = getBinaryMeta(binPath);
            if (proc.code === 0) {
              updateOtaJob({
                active: false,
                status: "done",
                phase: "done",
                progress: 100,
                rawBytes: meta.sizeBytes,
                totalBytes: meta.sizeBytes,
                message: `Firmware built (${(meta.sizeBytes / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
              });
            } else {
              updateOtaJob({
                active: false,
                status: "error",
                phase: "error",
                error: output || `Build failed (exit ${proc.code})`,
                message: "Firmware build failed",
              });
            }
            res.statusCode = proc.code === 0 ? 200 : 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: proc.code === 0,
                output,
                durationSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
                binary: getBinaryMeta(binPath),
              })
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            updateOtaJob({
              active: false,
              status: "error",
              phase: "error",
              error: errMsg,
              message: `Build failed: ${errMsg}`,
            });
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: errMsg,
              })
            );
          } finally {
            buildBusy = false;
          }
          return;
        }

        if (url.pathname === "/api/bridge/ota" && req.method === "POST") {
          if (otaBusy || buildBusy || usbJob?.status === "running") {
            res.statusCode = 409;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Another firmware build or flash is in progress." }));
            return;
          }
          otaBusy = true;
          startOtaJob("preflight", "Preparing Wi-Fi OTA...");
          invalidateFlash();
          const otaRevision = flashRevision;
          const otaHost = robotIp;
          let tempUploadPath: string | null = null;
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const rawBody = Buffer.concat(chunks);
            const contentType = String(req.headers["content-type"] || "");

            let force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
            let minBatteryPct = Number(url.searchParams.get("minBattery") || OTA_MIN_BATTERY_PCT);
            if (!Number.isFinite(minBatteryPct)) minBatteryPct = OTA_MIN_BATTERY_PCT;

            let binPath = path.resolve(repoRoot, "balax/build/balax.bin");
            if (contentType.includes("application/octet-stream") && rawBody.length > 0) {
              tempUploadPath = path.join(os.tmpdir(), `balax-ota-${Date.now()}.bin`);
              fs.writeFileSync(tempUploadPath, rawBody);
              binPath = tempUploadPath;
            } else if (rawBody.length > 0 && contentType.includes("application/json")) {
              const parsed = JSON.parse(rawBody.toString("utf8")) as {
                force?: boolean;
                minBatteryPct?: number;
              };
              if (parsed.force) force = true;
              if (typeof parsed.minBatteryPct === "number" && Number.isFinite(parsed.minBatteryPct)) {
                minBatteryPct = parsed.minBatteryPct;
              }
            }

            if (!fs.existsSync(binPath)) {
              const errMsg = "Firmware binary not found. Click Build Firmware first.";
              updateOtaJob({ active: false, status: "error", phase: "error", error: errMsg, message: errMsg });
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: errMsg }));
              return;
            }

            const t0 = Date.now();
            const firmware = fs.readFileSync(binPath);
            updateOtaJob({
              phase: "preflight",
              progress: 2,
              rawBytes: firmware.length,
              totalBytes: firmware.length,
              message: `Preparing Wi-Fi OTA (${(firmware.length / 1024).toFixed(0)} KB)...`,
            });
            const otaResult = await withRobotLock(async () => {
              requireCurrentSession(otaRevision);
              let ip = await resolveTargetIp(robotIp);
              requireCurrentSession(otaRevision);

              // Probe target first so an already-booted factory OTA stub skips /api/cmd calls.
              let chal = await getChallengeFull(ip);
              if (!chal.is_stub) {
                // Live pre-flight safety check (battery >= 30% & cool temps) unless force=true
                if (!force) {
                  updateOtaJob({ phase: "preflight", progress: 4, message: "Checking battery & thermal safety..." });
                  const statusCmd = Buffer.from("status", "utf8");
                  const statusNonce = await getChallenge(ip);
                  const statusSig = signPayload(statusNonce, statusCmd);
                  const statusRes = await fetch(`http://${ip}/api/cmd`, {
                    method: "POST",
                    headers: {
                      "X-Nonce": statusNonce,
                      "X-Signature": statusSig,
                      "Content-Type": "text/plain",
                    },
                    body: statusCmd,
                    signal: AbortSignal.timeout(4000),
                  });
                  const statusText = await statusRes.text();
                  const liveHealth = parseHealthStatus(statusText);
                  health = liveHealth;
                  lastHealthPollMs = Date.now();
                  const blockers = checkHealthBlockers(liveHealth, minBatteryPct);
                  if (blockers.length > 0) {
                    return { blocked: true as const, blockers, health: liveHealth };
                  }
                }

                // Stop telemetry stream first to free up to 24 KB of heap before esp_ota_begin
                updateOtaJob({ phase: "preflight", progress: 6, message: "Pausing telemetry stream..." });
                const stopCmd = Buffer.from("stream stop", "utf8");
                const stopNonce = await getChallenge(ip);
                const stopSig = signPayload(stopNonce, stopCmd);
                await fetch(`http://${ip}/api/cmd`, {
                  method: "POST",
                  headers: {
                    "X-Nonce": stopNonce,
                    "X-Signature": stopSig,
                    "Content-Type": "text/plain",
                  },
                  body: stopCmd,
                  signal: AbortSignal.timeout(4000),
                });
                chal = await getChallengeFull(ip);
              }

              if (chal.has_factory && !chal.is_stub) {
                updateOtaJob({
                  phase: "entering-stub",
                  progress: 8,
                  message: "Rebooting BalaX into OTA updater...",
                });
                const enterSig = signPayload(chal.nonce, Buffer.alloc(0));
                const entered = await fetch(`http://${ip}/api/ota/enter`, {
                  method: "POST",
                  headers: { "X-Nonce": chal.nonce, "X-Signature": enterSig },
                  signal: AbortSignal.timeout(4000),
                });
                if (!entered.ok) throw new Error(`Factory OTA updater rejected boot selection (HTTP ${entered.status}).`);
                const enterStart = Date.now();
                const deadline = enterStart + 20_000;
                let stubChal: typeof chal | null = null;
                let refreshedIp = false;
                while (Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 600));
                  const waitSec = Math.round((Date.now() - enterStart) / 1000);
                  updateOtaJob({
                    phase: "entering-stub",
                    progress: Math.min(14, 8 + Math.round((waitSec / 20) * 6)),
                    message: `Waiting for OTA updater (${waitSec}s)...`,
                  });
                  if (!refreshedIp && waitSec >= 9) {
                    refreshedIp = true;
                    cachedResolveMs = 0;
                    try { ip = await resolveTargetIp(robotIp); } catch { /* keep previous ip */ }
                  }
                  try {
                    const c = await getChallengeFull(ip);
                    if (c.is_stub && c.partition === "factory") { stubChal = c; break; }
                  } catch { /* rebooting */ }
                }
                if (!stubChal) throw new Error("Factory OTA updater did not come online. Firmware was not uploaded.");
                chal = stubChal;
              }

              const rawSha = crypto.createHash("sha256").update(firmware).digest("hex");
              let wirePayload: Buffer = firmware;
              let wireContentType = "application/octet-stream";
              let uploadPath = binPath;
              let tempCompressedPath: string | null = null;
              if (chal.compressed_ota) {
                updateOtaJob({ phase: "compressing", progress: 14, message: "Compressing firmware (zlib-9)..." });
                const comp = zlib.deflateSync(firmware, { level: 9 });
                if (comp.length < firmware.length) {
                  wirePayload = comp;
                  wireContentType = "application/x-balax-zlib";
                  tempCompressedPath = path.join(os.tmpdir(), `balax-ota-${Date.now()}.zlib`);
                  fs.writeFileSync(tempCompressedPath, wirePayload);
                  uploadPath = tempCompressedPath;
                }
              }

              const compressed = wireContentType === "application/x-balax-zlib";
              const totalKb = (wirePayload.length / 1024).toFixed(0);
              updateOtaJob({
                phase: "uploading",
                progress: 15,
                compressed,
                totalBytes: wirePayload.length,
                wireBytes: 0,
                message: `Uploading 0/${totalKb} KB${compressed ? " (zlib)" : ""}...`,
              });

              const otaNonce = chal.nonce;
              const otaSig = signPayload(otaNonce, wirePayload);
              let proc;
              try {
                proc = await runProcessAsync(
                  "curl",
                  [
                    "-#",
                    "-S",
                    "--fail-with-body",
                    "-X", "POST",
                    `http://${ip}/api/ota`,
                    "-H", `Content-Type: ${wireContentType}`,
                    "-H", `X-Raw-Size: ${firmware.length}`,
                    "-H", `X-Raw-Sha256: ${rawSha}`,
                    "-H", "Expect:",
                    "-H", `X-Nonce: ${otaNonce}`,
                    "-H", `X-Signature: ${otaSig}`,
                    "--data-binary", `@${uploadPath}`,
                  ],
                  {
                    timeoutMs: 75_000,
                    onLine: (line) => {
                      const pct = parseCurlProgressPct(line);
                      if (pct === null) return;
                      const sentBytes = Math.round((pct / 100) * wirePayload.length);
                      if (pct >= 99.5) {
                        updateOtaJob({
                          phase: "verifying",
                          progress: 94,
                          wireBytes: wirePayload.length,
                          message: "Verifying SHA-256 & committing boot slot...",
                        });
                      } else {
                        updateOtaJob({
                          phase: "uploading",
                          progress: 15 + Math.round(pct * 0.77),
                          wireBytes: sentBytes,
                          message: `Uploading ${(sentBytes / 1024).toFixed(0)}/${totalKb} KB (${Math.round(pct)}%)...`,
                        });
                      }
                    },
                  }
                );
              } finally {
                if (tempCompressedPath) {
                  try { fs.unlinkSync(tempCompressedPath); } catch { /* ignore */ }
                }
              }
              if (proc.code !== 0) {
                const cleanErr = stripCurlProgressLines(proc.stderr) || proc.stdout.trim() || `curl exit ${proc.code}`;
                throw new Error(cleanErr);
              }
              if (robotIp === otaHost) {
                streamResumeAtMs = Date.now() + OTA_RESTART_WAIT_MS;
                resetRobotTelemetry();
                setRobotConnected(false);
                pipelinedNonce = null;
              }
              const dtSec = (Date.now() - t0) / 1000;
              const rawTxt = proc.stdout.trim();
              let parsedOut: Record<string, unknown> = { raw: rawTxt };
              try {
                if (rawTxt.startsWith("{")) parsedOut = JSON.parse(rawTxt);
              } catch { /* ignore */ }
              const partition = typeof parsedOut.partition === "string" ? parsedOut.partition : null;
              const kbps = Number(((firmware.length / 1024) / Math.max(dtSec, 0.01)).toFixed(0));
              updateOtaJob({
                active: false,
                status: "done",
                phase: "done",
                progress: 100,
                wireBytes: wirePayload.length,
                totalBytes: wirePayload.length,
                partition,
                message: `Flashed ${partition ?? "ota"} in ${dtSec.toFixed(1)}s (${kbps} KB/s) — rebooting`,
              });
              return {
                blocked: false as const,
                payload: {
                  ok: true,
                  ...parsedOut,
                  compressed,
                  wireBytes: wirePayload.length,
                  sizeBytes: firmware.length,
                  rawSha256: rawSha,
                  durationSec: Number(dtSec.toFixed(1)),
                  kbps,
                },
              };
            });

            if (otaResult.blocked) {
              updateOtaJob({
                active: false,
                status: "error",
                phase: "error",
                error: otaResult.blockers.join(" · "),
                message: `OTA blocked: ${otaResult.blockers.join(" · ")}`,
              });
              res.statusCode = 412;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: false,
                  blocked: true,
                  blockers: otaResult.blockers,
                  health: otaResult.health,
                })
              );
              return;
            }

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(otaResult.payload));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            updateOtaJob({
              active: false,
              status: "error",
              phase: "error",
              error: errMsg,
              message: `Wi-Fi OTA failed: ${errMsg}`,
            });
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: errMsg }));
          } finally {
            otaBusy = false;
            invalidateFlash();
            if (tempUploadPath) {
              try { fs.unlinkSync(tempUploadPath); } catch { /* ignore */ }
            }
          }
          return;
        }

        if (url.pathname.startsWith("/api/bridge/cam/")) {
          const camHostParam = url.searchParams.get("host");
          if (camHostParam) camBridge.setHost(camHostParam);

          if (url.pathname === "/api/bridge/cam/status" && req.method === "GET") {
            const probe = url.searchParams.get("probe") !== "0";
            const st = await camBridge.getStatus(probe);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(st));
            return;
          }

          if (url.pathname === "/api/bridge/cam/ota/info" && req.method === "GET") {
            const probe = url.searchParams.get("probe") !== "0";
            const info = await camBridge.getOtaInfo(probe);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(info));
            return;
          }

          if (url.pathname === "/api/bridge/cam/push" && req.method === "GET") {
            const pref = url.searchParams.get("transport") as CamTransportPreference | null;
            if (pref === "auto" || pref === "udp" || pref === "http" || pref === "usb") {
              await camBridge.startStream(pref);
            }
            camBridge.attachBinaryPushClient(res);
            return;
          }

          if (url.pathname === "/api/bridge/cam/stream" && req.method === "GET") {
            const pref = url.searchParams.get("transport") as CamTransportPreference | null;
            if (pref === "auto" || pref === "udp" || pref === "http" || pref === "usb") {
              await camBridge.startStream(pref);
            }
            camBridge.attachMjpegClient(res);
            return;
          }

          if (url.pathname === "/api/bridge/cam/frame" && req.method === "GET") {
            const f = camBridge.getLatestFrame();
            res.setHeader("Cache-Control", "no-store");
            if (!f || f.jpeg.length === 0) {
              res.statusCode = 204;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("X-Frame-Id", String(f.frameId));
            res.setHeader("X-Pitch-Cdeg", String(f.pitchCdeg));
            res.setHeader("X-Roll-Cdeg", String(f.rollCdeg));
            res.setHeader("X-Has-Attitude", f.hasAttitude ? "1" : "0");
            res.setHeader("X-Codec-Mode", f.codecModeName);
            res.setHeader("X-Skipped", f.isSkipped ? "1" : "0");
            res.setHeader("X-Width", String(f.width));
            res.setHeader("X-Height", String(f.height));
            res.end(f.jpeg);
            return;
          }

          if (req.method === "POST") {
            const contentType = String(req.headers["content-type"] || "").toLowerCase();
            const isBinaryUpload = contentType.includes("application/octet-stream");
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            for await (const c of req) {
              const b = Buffer.from(c);
              totalBytes += b.length;
              if (totalBytes > 4 * 1024 * 1024) {
                res.statusCode = 413;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: false, error: "Firmware upload exceeds 4 MB limit" }));
                return;
              }
              chunks.push(b);
            }
            const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
            let body: Record<string, unknown> = {};
            if (!isBinaryUpload && rawBody.length > 0) {
              try {
                body = JSON.parse(rawBody.toString("utf8"));
              } catch {
                // ignore malformed JSON
              }
            }
            if (typeof body.host === "string" && body.host.trim()) {
              camBridge.setHost(body.host.trim());
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");

            if (url.pathname === "/api/bridge/cam/start") {
              const pref = body.transport as CamTransportPreference | undefined;
              await camBridge.startStream(
                pref === "auto" || pref === "udp" || pref === "http" || pref === "usb" ? pref : undefined,
              );
              const st = await camBridge.getStatus(false);
              res.end(JSON.stringify({ ok: true, ...st }));
              return;
            }
            if (url.pathname === "/api/bridge/cam/stop") {
              await camBridge.stopStream();
              const st = await camBridge.getStatus(false);
              res.end(JSON.stringify({ ok: true, ...st }));
              return;
            }
            if (url.pathname === "/api/bridge/cam/transport") {
              const pref = body.transport as CamTransportPreference | undefined;
              const nextPref: CamTransportPreference =
                pref === "auto" || pref === "udp" || pref === "http" || pref === "usb" ? pref : "auto";
              await camBridge.setTransportPreference(nextPref);
              const st = await camBridge.getStatus(false);
              res.end(JSON.stringify({ ok: true, ...st }));
              return;
            }
            if (url.pathname === "/api/bridge/cam/power") {
              const mode = body.mode === "sleep" || body.mode === "idle" || body.mode === "wake" ? body.mode : "idle";
              const via = body.via === "usb" || body.via === "lan" || body.via === "auto" ? body.via : "auto";
              if (via === "usb") {
                const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
                const sameOrigin = isSameOriginUsbRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"]);
                if (!local || !sameOrigin) {
                  res.statusCode = 403;
                  res.end(JSON.stringify({ ok: false, error: "USB camera power control requires local same-origin request" }));
                  return;
                }
              }
              const out = await camBridge.setPower(mode, via);
              res.end(JSON.stringify(out));
              return;
            }
            if (url.pathname === "/api/bridge/cam/ota/build") {
              const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
              const originOk = !req.headers.origin || isSameOriginUsbRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"]);
              if (!local || !originOk) {
                res.statusCode = 403;
                res.end(JSON.stringify({ ok: false, error: "ESP32-CAM local firmware build requires a local bridge request" }));
                return;
              }
              try {
                const job = await camBridge.startBuild();
                res.statusCode = 202;
                res.end(JSON.stringify({ ok: true, job }));
              } catch (err) {
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              }
              return;
            }
            if (url.pathname === "/api/bridge/cam/ota") {
              try {
                const customName = String(req.headers["x-filename"] || url.searchParams.get("filename") || "custom.bin");
                const job = isBinaryUpload
                  ? await camBridge.startWifiOta({ customBytes: rawBody, customName })
                  : await camBridge.startWifiOta();
                res.statusCode = 202;
                res.end(JSON.stringify({ ok: true, job }));
              } catch (err) {
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              }
              return;
            }
            if (url.pathname === "/api/bridge/cam/flash") {
              const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
              const originOk = !req.headers.origin || isSameOriginUsbRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"]);
              if (!local || !originOk) {
                res.statusCode = 403;
                res.end(JSON.stringify({ ok: false, error: "ESP32-CAM USB flashing requires a local bridge request" }));
                return;
              }
              const confirmed = isBinaryUpload
                ? url.searchParams.get("confirmed") === "1" || url.searchParams.get("confirmed") === "true"
                : body.confirmed === true;
              if (!confirmed) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: "Confirm the ESP32-CAM USB flash before writing" }));
                return;
              }
              try {
                const port = isBinaryUpload
                  ? (url.searchParams.get("port") || undefined)
                  : (typeof body.port === "string" ? body.port : undefined);
                const full = !isBinaryUpload && body.full === true;
                const customName = String(req.headers["x-filename"] || url.searchParams.get("filename") || "custom.bin");
                const job = isBinaryUpload
                  ? await camBridge.startUsbFlash(port, { customBytes: rawBody, customName })
                  : await camBridge.startUsbFlash(port, { full });
                res.statusCode = 202;
                res.end(JSON.stringify({ ok: true, job }));
              } catch (err) {
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              }
              return;
            }
            if (url.pathname === "/api/bridge/cam/config") {
              try {
                const out = await camBridge.setConfig(body);
                res.end(JSON.stringify({ ok: true, ...out }));
              } catch (err) {
                res.statusCode = 502;
                res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              }
              return;
            }
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Unknown /api/bridge/cam endpoint" }));
          return;
        }

        if (url.pathname === "/api/bridge/prog/run" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const rawBody = Buffer.concat(chunks);
            const shaQ = url.searchParams.get("sha256") || "";
            const progName = String(req.headers["x-prog-name"] || url.searchParams.get("name") || "applet");
            const progPin = String(req.headers["x-prog-pin"] || url.searchParams.get("pin") || "0");
            const out = await withRobotLock(async () => {
              const ip = await resolveTargetIp(robotIp);
              const nonce = await getChallenge(ip);
              const payload = rawBody.length > 0 ? rawBody : Buffer.alloc(0);
              const sig = signPayload(nonce, payload);
              const qs = shaQ && rawBody.length === 0 ? `?sha256=${encodeURIComponent(shaQ)}` : "";
              const r = await fetch(`http://${ip}/api/prog/run${qs}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Nonce": nonce,
                  "X-Signature": sig,
                  "X-Prog-Name": progName,
                  "X-Prog-Pin": progPin,
                },
                body: payload.length > 0 ? payload : undefined,
                signal: AbortSignal.timeout(6000),
              });
              return { status: r.status, text: await r.text() };
            });
            res.statusCode = out.status;
            res.setHeader("Content-Type", "application/json");
            res.end(out.text);
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/prog/stop" && req.method === "POST") {
          try {
            const text = await withRobotLock(async () => {
              const ip = await resolveTargetIp(robotIp);
              const nonce = await getChallenge(ip);
              const sig = signPayload(nonce, Buffer.alloc(0));
              const r = await fetch(`http://${ip}/api/prog/stop`, {
                method: "POST",
                headers: { "X-Nonce": nonce, "X-Signature": sig },
                signal: AbortSignal.timeout(4000),
              });
              return await r.text();
            });
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/prog/status" && req.method === "GET") {
          try {
            const text = await withRobotLock(async () => {
              const ip = await resolveTargetIp(robotIp);
              const nonce = await getChallenge(ip);
              const sig = signPayload(nonce, Buffer.alloc(0));
              const r = await fetch(`http://${ip}/api/prog/status`, {
                method: "GET",
                headers: { "X-Nonce": nonce, "X-Signature": sig },
                signal: AbortSignal.timeout(4000),
              });
              return await r.text();
            });
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/prog/cache" && (req.method === "GET" || req.method === "DELETE")) {
          try {
            const text = await withRobotLock(async () => {
              const ip = await resolveTargetIp(robotIp);
              const nonce = await getChallenge(ip);
              const sig = signPayload(nonce, Buffer.alloc(0));
              const r = await fetch(`http://${ip}/api/prog/cache`, {
                method: req.method,
                headers: { "X-Nonce": nonce, "X-Signature": sig },
                signal: AbortSignal.timeout(4000),
              });
              return await r.text();
            });
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/prog/cache/pin" && req.method === "POST") {
          try {
            const sha = url.searchParams.get("sha256") || "";
            const pin = url.searchParams.get("pin") || "1";
            const text = await withRobotLock(async () => {
              const ip = await resolveTargetIp(robotIp);
              const nonce = await getChallenge(ip);
              const sig = signPayload(nonce, Buffer.alloc(0));
              const r = await fetch(
                `http://${ip}/api/prog/cache/pin?sha256=${encodeURIComponent(sha)}&pin=${encodeURIComponent(pin)}`,
                {
                  method: "POST",
                  headers: { "X-Nonce": nonce, "X-Signature": sig },
                  signal: AbortSignal.timeout(4000),
                },
              );
              return await r.text();
            });
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/connect" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
            ip?: string;
          };
          const host = body.ip?.trim();
          if (host) {
            robotIp = host;
            cachedResolveMs = 0;
            resetRobotTelemetry();
          }
          manuallyDisconnected = false;
          connected = false;
          powerMode = "unknown";
          usbSleepOrigin = null;
          usbSleepPort = null;
          streamUnavailable = false;
          pipelinedNonce = null;
          clearRobotReadings();
          const revision = flashRevision;
          await streamPoll;
          if (revision === flashRevision) await pollStreamOnce();
          if (rescheduleLoopFn) rescheduleLoopFn();
          void pollHealthIfDue(true);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, robotIp, connected, lastError }));
          return;
        }

        if (url.pathname === "/api/bridge/disconnect" && req.method === "POST") {
          manuallyDisconnected = true;
          connected = false;
          powerMode = "unknown";
          usbSleepOrigin = null;
          usbSleepPort = null;
          streamUnavailable = false;
          pipelinedNonce = null;
          clearRobotReadings();
          lastError = null;
          try {
            await runRobotCommand("stream stop");
          } catch {
            // Robot may already be unreachable; local disconnect still succeeds
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, robotIp, connected: false, disconnected: true }));
          return;
        }

        if (url.pathname === "/api/bridge/reload" && req.method === "POST") {
          const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (!local) {
            res.statusCode = 403;
            res.end(JSON.stringify({ ok: false, error: "Reload requires a local request." }));
            return;
          }
          let body: Partial<{ restart: boolean }> = {};
          try {
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const c of req) {
              const b = Buffer.from(c);
              length += b.length;
              if (length > 1024) throw new Error("Reload request is too large.");
              chunks.push(b);
            }
            if (length > 0) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Invalid JSON." }));
            return;
          }
          const restart = body.restart === true;
          if (restart) {
            res.end(JSON.stringify({ ok: true, action: "restart" }));
            setTimeout(() => { void server.restart?.(); }, 50);
          } else {
            server.ws?.send({ type: "full-reload", path: "*" });
            res.end(JSON.stringify({ ok: true, action: "full-reload" }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/power" && req.method === "POST") {
          const local = isLocalUsbRequest(req.headers.host, req.socket.remoteAddress, req.socket.localAddress);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          let body: Partial<{
            mode: "wifi-sleep" | "usb-sleep" | "sleep" | "off" | "wake";
            via: "lan" | "usb";
            port: string;
            force: boolean;
            localOnly: boolean;
          }>;
          try {
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const c of req) {
              const b = Buffer.from(c);
              length += b.length;
              if (length > 4096) throw new Error("Power request is too large.");
              chunks.push(b);
            }
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Invalid JSON." }));
            return;
          }

          const rawMode = body.mode;
          const mode: "wifi-sleep" | "usb-sleep" | "wake" | null =
            rawMode === "wake" ? "wake"
              : rawMode === "wifi-sleep" || rawMode === "sleep" ? "wifi-sleep"
                : rawMode === "usb-sleep" || rawMode === "off" ? "usb-sleep"
                  : null;
          if (!mode) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Expected mode: 'wifi-sleep', 'usb-sleep', or 'wake'." }));
            return;
          }

          // Local CLI sync: pause bridge polling without sending a duplicate command to the robot.
          if (body.localOnly === true) {
            if (!local) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "Local-only bridge sync requires a local request." }));
              return;
            }
            if (mode === "wifi-sleep" || mode === "usb-sleep") {
              powerMode = mode;
              if (mode === "usb-sleep") {
                const sp = getStickCUsbPorts();
                usbSleepOrigin = sp.length > 0 ? "host-usb" : "lan-wall";
                usbSleepPort = sp[0] ?? null;
              } else {
                usbSleepOrigin = null;
                usbSleepPort = null;
              }
              manuallyDisconnected = true;
              setRobotConnected(false, mode === "wifi-sleep");
              if (mode === "wifi-sleep") {
                lastSleepPollMs = Date.now() - SLEEP_HEALTH_INTERVAL_MS + 1500;
                sleepProbeMisses = 0;
              }
              pipelinedNonce = null;
              lastError = null;
            }
            res.end(JSON.stringify({ ok: true, mode, powerMode }));
            return;
          }

          const via = body.via === "usb" ? "usb" : "lan";
          const force = body.force === true;

          if (via === "usb") {
            const originOk = !req.headers.origin ||
              isSameOriginUsbRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"]);
            if (!local || !originOk) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: "USB power control requires this app on the bridge computer." }));
              return;
            }
            if (otaBusy || buildBusy || usbJob?.status === "running") {
              res.statusCode = 409;
              res.end(JSON.stringify({ ok: false, error: "Another firmware build or flash is in progress." }));
              return;
            }
            const python = espIdfPython();
            if (!python) {
              res.statusCode = 412;
              res.end(JSON.stringify({ ok: false, error: "Install the BalaX ESP-IDF tools to enable USB power control." }));
              return;
            }
            const ports = usbSerialPorts();
            const stickCPorts = filterStickCUsbPorts(ports, getCamConfirmedUsbPort(), usbSerialPortKinds(ports));
            const chosenPort = typeof body.port === "string" && body.port.trim()
              ? body.port.trim()
              : stickCPorts.length === 1 ? stickCPorts[0]! : "";
            if (!chosenPort || !ports.includes(chosenPort)) {
              res.statusCode = 400;
              res.end(JSON.stringify({
                ok: false,
                error: ports.length === 0
                  ? "No BalaX USB serial port detected. Plug in USB first."
                  : "Select a connected USB serial port.",
              }));
              return;
            }
            if (mode === "wifi-sleep") {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Use mode 'usb-sleep' or 'wake' for USB power control." }));
              return;
            }
            const proc = await runProcessAsync(python, usbPowerArgs(balaxDir, mode, chosenPort, force), {
              cwd: balaxDir,
              timeoutMs: 15_000,
            });
            const output = (proc.stdout + proc.stderr).trim();
            if (proc.code !== 0) {
              res.statusCode = 502;
              res.end(JSON.stringify({ ok: false, error: output || `USB ${mode} failed.` }));
              return;
            }
            if (mode === "usb-sleep") {
              powerMode = "usb-sleep";
              usbSleepOrigin = "host-usb";
              usbSleepPort = chosenPort;
              manuallyDisconnected = true;
              setRobotConnected(false);
              pipelinedNonce = null;
              lastError = null;
            } else {
              powerMode = "awake";
              usbSleepOrigin = null;
              usbSleepPort = null;
              manuallyDisconnected = false;
              connected = false;
              streamUnavailable = false;
              pipelinedNonce = null;
              clearRobotReadings();
              rescheduleLoopFn?.();
            }
            res.end(JSON.stringify({ ok: true, mode, powerMode, via: "usb", port: chosenPort, output }));
            return;
          }

          // LAN power control
          const wasConnected = connected;
          try {
            if (mode === "wifi-sleep" || mode === "usb-sleep") {
              manuallyDisconnected = true;
              const cmd = force ? `${mode} force` : mode;
              let output = (await runRobotCommand(cmd)).trim();
              // Backwards compatibility with classic-2020 backup firmware (`sleep` / `off`)
              if (/^unrecognized command/i.test(output)) {
                const legacy = mode === "wifi-sleep" ? "sleep" : "off";
                output = (await runRobotCommand(force ? `${legacy} force` : legacy)).trim();
              }
              if (/^refusing\b/i.test(output) || /^unrecognized command/i.test(output)) {
                manuallyDisconnected = !wasConnected;
                if (wasConnected) rescheduleLoopFn?.();
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, error: output }));
                return;
              }
              powerMode = mode;
              if (mode === "usb-sleep") {
                const sp = getStickCUsbPorts();
                usbSleepOrigin = sp.length > 0 ? "host-usb" : "lan-wall";
                usbSleepPort = sp[0] ?? null;
              } else {
                usbSleepOrigin = null;
                usbSleepPort = null;
              }
              setRobotConnected(false, mode === "wifi-sleep");
              if (mode === "wifi-sleep") {
                lastSleepPollMs = Date.now() - SLEEP_HEALTH_INTERVAL_MS + 1500;
                sleepProbeMisses = 0;
              }
              pipelinedNonce = null;
              lastError = null;
              res.end(JSON.stringify({ ok: true, mode, powerMode, via: "lan", output }));
              return;
            }

            // LAN wake
            const output = (await runRobotCommand("wake")).trim();
            powerMode = "awake";
            usbSleepOrigin = null;
            usbSleepPort = null;
            manuallyDisconnected = false;
            connected = false;
            streamUnavailable = false;
            pipelinedNonce = null;
            clearRobotReadings();
            const revision = flashRevision;
            await streamPoll;
            if (revision === flashRevision) await pollStreamOnce();
            rescheduleLoopFn?.();
            void pollHealthIfDue(true);
            res.end(JSON.stringify({ ok: true, mode: "wake", powerMode, via: "lan", connected, output }));
          } catch (err) {
            if ((mode === "wifi-sleep" || mode === "usb-sleep") && wasConnected) {
              manuallyDisconnected = false;
              rescheduleLoopFn?.();
            }
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/hil" && req.method === "GET") {
          const name = (url.searchParams.get("name") || "").replace(/[^a-zA-Z0-9._-]/g, "");
          if (name) {
            const fp = path.join(hilDir, name.endsWith(".json") ? name : `${name}.json`);
            if (!fs.existsSync(fp)) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(fs.readFileSync(fp, "utf8"));
            return;
          }
          const files = fs.readdirSync(hilDir).filter((f) => f.endsWith(".json")).sort();
          const list = files.map((f) => {
            try {
              const obj = JSON.parse(fs.readFileSync(path.join(hilDir, f), "utf8"));
              return {
                name: obj.name || f.replace(/\.json$/, ""),
                recordedAt: obj.recordedAt || "",
                sampleCount: Array.isArray(obj.samples) ? obj.samples.length : 0,
              };
            } catch {
              return { name: f.replace(/\.json$/, ""), recordedAt: "", sampleCount: 0 };
            }
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ captures: list }));
          return;
        }

        if (url.pathname === "/api/bridge/hil" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const text = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(text) as { name?: string };
            const safeName = (parsed.name || `capture_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_");
            const fp = path.join(hilDir, `${safeName}.json`);
            fs.writeFileSync(fp, text, "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, file: fp, name: safeName }));
          } catch (err) {
            res.statusCode = 400;
            res.end(err instanceof Error ? err.message : String(err));
          }
          return;
        }

        if (url.pathname === "/api/bridge/drive" && req.method === "POST") {
          res.setHeader("Content-Type", "application/json");
          if (otaBusy || usbJob?.status === "running" || !connected || !authKey || !robotIp) {
            res.statusCode = 409;
            res.end(JSON.stringify({ ok: false, error: "Robot offline or busy" }));
            return;
          }
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            const parsed = JSON.parse(raw || "{}") as { forward?: unknown; turn?: unknown };
            const forward = typeof parsed.forward === "number" && Number.isFinite(parsed.forward) ? parsed.forward : 0;
            const turn = typeof parsed.turn === "number" && Number.isFinite(parsed.turn) ? parsed.turn : 0;
            const seq = ++driveSeq;
            lastDrive = { forward, turn, atMs: Date.now() };
            const result = await sendRobotDrive(forward, turn, seq);
            res.end(JSON.stringify({ ok: true, forward, turn, ...result }));
          } catch (err) {
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.pathname === "/api/bridge/cmd" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            let cmd = raw;
            if (raw.startsWith("{")) {
              const parsed = JSON.parse(raw) as { cmd?: string };
              cmd = parsed.cmd || "";
            }
            if (/^reboot(?:\s|$)/.test(cmd.trimStart())) invalidateFlash();
            const output = await runRobotCommand(cmd);
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(output);
          } catch (err) {
            res.statusCode = 502;
            res.end(err instanceof Error ? err.message : String(err));
          }
          return;
        }

        next();
      }));
    },
  };
}

  async function getChallengeFull(ip: string): Promise<{
    nonce: string;
    partition?: string;
    version?: string;
    compressed_ota?: boolean;
    sector_skip?: boolean;
    prog_vm?: boolean;
    has_factory?: boolean;
    is_stub?: boolean;
    flash_erases?: number;
  }> {
    const res = await fetch(`http://${ip}/api/challenge`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`challenge HTTP ${res.status}`);
    return (await res.json()) as {
      nonce: string;
      partition?: string;
      version?: string;
      compressed_ota?: boolean;
      sector_skip?: boolean;
      prog_vm?: boolean;
      has_factory?: boolean;
      is_stub?: boolean;
      flash_erases?: number;
    };
  }

export const balaxTelemetryBridgePlugin = telemetryBridgePlugin;
