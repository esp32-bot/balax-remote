import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BalaXArtifactMeta,
  IndexedDbArtifactStore,
  computeRetentionScore,
  sha256Hex,
} from "@g-ai/rc";
import type { CamOtaInfoResponse } from "./cameraProtocol";
import { DEFAULT_CAMERA_HOST } from "./cameraSettings";
import { BrowserWebSerialFlashCard } from "./BrowserWebSerialFlashCard";
import { detectRuntimeMode } from "./runtimeMode";

interface CamOtaSectionProps {
  fwStore: IndexedDbArtifactStore;
  cachedFw: BalaXArtifactMeta[];
  onRefreshCache: () => Promise<void>;
}

function formatAge(ms: number): string {
  if (!ms) return "never";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

export const CamOtaSection: React.FC<CamOtaSectionProps> = ({
  fwStore,
  cachedFw,
  onRefreshCache,
}) => {
  const [camHost, setCamHost] = useState(DEFAULT_CAMERA_HOST);
  const [info, setInfo] = useState<CamOtaInfoResponse | null>(null);
  const [selectedPort, setSelectedPort] = useState("");
  const [usbConfirm, setUsbConfirm] = useState(false);
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string>("");
  const [actionNotice, setActionNotice] = useState<string>("");
  const chainWifiAfterBuildRef = useRef<string | null>(null);
  const lastPowerModeRef = useRef<string>("unknown");

  const refreshInfo = useCallback(async (forceProbe?: boolean) => {
    const mode = await detectRuntimeMode();
    if (mode !== "bridge") return;
    try {
      const probe = forceProbe ?? (lastPowerModeRef.current !== "sleep");
      const qs = new URLSearchParams({ host: camHost.trim() || DEFAULT_CAMERA_HOST, probe: probe ? "1" : "0" });
      const res = await fetch(`/api/bridge/cam/ota/info?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as CamOtaInfoResponse;
      lastPowerModeRef.current = data.powerMode;
      setInfo(data);
      if (data.ports.length > 0) {
        setSelectedPort((prev) => (prev && data.ports.includes(prev) ? prev : data.ports[0]));
      } else {
        setSelectedPort("");
      }
    } catch {
      // ignore transient poll error
    }
  }, [camHost]);

  const jobRunning = info?.job?.status === "running";

  useEffect(() => {
    void refreshInfo();
    const timer = window.setInterval(() => {
      void refreshInfo();
    }, jobRunning ? 450 : 2500);
    return () => window.clearInterval(timer);
  }, [refreshInfo, jobRunning]);

  // Chain Wi-Fi OTA automatically after "Build & Flash Wi-Fi" build finishes
  useEffect(() => {
    const targetBuildId = chainWifiAfterBuildRef.current;
    if (!targetBuildId || !info?.job) return;
    if (info.job.id !== targetBuildId) return;
    if (info.job.status === "done") {
      chainWifiAfterBuildRef.current = null;
      void startWifiOta();
    } else if (info.job.status === "error") {
      chainWifiAfterBuildRef.current = null;
    }
  }, [info?.job]);

  const busy = submitting || jobRunning;

  async function startBuild(andFlashWifi = false) {
    setSubmitting(true);
    setActionError("");
    setActionNotice("");
    try {
      const qs = new URLSearchParams({ host: camHost.trim() || DEFAULT_CAMERA_HOST });
      const res = await fetch(`/api/bridge/cam/ota/build?${qs}`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; job?: { id: string; message?: string }; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Build failed (HTTP ${res.status})`);
      }
      if (andFlashWifi && data.job?.id) {
        chainWifiAfterBuildRef.current = data.job.id;
        setActionNotice("Building balax_cam_fw.bin — Wi-Fi OTA will start automatically when build finishes.");
      } else {
        setActionNotice(data.job?.message || "Building balax_cam_fw.bin…");
      }
      await refreshInfo(false);
    } catch (err) {
      chainWifiAfterBuildRef.current = null;
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function startWifiOta(customBytes?: Uint8Array, customName?: string) {
    setSubmitting(true);
    setActionError("");
    setActionNotice("");
    try {
      const qs = new URLSearchParams({ host: camHost.trim() || DEFAULT_CAMERA_HOST });
      if (customName) qs.set("filename", customName);
      let res: Response;
      if (customBytes) {
        const copy = new Uint8Array(customBytes.byteLength);
        copy.set(customBytes);
        res = await fetch(`/api/bridge/cam/ota?${qs}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": customName || "custom.bin",
          },
          body: copy,
        });
      } else {
        res = await fetch(`/api/bridge/cam/ota?${qs}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: camHost.trim() || DEFAULT_CAMERA_HOST }),
        });
      }
      const data = (await res.json()) as { ok?: boolean; job?: { message?: string }; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Wi-Fi OTA failed (HTTP ${res.status})`);
      }
      setActionNotice(data.job?.message || "Starting ESP32-CAM Wi-Fi OTA…");
      await refreshInfo(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function startUsbFlash(opts: { full?: boolean; customBytes?: Uint8Array; customName?: string } = {}) {
    if (!usbConfirm) {
      setActionError("Check the USB flash confirmation box before writing to ESP32-CAM.");
      return;
    }
    if (!selectedPort) {
      setActionError("No ESP32-CAM USB serial port selected.");
      return;
    }
    setSubmitting(true);
    setActionError("");
    setActionNotice("");
    try {
      const qs = new URLSearchParams({
        host: camHost.trim() || DEFAULT_CAMERA_HOST,
        port: selectedPort,
        confirmed: "1",
      });
      if (opts.customName) qs.set("filename", opts.customName);

      let res: Response;
      if (opts.customBytes) {
        const copy = new Uint8Array(opts.customBytes.byteLength);
        copy.set(opts.customBytes);
        res = await fetch(`/api/bridge/cam/flash?${qs}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": opts.customName || "custom.bin",
          },
          body: copy,
        });
      } else {
        res = await fetch(`/api/bridge/cam/flash?${qs}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmed: true,
            port: selectedPort,
            full: Boolean(opts.full),
          }),
        });
      }
      const data = (await res.json()) as { ok?: boolean; job?: { message?: string }; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `USB flash failed (HTTP ${res.status})`);
      }
      setUsbConfirm(false);
      setActionNotice(data.job?.message || "Starting ESP32-CAM USB flash…");
      await refreshInfo(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function cacheUploadedFile(file: File): Promise<Uint8Array> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    await fwStore.put({
      id: `cam-upload-${sha.slice(0, 12)}`,
      name: file.name,
      kind: "firmware",
      channel: "custom",
      sha256: sha,
      rawSize: bytes.byteLength,
      createdAt: Date.now(),
      refetchCost: 2.0,
      pinned: false,
      source: "upload",
      bytes,
    });
    await onRefreshCache();
    return bytes;
  }

  async function flashCustom(via: "wifi" | "usb") {
    if (!customFile) return;
    try {
      const bytes = await cacheUploadedFile(customFile);
      if (via === "wifi") {
        await startWifiOta(bytes, customFile.name);
      } else {
        await startUsbFlash({ customBytes: bytes, customName: customFile.name });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function flashCached(sha256: string, via: "wifi" | "usb") {
    const art = await fwStore.get(sha256);
    if (!art) return;
    await onRefreshCache();
    if (via === "wifi") {
      await startWifiOta(art.bytes, art.name);
    } else {
      await startUsbFlash({ customBytes: art.bytes, customName: art.name });
    }
  }

  const job = info?.job ?? null;
  const ports = info?.ports ?? [];
  const thermalColor = info?.thermalState === "cooldown"
    ? "#f85149"
    : info?.thermalState === "throttled"
      ? "#d29922"
      : "#3fb950";
  const slotLabel = info?.isStub
    ? "factory (OTA Stub)"
    : info?.runningPartition
      ? info.runningPartition
      : info?.available
        ? info.powerMode
        : ports.length > 0
          ? "USB Ready"
          : "Offline";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Camera Status Checklist */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${info?.available || ports.length > 0 ? "rgba(63,185,80,0.4)" : "rgba(248,81,73,0.45)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>ESP32-CAM / Slot</div>
          <strong style={{ color: info?.available || ports.length > 0 ? "#3fb950" : "#f85149" }}>
            {slotLabel}
          </strong>
        </div>

        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${info?.thermalState === "ok" || !info ? "rgba(63,185,80,0.4)" : "rgba(210,153,34,0.55)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Die Thermal</div>
          <strong style={{ color: info?.dieTempC != null ? thermalColor : "var(--muted)" }}>
            {info?.dieTempC != null ? `${info.dieTempC}°C (${info.thermalState})` : "—"}
          </strong>
        </div>

        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${info?.ip || ports.length > 0 ? "rgba(88,166,255,0.4)" : "rgba(48,54,61,0.7)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Link</div>
          <strong style={{ color: info?.ip ? "#79c0ff" : ports.length > 0 ? "#3fb950" : "var(--muted)" }}>
            {info?.ip ? `Wi-Fi · ${ports.length} USB` : ports.length > 0 ? `${ports.length} USB port` : "None"}
          </strong>
        </div>
      </div>

      <BrowserWebSerialFlashCard
        target="cam"
        fwStore={fwStore}
        cachedFw={cachedFw}
        onComplete={(msg) => setActionNotice(msg)}
      />

      {/* Live ESP32-CAM Build / USB Flash / Wi-Fi OTA Progress */}
      {job && (
        <div
          style={{
            background:
              job.status === "error"
                ? "rgba(248, 81, 73, 0.12)"
                : job.status === "done"
                  ? "rgba(63, 185, 80, 0.12)"
                  : "rgba(88, 166, 255, 0.12)",
            border:
              job.status === "error"
                ? "1px solid rgba(248, 81, 73, 0.5)"
                : job.status === "done"
                  ? "1px solid rgba(63, 185, 80, 0.5)"
                  : "1px solid rgba(88, 166, 255, 0.5)",
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong
              style={{
                color: job.status === "error" ? "#f85149" : job.status === "done" ? "#3fb950" : "#79c0ff",
              }}
            >
              {job.message}
            </strong>
            <span style={{ color: "var(--muted)", fontSize: "0.72rem", whiteSpace: "nowrap" }}>
              {job.status === "running" ? `${job.progress}% · ${job.phase}` : job.status.toUpperCase()}
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: "rgba(13, 17, 23, 0.85)",
              overflow: "hidden",
              border: "1px solid rgba(48, 54, 61, 0.8)",
            }}
          >
            <div
              style={{
                width: `${Math.max(2, Math.min(100, job.progress))}%`,
                height: "100%",
                background:
                  job.status === "error" ? "#f85149" : job.status === "done" ? "#3fb950" : "#58a6ff",
                transition: "width 180ms ease-out",
              }}
            />
          </div>
          {job.error && (
            <div style={{ color: "#fca5a5", fontSize: "0.72rem", whiteSpace: "pre-wrap" }}>
              {job.error}
            </div>
          )}
          {job.detail && (
            <pre
              style={{
                margin: 0,
                fontSize: "0.68rem",
                color: "#c9d1d9",
                whiteSpace: "pre-wrap",
                maxHeight: 90,
                overflowY: "auto",
              }}
            >
              {job.detail}
            </pre>
          )}
        </div>
      )}

      {/* USB Flash Card (Primary for USB testing + one-time Full Flash for OTA Stub) */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <strong>USB Flash (ESP32-CAM)</strong>
          <button
            type="button"
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "2px 7px" }}
            onClick={() => void refreshInfo(true)}
          >
            Refresh Ports
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={busy || ports.length === 0}
            style={{
              flex: 1,
              background: "#161b22",
              color: "#e6edf3",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "4px 6px",
              fontSize: "0.73rem",
            }}
          >
            {ports.length === 0 ? (
              <option value="">No USB serial port detected</option>
            ) : (
              ports.map((port) => (
                <option key={port} value={port}>
                  {port}
                </option>
              ))
            )}
          </select>
        </div>

        <div style={{ fontSize: "0.71rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: 2 }}>
          <span>
            App binary (<code>ota_0</code> @ <code>0xB0000</code>):{" "}
            {info?.binary.exists ? (
              <>
                <strong>{(info.binary.sizeBytes / 1024).toFixed(0)} KB</strong> · #{info.binary.sha256Short} ·{" "}
                {formatAge(info.binary.modifiedAtMs)}
              </>
            ) : (
              <span style={{ color: "#d29922" }}>not built yet</span>
            )}
          </span>
          <span>
            OTA rescue stub (<code>factory</code> @ <code>0x20000</code>):{" "}
            {info?.stubBinary.exists ? (
              <>
                <strong>{(info.stubBinary.sizeBytes / 1024).toFixed(0)} KB</strong> · #{info.stubBinary.sha256Short}
                {info.fullFlashReady ? " · Full Flash Ready" : ""}
              </>
            ) : (
              <span style={{ color: "#d29922" }}>stub binary missing</span>
            )}
          </span>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.72rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={usbConfirm}
            disabled={busy || !selectedPort}
            onChange={(e) => setUsbConfirm(e.target.checked)}
          />
          <span>
            Confirm writing ESP32-CAM flash over USB{selectedPort ? ` (${selectedPort})` : ""}
          </span>
        </label>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            disabled={busy || !usbConfirm || !selectedPort || !info?.binary.exists}
            onClick={() => void startUsbFlash({ full: false })}
            style={{
              background: "rgba(56, 139, 253, 0.2)",
              borderColor: "rgba(56, 139, 253, 0.55)",
              color: "#79c0ff",
              fontWeight: 600,
              padding: "5px 9px",
            }}
          >
            Flash App (ota_0)
          </button>
          <button
            type="button"
            disabled={busy || !usbConfirm || !selectedPort || !info?.fullFlashReady}
            onClick={() => void startUsbFlash({ full: true })}
            style={{
              background: "rgba(63, 185, 80, 0.16)",
              borderColor: "rgba(63, 185, 80, 0.5)",
              color: "#3fb950",
              fontWeight: 600,
              padding: "5px 9px",
            }}
          >
            Full Flash (Boot + OTA Stub + App)
          </button>
        </div>

        <div style={{ fontSize: "0.69rem", color: "var(--muted)" }}>
          Use <strong>Full Flash</strong> once over USB to install the 576 KB <code>factory</code> OTA rescue stub so
          future Wi-Fi LAN OTA updates work wirelessly without USB.
        </div>
      </div>

      {/* Wi-Fi LAN OTA Card */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <strong>Wi-Fi LAN OTA (Two-Stage Compact)</strong>
          <input
            type="text"
            value={camHost}
            disabled={busy}
            onChange={(e) => setCamHost(e.target.value)}
            aria-label="ESP32-CAM host"
            style={{
              width: 145,
              background: "#161b22",
              color: "#e6edf3",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "2px 6px",
              fontSize: "0.71rem",
            }}
          />
        </div>

        <div style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
          Reboots <code>{camHost || DEFAULT_CAMERA_HOST}</code> into the low-power <code>factory</code> OTA stub
          (OV2640 off), pushes <code>zlib</code>-compressed firmware with 4 KB sector-skip + SHA-256 verification, and
          reboots into <code>ota_0</code>.
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            disabled={busy || !info?.available}
            onClick={() => void startBuild(true)}
            style={{
              background: "rgba(56, 139, 253, 0.2)",
              borderColor: "rgba(56, 139, 253, 0.55)",
              color: "#79c0ff",
              fontWeight: 600,
              padding: "5px 9px",
            }}
          >
            Build &amp; Flash Wi-Fi
          </button>
          <button
            type="button"
            disabled={busy || !info?.available || !info?.binary.exists}
            onClick={() => void startWifiOta()}
            style={{ padding: "5px 9px" }}
          >
            Flash Built .bin (Wi-Fi)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void startBuild(false)}
            style={{ padding: "5px 9px" }}
          >
            Build Only
          </button>
        </div>
      </div>

      {/* Custom .bin Upload Card */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <strong>Custom ESP32-CAM .bin Upload</strong>
        <input
          type="file"
          accept=".bin,application/octet-stream"
          disabled={busy}
          onChange={(e) => setCustomFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: "0.72rem" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            disabled={busy || !customFile || !info?.available}
            onClick={() => void flashCustom("wifi")}
            style={{ padding: "4px 8px" }}
          >
            Flash Wi-Fi OTA
          </button>
          <button
            type="button"
            disabled={busy || !customFile || !usbConfirm || !selectedPort}
            onClick={() => void flashCustom("usb")}
            style={{ padding: "4px 8px" }}
          >
            Flash USB (ota_0)
          </button>
        </div>
      </div>

      {/* Browser Firmware Cache */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <strong>Browser Firmware Cache ({cachedFw.length} · Offline)</strong>
          {cachedFw.length > 0 && (
            <button
              type="button"
              style={{ fontSize: "0.68rem", padding: "2px 6px" }}
              onClick={() => void fwStore.clearUnpinned().then(onRefreshCache)}
            >
              Evict Unpinned
            </button>
          )}
        </div>
        {cachedFw.length === 0 ? (
          <div style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
            Upload a `.bin` file above to cache it in this browser for offline Wi-Fi or USB flashing.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 110, overflowY: "auto" }}>
            {cachedFw.map((fw) => (
              <div
                key={fw.sha256}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  fontSize: "0.71rem",
                  borderTop: "1px solid rgba(33,38,45,0.6)",
                  paddingTop: 3,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {fw.pinned ? "📌 " : ""}
                  <strong>{fw.name}</strong> ({(fw.rawSize / 1024).toFixed(0)} KB · score{" "}
                  {Number.isFinite(computeRetentionScore(fw)) ? computeRetentionScore(fw).toFixed(1) : "∞"})
                </span>
                <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void fwStore.setPinned(fw.sha256, !fw.pinned).then(onRefreshCache)}
                  >
                    {fw.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !info?.available}
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void flashCached(fw.sha256, "wifi")}
                  >
                    Wi-Fi
                  </button>
                  <button
                    type="button"
                    disabled={busy || !usbConfirm || !selectedPort}
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void flashCached(fw.sha256, "usb")}
                  >
                    USB
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {(actionError || actionNotice) && (
        <div
          style={{
            background: actionError ? "rgba(248, 81, 73, 0.12)" : "rgba(88, 166, 255, 0.12)",
            border: actionError ? "1px solid rgba(248, 81, 73, 0.5)" : "1px solid rgba(88, 166, 255, 0.45)",
            borderRadius: 6,
            padding: "7px 9px",
            color: actionError ? "#f85149" : "#79c0ff",
            fontSize: "0.73rem",
          }}
        >
          {actionError || actionNotice}
        </div>
      )}
    </div>
  );
};
