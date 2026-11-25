import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BalaXArtifactMeta,
  IndexedDbArtifactStore,
  computeRetentionScore,
  downloadAndCacheGitHubFirmware,
  sha256Hex,
} from "@g-ai/rc";
import { UsbFlashCard, useUsbFlash } from "./UsbFlashCard";
import { CamOtaSection } from "./CamOtaSection";
import { BrowserWebSerialFlashCard } from "./BrowserWebSerialFlashCard";
import { detectRuntimeMode } from "./runtimeMode";
import type { OtaJobSnapshot } from "./otaProtocol";

export interface OtaHealth {
  pmicC: number | null;
  imuC: number | null;
  batteryPct: number | null;
  batteryMa: number | null;
  usbV: number | null;
  cpuMhz: number | null;
  cpu0Load: number | null;
  cpu1Load: number | null;
  wifiPs: string | null;
  updatedAtMs: number;
}

interface BinaryMeta {
  exists: boolean;
  sizeBytes: number;
  modifiedAtMs: number;
  sha256Short: string;
}

interface OtaInfoResponse {
  robotIp: string;
  connected: boolean;
  otaBusy: boolean;
  buildBusy: boolean;
  otaJob?: OtaJobSnapshot | null;
  robotPartition: string | null;
  robotVersion: string | null;
  binary: BinaryMeta;
  health: OtaHealth | null;
  limits: {
    minBatteryPct: number;
    maxPmicC: number;
    maxImuC: number;
  };
}

interface OtaPanelProps {
  connected: boolean;
  health: OtaHealth | null;
  targetHost: string;
  otaJob?: OtaJobSnapshot | null;
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

export const OtaPanel: React.FC<OtaPanelProps> = ({
  connected,
  health,
  targetHost,
  otaJob,
}) => {
  const [targetDevice, setTargetDevice] = useState<"balax" | "cam">("balax");
  const [info, setInfo] = useState<OtaInfoResponse | null>(null);
  const fwStoreRef = useRef<IndexedDbArtifactStore | null>(null);
  if (!fwStoreRef.current) fwStoreRef.current = new IndexedDbArtifactStore();
  const [cachedFw, setCachedFw] = useState<BalaXArtifactMeta[]>([]);
  const [ghChannel, setGhChannel] = useState<"stable" | "dev">("stable");
  const [ghBusy, setGhBusy] = useState(false);
  const [camStatus, setCamStatus] = useState<{ available: boolean; host: string; message?: string }>({
    available: false,
    host: "balax-cam.local",
    message: "ESP32-CAM not connected (optional)",
  });

  const refreshFwCache = useCallback(async () => {
    try {
      setCachedFw(await fwStoreRef.current!.list("firmware"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshFwCache();
    fetch("/api/bridge/cam/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setCamStatus(j); })
      .catch(() => {});
  }, [refreshFwCache]);
  const [phase, setPhase] = useState<"idle" | "building" | "flashing" | "done" | "error">("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [detailLog, setDetailLog] = useState<string>("");
  const [forceOverride, setForceOverride] = useState(false);
  const [customFile, setCustomFile] = useState<File | null>(null);
  const usb = useUsbFlash();

  const refreshInfo = useCallback(async () => {
    const mode = await detectRuntimeMode();
    if (mode !== "bridge") return;
    try {
      const res = await fetch("/api/bridge/ota/info");
      if (!res.ok) return;
      const data = (await res.json()) as OtaInfoResponse;
      setInfo(data);
    } catch {
      // ignore transient poll error
    }
  }, []);

  useEffect(() => {
    void refreshInfo();
    const id = window.setInterval(() => void refreshInfo(), 4000);
    return () => window.clearInterval(id);
  }, [refreshInfo, connected]);

  useEffect(() => {
    if (phase !== "building" && phase !== "flashing") return;
    const t0 = Date.now();
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const effectiveHealth = health ?? info?.health ?? null;
  const minBat = info?.limits.minBatteryPct ?? 30;
  const maxPmic = info?.limits.maxPmicC ?? 46;
  const maxImu = info?.limits.maxImuC ?? 58;

  const blockers: string[] = [];
  if (!connected) {
    blockers.push(`Robot (${targetHost}) is offline — power on & connect first`);
  }
  if (effectiveHealth?.batteryPct !== null && effectiveHealth?.batteryPct !== undefined && effectiveHealth.batteryPct < minBat) {
    blockers.push(`Battery is ${effectiveHealth.batteryPct.toFixed(0)}% (minimum ${minBat}%)`);
  }
  if (effectiveHealth?.pmicC !== null && effectiveHealth?.pmicC !== undefined && effectiveHealth.pmicC >= maxPmic) {
    blockers.push(`PMIC is ${effectiveHealth.pmicC.toFixed(1)}°C (must be < ${maxPmic}°C)`);
  }
  if (effectiveHealth?.imuC !== null && effectiveHealth?.imuC !== undefined && effectiveHealth.imuC >= maxImu) {
    blockers.push(`IMU is ${effectiveHealth.imuC.toFixed(1)}°C (must be < ${maxImu}°C)`);
  }

  const safetyBlocked = blockers.filter((b) => !b.includes("offline")).length > 0;
  const liveOtaJob = otaJob ?? info?.otaJob ?? null;
  const wifiBusy = phase === "building" || phase === "flashing" || Boolean(liveOtaJob?.active) || Boolean(info?.otaBusy) || Boolean(info?.buildBusy);
  const busy = wifiBusy || usb.pending;
  const canFlashLocal = connected && Boolean(info?.binary.exists) && !busy && (!safetyBlocked || forceOverride);
  const canFlashCustom = connected && Boolean(customFile) && !busy && (!safetyBlocked || forceOverride);

  async function runBuild(): Promise<boolean> {
    setPhase("building");
    setStatusMsg("Compiling BalaX firmware (tools/bx build)...");
    setDetailLog("");
    try {
      const res = await fetch("/api/bridge/ota/build", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        output?: string;
        error?: string;
        durationSec?: number;
        binary?: BinaryMeta;
      };
      if (!res.ok || !data.ok) {
        setPhase("error");
        setStatusMsg("Build failed");
        setDetailLog(data.output || data.error || `HTTP ${res.status}`);
        return false;
      }
      setPhase("done");
      setStatusMsg(
        `Built balax.bin (${((data.binary?.sizeBytes ?? 0) / 1024).toFixed(0)} KB) in ${data.durationSec ?? "?"}s`
      );
      setDetailLog(data.output || "");
      await refreshInfo();
      return true;
    } catch (err) {
      setPhase("error");
      setStatusMsg(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function runFlash(file: File | null = null): Promise<void> {
    setPhase("flashing");
    setStatusMsg(
      file
        ? `Uploading ${file.name} (${(file.size / 1024).toFixed(0)} KB) to ${targetHost}...`
        : `Flashing balax.bin to ${targetHost} over Wi-Fi (HMAC-SHA256 verified)...`
    );
    setDetailLog("");
    try {
      const url = `/api/bridge/ota?force=${forceOverride ? "1" : "0"}`;
      const res = file
        ? await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: await file.arrayBuffer(),
          })
        : await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: forceOverride }),
          });
      const data = (await res.json()) as {
        ok?: boolean;
        blocked?: boolean;
        blockers?: string[];
        partition?: string;
        compressed?: boolean;
        wireBytes?: number;
        sizeBytes?: number;
        sectors_erased?: number;
        sectors_skipped?: number;
        flash_erases_total?: number;
        durationSec?: number;
        kbps?: number;
        error?: string;
      };
      if (res.status === 412 && data.blocked) {
        setPhase("error");
        setStatusMsg("Blocked by pre-flight safety check");
        setDetailLog((data.blockers || []).join("\n"));
        return;
      }
      if (!res.ok || !data.ok) {
        setPhase("error");
        setStatusMsg("Wi-Fi OTA failed");
        setDetailLog(data.error || `HTTP ${res.status}`);
        return;
      }
      setPhase("done");
      setForceOverride(false);
      const compNote = data.compressed && data.wireBytes && data.sizeBytes
        ? ` · zlib-9 ${(data.wireBytes / 1024).toFixed(0)}/${(data.sizeBytes / 1024).toFixed(0)} KB`
        : "";
      const wearNote = data.sectors_skipped !== undefined
        ? ` · sectors: ${data.sectors_erased ?? 0} erased, ${data.sectors_skipped} skipped`
        : "";
      setStatusMsg(
        `Flashed to '${data.partition ?? "ota"}' in ${data.durationSec ?? "?"}s (${data.kbps ?? "?"} KB/s${compNote}${wearNote}) — rebooting!`
      );
      setDetailLog(
        `Cumulative flash sector erases: ${data.flash_erases_total ?? "—"}. Waiting for BalaX to reconnect...`
      );
      setTimeout(() => void refreshInfo(), 5000);
    } catch (err) {
      setPhase("error");
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function runBuildAndFlash() {
    const ok = await runBuild();
    if (ok) {
      await runFlash(null);
    }
  }

  async function fetchGitHubAndCache(andFlash: boolean) {
    setGhBusy(true);
    setPhase("flashing");
    setStatusMsg(`Fetching GitHub '${ghChannel}' release in browser (zero TLS on robot)...`);
    setDetailLog("");
    try {
      const { manifest, artifact, fromCache } = await downloadAndCacheGitHubFirmware(ghChannel, fwStoreRef.current!);
      await refreshFwCache();
      setStatusMsg(
        `${fromCache ? "Loaded from Browser Cache" : "Downloaded & SHA-256 verified"}: ${manifest.version} (${(artifact.rawSize / 1024).toFixed(0)} KB)`
      );
      setPhase("done");
      if (andFlash) {
        const copy = new Uint8Array(artifact.bytes.byteLength);
        copy.set(artifact.bytes);
        const f = new File([copy.buffer], artifact.name, { type: "application/octet-stream" });
        await runFlash(f);
      }
    } catch (err) {
      setPhase("error");
      setStatusMsg("GitHub release fetch failed");
      setDetailLog(err instanceof Error ? err.message : String(err));
    } finally {
      setGhBusy(false);
    }
  }

  async function flashFromBrowserCache(sha256: string) {
    const art = await fwStoreRef.current!.get(sha256);
    if (!art) return;
    await refreshFwCache();
    const copy = new Uint8Array(art.bytes.byteLength);
    copy.set(art.bytes);
    const f = new File([copy.buffer], art.name, { type: "application/octet-stream" });
    await runFlash(f);
  }

  async function cacheCustomFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    await fwStoreRef.current!.put({
      id: `upload-${sha.slice(0, 12)}`,
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
    await refreshFwCache();
  }

  const batOk =
    effectiveHealth?.batteryPct === null ||
    effectiveHealth?.batteryPct === undefined ||
    effectiveHealth.batteryPct >= minBat;
  const tempOk =
    (effectiveHealth?.pmicC === null ||
      effectiveHealth?.pmicC === undefined ||
      effectiveHealth.pmicC < maxPmic) &&
    (effectiveHealth?.imuC === null ||
      effectiveHealth?.imuC === undefined ||
      effectiveHealth.imuC < maxImu);

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.78rem" }}>
      {/* Target Device Switcher: BalaX vs ESP32-CAM */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 4,
        }}
      >
        <button
          type="button"
          onClick={() => setTargetDevice("balax")}
          style={{
            padding: "5px 8px",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: "0.74rem",
            background: targetDevice === "balax" ? "rgba(56, 139, 253, 0.22)" : "transparent",
            borderColor: targetDevice === "balax" ? "rgba(56, 139, 253, 0.55)" : "transparent",
            color: targetDevice === "balax" ? "#79c0ff" : "var(--muted)",
          }}
        >
          BalaX (M5StickC Plus)
        </button>
        <button
          type="button"
          onClick={() => setTargetDevice("cam")}
          style={{
            padding: "5px 8px",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: "0.74rem",
            background: targetDevice === "cam" ? "rgba(56, 139, 253, 0.22)" : "transparent",
            borderColor: targetDevice === "cam" ? "rgba(56, 139, 253, 0.55)" : "transparent",
            color: targetDevice === "cam" ? "#79c0ff" : "var(--muted)",
          }}
        >
          ESP32-CAM (OV2640)
        </button>
      </div>

      {targetDevice === "cam" ? (
        <CamOtaSection
          fwStore={fwStoreRef.current!}
          cachedFw={cachedFw}
          onRefreshCache={refreshFwCache}
        />
      ) : (
        <>
      <BrowserWebSerialFlashCard
          target="stickc"
          fwStore={fwStoreRef.current!}
          cachedFw={cachedFw}
          onComplete={(msg) => {
            setPhase("done");
            setStatusMsg(msg);
          }}
        />
        <UsbFlashCard usb={usb} wifiBusy={wifiBusy} />
      {/* Pre-flight Safety Checklist */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
        }}
      >
        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${connected ? "rgba(63,185,80,0.4)" : "rgba(248,81,73,0.45)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Robot / Slot</div>
          <strong style={{ color: connected ? "#3fb950" : "#f85149" }}>
            {connected ? info?.robotPartition || "Online" : "Offline"}
          </strong>
        </div>
        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${batOk ? "rgba(63,185,80,0.4)" : "rgba(248,81,73,0.6)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Battery (≥{minBat}%)</div>
          <strong style={{ color: batOk ? "#3fb950" : "#f85149" }}>
            {effectiveHealth?.batteryPct !== null && effectiveHealth?.batteryPct !== undefined
              ? `${effectiveHealth.batteryPct.toFixed(0)}%`
              : "—"}
          </strong>
        </div>
        <div
          style={{
            background: "#0d1117",
            border: `1px solid ${tempOk ? "rgba(63,185,80,0.4)" : "rgba(248,81,73,0.6)"}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>PMIC / IMU</div>
          <strong style={{ color: tempOk ? "#3fb950" : "#f85149" }}>
            {effectiveHealth?.pmicC !== null && effectiveHealth?.pmicC !== undefined
              ? `${effectiveHealth.pmicC.toFixed(0)}°/${effectiveHealth.imuC != null ? effectiveHealth.imuC.toFixed(0) : "—"}°C`
              : "—"}
          </strong>
        </div>
      </div>

      {/* Live Wi-Fi OTA / Build Progress (synced from bridge for all tabs & CLI/agent updates) */}
      {liveOtaJob && (
        <div
          style={{
            background:
              liveOtaJob.status === "error"
                ? "rgba(248, 81, 73, 0.12)"
                : liveOtaJob.status === "done"
                  ? "rgba(63, 185, 80, 0.12)"
                  : "rgba(88, 166, 255, 0.12)",
            border:
              liveOtaJob.status === "error"
                ? "1px solid rgba(248, 81, 73, 0.5)"
                : liveOtaJob.status === "done"
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
                color:
                  liveOtaJob.status === "error"
                    ? "#f85149"
                    : liveOtaJob.status === "done"
                      ? "#3fb950"
                      : "#79c0ff",
              }}
            >
              {liveOtaJob.message}
            </strong>
            <span style={{ color: "var(--muted)", fontSize: "0.72rem", whiteSpace: "nowrap" }}>
              {liveOtaJob.active ? `${liveOtaJob.progress}%` : liveOtaJob.status.toUpperCase()}
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
                width: `${Math.max(2, Math.min(100, liveOtaJob.progress))}%`,
                height: "100%",
                background:
                  liveOtaJob.status === "error"
                    ? "#f85149"
                    : liveOtaJob.status === "done"
                      ? "#3fb950"
                      : "#58a6ff",
                transition: "width 180ms ease-out",
              }}
            />
          </div>
          {liveOtaJob.error && (
            <div style={{ color: "#fca5a5", fontSize: "0.72rem", whiteSpace: "pre-wrap" }}>
              {liveOtaJob.error}
            </div>
          )}
        </div>
      )}

      {/* Wi-Fi OTA from the laptop build */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid #21262d",
          borderRadius: 8,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Wi-Fi OTA · Local laptop build (<code>balax.bin</code>)</strong>
          <span style={{ color: "var(--muted)", fontSize: "0.72rem" }}>
            {info?.binary.exists
              ? `${(info.binary.sizeBytes / 1024).toFixed(0)} KB · ${formatAge(info.binary.modifiedAtMs)} · #${info.binary.sha256Short}`
              : "Not built yet"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            className="primary"
            disabled={!connected || busy || (safetyBlocked && !forceOverride)}
            style={{ padding: "5px 11px", fontSize: "0.77rem", fontWeight: 600 }}
            onClick={() => void runBuildAndFlash()}
          >
            {liveOtaJob?.active
              ? liveOtaJob.phase === "building"
                ? "Building..."
                : `Flashing ${liveOtaJob.progress}%...`
              : phase === "building"
                ? `Building... (${elapsedSec}s)`
                : phase === "flashing"
                  ? `Flashing... (${elapsedSec}s)`
                  : "Build & Flash"}
          </button>
          <button
            disabled={!canFlashLocal}
            style={{ padding: "5px 10px", fontSize: "0.77rem" }}
            onClick={() => void runFlash(null)}
          >
            Flash Built `.bin`
          </button>
          <button
            disabled={busy}
            style={{ padding: "5px 10px", fontSize: "0.77rem" }}
            onClick={() => void runBuild()}
          >
            Build Only
          </button>
        </div>

        {safetyBlocked && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              borderRadius: 6,
              background: "rgba(248, 81, 73, 0.14)",
              border: "1px solid rgba(248, 81, 73, 0.45)",
              color: "#fca5a5",
              fontSize: "0.74rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={forceOverride}
              onChange={(e) => setForceOverride(e.target.checked)}
            />
            <span>
              <strong>Override safety gate</strong> ({blockers.filter((b) => !b.includes("offline")).join(" · ")})
            </span>
          </label>
        )}
      </div>

      {/* Upload Any Custom .bin */}
      <div
        style={{
          background: "#0d1117",
          border: "1px solid #21262d",
          borderRadius: 8,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <strong>Or Flash Custom `.bin` File</strong>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".bin"
            onChange={(e) => setCustomFile(e.target.files?.[0] ?? null)}
            style={{ flex: 1, fontSize: "0.74rem", minWidth: 160 }}
          />
          <button
            disabled={!canFlashCustom}
            style={{ padding: "4px 10px", fontSize: "0.76rem" }}
            onClick={() => customFile && void cacheCustomFile(customFile).then(() => runFlash(customFile))}
          >
            Flash File
          </button>
        </div>
      </div>

      {/* Offloaded GitHub Releases OTA (Browser HTTPS -> SHA-256 -> IndexedDB -> Local LAN zlib OTA) */}
      <div
        style={{
          background: "rgba(22, 27, 34, 0.72)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>GitHub Releases OTA (Offloaded to Browser)</strong>
          <span style={{ fontSize: "0.69rem", color: "#3fb950" }}>0 B TLS on robot</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={ghChannel}
            onChange={(e) => setGhChannel(e.target.value as "stable" | "dev")}
            style={{ fontSize: "0.74rem", padding: "4px 6px" }}
          >
            <option value="stable">stable channel</option>
            <option value="dev">dev channel</option>
          </select>
          <button
            disabled={ghBusy}
            style={{ padding: "4px 9px", fontSize: "0.74rem" }}
            onClick={() => void fetchGitHubAndCache(false)}
          >
            Download & Cache
          </button>
          <button
            disabled={ghBusy || !connected || busy}
            style={{ padding: "4px 9px", fontSize: "0.74rem" }}
            onClick={() => void fetchGitHubAndCache(true)}
          >
            Fetch & Flash
          </button>
        </div>
      </div>

      {/* Browser Cache (IndexedDB · Cost-Aware W-TinyLFU · Offline Ready) + Optional ESP32-CAM SD */}
      <div
        style={{
          background: "rgba(22, 27, 34, 0.72)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <strong>Browser Firmware Cache ({cachedFw.length} · Offline)</strong>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span
              title={camStatus.message}
              style={{
                fontSize: "0.68rem",
                padding: "2px 6px",
                borderRadius: 999,
                background: camStatus.available ? "rgba(63,185,80,0.18)" : "rgba(139,148,158,0.16)",
                color: camStatus.available ? "#3fb950" : "#8b949e",
              }}
            >
              CAM SD: {camStatus.available ? "Online" : "Offline (Optional)"}
            </span>
            {cachedFw.length > 0 && (
              <button
                style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                onClick={() => void fwStoreRef.current!.clearUnpinned().then(refreshFwCache)}
              >
                Evict Unpinned
              </button>
            )}
          </div>
        </div>
        {cachedFw.length === 0 ? (
          <div style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
            No cached firmware yet. Download a GitHub release or save a `.bin` file to flash offline anytime (no ESP32-CAM required).
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
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void fwStoreRef.current!.setPinned(fw.sha256, !fw.pinned).then(refreshFwCache)}
                  >
                    {fw.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    disabled={!connected || busy}
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void flashFromBrowserCache(fw.sha256)}
                  >
                    Flash
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live Status / Progress Box */}
      {(statusMsg || detailLog) && (
        <div
          style={{
            background:
              phase === "error"
                ? "rgba(248, 81, 73, 0.12)"
                : phase === "done"
                  ? "rgba(63, 185, 80, 0.12)"
                  : "rgba(88, 166, 255, 0.12)",
            border:
              phase === "error"
                ? "1px solid rgba(248, 81, 73, 0.5)"
                : phase === "done"
                  ? "1px solid rgba(63, 185, 80, 0.5)"
                  : "1px solid rgba(88, 166, 255, 0.45)",
            borderRadius: 6,
            padding: "7px 9px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong
            style={{
              color:
                phase === "error" ? "#f85149" : phase === "done" ? "#3fb950" : "#58a6ff",
            }}
          >
            {statusMsg}
          </strong>
          {detailLog && (
            <pre
              style={{
                margin: 0,
                fontSize: "0.71rem",
                color: "#c9d1d9",
                whiteSpace: "pre-wrap",
                maxHeight: 110,
                overflowY: "auto",
              }}
            >
              {detailLog}
            </pre>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
};
