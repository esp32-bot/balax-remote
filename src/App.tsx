import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActiveImuCalibration,
  CameraInputSettings,
  computeStickVector,
  createDefaultBalaXGains,
  DEFAULT_IMU_CALIBRATION,
  GainParam,
  HilCapture,
  parseImuStatusOutput,
  readSavedCameraInputSettings,
  RobotKinematicState,
  writeSavedCameraInputSettings,
} from "@g-ai/rc";
import type {
  GameLogLine,
  GameLogSizeChange,
  WindowTabDefinition,
} from "@g-ai/3d-ui";
import { createWindowWorkspaceState } from "@g-ai/3d-ui";
import { browserOverlayGeometry, browserOverlayLayout } from "@g-ai/3d-ui/browser";
import {
  GameLogOverlay,
  useGameLog,
  WindowOverlay,
} from "@g-ai/3d-ui/react";
import type { WindowOverlayLogSize } from "@g-ai/3d-ui/react";
import "@g-ai/3d-ui/windowing.css";
import "@g-ai/3d-ui/log.css";
import { BalaXBabylonScene } from "./BalaXBabylonScene";
import { CalibrationHilPanel } from "./CalibrationHilPanel";
import { OtaPanel } from "./OtaPanel";
import { ProgramsPanel } from "./ProgramsPanel";
import { CpuPanel, FlashPanel, RamPanel, RobotHealth, SystemSnapshot } from "./SystemMonitorPanels";
import type { FlashSnapshot } from "./flashProtocol";
import { TraceSample } from "./bxz1";

interface StreamMetrics {
  targetHz: number;
  actualPollHz: number;
  sampleRateHz: number;
  rttMs: number;
  avgRttMs: number;
  lastSampleAgeMs: number | null;
  pipelinedNonce: boolean;
  resolvedIp: string;
  resolvedVia: "ip" | "mdns" | "fallback";
  healthIntervalMs: number;
}

interface BridgeTraceResponse {
  robotIp: string;
  connected: boolean;
  telemetryAvailable?: boolean;
  lastAckTick: number;
  flashRevision?: number;
  totalSamplesReceived: number;
  totalBytesCompressed: number;
  health?: RobotHealth | null;
  streamMetrics?: StreamMetrics | null;
  samples: TraceSample[];
}

const RATE_PRESETS: ReadonlyArray<{ hz: number; label: string; title: string }> = [
  { hz: 2, label: "2 Hz", title: "Eco (lowest battery & heat)" },
  { hz: 5, label: "5 Hz", title: "Cool monitoring" },
  { hz: 10, label: "10 Hz", title: "Balanced" },
  { hz: 20, label: "20 Hz", title: "Smooth 3D motion (recommended)" },
  { hz: 30, label: "30 Hz", title: "Turbo / lowest latency" },
];

// Conservative M5StickC Plus LiPo thermal thresholds (no onboard battery thermistor)
const PMIC_WARN_C = 42;
const PMIC_HOT_C = 46;
const IMU_WARN_C = 52;
const IMU_HOT_C = 58;
const BATTERY_LOW_PCT = 30;

type BalaXTabId = "telemetry" | "calibrate" | "camera" | "cpu" | "ram" | "flash" | "ota" | "programs" | "tuning" | "console";

const TAB_DEFINITIONS: readonly WindowTabDefinition<BalaXTabId>[] = [
  { id: "telemetry", label: "Telemetry" },
  { id: "calibrate", label: "Calibrate & HIL" },
  { id: "camera", label: "Camera" },
  { id: "cpu", label: "CPU" },
  { id: "ram", label: "RAM" },
  { id: "flash", label: "Flash" },
  { id: "ota", label: "Firmware OTA" },
  { id: "programs", label: "Programs" },
  { id: "tuning", label: "Balance Gains" },
  { id: "console", label: "Console & Log" },
];

const WORKSPACE_STORAGE_KEY = "balax.window-workspace.v6";
const RESTORABLE_TABS = new Set(TAB_DEFINITIONS.map(({ id }) => id));
const OVERLAY_CONTEXT = {
  active: false,
  ready: true,
  baseOnlyTabs: new Set<BalaXTabId>(),
  contextOnlyTabs: new Set<BalaXTabId>(),
  entryTabId: "telemetry" as const,
};
const DEFAULT_WORKSPACE = JSON.stringify(createWindowWorkspaceState<BalaXTabId>({
  primary: { tabs: ["telemetry", "calibrate", "camera"], width: 450, height: 440 },
  secondary: { tabs: ["cpu", "ram", "flash", "ota", "programs", "tuning", "console"], width: 420, height: 380 },
}));
const WORKSPACE_STORAGE = {
  getItem: () => window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? DEFAULT_WORKSPACE,
  setItem: (_key: string, value: string) => window.localStorage.setItem(WORKSPACE_STORAGE_KEY, value),
};

function createLogSizePort(): WindowOverlayLogSize & { update(change: GameLogSizeChange): void } {
  let width: number | null = null;
  const listeners = new Set<(change: GameLogSizeChange) => void>();
  return {
    getWidth: () => width,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(change) {
      width = change.width;
      for (const listener of listeners) listener(change);
    },
  };
}

const RAD_TO_DEG = 180 / Math.PI;

export default function App() {
  const [targetHost, setTargetHost] = useState("balax.local");
  const [connected, setConnected] = useState(false);
  const [telemetryAvailable, setTelemetryAvailable] = useState(false);
  const [health, setHealth] = useState<RobotHealth | null>(null);
  const [streamMetrics, setStreamMetrics] = useState<StreamMetrics | null>(null);
  const [targetHz, setTargetHz] = useState<number>(20);
  const targetHzRef = useRef<number>(20);
  const pendingRate = useRef<number | null>(null);
  const rateRequestActive = useRef(false);
  const rateRevision = useRef(0);
  const [systemSnap, setSystemSnap] = useState<SystemSnapshot | null>(null);
  const [flashRevision, setFlashRevision] = useState<number | null>(null);
  const [flashSnapshot, setFlashSnapshot] = useState<FlashSnapshot | null>(null);
  const [flashRefresh, setFlashRefresh] = useState(0);
  const lastFlashRequest = useRef<{ revision: number | null; refresh: number } | null>(null);
  const [latest, setLatest] = useState<TraceSample | null>(null);
  const [kinematics, setKinematics] = useState<RobotKinematicState | null>(null);
  const [totalSamples, setTotalSamples] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [gains, setGains] = useState<GainParam[]>(() => [
    { name: "brightness", value: 50, min: 0, max: 100 },
    { name: "volume", value: 60, min: 0, max: 100 },
    ...createDefaultBalaXGains(),
  ]);
  const [cmdInput, setCmdInput] = useState("status");
  const [cmdOutput, setCmdOutput] = useState<string>("");
  const [zeroingImu, setZeroingImu] = useState(false);
  const [imuNotice, setImuNotice] = useState<string>("");
  const [resetPoseToken, setResetPoseToken] = useState(0);
  const [resetAllToken, setResetAllToken] = useState(0);
  const [activeCal, setActiveCal] = useState<ActiveImuCalibration>(DEFAULT_IMU_CALIBRATION);
  const [replayingName, setReplayingName] = useState<string | null>(null);
  const [replayLatest, setReplayLatest] = useState<TraceSample | null>(null);
  const replayHistoryRef = useRef<TraceSample[]>([]);
  const replayTimerRef = useRef<number | null>(null);
  const [cameraSettings, setCameraSettings] = useState<CameraInputSettings>(() =>
    readSavedCameraInputSettings()
  );

  const gameLog = useGameLog();
  const webGlWarningShown = useRef(false);
  const onWebGlUnavailable = () => {
    if (webGlWarningShown.current) return;
    webGlWarningShown.current = true;
    gameLog.print({ text: "WebGL unavailable. Telemetry and controls are still available.", tone: "warning" });
  };
  const thermalLineRef = useRef<GameLogLine | null>(null);
  const thermalLevelRef = useRef<"ok" | "warm" | "hot">("ok");
  const batteryLineRef = useRef<GameLogLine | null>(null);
  const prevConnectedRef = useRef<boolean | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const [logSize] = useState(createLogSizePort);
  const [overlayGeometry] = useState(() => browserOverlayGeometry(window, () => controlsRef.current?.getBoundingClientRect().top));
  const [overlayLayout] = useState(() => browserOverlayLayout(document.documentElement));
  const [presentation, setPresentation] = useState<"overlay" | "split">("overlay");
  const [tabVisibility, setTabVisibility] = useState<Partial<Record<BalaXTabId, boolean>>>({});
  const flashVisible = tabVisibility.flash === true;
  const systemVisible = tabVisibility.cpu === true || tabVisibility.ram === true;
  const onTabVisibility = useCallback((tab: BalaXTabId, visible: boolean) => {
    if (tab === "flash" || tab === "cpu" || tab === "ram" || tab === "telemetry") {
      setTabVisibility((current) => current[tab] === visible ? current : { ...current, [tab]: visible });
    }
  }, []);

  useEffect(() => {
    const controls = controlsRef.current;
    const app = appRef.current;
    if (!controls || !app) return;
    const measure = () => app.style.setProperty("--balax-controls-height", `${controls.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    return () => observer.disconnect();
  }, []);

  const historyRef = useRef<TraceSample[]>([]);
  const lastSeenTickRef = useRef<number>(0);
  const lastTraceFlashRevision = useRef<number | null>(null);
  const plotCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const updateCameraSettings = (patch: Partial<CameraInputSettings>) => {
    setCameraSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSavedCameraInputSettings(next);
      return next;
    });
  };

  const updateTargetRate = async (nextHz: number) => {
    const clamped = Math.max(1, Math.min(50, Math.round(nextHz)));
    setTargetHz(clamped);
    targetHzRef.current = clamped;
    pendingRate.current = clamped;
    if (rateRequestActive.current) return;
    rateRequestActive.current = true;
    try {
      while (pendingRate.current !== null) {
        const targetHz = pendingRate.current;
        pendingRate.current = null;
        try {
          const res = await fetch("/api/bridge/rate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetHz }),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = (await res.json()) as { streamMetrics?: StreamMetrics };
            if (data.streamMetrics) setStreamMetrics(data.streamMetrics);
          }
        } catch {
          // The next trace response reconciles the rate if the write failed.
        }
      }
    } finally {
      rateRevision.current += 1;
      rateRequestActive.current = false;
    }
  };

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      const t0 = performance.now();
      const rateAtStart = rateRevision.current;
      try {
        const res = await fetch(
          `/api/bridge/trace?since=${lastSeenTickRef.current}&limit=400`
        );
        if (!res.ok) throw new Error(`Bridge trace returned HTTP ${res.status}.`);
        const data = (await res.json()) as BridgeTraceResponse;
        if (!active) return;

        setConnected(data.connected);
        const canStream = data.connected && (data.telemetryAvailable ?? true);
        setTelemetryAvailable(canStream);
        setFlashRevision(data.flashRevision ?? null);
        const sessionChanged = data.flashRevision != null && lastTraceFlashRevision.current != null
          && data.flashRevision !== lastTraceFlashRevision.current;
        lastTraceFlashRevision.current = data.flashRevision ?? null;
        setHealth(data.connected ? (data.health ?? null) : null);
        if (data.streamMetrics) {
          setStreamMetrics(data.streamMetrics);
          if (!rateRequestActive.current && rateAtStart === rateRevision.current) {
            setTargetHz(data.streamMetrics.targetHz);
            targetHzRef.current = data.streamMetrics.targetHz;
          }
        }
        setTotalSamples(data.totalSamplesReceived);
        setTotalBytes(data.totalBytesCompressed);

        const tickReset = data.lastAckTick > 0 && lastSeenTickRef.current > 0 && data.lastAckTick < lastSeenTickRef.current;
        if (sessionChanged || tickReset) {
          lastSeenTickRef.current = 0;
          historyRef.current = [];
          setLatest(null);
        }

        if (!canStream) setLatest(null);
        if (canStream && data.samples.length > 0) {
          if (data.samples[0]!.tick < lastSeenTickRef.current) {
            lastSeenTickRef.current = 0;
            historyRef.current = [];
          }
          for (const s of data.samples) {
            if (s.tick > lastSeenTickRef.current) {
              historyRef.current.push(s);
              lastSeenTickRef.current = s.tick;
            }
          }
          if (historyRef.current.length > 1200) {
            historyRef.current.splice(0, historyRef.current.length - 1200);
          }
          setLatest(historyRef.current[historyRef.current.length - 1] ?? null);
        }
      } catch {
        if (active) {
          setConnected(false);
          setTelemetryAvailable(false);
          setHealth(null);
          setLatest(null);
        }
      }
      if (!active) return;
      const periodMs = Math.max(20, Math.min(500, Math.round(1000 / Math.max(1, targetHzRef.current))));
      const elapsed = performance.now() - t0;
      timer = window.setTimeout(() => void poll(), Math.max(10, Math.round(periodMs - elapsed)));
    };

    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!connected) {
      lastFlashRequest.current = null;
      setFlashSnapshot(null);
      return;
    }

    const previous = lastFlashRequest.current;
    const manual = previous !== null && previous.refresh !== flashRefresh;
    if (!flashVisible && previous !== null && previous.revision === flashRevision && !manual) return;
    lastFlashRequest.current = { revision: flashRevision, refresh: flashRefresh };

    const request = new AbortController();
    setFlashSnapshot(null);
    void (async () => {
      try {
        const res = await fetch("/api/bridge/flash?refresh=1", { signal: request.signal });
        if (!res.ok) throw new Error(`Flash inspection failed (HTTP ${res.status}).`);
        const snapshot = (await res.json()) as FlashSnapshot;
        if (!request.signal.aborted) setFlashSnapshot(snapshot);
      } catch (err) {
        if (request.signal.aborted) return;
        setFlashSnapshot({
          connected: true,
          revision: flashRevision ?? 0,
          status: "error",
          live: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => request.abort();
  }, [connected, flashRevision, flashVisible, flashRefresh]);

  // Poll CPU and RAM monitor history independently of the on-demand flash command.
  useEffect(() => {
    setSystemSnap(null);
    if (!connected || !systemVisible) return;
    let active = true;
    const pollSys = async () => {
      try {
        const res = await fetch("/api/bridge/system");
        if (!res.ok) return;
        const data = (await res.json()) as SystemSnapshot;
        if (active) setSystemSnap(data);
      } catch {
        // ignore transient poll error
      }
    };
    const timer = setInterval(() => void pollSys(), 2000);
    void pollSys();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connected, flashRevision, systemVisible]);

  // Draw 100 Hz telemetry strip chart (Pitch, Rate, Motor power)
  useEffect(() => {
    const canvas = plotCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#010409";
    ctx.fillRect(0, 0, w, h);

    // Zero line
    ctx.strokeStyle = "#21262d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const samples = historyRef.current.slice(-300);
    if (samples.length < 2) return;

    const drawSeries = (
      color: string,
      extract: (s: TraceSample) => number,
      scale: number
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      samples.forEach((s, idx) => {
        const x = (idx / (samples.length - 1)) * w;
        const y = h / 2 - (extract(s) / scale) * (h * 0.44);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries("#58a6ff", (s) => s.pitchDeg, 90); // Pitch (deg)
    drawSeries("#3fb950", (s) => s.motorL, 127); // Motor Left (-127..127)
    drawSeries("#d29922", (s) => s.pitchDps, 250); // Pitch rate (deg/s)
  }, [latest, tabVisibility.telemetry]);

  async function sendRobotCommand(cmd: string): Promise<string> {
    try {
      const res = await fetch("/api/bridge/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd }),
      });
      const text = (await res.text()).trim();
      setCmdOutput(text);
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCmdOutput(msg);
      return msg;
    }
  }

  async function refreshImuCalibration(): Promise<ActiveImuCalibration | null> {
    try {
      const out = await sendRobotCommand("imu");
      if (!out || out.toLowerCase().includes("error") || out.toLowerCase().includes("failed")) {
        return null;
      }
      const parsed = parseImuStatusOutput(out);
      setActiveCal(parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (connected) {
      void refreshImuCalibration();
    }
  }, [connected]);

  function stopReplay() {
    if (replayTimerRef.current !== null) {
      window.clearInterval(replayTimerRef.current);
      replayTimerRef.current = null;
    }
    replayHistoryRef.current = [];
    setReplayLatest(null);
    setReplayingName(null);
    setResetAllToken((n) => n + 1);
  }

  function startReplayCapture(cap: HilCapture) {
    stopReplay();
    if (!cap.samples.length) return;
    setReplayingName(cap.name);
    setResetAllToken((n) => n + 1);
    const rebased: TraceSample[] = cap.samples.map((sample, idx) => ({
      ...(sample as TraceSample),
      tick: idx + 1,
    }));
    let cursor = 0;
    replayTimerRef.current = window.setInterval(() => {
      const batchEnd = Math.min(rebased.length, cursor + 4);
      for (let i = cursor; i < batchEnd; i++) {
        replayHistoryRef.current.push(rebased[i]!);
      }
      if (replayHistoryRef.current.length > 120) {
        replayHistoryRef.current.splice(0, replayHistoryRef.current.length - 120);
      }
      cursor = batchEnd;
      setReplayLatest(rebased[cursor - 1] ?? null);
      if (cursor >= rebased.length) {
        if (replayTimerRef.current !== null) {
          window.clearInterval(replayTimerRef.current);
          replayTimerRef.current = null;
        }
        window.setTimeout(() => {
          setReplayingName(null);
          setReplayLatest(null);
          replayHistoryRef.current = [];
        }, 1200);
      }
    }, 40);
  }

  useEffect(() => {
    return () => {
      if (replayTimerRef.current !== null) {
        window.clearInterval(replayTimerRef.current);
      }
    };
  }, []);

  async function zeroImuAndSaveFlash() {
    if (zeroingImu) return;
    setZeroingImu(true);
    setImuNotice("Hold still (~1s)...");
    const line = gameLog.print({
      text: "Zeroing IMU — hold BalaX still (~1s)…",
      tone: "progress",
      progress: null,
    });
    try {
      const reply = await sendRobotCommand("imu zero");
      setResetAllToken((n) => n + 1);
      if (reply.toLowerCase().includes("saved")) {
        setImuNotice("Zeroed & saved to flash");
        line.update({ text: "IMU zeroed & saved to flash", tone: "success" });
        void refreshImuCalibration();
      } else {
        const msg = reply.slice(0, 64) || "Check console";
        setImuNotice(msg);
        line.update({ text: `IMU zero: ${msg}`, tone: "warning" });
      }
      setTimeout(() => setImuNotice(""), 4500);
    } finally {
      setZeroingImu(false);
    }
  }

  function centerSimPose() {
    setResetPoseToken((n) => n + 1);
    void sendRobotCommand("imu heading");
  }

  async function connectWifi() {
    lastSeenTickRef.current = 0;
    historyRef.current = [];
    setLatest(null);
    try {
      const res = await fetch("/api/bridge/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: targetHost }),
      });
      if (!res.ok) throw new Error(`Connect failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { lastError?: string };
      if (data.lastError) setCmdOutput(data.lastError);
    } catch (err) {
      setCmdOutput(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnectWifi() {
    try {
      const res = await fetch("/api/bridge/disconnect", { method: "POST" });
      if (!res.ok) throw new Error(`Disconnect failed (HTTP ${res.status}).`);
      setConnected(false);
      setTelemetryAvailable(false);
      setHealth(null);
      setLatest(null);
      setCmdOutput("Disconnected (robot telemetry stream stopped).");
    } catch (err) {
      setCmdOutput(err instanceof Error ? err.message : String(err));
    }
  }

  async function setScreenOff() {
    setGains((prev) =>
      prev.map((g) => (g.name === "brightness" ? { ...g, value: 0 } : g))
    );
    await sendRobotCommand("set brightness 0");
    gameLog.print({ text: "Display brightness set to 0% (LCD off)", tone: "info" });
  }

  function downloadSessionCsv() {
    window.open("/api/bridge/trace?limit=10000&format=csv", "_blank");
  }

  const bytesPerSample =
    totalSamples > 0 ? (totalBytes / totalSamples).toFixed(1) : "0.0";

  const pitchDegDisplay = kinematics
    ? kinematics.pitchRad * RAD_TO_DEG
    : latest?.pitchDeg ?? 0;
  const rollDegDisplay = kinematics ? kinematics.rollRad * RAD_TO_DEG : 0;
  const yawDegDisplay = kinematics
    ? kinematics.yawRad * RAD_TO_DEG
    : latest?.yawDeg ?? 0;

  const pmicC = health?.pmicC ?? null;
  const imuC = health?.imuC ?? null;
  const batteryPct = health?.batteryPct ?? null;
  const isOverheating =
    connected &&
    ((pmicC !== null && pmicC >= PMIC_HOT_C) || (imuC !== null && imuC >= IMU_HOT_C));
  const isWarm =
    connected &&
    !isOverheating &&
    ((pmicC !== null && pmicC >= PMIC_WARN_C) || (imuC !== null && imuC >= IMU_WARN_C));
  const isLowBattery =
    connected && batteryPct !== null && batteryPct < BATTERY_LOW_PCT;
  const thermalColor = isOverheating ? "#f85149" : isWarm ? "#d29922" : "#3fb950";

  // Route connection changes into the shared FOSS Earth floating log
  useEffect(() => {
    if (prevConnectedRef.current === null) {
      prevConnectedRef.current = connected;
      return;
    }
    if (prevConnectedRef.current === connected) return;
    prevConnectedRef.current = connected;
    if (connected) {
      gameLog.print({
        text: `Connected to ${targetHost} (${streamMetrics?.resolvedIp ?? targetHost})`,
        tone: "success",
      });
    } else {
      gameLog.print({
        text: `Disconnected from ${targetHost}`,
        tone: "info",
      });
    }
  }, [connected, targetHost, gameLog]);

  // Route thermal warnings into the shared FOSS Earth floating log (auto-fades to peek chip,
  // swipe-dismissable, and refreshes live temps silently without re-popping over the 3D scene).
  useEffect(() => {
    const level: "ok" | "warm" | "hot" = isOverheating ? "hot" : isWarm ? "warm" : "ok";
    const prevLevel = thermalLevelRef.current;

    if (level === "ok") {
      if (prevLevel !== "ok") {
        thermalLevelRef.current = "ok";
        if (thermalLineRef.current && !thermalLineRef.current.isRemoved?.()) {
          if (connected) {
            thermalLineRef.current.update({
              text: `BalaX cooled down (PMIC ${pmicC !== null ? `${pmicC.toFixed(1)}°C` : "—"} · IMU ${imuC !== null ? `${imuC.toFixed(1)}°C` : "—"})`,
              tone: "success",
            });
          } else {
            thermalLineRef.current.remove();
          }
        }
        thermalLineRef.current = null;
      }
      return;
    }

    const tempSummary = `PMIC ${pmicC !== null ? `${pmicC.toFixed(1)}°C` : "—"} · IMU ${imuC !== null ? `${imuC.toFixed(1)}°C` : "—"}`;
    const entry = {
      text:
        level === "hot"
          ? `Too hot (${tempSummary}) — cool down to protect sealed LiPo`
          : `Running warm (${tempSummary}) — dim screen or let cool soon`,
      tone: (level === "hot" ? "error" : "warning") as "error" | "warning",
      actions: [
        { label: "Screen Off (0%)", onClick: () => void setScreenOff() },
        ...(level === "hot"
          ? [{ label: "Disconnect", onClick: () => void disconnectWifi() }]
          : []),
      ],
    };

    const escalated = prevLevel !== level;
    thermalLevelRef.current = level;

    if (!thermalLineRef.current || thermalLineRef.current.isRemoved?.()) {
      // Only print a new line when entering warm/hot (don't re-spam if the user dismissed it)
      if (escalated) {
        thermalLineRef.current = gameLog.print(entry);
      }
    } else {
      thermalLineRef.current.update({ ...entry, silent: !escalated });
    }
  }, [connected, isOverheating, isWarm, pmicC, imuC, gameLog]);

  // Route low-battery alerts into the shared FOSS Earth floating log
  useEffect(() => {
    if (!isLowBattery || batteryPct === null) {
      if (batteryLineRef.current && !batteryLineRef.current.isRemoved?.()) {
        batteryLineRef.current.remove();
      }
      batteryLineRef.current = null;
      return;
    }
    const text = `Low battery (${batteryPct.toFixed(0)}%) — charge BalaX soon`;
    if (!batteryLineRef.current || batteryLineRef.current.isRemoved?.()) {
      batteryLineRef.current = gameLog.print({ text, tone: "warning" });
    } else {
      batteryLineRef.current.update({ text, tone: "warning", silent: true });
    }
  }, [isLowBattery, batteryPct, gameLog]);
  const actualPollHz = streamMetrics?.actualPollHz ?? 0;
  const effectiveTargetHz = targetHz;
  const rateRatio = effectiveTargetHz > 0 ? actualPollHz / effectiveTargetHz : 0;
  const rateColor = !telemetryAvailable
    ? "#8b949e"
    : rateRatio >= 0.78
      ? "#3fb950"
      : rateRatio >= 0.45
        ? "#d29922"
        : "#f85149";

  const renderTabContent = (tabId: BalaXTabId) => {
    switch (tabId) {
      case "telemetry":
        return (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "0.78rem",
                gap: 6,
              }}
            >
              <span>
                <strong style={{ color: "#58a6ff" }}>Pitch°</strong> ·{" "}
                <strong style={{ color: "#3fb950" }}>Motor</strong> ·{" "}
                <strong style={{ color: "#d29922" }}>Rate°/s</strong>
              </span>
              <span style={{ color: "var(--muted)" }}>
                #{latest?.tick ?? 0} · {bytesPerSample} B/s ·{" "}
                <strong style={{ color: kinematics?.isResting ? "#3fb950" : "#d29922" }}>
                  {kinematics?.isResting ? "REST" : "LIVE"}
                </strong>
              </span>
            </div>
            <canvas
              ref={plotCanvasRef}
              width={460}
              height={110}
              style={{ width: "100%", borderRadius: 6, border: "1px solid #21262d" }}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                fontSize: "0.75rem",
              }}
            >
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>State</div>
                <strong
                  style={{
                    color: latest?.state === "BALANCING" ? "#3fb950" : "#58a6ff",
                  }}
                >
                  {latest?.state ?? "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Pitch / Roll / Yaw</div>
                <strong>
                  {latest
                    ? `${pitchDegDisplay.toFixed(1)}° / ${rollDegDisplay.toFixed(1)}° / ${yawDegDisplay.toFixed(1)}°`
                    : "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Pos X/Y/Z (cm)</div>
                <strong>
                  {kinematics
                    ? `${(kinematics.posX * 100).toFixed(1)} / ${(kinematics.posY * 100).toFixed(1)} / ${(kinematics.posZ * 100).toFixed(1)}`
                    : "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Accel X/Y/Z (g)</div>
                <strong>
                  {latest
                    ? `${(latest.accelXG ?? 0).toFixed(2)} / ${(latest.accelYG ?? 0).toFixed(2)} / ${(latest.accelZG ?? 0).toFixed(2)}`
                    : "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Gyro X/Y/Z (°/s)</div>
                <strong>
                  {latest
                    ? `${(latest.gyroXDps ?? 0).toFixed(1)} / ${(latest.gyroYDps ?? 0).toFixed(1)} / ${(latest.gyroZDps ?? 0).toFixed(1)}`
                    : "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Motors L/R</div>
                <strong>
                  {latest?.motorL ?? 0} / {latest?.motorR ?? 0}
                </strong>
              </div>
              <div
                style={{
                  background: isOverheating
                    ? "rgba(248, 81, 73, 0.16)"
                    : isWarm
                      ? "rgba(210, 153, 34, 0.14)"
                      : "#0d1117",
                  border: isOverheating
                    ? "1px solid rgba(248, 81, 73, 0.65)"
                    : isWarm
                      ? "1px solid rgba(210, 153, 34, 0.5)"
                      : "1px solid transparent",
                  padding: "6px 8px",
                  borderRadius: 6,
                }}
              >
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>PMIC / IMU Temp</div>
                <strong style={{ color: health ? thermalColor : undefined }}>
                  {pmicC !== null || imuC !== null
                    ? `${pmicC !== null ? pmicC.toFixed(1) : "—"}° / ${imuC !== null ? imuC.toFixed(1) : "—"}°C`
                    : "—"}
                </strong>
              </div>
              <div
                style={{
                  background: isLowBattery ? "rgba(210, 153, 34, 0.14)" : "#0d1117",
                  border: isLowBattery ? "1px solid rgba(210, 153, 34, 0.5)" : "1px solid transparent",
                  padding: "6px 8px",
                  borderRadius: 6,
                }}
              >
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Battery / Draw</div>
                <strong style={{ color: isLowBattery ? "#d29922" : undefined }}>
                  {batteryPct !== null
                    ? `${batteryPct.toFixed(0)}%${health?.batteryMa !== null && health?.batteryMa !== undefined ? ` (${health.batteryMa > 0 ? "+" : ""}${health.batteryMa.toFixed(0)} mA)` : ""}`
                    : "—"}
                </strong>
              </div>
              <div style={{ background: "#0d1117", padding: "6px 8px", borderRadius: 6 }}>
                <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>CPU / Wi-Fi</div>
                <strong>
                  {health?.cpuMhz !== null && health?.cpuMhz !== undefined
                    ? `${health.cpuMhz.toFixed(0)} MHz${health.wifiPs ? ` · ${health.wifiPs}` : ""}`
                    : "—"}
                </strong>
              </div>
            </div>
            {/* Stream Update Rate Monitor & Target Rate Controls */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                borderRadius: 6,
                padding: "7px 9px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: "0.74rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, color: "#c9d1d9" }}>
                  Update Rate{" "}
                  <strong style={{ color: rateColor }}>
                    {telemetryAvailable ? `${actualPollHz.toFixed(1)} Hz` : "—"}
                  </strong>
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                    {" "}
                    / {effectiveTargetHz} Hz target
                  </span>
                </span>
                <span style={{ fontSize: "0.69rem", color: "var(--muted)" }}>
                  {connected && !telemetryAvailable ? "Live telemetry unavailable on this firmware" : streamMetrics ? (
                    <>
                      <strong style={{ color: streamMetrics.pipelinedNonce ? "#3fb950" : "#d29922" }}>
                        {streamMetrics.pipelinedNonce ? "1-RTT" : "2-RTT"}
                      </strong>
                      {" · "}
                      {streamMetrics.resolvedIp} ({streamMetrics.resolvedVia})
                    </>
                  ) : (
                    "Waiting for bridge..."
                  )}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                {RATE_PRESETS.map((p) => (
                  <button
                    key={p.hz}
                    className={targetHz === p.hz ? "primary" : undefined}
                    style={{ padding: "2px 7px", fontSize: "0.71rem" }}
                    title={p.title}
                    onClick={() => void updateTargetRate(p.hz)}
                  >
                    {p.label}
                  </button>
                ))}
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={targetHz}
                  onChange={(e) => void updateTargetRate(Number(e.target.value))}
                  style={{ flex: 1, minWidth: 72, accentColor: "#58a6ff" }}
                  title={`Target update rate: ${targetHz} Hz (1–50 Hz)`}
                />
                <span style={{ minWidth: 36, textAlign: "right", color: "#58a6ff", fontWeight: 600 }}>
                  {targetHz} Hz
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 6,
                  fontSize: "0.7rem",
                }}
              >
                <div>
                  <div style={{ color: "var(--muted)", fontSize: "0.65rem" }}>Poll Rate</div>
                  <strong style={{ color: rateColor }}>
                    {telemetryAvailable ? `${actualPollHz.toFixed(1)} Hz` : "—"}
                  </strong>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: "0.65rem" }}>IMU Samples</div>
                  <strong>
                    {telemetryAvailable && streamMetrics ? `${streamMetrics.sampleRateHz.toFixed(0)} sps` : "—"}
                  </strong>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: "0.65rem" }}>HTTP RTT</div>
                  <strong>
                    {telemetryAvailable && streamMetrics ? `${streamMetrics.avgRttMs.toFixed(0)} ms` : "—"}
                  </strong>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: "0.65rem" }}>Data Lag</div>
                  <strong
                    style={{
                      color:
                        streamMetrics?.lastSampleAgeMs != null && streamMetrics.lastSampleAgeMs > 500
                          ? "#f85149"
                          : undefined,
                    }}
                  >
                    {telemetryAvailable && streamMetrics?.lastSampleAgeMs != null
                      ? `${streamMetrics.lastSampleAgeMs} ms`
                      : "—"}
                  </strong>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="primary"
                disabled={zeroingImu}
                style={{ padding: "4px 10px", fontSize: "0.76rem" }}
                onClick={() => void zeroImuAndSaveFlash()}
                title="Sample 1s stationary IMU, save 6-axis bias to flash, and zero 3D pose"
              >
                {zeroingImu ? "Zeroing IMU..." : "Zero IMU (Save Flash)"}
              </button>
              <button
                style={{ padding: "4px 10px", fontSize: "0.76rem" }}
                onClick={centerSimPose}
                title="Recenter 3D position (X, Y, Z) and yaw heading without recalibrating flash"
              >
                Center Pose
              </button>
              {imuNotice && (
                <span style={{ fontSize: "0.73rem", color: "#58a6ff" }}>{imuNotice}</span>
              )}
            </div>
          </div>
        );

      case "calibrate":
        return (
          <CalibrationHilPanel
            connected={connected}
            latest={latest}
            historyRef={historyRef}
            activeCal={activeCal}
            onRefreshCal={refreshImuCalibration}
            onSendCmd={sendRobotCommand}
            onZeroImu={zeroImuAndSaveFlash}
            onCalibrationApplied={(cal) => {
              setActiveCal(cal);
              setResetAllToken((n) => n + 1);
            }}
            onReplayCapture={startReplayCapture}
            replayingName={replayingName}
            onStopReplay={stopReplay}
          />
        );

      case "camera":
        return (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.82rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Input Mode</span>
              <div style={{ display: "flex", gap: 6 }}>
                {(["trackpad", "mouse"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cameraSettings.mode === m ? "primary" : undefined}
                    style={{ padding: "4px 10px", fontSize: "0.78rem" }}
                    onClick={() => updateCameraSettings({ mode: m })}
                  >
                    {m === "trackpad" ? "Trackpad" : "Mouse"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 48px", gap: 8, alignItems: "center" }}>
              <span>Glide Inertia</span>
              <input
                type="range"
                min={0}
                max={0.95}
                step={0.01}
                value={cameraSettings.glideDecay}
                onChange={(e) => updateCameraSettings({ glideDecay: Number(e.target.value) })}
              />
              <span>{Math.round(cameraSettings.glideDecay * 100)}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 48px", gap: 8, alignItems: "center" }}>
              <span>Orbit Speed</span>
              <input
                type="range"
                min={0.3}
                max={2.5}
                step={0.1}
                value={cameraSettings.dragSensitivity}
                onChange={(e) => updateCameraSettings({ dragSensitivity: Number(e.target.value) })}
              />
              <span>{cameraSettings.dragSensitivity.toFixed(1)}×</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 48px", gap: 8, alignItems: "center" }}>
              <span>Zoom Speed</span>
              <input
                type="range"
                min={0.3}
                max={2.5}
                step={0.1}
                value={cameraSettings.zoomSensitivity}
                onChange={(e) => updateCameraSettings({ zoomSensitivity: Number(e.target.value) })}
              />
              <span>{cameraSettings.zoomSensitivity.toFixed(1)}×</span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={cameraSettings.invertYaw}
                  onChange={(e) => updateCameraSettings({ invertYaw: e.target.checked })}
                />
                Invert Yaw
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={cameraSettings.invertPitch}
                  onChange={(e) => updateCameraSettings({ invertPitch: e.target.checked })}
                />
                Invert Pitch
              </label>
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.74rem", lineHeight: 1.35 }}>
              Trackpad: two-finger swipe orbits, pinch or Option/Alt+swipe zooms with FOSS Earth inertial glide.
            </div>
          </div>
        );

      case "tuning":
        return (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "0.82rem" }}>Live Balance Gains, Screen & Volume</strong>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  style={{ fontSize: "0.74rem", padding: "3px 8px" }}
                  onClick={() => void sendRobotCommand("beep")}
                >
                  Beep
                </button>
                <button
                  className="primary"
                  style={{ fontSize: "0.74rem", padding: "3px 10px" }}
                  onClick={() => void sendRobotCommand("save")}
                >
                  Save to NVS
                </button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {gains.map((g, idx) => (
                <div
                  key={g.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "92px 1fr 56px",
                    gap: 8,
                    alignItems: "center",
                    fontSize: "0.78rem",
                  }}
                >
                  <span>{g.name}</span>
                  <input
                    type="range"
                    min={g.min}
                    max={g.max}
                    step={g.name === "brightness" || g.name === "volume" ? 1 : g.max - g.min <= 100 ? 0.1 : 1}
                    value={g.value}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      const next = [...gains];
                      next[idx] = { ...g, value: val };
                      setGains(next);
                      void sendRobotCommand(`set ${g.name} ${val}`);
                    }}
                  />
                  <span>{g.value}</span>
                </div>
              ))}
            </div>
          </div>
        );

      case "console":
        return (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && cmdInput.trim()) {
                    void sendRobotCommand(cmdInput.trim());
                  }
                }}
                placeholder="Command (e.g. probe cpu_mhz pmic_c, status, imu)"
                style={{ flex: 1, fontSize: "0.8rem" }}
              />
              <button
                className="primary"
                style={{ padding: "4px 10px", fontSize: "0.78rem" }}
                onClick={() => {
                  if (cmdInput.trim()) void sendRobotCommand(cmdInput.trim());
                }}
              >
                Run
              </button>
              <button
                style={{ padding: "4px 10px", fontSize: "0.78rem" }}
                onClick={downloadSessionCsv}
              >
                CSV
              </button>
            </div>
            <div style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
              Buffered: {totalSamples.toLocaleString()} samples ({(totalBytes / 1024).toFixed(1)} KB BXZ2)
            </div>
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: "#010409",
                border: "1px solid #21262d",
                borderRadius: 6,
                fontSize: "0.74rem",
                color: "#c9d1d9",
                minHeight: 120,
                maxHeight: 220,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {cmdOutput || "Ready. Run `status`, `imu`, or `imu zero`."}
            </pre>
          </div>
        );

      case "cpu":
        return (
          <CpuPanel
            connected={connected}
            system={connected ? systemSnap : null}
            onSendCmd={(c) => void sendRobotCommand(c)}
            onScreenOff={() => void setScreenOff()}
          />
        );

      case "ram":
        return (
          <RamPanel
            connected={connected}
            system={connected ? systemSnap : null}
            onSendCmd={(c) => void sendRobotCommand(c)}
          />
        );

      case "flash":
        return (
          <FlashPanel
            connected={connected}
            response={flashRevision == null || flashSnapshot?.revision === flashRevision ? flashSnapshot : null}
            health={health}
            onRefresh={() => setFlashRefresh((n) => n + 1)}
            onSendCmd={(c) => void sendRobotCommand(c)}
          />
        );

      case "ota":
        return (
          <OtaPanel
            connected={connected}
            health={health}
            targetHost={targetHost}
          />
        );

      case "programs":
        return <ProgramsPanel connected={connected} />;
    }
  };

  return (
    <div ref={appRef} style={{ position: "fixed", inset: 0, background: "#010409", overflow: "hidden" }}>
      <BalaXBabylonScene
        latest={replayingName ? replayLatest : latest}
        history={replayingName ? replayHistoryRef.current : historyRef.current}
        cameraSettings={cameraSettings}
        resetPoseToken={resetPoseToken}
        resetAllToken={resetAllToken}
        leverArmM={activeCal.leverArmM}
        onKinematics={setKinematics}
        onWebGlUnavailable={onWebGlUnavailable}
      />

      <GameLogOverlay controller={gameLog} ariaLabel="BalaX activity log" className="balax-game-log" onSize={logSize.update} />
      <WindowOverlay<BalaXTabId>
        tabDefinitions={TAB_DEFINITIONS}
        renderTabContent={renderTabContent}
        context={OVERLAY_CONTEXT}
        restorableTabs={RESTORABLE_TABS}
        storage={WORKSPACE_STORAGE}
        geometry={overlayGeometry}
        logSize={logSize}
        layoutPort={overlayLayout}
        onTabVisibility={onTabVisibility}
        presentation={{ choice: presentation, onChoice: setPresentation, edges: "inset" }}
      />

      <div className="balax-controls" ref={controlsRef}>
        <div className="balax-hud">
          <span
            className={`badge ${connected ? "online" : "offline"}`}
            style={
              connected
                ? { borderColor: rateColor, color: rateColor }
                : undefined
            }
            title={
              telemetryAvailable && streamMetrics
                ? `Live poll ${actualPollHz.toFixed(1)}/${effectiveTargetHz} Hz · IMU ${streamMetrics.sampleRateHz.toFixed(0)} sps · RTT ${streamMetrics.avgRttMs.toFixed(0)} ms (${streamMetrics.pipelinedNonce ? "1-RTT" : "2-RTT"}) · ${streamMetrics.resolvedIp} (${streamMetrics.resolvedVia})`
                : connected ? "Robot connected. Live telemetry unavailable." : "Robot offline"
            }
          >
            {telemetryAvailable ? `${actualPollHz.toFixed(1)} Hz · ${streamMetrics ? `${streamMetrics.avgRttMs.toFixed(0)}ms` : "LIVE"}`
              : connected ? "CONNECTED" : "OFFLINE"}
          </span>
          <input
            value={targetHost}
            onChange={(e) => setTargetHost(e.target.value)}
            disabled={connected}
            aria-label="Robot hostname"
            placeholder="balax.local"
            style={{ width: 115, padding: "4px 8px", fontSize: "0.78rem", opacity: connected ? 0.72 : 1 }}
          />
          <button
            className={connected ? "danger" : "primary"}
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={() => void (connected ? disconnectWifi() : connectWifi())}
            title={
              connected
                ? "Disconnect bridge and stop 100 Hz telemetry stream to save robot battery & heat"
                : "Connect to robot over Wi-Fi"
            }
          >
            {connected ? "Disconnect" : "Connect"}
          </button>
          <button
            className="primary"
            disabled={zeroingImu}
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={() => void zeroImuAndSaveFlash()}
            title="Zero 6-axis IMU biases (hold still ~1s) and save permanently to NVS flash"
          >
            {zeroingImu ? "Zeroing..." : "Zero IMU"}
          </button>
          <button
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={centerSimPose}
            title="Recenter 3D pose (X, Y, Z & yaw) without recalibrating flash"
          >
            Center
          </button>
          <button
            className="success"
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={() => void sendRobotCommand("arm")}
          >
            ARM
          </button>
          <button
            className="danger"
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={() => void sendRobotCommand("disarm")}
          >
            DISARM
          </button>
          <button
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            onClick={() => void sendRobotCommand("takeoff")}
          >
            Takeoff
          </button>
          {connected && <span style={{ color: "var(--muted)", marginLeft: 4 }}>
            <strong>{latest?.state ?? "—"}</strong> · P{" "}
            <strong>{latest ? `${pitchDegDisplay.toFixed(1)}°` : "—"}</strong> R{" "}
            <strong>{latest ? `${rollDegDisplay.toFixed(1)}°` : "—"}</strong> Y{" "}
            <strong>{latest ? `${yawDegDisplay.toFixed(1)}°` : "—"}</strong>
            {health && (pmicC !== null || imuC !== null) && (
              <>
                {" · "}
                <strong style={{ color: thermalColor }}>
                  {pmicC !== null ? `${pmicC.toFixed(0)}°` : "—"}
                  {imuC !== null ? `/${imuC.toFixed(0)}°C` : "C"}
                </strong>
              </>
            )}
            {batteryPct !== null && (
              <>
                {" · "}
                <strong style={{ color: isLowBattery ? "#d29922" : "#3fb950" }}>
                  {batteryPct.toFixed(0)}%
                </strong>
              </>
            )}
          </span>}
          {imuNotice && <span style={{ color: "var(--muted)" }}>{imuNotice}</span>}
        </div>

        {/* Touch Joystick Pad in bottom-right corner */}
        <div
          className="balax-joystick"
          style={{
            borderRadius: "50%",
            background: "rgba(8, 15, 27, 0.88)",
            border: "1px solid rgba(148, 163, 184, 0.3)",
            backdropFilter: "blur(12px)",
            touchAction: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.72rem",
            color: "var(--muted)",
            userSelect: "none",
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const rect = e.currentTarget.getBoundingClientRect();
            setOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
          onPointerMove={(e) => {
            if (!origin) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setStick(
              computeStickVector(
                origin.x,
                origin.y,
                e.clientX - rect.left,
                e.clientY - rect.top,
                44
              )
            );
          }}
          onPointerUp={() => {
            setOrigin(null);
            setStick({ x: 0, y: 0 });
          }}
          onLostPointerCapture={() => {
            setOrigin(null);
            setStick({ x: 0, y: 0 });
          }}
        >
          Drive {(stick.y * 100).toFixed(0)}% / {(stick.x * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}
