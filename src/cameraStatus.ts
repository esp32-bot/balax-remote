import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SettingsRegistry } from "@g-ai/ui";
import type { CamBridgeStatus } from "./cameraProtocol";
import {
  CAMERA_DEVICE_SETTINGS,
  CAMERA_SETTING,
  DEFAULT_CAMERA_HOST,
  createCameraSettings,
  writeCameraConfig,
  readAppliedCameraConfig,
  type CameraConfig,
  type CameraSettingValue,
} from "./cameraSettings";
import {
  detectRuntimeMode,
  getRuntimeMode,
  hasWebSerial,
  subscribeRuntimeMode,
  type RuntimeTransportMode,
} from "./runtimeMode";
import { webSerialCam } from "./webSerialCam";

export type CamStatus = CamBridgeStatus;
export type CameraNotice = (text: string, tone?: "info" | "warning" | "error") => void;

export interface CameraStatusController {
  settings: SettingsRegistry;
  host: string;
  status: CamStatus | null;
  receivedAtMs: number | null;
  lastDeviceConfig: CameraConfig | undefined;
  streaming: boolean;
  directUsbConnected: boolean;
  runtimeMode: RuntimeTransportMode;
  setStreaming: (streaming: boolean) => void;
  fetchStatus: (probe?: boolean) => Promise<void>;
  connectDirectUsb: () => Promise<void>;
  disconnectDirectUsb: () => Promise<void>;
}

export function useCameraSetting<T extends CameraSettingValue>(settings: SettingsRegistry, id: string): T {
  const subscribe = useCallback((listener: () => void) => settings.watch(id, listener), [settings, id]);
  return useSyncExternalStore(subscribe, () => settings.get<T>(id));
}

export function useCameraStatus(fastPoll: boolean, onNotice: CameraNotice): CameraStatusController {
  const [settings] = useState(createCameraSettings);
  const host = useCameraSetting<string>(settings, CAMERA_SETTING.host).trim() || DEFAULT_CAMERA_HOST;
  const runtimeMode = useSyncExternalStore(subscribeRuntimeMode, getRuntimeMode);
  const [snapshot, setSnapshot] = useState<{ status: CamStatus; receivedAtMs: number } | null>(null);
  const [directSnapshot, setDirectSnapshot] = useState<{ status: CamStatus; receivedAtMs: number } | null>(null);
  const [directUsbConnected, setDirectUsbConnected] = useState(() => webSerialCam.isConnected());
  const [deviceConfig, setDeviceConfig] = useState<{ host: string; config: CameraConfig }>();
  const [streaming, updateStreaming] = useState(false);
  const [, markExpired] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const announcedFlash = useRef("");
  const initializedSettings = useRef(false);
  const localEdits = useRef(new Set<string>());
  const notice = useRef(onNotice);
  notice.current = onNotice;

  useEffect(() => {
    void detectRuntimeMode();
  }, []);

  useEffect(() => {
    webSerialCam.setHost(host);
  }, [host]);

  const applyCameraConfig = useCallback((next: CamStatus) => {
    const config = readAppliedCameraConfig(next);
    if (config) {
      if (!initializedSettings.current) {
        initializedSettings.current = true;
        writeCameraConfig(settings, config, localEdits.current);
      }
      setDeviceConfig({ host: next.host, config });
    }
  }, [settings]);

  // Subscribe to direct Web Serial ESP32-FPV status (works serverless on GitHub Pages!)
  useEffect(() => {
    const stop = webSerialCam.subscribeStatus((next) => {
      const connected = webSerialCam.isConnected();
      setDirectUsbConnected(connected);
      if (connected || next.powerMode === "sleep") {
        applyCameraConfig(next);
        setDirectSnapshot({ status: next, receivedAtMs: Date.now() });
        updateStreaming(next.streaming);
      } else {
        setDirectSnapshot(null);
        updateStreaming(false);
      }
    });
    if (webSerialCam.isConnected()) {
      const cur = webSerialCam.getStatus();
      setDirectUsbConnected(true);
      setDirectSnapshot({ status: cur, receivedAtMs: Date.now() });
      updateStreaming(cur.streaming);
    }
    return stop;
  }, [applyCameraConfig]);

  const activeSnap = directUsbConnected || (runtimeMode === "standalone" && directSnapshot)
    ? directSnapshot
    : snapshot;
  const status = activeSnap && (directUsbConnected || activeSnap.status.host === host)
    ? activeSnap.status
    : null;
  const receivedAtMs = status && activeSnap ? activeSnap.receivedAtMs : null;
  const lastDeviceConfig = deviceConfig?.host === host ? deviceConfig.config : undefined;

  const setStreaming = useCallback((next: boolean) => {
    activeRequest.current?.abort();
    updateStreaming(next);
  }, []);

  const connectDirectUsb = useCallback(async () => {
    if (!hasWebSerial()) {
      throw new Error("Web Serial is not supported in this browser. Use Chrome, Edge, or Brave.");
    }
    const next = await webSerialCam.connect();
    settings.set(CAMERA_SETTING.transport, "usb");
    setDirectUsbConnected(webSerialCam.isConnected());
    setDirectSnapshot({ status: next, receivedAtMs: Date.now() });
    applyCameraConfig(next);
    notice.current(`ESP32-FPV connected directly over Web Serial (${next.usbPort ?? "USB"}).`, "info");
  }, [applyCameraConfig, settings]);

  const disconnectDirectUsb = useCallback(async () => {
    await webSerialCam.disconnect();
    setDirectUsbConnected(false);
    setDirectSnapshot(null);
    updateStreaming(false);
  }, []);

  const fetchStatus = useCallback(async (probe = true) => {
    if (webSerialCam.isConnected()) {
      const next = webSerialCam.getStatus();
      setDirectSnapshot({ status: next, receivedAtMs: Date.now() });
      applyCameraConfig(next);
      return;
    }
    const mode = await detectRuntimeMode();
    if (mode !== "bridge") return;

    activeRequest.current?.abort();
    const request = new AbortController();
    activeRequest.current = request;
    try {
      const query = new URLSearchParams({ host, probe: probe ? "1" : "0" });
      const res = await fetch(`/api/bridge/cam/status?${query}`, { signal: request.signal });
      if (!res.ok) return;
      const next = (await res.json()) as CamStatus;
      if (request.signal.aborted || next.host !== host) return;
      applyCameraConfig(next);
      setSnapshot({ status: next, receivedAtMs: Date.now() });
      updateStreaming(next.streaming);
      const job = next.flashJob;
      if (job && job.status !== "running" && announcedFlash.current !== job.id) {
        announcedFlash.current = job.id;
        notice.current(job.message, job.status === "done" ? "info" : "error");
      }
    } catch {
      // A hidden tab or a temporarily unavailable bridge leaves the last reading intact.
    } finally {
      if (activeRequest.current === request) activeRequest.current = null;
    }
  }, [applyCameraConfig, host]);

  useEffect(() => () => activeRequest.current?.abort(), [host]);
  useEffect(() => {
    const stops = Object.values(CAMERA_DEVICE_SETTINGS).map(id => (
      settings.watch(id, () => { localEdits.current.add(id); })
    ));
    return () => { for (const stop of stops) stop(); };
  }, [settings]);

  const flashing = status?.flashJob?.status === "running";
  const allowProbe = status?.powerMode !== "sleep" && !flashing;
  const intervalMs = flashing ? 450 : streaming ? 1000 : fastPoll ? 2500 : 4500;
  useEffect(() => {
    if (directUsbConnected || runtimeMode === "standalone") return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      if (!activeRequest.current) await fetchStatus(allowProbe);
      if (!stopped) timer = window.setTimeout(() => void poll(), intervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [allowProbe, directUsbConnected, fetchStatus, intervalMs, runtimeMode]);

  useEffect(() => {
    if (receivedAtMs === null) return;
    const timer = window.setTimeout(() => markExpired(value => value + 1), 10500);
    return () => window.clearTimeout(timer);
  }, [receivedAtMs]);

  return {
    settings,
    host,
    status,
    receivedAtMs,
    lastDeviceConfig,
    streaming,
    directUsbConnected,
    runtimeMode,
    setStreaming,
    fetchStatus,
    connectDirectUsb,
    disconnectDirectUsb,
  };
}
