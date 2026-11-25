import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createParameterSection, createSavedSettingsSection, createSectionsElement } from "@g-ai/ui";
import { AdoptedElement } from "@g-ai/ui/react";
import "@g-ai/ui/styles.css";
import type { CamStabMode } from "./cameraProtocol";
import {
  CAMERA_SETTING,
  CAMERA_SETTINGS_SECTIONS,
  cameraConfigDiff,
  readAppliedCameraConfig,
  readCameraConfig,
  writeCameraConfig,
  type CameraConfig,
  type CameraTransport,
} from "./cameraSettings";
import { useCameraSetting, type CameraNotice, type CameraStatusController, type CamStatus } from "./cameraStatus";
import { hasWebSerial } from "./runtimeMode";
import { webSerialCam } from "./webSerialCam";
import "./camera.css";

export interface FpvCamPanelProps {
  camera: CameraStatusController;
  robotConnected: boolean;
  robotPitchDeg: number;
  robotRollDeg: number;
  onNotice: CameraNotice;
}

const DEFAULT_VFOV_DEG = 45;
const CAM_PUSH_MAGIC = 0x464d4342; // 'B','C','M','F' LE
const CAM_PUSH_HEADER_LEN = 24;
const CODEC_CODE_NAMES: Record<number, string> = {
  0: "PASS_THROUGH",
  1: "FRAME_SKIP",
  6: "DCT_SPARSE_BLOCK",
};
const CAMERA_ACTION = "foss-earth-choice foss-earth-parameter__action";
const TRANSPORT_LABEL = {
  none: "Idle",
  udp_ecl1: "UDP ECL1",
  http_mjpeg: "HTTP MJPEG",
  usb_ecl1: "USB 921k",
};
const STAB_LABEL: Record<CamStabMode, string> = {
  hybrid: "Hybrid (Cam+Rx)",
  camera_crop: "Camera Only",
  receiver_warp: "Client Only",
  none: "Off",
};

function findPushMagic(buf: Uint8Array, from = 0): number {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0x42 && buf[i + 1] === 0x43 && buf[i + 2] === 0x4d && buf[i + 3] === 0x46) {
      return i;
    }
  }
  return -1;
}

export function FpvCamPanel({
  camera,
  robotConnected,
  robotPitchDeg,
  robotRollDeg,
  onNotice,
}: FpvCamPanelProps) {
  const { host, settings, streaming, directUsbConnected, runtimeMode, setStreaming, fetchStatus, connectDirectUsb, disconnectDirectUsb } = camera;
  const status = camera.receivedAtMs !== null && Date.now() - camera.receivedAtMs <= 10500
    ? camera.status
    : camera.status?.powerMode === "sleep" ? camera.status : null;
  const [busy, setBusy] = useState<"stream" | "power" | "flash" | "apply" | null>(null);
  const [lastApplied, setLastApplied] = useState<{ host: string; config: CameraConfig } | null>(null);
  const [sectionsView, setSectionsView] = useState<{ element: HTMLElement; powerActions: HTMLElement } | null>(null);
  const [, refreshSettings] = useReducer((value: number) => value + 1, 0);
  const transport = useCameraSetting<CameraTransport>(settings, CAMERA_SETTING.transport);
  const warp = useCameraSetting<boolean>(settings, CAMERA_SETTING.receiverWarp);
  const showHud = useCameraSetting<boolean>(settings, CAMERA_SETTING.hud);
  const previousConfig = lastApplied?.host === host ? lastApplied.config : undefined;
  const appliedConfig = readAppliedCameraConfig(status, previousConfig ?? camera.lastDeviceConfig);
  const config = readCameraConfig(settings);
  const baselineConfig = appliedConfig ?? readCameraConfig(settings, true);
  const configPatch = cameraConfigDiff(config, baselineConfig);
  const configPending = Object.keys(configPatch).length > 0;
  const transportPending = streaming && status !== null && status.transportPreference !== transport;
  const stabMode: CamStabMode = status?.stabMode ?? previousConfig?.stab_mode ?? config.stab_mode;
  const vfovDeg = status?.vfovDeg ?? previousConfig?.vfov_deg ?? config.vfov_deg ?? DEFAULT_VFOV_DEG;
  // Camera-only crop zeroes residual attitude so client must never double-warp.
  const applyBrowserWarp = warp && (stabMode === "hybrid" || stabMode === "receiver_warp");
  const statusRef = useRef(status);
  statusRef.current = status;
  const readings = useRef(new Set<() => void>());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastBitmapRef = useRef<ImageBitmap | null>(null);
  const lastFrameIdRef = useRef<number>(0);
  const frameAttitudeRef = useRef<{
    hasAtt: boolean;
    pitchDeg: number;
    rollDeg: number;
    codec: string;
    skipped: boolean;
    width: number;
    height: number;
  }>({
    hasAtt: false,
    pitchDeg: 0,
    rollDeg: 0,
    codec: "PASS_THROUGH",
    skipped: false,
    width: 320,
    height: 240,
  });
  const robotAttRef = useRef({ connected: robotConnected, pitchDeg: robotPitchDeg, rollDeg: robotRollDeg });
  robotAttRef.current = { connected: robotConnected, pitchDeg: robotPitchDeg, rollDeg: robotRollDeg };

  useEffect(() => settings.subscribe(refreshSettings), [settings]);

  useEffect(() => {
    const powerActions = document.createElement("div");
    powerActions.className = "foss-earth-choices camera-actions";
    const removeFpsReading = settings.setReadingSource(CAMERA_SETTING.fps, () => {
      const st = statusRef.current;
      if (!st?.cameraOn) return null;
      const tgt = st.fpsTarget === 0 ? "uncapped" : st.fpsTarget != null ? `cap ${st.fpsTarget}` : "";
      return { text: `${st.fps.toFixed(1)} fps${tgt ? ` (${tgt})` : ""}`, inUse: st.fps };
    });
    const removeClockReading = settings.setReadingSource(CAMERA_SETTING.clock, () => {
      const st = statusRef.current;
      if (st?.cpuMhz == null) return null;
      return `${st.cpuMhz} MHz${st.cpuDfs ? " DFS" : ""}`;
    });
    const removeQualityReading = settings.setReadingSource(CAMERA_SETTING.quality, () => {
      const st = statusRef.current;
      if (st?.effectiveQuality == null) return null;
      return `QS ${st.effectiveQuality}${st.autoQuality ? " auto" : ""}`;
    });
    const removeThermalReading = settings.setReadingSource(CAMERA_SETTING.thermalLimitC, () => {
      const st = statusRef.current;
      if (st?.dieTempC == null) return null;
      const badge = st.thermalState !== "ok" ? ` (${st.thermalState})` : "";
      return `${st.dieTempC}°C${badge}`;
    });
    const groups = CAMERA_SETTINGS_SECTIONS.map(section => {
      const handle = createParameterSection(settings, {
        document,
        tab: "camera",
        section: section.id,
        main: section.id === "power" ? powerActions : undefined,
        showAll: false,
        refresh: {
          subscribe: listener => {
            readings.current.add(listener);
            return () => { readings.current.delete(listener); };
          },
        },
      });
      return { ...section, id: `balax.camera.${section.id}`, element: handle.element, destroy: handle.destroy, defaultOpen: true };
    });
    const saved = createSavedSettingsSection(settings, document);
    const view = createSectionsElement([
      ...groups,
      { id: "balax.camera.saved", title: "Saved settings", element: saved.element, help: "Import, export or reset the camera settings saved in this browser." },
    ], { document });
    setSectionsView({ element: view.element, powerActions });
    return () => {
      view.destroy();
      for (const group of groups) group.destroy();
      saved.destroy();
      removeFpsReading();
      removeClockReading();
      removeQualityReading();
      removeThermalReading();
    };
  }, [settings]);
  useEffect(() => {
    for (const refresh of readings.current) refresh();
  }, [status]);

  // Zero-poll binary push stream (/api/bridge/cam/push) with /api/bridge/cam/frame fallback
  useEffect(() => {
    if (!streaming) return;
    let alive = true;
    let abortCtrl: AbortController | null = null;
    let decoding = false;
    let pendingDecode: { frameId: number; bytes: Uint8Array } | null = null;

    const scheduleDecode = (frameId: number, bytes: Uint8Array) => {
      if (bytes.length === 0) return;
      if (frameId === lastFrameIdRef.current && lastBitmapRef.current) return;
      pendingDecode = { frameId, bytes };
      if (decoding) return;
      decoding = true;

      void (async () => {
        while (alive && pendingDecode) {
          const item = pendingDecode;
          pendingDecode = null;
          try {
            const copy = new Uint8Array(item.bytes.byteLength);
            copy.set(item.bytes);
            const bmp = await createImageBitmap(new Blob([copy], { type: "image/jpeg" }));
            if (!alive) {
              bmp.close();
              break;
            }
            lastBitmapRef.current?.close();
            lastBitmapRef.current = bmp;
            lastFrameIdRef.current = item.frameId;
          } catch {
            // ignore corrupted JPEG frame
          }
        }
        decoding = false;
      })();
    };

    const pullFallbackOnce = async () => {
      try {
        const res = await fetch("/api/bridge/cam/frame", { cache: "no-store" });
        if (!alive || res.status !== 200) return;
        const fid = Number(res.headers.get("X-Frame-Id") || "0");
        const hasAtt = res.headers.get("X-Has-Attitude") === "1";
        const pitchDeg = Number(res.headers.get("X-Pitch-Cdeg") || "0") / 100;
        const rollDeg = Number(res.headers.get("X-Roll-Cdeg") || "0") / 100;
        const codec = res.headers.get("X-Codec-Mode") || "PASS_THROUGH";
        const skipped = res.headers.get("X-Skipped") === "1";
        const width = Number(res.headers.get("X-Width") || "320");
        const height = Number(res.headers.get("X-Height") || "240");
        frameAttitudeRef.current = { hasAtt, pitchDeg, rollDeg, codec, skipped, width, height };
        const buf = new Uint8Array(await res.arrayBuffer());
        if (alive) scheduleDecode(fid, buf);
      } catch {
        // ignore transient fallback error
      }
    };

    if (directUsbConnected) {
      const stopDirect = webSerialCam.subscribeFrames((frame) => {
        if (!alive) return;
        frameAttitudeRef.current = {
          hasAtt: frame.hasAttitude,
          pitchDeg: frame.pitchCdeg / 100,
          rollDeg: frame.rollCdeg / 100,
          codec: frame.codecModeName,
          skipped: frame.isSkipped,
          width: frame.width,
          height: frame.height,
        };
        if (frame.jpeg.byteLength > 0) {
          scheduleDecode(frame.frameId, frame.jpeg);
        }
      });
      return () => {
        alive = false;
        stopDirect();
      };
    }

    const runPushLoop = async () => {
      while (alive) {
        abortCtrl = new AbortController();
        try {
          const res = await fetch("/api/bridge/cam/push", {
            cache: "no-store",
            signal: abortCtrl.signal,
          });
          if (!res.ok || !res.body) {
            await pullFallbackOnce();
            await new Promise(r => setTimeout(r, 350));
            continue;
          }
          const reader = res.body.getReader();
          let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
          while (alive) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            if (buf.length === 0) {
              buf = value;
            } else {
              const merged = new Uint8Array(buf.length + value.length);
              merged.set(buf, 0);
              merged.set(value, buf.length);
              buf = merged;
            }

            // Drain all complete frames in buffer, decoding only the freshest JPEG.
            let newest: { frameId: number; bytes: Uint8Array } | null = null;
            let offset = 0;
            while (buf.length - offset >= CAM_PUSH_HEADER_LEN) {
              const dv = new DataView(buf.buffer, buf.byteOffset + offset, CAM_PUSH_HEADER_LEN);
              const magic = dv.getUint32(0, true);
              if (magic !== CAM_PUSH_MAGIC) {
                const nextMagic = findPushMagic(buf, offset + 1);
                if (nextMagic < 0) {
                  offset = Math.max(offset, buf.length - 3);
                  break;
                }
                offset = nextMagic;
                continue;
              }
              const frameId = dv.getUint32(4, true);
              const width = dv.getUint16(8, true);
              const height = dv.getUint16(10, true);
              const pitchCdeg = dv.getInt16(12, true);
              const rollCdeg = dv.getInt16(14, true);
              const flags = dv.getUint8(16);
              const codecCode = dv.getUint8(17);
              const jpegLen = dv.getUint32(20, true);
              if (jpegLen > 512 * 1024) {
                offset += 4;
                continue;
              }
              if (buf.length - offset < CAM_PUSH_HEADER_LEN + jpegLen) {
                break;
              }
              const jpegStart = offset + CAM_PUSH_HEADER_LEN;
              const jpegBytes = buf.subarray(jpegStart, jpegStart + jpegLen);
              frameAttitudeRef.current = {
                hasAtt: (flags & 1) !== 0,
                pitchDeg: pitchCdeg / 100,
                rollDeg: rollCdeg / 100,
                codec: CODEC_CODE_NAMES[codecCode] ?? "PASS_THROUGH",
                skipped: (flags & 2) !== 0,
                width: width || 320,
                height: height || 240,
              };
              if (jpegLen > 0) {
                newest = { frameId, bytes: jpegBytes.slice() };
              }
              offset = jpegStart + jpegLen;
            }

            if (offset > 0) {
              buf = offset < buf.length ? buf.slice(offset) : new Uint8Array(0);
            }
            if (newest) {
              scheduleDecode(newest.frameId, newest.bytes);
            }
          }
          try { reader.releaseLock(); } catch { /* ignore */ }
        } catch {
          if (!alive) break;
          await pullFallbackOnce();
        }
        if (alive) {
          await new Promise(r => setTimeout(r, 350));
        }
      }
    };

    if (runtimeMode === "standalone") {
      return () => { alive = false; };
    }
    void runPushLoop();

    return () => {
      alive = false;
      abortCtrl?.abort();
    };
  }, [streaming, directUsbConnected, runtimeMode]);

  // Smooth 60 Hz canvas render + dynamic aspect ratio + hybrid/client horizon warp
  useEffect(() => {
    let rafId = 0;

    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const bmp = lastBitmapRef.current;
        if (bmp && (canvas.width !== bmp.width || canvas.height !== bmp.height)) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.fillStyle = "#080d14";
          ctx.fillRect(0, 0, w, h);

          const fa = frameAttitudeRef.current;
          const ra = robotAttRef.current;
          const st = statusRef.current;

          // Attitude hierarchy: camera UART/ESP-NOW metadata first -> BalaX live telemetry fallback
          const useCamAtt = fa.hasAtt;
          const useRobotAtt = !useCamAtt && ra.connected && stabMode !== "camera_crop";
          const pitchDeg = useCamAtt ? fa.pitchDeg : useRobotAtt ? ra.pitchDeg : 0;
          const rollDeg = useCamAtt ? fa.rollDeg : useRobotAtt ? ra.rollDeg : 0;

          if (bmp) {
            ctx.save();
            ctx.translate(w / 2, h / 2);
            if (applyBrowserWarp) {
              const clampedPitch = Math.max(-22, Math.min(22, pitchDeg));
              const clampedRoll = Math.max(-35, Math.min(35, rollDeg));
              const dy = (clampedPitch / Math.max(20, vfovDeg)) * h;
              // Hybrid mode only corrects small roll + sub-crop pitch residual, preserving more FOV.
              const overscan = stabMode === "hybrid" ? 1.08 : 1.16;
              ctx.scale(overscan, overscan);
              ctx.rotate((-clampedRoll * Math.PI) / 180);
              ctx.translate(0, dy);
            }
            ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
            ctx.restore();
          } else {
            ctx.fillStyle = "#6e7681";
            ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
            ctx.textAlign = "center";
            ctx.fillText(
              streaming ? "Waiting for camera frames" : "Camera preview paused",
              w / 2,
              h / 2 - 6,
            );
            ctx.fillStyle = "#484f58";
            ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
            ctx.fillText(
              streaming ? host : "Start stream to turn on the sensor",
              w / 2,
              h / 2 + 12,
            );
          }

          if (showHud && bmp) {
            const sc = Math.max(1, Math.min(2.2, w / 340));
            ctx.save();
            ctx.strokeStyle = stabMode !== "none" ? "rgba(88, 166, 255, 0.78)" : "rgba(210, 153, 34, 0.72)";
            ctx.lineWidth = 1.2 * sc;
            const cx = w / 2;
            const cy = h / 2;
            ctx.beginPath();
            ctx.moveTo(cx - 52 * sc, cy);
            ctx.lineTo(cx - 12 * sc, cy);
            ctx.moveTo(cx + 12 * sc, cy);
            ctx.lineTo(cx + 52 * sc, cy);
            ctx.moveTo(cx, cy - 8 * sc);
            ctx.lineTo(cx, cy + 8 * sc);
            ctx.stroke();

            // Top-left live HUD pill (scaled cleanly for QVGA -> SVGA)
            const pad = 6 * sc;
            const boxW = Math.min(w - pad * 2, 238 * sc);
            const boxH = 36 * sc;
            ctx.fillStyle = "rgba(1, 4, 9, 0.68)";
            ctx.fillRect(pad, pad, boxW, boxH);
            ctx.fillStyle = "#e6edf3";
            ctx.font = `${Math.round(10 * sc)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
            ctx.textAlign = "left";
            const modeTag = stabMode === "hybrid" ? "HYB"
              : stabMode === "camera_crop" ? "CAM"
              : stabMode === "receiver_warp" ? "RX"
              : "RAW";
            const attSrc = useCamAtt ? "CAM" : useRobotAtt ? "BALAX" : "NONE";
            const tempStr = st?.dieTempC != null ? ` ${st.dieTempC}°C` : "";
            ctx.fillText(
              `${modeTag} | P ${pitchDeg >= 0 ? "+" : ""}${pitchDeg.toFixed(1)}° R ${rollDeg >= 0 ? "+" : ""}${rollDeg.toFixed(1)}°${tempStr}`,
              pad + 5 * sc,
              pad + 13 * sc,
            );
            ctx.fillStyle = st?.thermalState === "cooldown"
              ? "#ff7b72"
              : st?.thermalState === "throttled"
                ? "#d29922"
                : "#8b949e";
            const cropTag = st && st.cropY !== 0 ? ` Y${st.cropY > 0 ? "+" : ""}${st.cropY}` : "";
            ctx.fillText(
              `${w}×${h} ${fa.skipped ? "SKIP" : fa.codec === "DCT_SPARSE_BLOCK" ? "DCT" : "RAW"} · ${attSrc}${cropTag}`,
              pad + 5 * sc,
              pad + 27 * sc,
            );
            ctx.restore();
          }
        }
      }
      rafId = window.requestAnimationFrame(draw);
    };

    rafId = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(rafId);
  }, [applyBrowserWarp, stabMode, vfovDeg, showHud, streaming, host]);

  useEffect(() => {
    return () => {
      lastBitmapRef.current?.close();
      lastBitmapRef.current = null;
    };
  }, []);

  async function runAction(action: NonNullable<typeof busy>, work: () => Promise<void>) {
    setBusy(action);
    try {
      await work();
    } catch (err) {
      const context = {
        stream: "Camera stream",
        power: "Camera power",
        flash: "Camera USB flash",
        apply: "Camera settings",
      }[action];
      onNotice(`${context}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function post<T extends { ok?: boolean; message?: string; error?: string }>(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const query = new URLSearchParams({ host });
    const res = await fetch(`/api/bridge/cam/${action}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json() as T;
    if (!res.ok || result.ok === false) {
      throw new Error(result.error ?? result.message ?? `Bridge returned HTTP ${res.status}`);
    }
    return result;
  }

  function handleStartStop() {
    return runAction("stream", async () => {
      if (directUsbConnected || runtimeMode === "standalone") {
        if (streaming) {
          await webSerialCam.stopStream();
          clearPreview();
          onNotice("Camera stream stopped (Web Serial). Returning to Cool Idle.");
          setStreaming(false);
        } else {
          if (!webSerialCam.isConnected()) {
            await connectDirectUsb();
          }
          await webSerialCam.startStream();
          setStreaming(true);
        }
        await fetchStatus(false);
        return;
      }
      if (streaming) {
        await post("stop");
        clearPreview();
        onNotice("Camera stream stopped. The sensor returns to Cool Idle after its viewer timeout.");
      } else {
        await post("start", { transport });
      }
      setStreaming(!streaming);
      await fetchStatus(false);
    });
  }

  function clearPreview() {
    lastBitmapRef.current?.close();
    lastBitmapRef.current = null;
    lastFrameIdRef.current = 0;
  }

  function handlePower(mode: "idle" | "sleep" | "wake", via: "auto" | "usb" = "auto") {
    return runAction("power", async () => {
      if (directUsbConnected || runtimeMode === "standalone") {
        const result = await webSerialCam.setPower(mode);
        if (mode !== "wake") {
          setStreaming(false);
          clearPreview();
        }
        onNotice(result.message);
        await fetchStatus(false);
        return;
      }
      const result = await post("power", { mode, via });
      if (mode !== "wake") {
        setStreaming(false);
        clearPreview();
      }
      onNotice(result.message ?? "Camera power state updated.");
      await fetchStatus(false);
    });
  }

  function handleFlashUsb() {
    const port = status?.usbPort;
    if (!port || !window.confirm(`Write ESP32-CAM firmware over USB on ${port}?`)) return;
    return runAction("flash", async () => {
      const result = await post<{ ok?: boolean; job?: CamStatus["flashJob"]; error?: string }>("flash", { confirmed: true, port });
      onNotice(result.job?.message ?? "Starting ESP32-CAM USB flash.");
      await fetchStatus(false);
    });
  }

  function handleApply() {
    return runAction("apply", async () => {
      if (directUsbConnected || runtimeMode === "standalone") {
        if (configPending) {
          await webSerialCam.setConfig(configPatch);
          setLastApplied({ host, config });
        }
        onNotice("Camera settings applied via Web Serial.");
        await fetchStatus(false);
        return;
      }
      if (configPending) {
        await post("config", configPatch);
        setLastApplied({ host, config });
      }
      if (transportPending) {
        await post("start", { transport });
      }
      onNotice("Camera settings applied.");
      await fetchStatus(false);
    });
  }

  function discardChanges() {
    if (configPending) writeCameraConfig(settings, baselineConfig);
    if (transportPending) settings.set(CAMERA_SETTING.transport, status.transportPreference);
  }

  const job = status?.flashJob;
  const flashing = job?.status === "running";
  const actionsDisabled = busy !== null || flashing;
  const sleep = status?.powerMode === "sleep";
  const statusLabel = sleep ? "Deep Sleep"
    : status?.powerMode === "cooldown" ? "Thermal Cooldown"
    : status?.powerMode === "ota_stub" ? "OTA Stub"
    : status?.powerMode === "idle" ? "Cool Idle"
    : status?.powerMode === "streaming" ? "Streaming"
    : streaming ? "Connecting" : status?.usbPort ? "USB ready" : status?.available ? "Reachable" : "Offline";
  const bitrate = status?.kbps ?? 0;
  const rawBitrate = status?.rawKbps ?? 0;
  const savings = status?.savingsPct ?? 0;
  const attitude = status?.telemSource && status.telemSource !== "none"
    ? status.telemSource.toUpperCase()
    : robotConnected ? "BalaX" : "None";
  const dimLabel = status && status.width > 0 && status.height > 0
    ? `${status.width}×${status.height}`
    : `${frameAttitudeRef.current.width}×${frameAttitudeRef.current.height}`;
  const thermalColor = status?.thermalState === "cooldown"
    ? "#ff7b72"
    : status?.thermalState === "throttled"
      ? "#d29922"
      : undefined;

  return (
    <div className="camera-panel">
      <div className="camera-state">
        <span className={`badge ${status?.available && !sleep && status.powerMode !== "cooldown" ? "online" : "offline"}`}>{statusLabel}</span>
        <span>
          {host}
          {status?.rssi != null && status.rssi !== 0 ? ` · ${status.rssi} dBm` : ""}
          {status?.dieTempC != null ? ` · ${status.dieTempC}°C` : ""}
        </span>
      </div>

      {job && (
        <div className="camera-flash-progress">
          <span>{job.message}</span>
          <progress value={job.progress} max={100} aria-label="ESP32-CAM job progress" />
        </div>
      )}

      <canvas ref={canvasRef} className="camera-preview" width={320} height={240} aria-label="Live camera preview" />

      <dl className="foss-earth-choices camera-metrics">
        <div>
          <dt>Stream</dt>
          <dd>{dimLabel} · {status?.fps.toFixed(1) ?? "0.0"} fps · {TRANSPORT_LABEL[status?.activeTransport ?? "none"]}</dd>
        </div>
        <div>
          <dt>Wire / raw</dt>
          <dd>
            {bitrate} / {rawBitrate} kbps{savings > 0 ? ` (−${savings}%)` : ""}
            {status?.effectiveQuality != null ? ` · QS ${status.effectiveQuality}` : ""}
          </dd>
        </div>
        <div>
          <dt>Stabilization</dt>
          <dd>
            {STAB_LABEL[stabMode]}
            {status && status.cropY !== 0 ? ` · Y${status.cropY > 0 ? "+" : ""}${status.cropY}px` : ""}
          </dd>
        </div>
        <div>
          <dt>Thermal / CPU</dt>
          <dd style={thermalColor ? { color: thermalColor } : undefined}>
            {status?.dieTempC != null ? `${status.dieTempC}°C` : "—"}
            {status?.cpuMhz != null ? ` · ${status.cpuMhz} MHz${status.cpuDfs ? " DFS" : ""}` : ""}
            {status?.thermalState && status.thermalState !== "ok" ? ` (${status.thermalState.toUpperCase()})` : ""}
          </dd>
        </div>
        {status?.codecMode === "DCT_SPARSE_BLOCK" && (
          <div><dt>DCT blocks</dt><dd>{status.changedBlocks} / {status.totalBlocks || "—"}</dd></div>
        )}
        <div>
          <dt>Attitude</dt>
          <dd>
            {attitude}
            {status && status.txDrops > 0 ? ` · ${status.txDrops} TX drops` : ""}
          </dd>
        </div>
      </dl>

      <div className="foss-earth-choices camera-actions">
        <button type="button" className={`${CAMERA_ACTION}${streaming ? "" : " primary"}`} disabled={actionsDisabled} onClick={() => void handleStartStop()}>
          {streaming ? "Stop stream" : "Start stream"}
        </button>
        {hasWebSerial() && (directUsbConnected || runtimeMode === "standalone") && (
          <button
            type="button"
            className={CAMERA_ACTION}
            disabled={actionsDisabled}
            onClick={() => void runAction("stream", async () => {
              if (directUsbConnected) {
                clearPreview();
                await disconnectDirectUsb();
                onNotice("Disconnected ESP32-FPV Web Serial port.");
              } else {
                await connectDirectUsb();
              }
            })}
          >
            {directUsbConnected ? "Disconnect USB" : "Connect USB (Web Serial)"}
          </button>
        )}
        <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled || sleep || (!configPending && !transportPending)}
          onClick={() => void handleApply()}>
          {busy === "apply" ? "Applying…" : "Apply to camera"}
        </button>
        {(configPending || transportPending) && (
          <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled} onClick={discardChanges}>Discard</button>
        )}
        <span className="camera-pending" role="status">
          {configPending || transportPending ? "Changes pending" : ""}
          {sleep && (configPending || transportPending) ? " · Wake camera to apply" : ""}
        </span>
      </div>

      {sectionsView && (
        <>
          <AdoptedElement element={sectionsView.element} />
          {createPortal(
            <>
              <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled || sleep} onClick={() => void handlePower("idle")}>Cool Idle</button>
              <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled || sleep} onClick={() => void handlePower("sleep")}>Deep Sleep</button>
              {status?.usbPort && (
                <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled} onClick={() => void handlePower("wake", "usb")}>Wake USB</button>
              )}
              {runtimeMode === "bridge" && status?.usbPort && status.flashReady && (
                <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled} onClick={() => void handleFlashUsb()}>Flash Cam USB</button>
              )}
              {(runtimeMode === "standalone" || directUsbConnected) && hasWebSerial() && (
                <button type="button" className={CAMERA_ACTION} disabled={actionsDisabled} onClick={() => void handlePower("wake", "usb")}>Wake USB</button>
              )}
            </>,
            sectionsView.powerActions,
          )}
        </>
      )}
    </div>
  );
}
