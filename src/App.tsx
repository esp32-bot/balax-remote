import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActiveImuCalibration,
  CameraInputSettings,
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
import { CommunicationsPanel } from "./CommunicationsPanel";
import { ControlLabPanel } from "./ControlLabPanel";
import { DualMotorDrivePad, type DriveStickCommand } from "./DualMotorDrivePad";
import { OtaPanel } from "./OtaPanel";
import { ProgramsPanel } from "./ProgramsPanel";
import { FpvCamPanel } from "./FpvCamPanel";
import { useCameraSetting, useCameraStatus } from "./cameraStatus";
import { detectRuntimeMode, getRuntimeMode, hasWebSerial, subscribeRuntimeMode } from "./runtimeMode";
import { webSerialCam } from "./webSerialCam";
import { webSerialStickC, type WebSerialStickCState } from "./webSerialStickC";
import { CAMERA_SETTING, DEFAULT_CAMERA_HOST, type CameraTransport } from "./cameraSettings";
import { DeviceControlGroup } from "./DeviceControlGroup";
import {
  resolveCamComm,
  resolveCamStateDisplay,
  resolveStickCComm,
  resolveStickCStateDisplay,
  type CamCommChoice,
  type CamStateChoice,
  type StickCCommChoice,
  type StickCStateChoice,
} from "./deviceControls";
import { CameraSystemMonitor, CpuPanel, FlashPanel, RamPanel, RobotHealth, SystemSnapshot } from "./SystemMonitorPanels";
import type { FlashSnapshot } from "./flashProtocol";
import type { OtaJobSnapshot } from "./otaProtocol";
import { TraceSample } from "./bxz1";
import { migrateWorkspaceV9 } from "./workspaceMigration";

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

type PowerModeState = "awake" | "wifi-sleep" | "usb-sleep" | "unknown";

interface BridgeTraceResponse {
  robotIp: string;
  connected: boolean;
  powerMode?: PowerModeState;
  usbAvailable?: boolean;
  usbPort?: string | null;
  telemetryAvailable?: boolean;
  lastAckTick: number;
  flashRevision?: number;
  totalSamplesReceived: number;
  totalBytesCompressed: number;
  health?: RobotHealth | null;
  otaJob?: OtaJobSnapshot | null;
  lastDrive?: { forward: number; turn: number; atMs: number } | null;
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

type BalaXTabId = "telemetry" | "control" | "comms" | "calibrate" | "camera" | "view3d" | "cpu" | "ram" | "flash" | "ota" | "programs" | "tuning" | "console";

const TAB_DEFINITIONS: readonly WindowTabDefinition<BalaXTabId>[] = [
  { id: "telemetry", label: "Telemetry" },
  { id: "control", label: "Control" },
  { id: "comms", label: "Network" },
  { id: "calibrate", label: "Calibrate & HIL" },
  { id: "camera", label: "Camera" },
  { id: "view3d", label: "3D View" },
  { id: "cpu", label: "CPU" },
  { id: "ram", label: "RAM" },
  { id: "flash", label: "Flash" },
  { id: "ota", label: "Firmware OTA" },
  { id: "programs", label: "Programs" },
  { id: "tuning", label: "Balance Gains" },
  { id: "console", label: "Console & Log" },
];

const WORKSPACE_STORAGE_KEY = "balax.window-workspace.v10";
const LEGACY_WORKSPACE_STORAGE_KEY = "balax.window-workspace.v9";
const RESTORABLE_TABS = new Set(TAB_DEFINITIONS.map(({ id }) => id));
const OVERLAY_CONTEXT = {
  active: false,
  ready: true,
  baseOnlyTabs: new Set<BalaXTabId>(),
  contextOnlyTabs: new Set<BalaXTabId>(),
  entryTabId: "telemetry" as const,
};
const DEFAULT_WORKSPACE = JSON.stringify(createWindowWorkspaceState<BalaXTabId>({
  primary: { tabs: ["telemetry", "control", "camera", "calibrate", "view3d"], width: 450, height: 480 },
  secondary: { tabs: ["comms", "cpu", "ram", "flash", "ota", "programs", "tuning", "console"], width: 440, height: 420 },
}));
const WORKSPACE_STORAGE = {
  getItem: () => window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    ?? migrateWorkspaceV9(window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY))
    ?? DEFAULT_WORKSPACE,
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
  const [powerMode, setPowerMode] = useState<PowerModeState>("unknown");
  const [usbAvailable, setUsbAvailable] = useState(false);
  const [usbPort, setUsbPort] = useState<string | null>(null);
  const [stickCCommChoice, setStickCCommChoice] = useState<StickCCommChoice>("auto");
  const [stickCForcedState, setStickCForcedState] = useState<StickCStateChoice>("auto");
  const [powerBusy, setPowerBusy] = useState(false);
  const [camForcedState, setCamForcedState] = useState<CamStateChoice>("auto");
  const [camBusy, setCamBusy] = useState(false);
  const [telemetryAvailable, setTelemetryAvailable] = useState(false);
  const [health, setHealth] = useState<RobotHealth | null>(null);
  const [otaJob, setOtaJob] = useState<OtaJobSnapshot | null>(null);
  const otaJobRef = useRef<OtaJobSnapshot | null>(null);
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
  const driveCmdRef = useRef<DriveStickCommand>({ forward: 0, turn: 0 });
  const [remoteStick, setRemoteStick] = useState<DriveStickCommand | null>(null);
  const lastDriveSentMsRef = useRef(0);
  const driveKeepaliveRef = useRef<number | null>(null);
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
  const otaLineRef = useRef<GameLogLine | null>(null);
  const otaLineJobIdRef = useRef<string | null>(null);
  const otaTerminalLoggedRef = useRef<string | null>(null);
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
    if (tab === "camera" || tab === "flash" || tab === "cpu" || tab === "ram" || tab === "telemetry" || tab === "comms") {
      setTabVisibility((current) => current[tab] === visible ? current : { ...current, [tab]: visible });
    }
  }, []);
  const onCameraNotice = useCallback((text: string, tone: "info" | "warning" | "error" = "info") => {
    gameLog.print({ text, tone });
  }, [gameLog]);
  const runtimeMode = useSyncExternalStore(subscribeRuntimeMode, getRuntimeMode);
  const [stickCSerial, setStickCSerial] = useState<WebSerialStickCState>(() => webSerialStickC.getState());
  useEffect(() => {
    void detectRuntimeMode();
    return webSerialStickC.subscribe(setStickCSerial);
  }, []);
  const camera = useCameraStatus(tabVisibility.camera === true || systemVisible || flashVisible, onCameraNotice);
  const camTransport = useCameraSetting<CameraTransport>(camera.settings, CAMERA_SETTING.transport);
  const camHostValue = useCameraSetting<string>(camera.settings, CAMERA_SETTING.host);
  const cameraStatus = camera.status?.powerMode === "sleep"
    || (camera.receivedAtMs != null && Date.now() - camera.receivedAtMs < 10500)
    ? camera.status : null;

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
    if (getRuntimeMode() === "standalone") return;
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
    if (runtimeMode === "standalone") return;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      const mode = await detectRuntimeMode();
      if (!active || mode !== "bridge") return;
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
        if (data.powerMode) setPowerMode(data.powerMode);
        if (typeof data.usbAvailable === "boolean") setUsbAvailable(data.usbAvailable);
        if (data.usbPort !== undefined) setUsbPort(data.usbPort ?? null);
        const canStream = data.connected && (data.telemetryAvailable ?? true);
        setTelemetryAvailable(canStream);
        setFlashRevision(data.flashRevision ?? null);
        const sessionChanged = data.flashRevision != null && lastTraceFlashRevision.current != null
          && data.flashRevision !== lastTraceFlashRevision.current;
        lastTraceFlashRevision.current = data.flashRevision ?? null;
        setHealth((data.connected || data.powerMode === "wifi-sleep") ? (data.health ?? null) : null);
        const nextOta = data.otaJob ?? null;
        otaJobRef.current = nextOta;
        setOtaJob(nextOta);
        setRemoteStick(data.connected && data.lastDrive ? { forward: data.lastDrive.forward, turn: data.lastDrive.turn } : null);
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
  }, [runtimeMode]);

  useEffect(() => {
    if (!connected || runtimeMode !== "bridge") {
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
  }, [connected, flashRevision, flashVisible, flashRefresh, runtimeMode]);

  // Poll CPU and RAM monitor history independently of the on-demand flash command.
  useEffect(() => {
    setSystemSnap(null);
    if (!connected || !systemVisible || runtimeMode !== "bridge") return;
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
  }, [connected, flashRevision, systemVisible, runtimeMode]);

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

  const postDriveCommand = useCallback(async (cmd: DriveStickCommand) => {
    if (getRuntimeMode() !== "bridge") return;
    try {
      await fetch("/api/bridge/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
    } catch {
      // ignore transient LAN hiccups during continuous driving
    }
  }, []);

  const handleDriveStickChange = useCallback(
    (cmd: DriveStickCommand) => {
      driveCmdRef.current = cmd;
      const isZero = Math.abs(cmd.forward) < 0.001 && Math.abs(cmd.turn) < 0.001;
      const now = performance.now();
      if (isZero) {
        if (driveKeepaliveRef.current !== null) {
          window.clearInterval(driveKeepaliveRef.current);
          driveKeepaliveRef.current = null;
        }
        lastDriveSentMsRef.current = now;
        if (connected) void postDriveCommand({ forward: 0, turn: 0 });
        return;
      }
      if (!connected) return;
      if (now - lastDriveSentMsRef.current >= 45) {
        lastDriveSentMsRef.current = now;
        void postDriveCommand(cmd);
      }
      if (driveKeepaliveRef.current === null) {
        driveKeepaliveRef.current = window.setInterval(() => {
          const cur = driveCmdRef.current;
          if (Math.abs(cur.forward) < 0.001 && Math.abs(cur.turn) < 0.001) {
            if (driveKeepaliveRef.current !== null) {
              window.clearInterval(driveKeepaliveRef.current);
              driveKeepaliveRef.current = null;
            }
            return;
          }
          lastDriveSentMsRef.current = performance.now();
          void postDriveCommand(cur);
        }, 60);
      }
    },
    [connected, postDriveCommand]
  );

  useEffect(() => {
    if (!connected && driveKeepaliveRef.current !== null) {
      window.clearInterval(driveKeepaliveRef.current);
      driveKeepaliveRef.current = null;
      driveCmdRef.current = { forward: 0, turn: 0 };
    }
    return () => {
      if (driveKeepaliveRef.current !== null) {
        window.clearInterval(driveKeepaliveRef.current);
        driveKeepaliveRef.current = null;
      }
    };
  }, [connected]);

  async function sendRobotCommand(cmd: string): Promise<string> {
    try {
      if (webSerialStickC.isConnected()) {
        const text = (await webSerialStickC.sendCommand(cmd)).trim();
        setCmdOutput(text || "(ok)");
        return text;
      }
      if (getRuntimeMode() === "standalone") {
        const msg = "Connect StickC over USB (Web Serial) or run the local bridge for Wi-Fi LAN.";
        setCmdOutput(msg);
        return msg;
      }
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
    if (getRuntimeMode() === "standalone") {
      const msg = "Standalone GitHub Pages mode uses browser Web Serial (USB). Run `npm run dev` locally for Wi-Fi LAN bridge.";
      setCmdOutput(msg);
      gameLog.print({ text: msg, tone: "info" });
      return;
    }
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
    if (webSerialStickC.isConnected()) {
      await webSerialStickC.disconnect();
      setCmdOutput("Disconnected StickC USB (Web Serial).");
      gameLog.print({ text: "Disconnected StickC USB (Web Serial).", tone: "info" });
      if (getRuntimeMode() === "standalone") return;
    }
    if (getRuntimeMode() === "standalone") return;
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

  async function setRobotPower(mode: "wifi-sleep" | "usb-sleep" | "wake", via: "lan" | "usb" = "lan") {
    if (powerBusy) return;
    setPowerBusy(true);
    try {
      if (webSerialStickC.isConnected() || getRuntimeMode() === "standalone") {
        if (mode === "wake") {
          const msg = await webSerialStickC.wake();
          setPowerMode("awake");
          setCmdOutput(msg);
          gameLog.print({ text: msg, tone: "info" });
          return;
        }
        if (!webSerialStickC.isConnected()) {
          await webSerialStickC.connect();
        }
        const out = await webSerialStickC.sendCommand(mode === "usb-sleep" ? "usb-sleep" : "sleep");
        setPowerMode(mode);
        const summary = mode === "usb-sleep"
          ? "BalaX entered usb-sleep over Web Serial"
          : "BalaX entered wifi-sleep over Web Serial";
        setCmdOutput(out || summary);
        gameLog.print({ text: summary, tone: "info" });
        return;
      }
      const res = await fetch("/api/bridge/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, via }),
      });
      const data = (await res.json()) as { ok?: boolean; powerMode?: PowerModeState; output?: string; error?: string };
      if (!res.ok || !data.ok) {
        const msg = data.error ?? `Power ${mode} failed (HTTP ${res.status}).`;
        setCmdOutput(msg);
        gameLog.print({ text: msg, tone: "error" });
        return;
      }
      if (data.powerMode) setPowerMode(data.powerMode);
      if (mode === "wifi-sleep" || mode === "usb-sleep") {
        setConnected(false);
        setTelemetryAvailable(false);
        setHealth(null);
        setLatest(null);
      }
      const summary =
        mode === "wifi-sleep"
          ? "BalaX entered wifi-sleep (faint 4s LED pulse; bridge paused)"
          : mode === "usb-sleep"
            ? "BalaX entered usb-sleep (ultra-dim 10s LED; auto-switches to wifi-sleep on unplug)"
            : via === "usb"
              ? "Pulsed USB reset — BalaX is waking..."
              : "Waking BalaX over Wi-Fi...";
      setCmdOutput(data.output || summary);
      gameLog.print({ text: summary, tone: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCmdOutput(msg);
      gameLog.print({ text: msg, tone: "error" });
    } finally {
      setPowerBusy(false);
    }
  }

  async function handleStickCCommSelect(next: StickCCommChoice) {
    setStickCCommChoice(next);
    if (next === "usb" && (getRuntimeMode() === "standalone" || !usbAvailable) && !webSerialStickC.isConnected()) {
      if (!hasWebSerial()) {
        gameLog.print({ text: "Browser Web Serial requires Chrome or Edge over HTTPS/localhost.", tone: "warning" });
        return;
      }
      setPowerBusy(true);
      try {
        const st = await webSerialStickC.connect();
        gameLog.print({ text: `Connected StickC USB (${st.portLabel ?? "Web Serial"}).`, tone: "info" });
      } catch (err) {
        gameLog.print({ text: `StickC USB: ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
      } finally {
        setPowerBusy(false);
      }
    } else if (next === "wifi" && getRuntimeMode() === "standalone") {
      gameLog.print({ text: "Wi-Fi LAN bridge requires local `npm run dev`. Use USB (Web Serial) on GitHub Pages.", tone: "info" });
    }
  }

  async function handleStickCStateSelect(next: StickCStateChoice, activeComm: "wifi" | "usb") {
    setStickCForcedState(next);
    if (next === "auto") return;
    if (getRuntimeMode() === "standalone" || webSerialStickC.isConnected()) {
      if (next === "awake") {
        if (!webSerialStickC.isConnected()) {
          setPowerBusy(true);
          try {
            const st = await webSerialStickC.connect();
            gameLog.print({ text: `Connected StickC USB (${st.portLabel ?? "Web Serial"}).`, tone: "info" });
          } catch (err) {
            gameLog.print({ text: `StickC USB: ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
          } finally {
            setPowerBusy(false);
          }
        } else {
          await setRobotPower("wake", "usb");
        }
        return;
      }
      if (next === "wifi-sleep" || next === "usb-sleep") {
        await setRobotPower(next, "usb");
        return;
      }
      await disconnectWifi();
      return;
    }
    if (next === "awake") {
      if (connected) return;
      if (powerMode === "wifi-sleep" && activeComm !== "usb") {
        await setRobotPower("wake", "lan");
      } else if (activeComm === "usb" && usbAvailable) {
        await setRobotPower("wake", "usb");
      } else {
        await connectWifi();
      }
      return;
    }
    if (next === "wifi-sleep") {
      await setRobotPower("wifi-sleep", "lan");
      return;
    }
    if (next === "usb-sleep") {
      await setRobotPower("usb-sleep", connected ? "lan" : "usb");
      return;
    }
    await disconnectWifi();
  }

  async function postCamBridge<T extends { ok?: boolean; message?: string; error?: string }>(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const query = new URLSearchParams({ host: camera.host });
    const res = await fetch(`/api/bridge/cam/${action}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as T;
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? data.message ?? `Camera bridge returned HTTP ${res.status}`);
    }
    return data;
  }

  async function handleCamCommSelect(next: CamCommChoice) {
    camera.settings.set(CAMERA_SETTING.transport, next);
    if (camBusy) return;
    setCamBusy(true);
    try {
      const standalone = getRuntimeMode() === "standalone";
      if (standalone || (next === "usb" && !cameraStatus?.usbPort && !camera.directUsbConnected)) {
        if (next === "usb" || (next === "auto" && standalone)) {
          if (!webSerialCam.isConnected()) {
            await camera.connectDirectUsb();
          }
        } else if (standalone) {
          gameLog.print({
            text: "Wi-Fi UDP/HTTP stream requires the local dev bridge (`npm run dev`). Use USB (Web Serial) on GitHub Pages.",
            tone: "info",
          });
        }
        return;
      }
      if (next !== "usb" && camera.directUsbConnected) {
        await camera.disconnectDirectUsb();
      }
      await postCamBridge("transport", { transport: next });
      await camera.fetchStatus(false);
    } catch (err) {
      gameLog.print({
        text: `ESP32-CAM transport: ${err instanceof Error ? err.message : String(err)}`,
        tone: "error",
      });
    } finally {
      setCamBusy(false);
    }
  }

  async function handleCamStateSelect(next: CamStateChoice) {
    setCamForcedState(next);
    if (next === "auto") return;
    if (camBusy) return;
    setCamBusy(true);
    try {
      if (camera.directUsbConnected || getRuntimeMode() === "standalone") {
        if (!webSerialCam.isConnected() && next !== "sleep") {
          await camera.connectDirectUsb();
        }
        if (next === "streaming") {
          if (cameraStatus?.powerMode === "sleep") {
            const wakeRes = await webSerialCam.setPower("wake");
            if (wakeRes.message) gameLog.print({ text: wakeRes.message, tone: "info" });
          }
          await webSerialCam.startStream();
          camera.setStreaming(true);
        } else if (next === "idle") {
          const res = await webSerialCam.setPower("idle");
          camera.setStreaming(false);
          gameLog.print({ text: res.message || "ESP32-CAM switched to Cool Idle.", tone: "info" });
        } else if (next === "sleep") {
          const res = await webSerialCam.setPower("sleep");
          camera.setStreaming(false);
          gameLog.print({ text: res.message || "ESP32-CAM entered Deep Sleep.", tone: "info" });
        }
        return;
      }
      const via = camTransport === "usb" ? "usb" : "auto";
      if (next === "streaming") {
        if (cameraStatus?.powerMode === "sleep") {
          const wakeRes = await postCamBridge("power", { mode: "wake", via });
          if (wakeRes.message) gameLog.print({ text: wakeRes.message, tone: "info" });
        }
        await postCamBridge("start", { transport: camTransport });
        camera.setStreaming(true);
        await camera.fetchStatus(false);
      } else if (next === "idle") {
        const res = await postCamBridge("power", { mode: "idle", via });
        camera.setStreaming(false);
        gameLog.print({ text: res.message ?? "ESP32-CAM switched to Cool Idle.", tone: "info" });
        await camera.fetchStatus(false);
      } else if (next === "sleep") {
        const res = await postCamBridge("power", { mode: "sleep", via });
        camera.setStreaming(false);
        gameLog.print({ text: res.message ?? "ESP32-CAM entered Deep Sleep.", tone: "info" });
        await camera.fetchStatus(false);
      }
    } catch (err) {
      gameLog.print({
        text: `ESP32-CAM state: ${err instanceof Error ? err.message : String(err)}`,
        tone: "error",
      });
    } finally {
      setCamBusy(false);
    }
  }

  async function handleCamWake() {
    if (camBusy) return;
    setCamBusy(true);
    try {
      if (camera.directUsbConnected || getRuntimeMode() === "standalone") {
        const res = await webSerialCam.setPower("wake");
        gameLog.print({ text: res.message || "Waking ESP32-CAM via Web Serial…", tone: "info" });
        return;
      }
      const via = camTransport === "usb" ? "usb" : "auto";
      const res = await postCamBridge("power", { mode: "wake", via });
      gameLog.print({ text: res.message ?? "Waking ESP32-CAM…", tone: "info" });
      await camera.fetchStatus(true);
    } catch (err) {
      gameLog.print({
        text: `ESP32-CAM wake: ${err instanceof Error ? err.message : String(err)}`,
        tone: "error",
      });
    } finally {
      setCamBusy(false);
    }
  }

  function downloadSessionCsv() {
    if (getRuntimeMode() !== "bridge") {
      gameLog.print({ text: "CSV session export requires live telemetry via the local bridge.", tone: "info" });
      return;
    }
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
    } else if (!otaJobRef.current?.active) {
      gameLog.print({
        text: `Disconnected from ${targetHost}`,
        tone: "info",
      });
    }
  }, [connected, targetHost, gameLog]);

  // Mirror bridge-level Wi-Fi OTA / firmware build progress into the floating GameLogOverlay
  // so updates triggered from any tab, CLI, or automation remain visible live in the UI.
  useEffect(() => {
    if (!otaJob) return;
    const prefix = otaJob.phase === "building" ? "Build" : `OTA ${otaJob.progress}%`;
    const activeText = `${prefix} · ${otaJob.message}`;

    if (otaJob.active) {
      if (
        otaLineRef.current &&
        otaLineJobIdRef.current === otaJob.id &&
        !otaLineRef.current.isRemoved?.()
      ) {
        otaLineRef.current.update({ text: activeText, tone: "info" });
      } else {
        otaLineJobIdRef.current = otaJob.id;
        otaLineRef.current = gameLog.print({ text: activeText, tone: "info" });
      }
      return;
    }

    const terminalKey = `${otaJob.id}:${otaJob.status}`;
    if (otaTerminalLoggedRef.current === terminalKey) return;
    otaTerminalLoggedRef.current = terminalKey;
    const tone = otaJob.status === "done" ? "success" : "error";
    const finalText = otaJob.status === "done"
      ? otaJob.message
      : (otaJob.error ? `OTA failed: ${otaJob.error}` : otaJob.message);
    if (
      otaLineRef.current &&
      otaLineJobIdRef.current === otaJob.id &&
      !otaLineRef.current.isRemoved?.()
    ) {
      otaLineRef.current.update({ text: finalText, tone });
    } else {
      otaLineJobIdRef.current = otaJob.id;
      otaLineRef.current = gameLog.print({ text: finalText, tone });
    }
  }, [otaJob, gameLog]);

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
        { label: "Wi-Fi Sleep", onClick: () => void setRobotPower("wifi-sleep", "lan") },
        ...(health?.usbV != null && health.usbV >= 4.0
          ? [{ label: "USB Sleep", onClick: () => void setRobotPower("usb-sleep", "lan") }]
          : []),
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

      case "control":
        return (
          <ControlLabPanel
            connected={connected}
            historyRef={historyRef}
            onSendCmd={sendRobotCommand}
          />
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
          <FpvCamPanel
            camera={camera}
            robotConnected={connected}
            robotPitchDeg={pitchDegDisplay}
            robotRollDeg={rollDegDisplay}
            onNotice={onCameraNotice}
          />
        );

      case "view3d":
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
              Trackpad: two-finger swipe orbits, pinch or Option/Alt+swipe zooms with exponential inertial glide.
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
          <CameraSystemMonitor kind="cpu" status={cameraStatus}>
            <CpuPanel
              connected={connected}
              system={connected ? systemSnap : null}
              onSendCmd={(c) => void sendRobotCommand(c)}
              onScreenOff={() => void setScreenOff()}
            />
          </CameraSystemMonitor>
        );

      case "ram":
        return (
          <CameraSystemMonitor kind="ram" status={cameraStatus}>
            <RamPanel
              connected={connected}
              system={connected ? systemSnap : null}
              onSendCmd={(c) => void sendRobotCommand(c)}
            />
          </CameraSystemMonitor>
        );

      case "flash":
        return (
          <CameraSystemMonitor kind="flash" status={cameraStatus}>
            <FlashPanel
              connected={connected}
              response={flashRevision == null || flashSnapshot?.revision === flashRevision ? flashSnapshot : null}
              health={health}
              onRefresh={() => setFlashRefresh((n) => n + 1)}
              onSendCmd={(c) => void sendRobotCommand(c)}
            />
          </CameraSystemMonitor>
        );

      case "ota":
        return (
          <OtaPanel
            connected={connected}
            health={health}
            targetHost={targetHost}
            otaJob={otaJob}
          />
        );

      case "comms":
        return (
          <CommunicationsPanel
            visible={tabVisibility.comms === true}
            connected={connected}
            powerMode={powerMode}
            onConnect={() => void connectWifi()}
            onDisconnect={() => void disconnectWifi()}
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
          {(() => {
            const effStickCUsbAvailable = stickCSerial.connected || usbAvailable;
            const effStickCUsbPort = stickCSerial.portLabel ?? usbPort;
            const effStickCConnected = connected || stickCSerial.connected;
            const stickCComm = resolveStickCComm({
              choice: stickCSerial.connected && stickCCommChoice === "auto" ? "usb" : stickCCommChoice,
              connected: effStickCConnected,
              powerMode,
              usbAvailable: effStickCUsbAvailable,
              usbV: health?.usbV ?? null,
            });
            const stickCState = resolveStickCStateDisplay({
              forcedState: stickCForcedState,
              connected: effStickCConnected,
              powerMode,
              otaActive: Boolean(otaJob?.active),
              otaPhase: otaJob?.phase,
              otaProgress: otaJob?.progress,
            });
            const camComm = resolveCamComm({
              choice: camTransport,
              activeTransport: cameraStatus?.activeTransport,
              usbPort: cameraStatus?.usbPort,
              ip: cameraStatus?.ip,
              available: Boolean(cameraStatus?.available),
            });
            const camState = resolveCamStateDisplay({
              forcedState: camForcedState,
              status: cameraStatus,
            });
            const robotState = latest?.state ?? "";
            const isArmed = ["ARMED", "LEVELING", "TAKEOFF", "BALANCING"].includes(robotState);
            const isFallen = robotState === "FALLEN";
            const canTakeoff = connected && (robotState === "READY" || robotState === "ARMED");
            const stickCMetric = otaJob?.active
              ? null
              : telemetryAvailable && streamMetrics
                ? `${actualPollHz.toFixed(0)}Hz · ${streamMetrics.avgRttMs.toFixed(0)}ms`
                : null;
            const camMetric = cameraStatus?.flashJob?.status === "running"
              ? null
              : camState.liveState === "streaming" && (cameraStatus?.fps ?? 0) > 0
                ? `${cameraStatus!.fps.toFixed(0)}fps${cameraStatus?.dieTempC != null ? ` · ${cameraStatus.dieTempC.toFixed(0)}°C` : ""}`
                : cameraStatus?.dieTempC != null && camState.liveState !== "offline"
                  ? `${cameraStatus.dieTempC.toFixed(0)}°C`
                  : null;
            const canStickCWifiSleep = effStickCConnected || powerMode === "wifi-sleep";
            const canStickCUsbSleep = stickCComm.canUsbSleep;
            const canCamWake = camState.liveState === "sleep" || camState.liveState === "offline";

            return (
              <>
                <DeviceControlGroup<StickCCommChoice, StickCStateChoice>
                  name="StickC"
                  statusTone={stickCState.tone}
                  metric={stickCMetric}
                  busy={powerBusy || Boolean(otaJob?.active)}
                  statusTitle={
                    otaJob?.active
                      ? `${otaJob.message} (${otaJob.progress}%)`
                      : telemetryAvailable && streamMetrics
                        ? `${targetHost} · Poll ${actualPollHz.toFixed(1)}/${effectiveTargetHz} Hz · IMU ${streamMetrics.sampleRateHz.toFixed(0)} sps · RTT ${streamMetrics.avgRttMs.toFixed(0)} ms · ${streamMetrics.resolvedIp}`
                        : `${targetHost} · ${stickCState.liveLabel}${effStickCUsbPort ? ` · USB ${effStickCUsbPort}` : ""}`
                  }
                  commValue={stickCCommChoice}
                  commLabel={stickCComm.label}
                  commTone={stickCComm.tone}
                  commForced={!stickCComm.isAuto}
                  commTitle={`StickC comm: ${stickCComm.label}${effStickCUsbPort ? ` (${effStickCUsbPort})` : ""}`}
                  commOptions={[
                    {
                      value: "auto",
                      label: "Auto",
                      badge: "Default",
                      description: `Active: ${stickCComm.active === "usb" ? "USB" : "Wi-Fi"}`,
                    },
                    {
                      value: "wifi",
                      label: "Wi-Fi",
                      badge: connected ? "Live" : runtimeMode === "standalone" ? "Bridge" : undefined,
                      description: runtimeMode === "standalone"
                        ? "Requires local `npm run dev` LAN bridge"
                        : `LAN bridge (${targetHost})`,
                    },
                    {
                      value: "usb",
                      label: "USB",
                      badge: stickCSerial.connected
                        ? "Web Serial"
                        : effStickCUsbPort
                          ? "Plugged"
                          : hasWebSerial()
                            ? "Connect…"
                            : "Unplugged",
                      description: effStickCUsbPort
                        ? effStickCUsbPort
                        : hasWebSerial()
                          ? "Click to connect StickC via browser Web Serial"
                          : "No StickC USB serial port detected",
                    },
                  ]}
                  onSelectComm={(next) => void handleStickCCommSelect(next)}
                  hostEditor={{
                    label: "Host",
                    value: targetHost,
                    placeholder: "balax.local",
                    onChange: (next) => setTargetHost(next),
                    onCommit: (next) => {
                      if (next.trim() && connected) void connectWifi();
                    },
                  }}
                  stateValue={stickCForcedState}
                  stateLabel={stickCState.label}
                  stateLiveLabel={stickCState.liveLabel}
                  stateTone={stickCState.tone}
                  stateForced={stickCState.isForced}
                  stateTitle={`StickC state: ${stickCState.label} (click to force state)`}
                  stateOptions={[
                    {
                      value: "auto",
                      label: "Auto",
                      badge: "Default",
                      description: `Track live state (${stickCState.liveLabel})`,
                    },
                    {
                      value: "awake",
                      label: "Awake / Connect",
                      tone: "primary",
                      description:
                        powerMode === "wifi-sleep"
                          ? "Wake StickC over Wi-Fi and reconnect"
                          : stickCComm.active === "usb" && usbAvailable
                            ? "Wake StickC over USB (RTS→EN)"
                            : `Connect bridge to ${targetHost}`,
                    },
                    {
                      value: "wifi-sleep",
                      label: "Wi-Fi Sleep",
                      tone: "warning",
                      disabled: !canStickCWifiSleep,
                      description: canStickCWifiSleep
                        ? "Low-power Wi-Fi sleep (faint 4s LED; wake over Wi-Fi)"
                        : "Connect over Wi-Fi first",
                    },
                    {
                      value: "usb-sleep",
                      label: "USB Sleep",
                      tone: "warning",
                      disabled: !canStickCUsbSleep,
                      description: canStickCUsbSleep
                        ? "Deep sleep for cool USB charging (wake over USB)"
                        : "Requires StickC USB connection",
                    },
                    {
                      value: "offline",
                      label: "Disconnect",
                      tone: "danger",
                      description: "Pause bridge telemetry stream without sleeping StickC",
                    },
                  ]}
                  onSelectState={(next) => void handleStickCStateSelect(next, stickCComm.active)}
                />

                <DeviceControlGroup<CamCommChoice, CamStateChoice>
                  name="ESP32-CAM"
                  statusTone={camState.tone}
                  metric={camMetric}
                  busy={camBusy || cameraStatus?.flashJob?.status === "running"}
                  statusTitle={`${camera.host}${cameraStatus?.ip ? ` (${cameraStatus.ip})` : ""} · ${camState.liveLabel}${cameraStatus?.usbPort ? ` · USB ${cameraStatus.usbPort}` : ""}`}
                  commValue={camTransport}
                  commLabel={camComm.label}
                  commTone={camComm.tone}
                  commForced={!camComm.isAuto}
                  commTitle={`ESP32-CAM comm: ${camComm.label}${cameraStatus?.usbPort ? ` (${cameraStatus.usbPort})` : ""}`}
                  commOptions={[
                    {
                      value: "auto",
                      label: "Auto",
                      badge: "Default",
                      description: "Prefer Wi-Fi UDP, fallback HTTP / USB",
                    },
                    {
                      value: "udp",
                      label: "Wi-Fi UDP",
                      badge: camComm.active === "udp" ? "Live" : undefined,
                      description: "Low-latency ECL1 UDP stream",
                    },
                    {
                      value: "http",
                      label: "Wi-Fi HTTP",
                      badge: camComm.active === "http" ? "Live" : undefined,
                      description: "HTTP MJPEG fallback stream",
                    },
                    {
                      value: "usb",
                      label: "USB",
                      badge: camera.directUsbConnected
                        ? "Web Serial"
                        : cameraStatus?.usbPort
                          ? "Plugged"
                          : hasWebSerial()
                            ? "Connect…"
                            : "Unplugged",
                      description: cameraStatus?.usbPort
                        ?? (hasWebSerial()
                          ? "Click to connect ESP32-FPV via browser Web Serial (921600 baud)"
                          : "No ESP32-CAM USB serial port detected"),
                    },
                  ]}
                  onSelectComm={(next) => void handleCamCommSelect(next)}
                  hostEditor={{
                    label: "Host",
                    value: camHostValue,
                    placeholder: DEFAULT_CAMERA_HOST,
                    onChange: (next) => camera.settings.set(CAMERA_SETTING.host, next),
                    onCommit: () => void camera.fetchStatus(true),
                  }}
                  stateValue={camForcedState}
                  stateLabel={camState.label}
                  stateLiveLabel={camState.liveLabel}
                  stateTone={camState.tone}
                  stateForced={camState.isForced}
                  stateTitle={`ESP32-CAM state: ${camState.label} (click to force state)`}
                  stateOptions={[
                    {
                      value: "auto",
                      label: "Auto",
                      badge: "Default",
                      description: `Track live state (${camState.liveLabel})`,
                    },
                    {
                      value: "streaming",
                      label: "Streaming",
                      tone: "primary",
                      description: `Start FPV stream via ${camComm.label}`,
                    },
                    {
                      value: "idle",
                      label: "Cool Idle",
                      tone: "warning",
                      description: "Cut OV2640 power (GPIO32 HIGH) → 40 MHz Wi-Fi idle",
                    },
                    {
                      value: "sleep",
                      label: "Deep Sleep",
                      tone: "danger",
                      description: "~10 µA deep sleep (wake via USB RTS→EN or Reset)",
                    },
                  ]}
                  onSelectState={(next) => void handleCamStateSelect(next)}
                  extraStateAction={
                    canCamWake
                      ? {
                          label: camTransport === "usb" || cameraStatus?.usbPort ? "Wake via USB" : "Wake Camera",
                          description: cameraStatus?.usbPort
                            ? `Pulse RTS→EN on ${cameraStatus.usbPort}`
                            : "Send wake request to ESP32-CAM",
                          onClick: () => void handleCamWake(),
                        }
                      : null
                  }
                />

                {connected && (
                  <button
                    className={isArmed || isFallen ? "danger" : "success"}
                    style={{ padding: "4px 11px", fontSize: "0.78rem" }}
                    onClick={() => void sendRobotCommand(isArmed || isFallen ? "disarm" : "arm")}
                    title={
                      isFallen
                        ? "Acknowledge fall and disarm motors"
                        : isArmed
                          ? "Disarm motors immediately"
                          : "Arm BalaX (stand upright to balance)"
                    }
                  >
                    {isFallen ? "Ack / Disarm" : isArmed ? "Disarm" : "Arm"}
                  </button>
                )}

                {canTakeoff && (
                  <button
                    className="primary"
                    style={{ padding: "4px 10px", fontSize: "0.78rem" }}
                    onClick={() => void sendRobotCommand("takeoff")}
                    title="Pop up from lying flat into balancing"
                  >
                    Takeoff
                  </button>
                )}

                {connected && !isArmed && (
                  <button
                    style={{ padding: "4px 9px", fontSize: "0.78rem" }}
                    disabled={zeroingImu}
                    onClick={() => void zeroImuAndSaveFlash()}
                    title="Zero 6-axis IMU biases (hold still ~1s) and save to flash"
                  >
                    {zeroingImu ? "Zeroing..." : "Zero IMU"}
                  </button>
                )}

                {connected && (
                  <button
                    style={{ padding: "4px 9px", fontSize: "0.78rem" }}
                    onClick={centerSimPose}
                    title="Recenter 3D pose without recalibrating flash"
                  >
                    Center
                  </button>
                )}
              </>
            );
          })()}
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
          {!connected && powerMode === "wifi-sleep" && health && (
            <span style={{ color: "var(--muted)", marginLeft: 4 }} title="Slow passive telemetry (15s poll, robot stays in Wi-Fi sleep)">
              {pmicC !== null && (
                <>
                  <strong style={{ color: thermalColor }}>{pmicC.toFixed(0)}°C</strong>
                </>
              )}
              {batteryPct !== null && (
                <>
                  {pmicC !== null ? " · " : ""}
                  <strong style={{ color: isLowBattery ? "#d29922" : "#3fb950" }}>
                    {batteryPct.toFixed(0)}%
                  </strong>
                  {health.batteryV !== null ? ` (${health.batteryV.toFixed(2)}V)` : ""}
                </>
              )}
              {health.usbV !== null && health.usbV >= 4.0 && (
                <>
                  {" · "}
                  <strong style={{ color: "#58a6ff" }}>USB {health.usbV.toFixed(1)}V</strong>
                </>
              )}
            </span>
          )}
          {imuNotice && <span style={{ color: "var(--muted)" }}>{imuNotice}</span>}
        </div>

        {/* Dual-motor drive joystick pad in bottom-right corner */}
        <DualMotorDrivePad
          connected={connected}
          robotState={latest?.state ?? ""}
          motorL={latest?.motorL ?? 0}
          motorR={latest?.motorR ?? 0}
          remoteStick={remoteStick}
          onChange={handleDriveStickChange}
        />
      </div>
    </div>
  );
}
