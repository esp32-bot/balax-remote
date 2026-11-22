import React, { useEffect, useRef, useState } from "react";
import type { FlashSnapshot } from "./flashProtocol";

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
  wifiSsid: string | null;
  wifiIp: string | null;
  streamActive: boolean | null;
  streamRamChunks: number | null;
  streamRamBytes: number | null;
  streamFlashChunks: number | null;
  streamFlashBytes: number | null;
  streamSamplesSent: number | null;
  streamCompressedBytes: number | null;
  flashErases?: number | null;
  otaErased?: number | null;
  otaSkipped?: number | null;
  progRunning?: boolean;
  cacheHits?: number | null;
  cacheMisses?: number | null;
  cacheKb?: number | null;
  cacheEntries?: number | null;
  updatedAtMs: number;
}

export interface SystemSnapshot {
  robotIp: string;
  connected: boolean;
  health: RobotHealth | null;
  healthHistory: RobotHealth[];
}

interface MiniChartSeries {
  color: string;
  fill?: string;
  values: (number | null)[];
  maxY: number;
}

const MiniHistoryCanvas: React.FC<{
  series: MiniChartSeries[];
  height?: number;
  thresholdY?: { value: number; maxY: number; color: string; label?: string };
}> = ({ series, height = 96, thresholdY }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#010409";
    ctx.fillRect(0, 0, w, h);

    // Subtle horizontal grid
    ctx.strokeStyle = "#161b22";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (thresholdY) {
      const ty = h - (Math.min(Math.max(thresholdY.value / thresholdY.maxY, 0), 1) * (h - 10) + 5);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = thresholdY.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(w, ty);
      ctx.stroke();
      ctx.restore();
      if (thresholdY.label) {
        ctx.fillStyle = thresholdY.color;
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(thresholdY.label, 6, Math.max(11, ty - 3));
      }
    }

    for (const s of series) {
      const n = s.values.length;
      if (n < 2) continue;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const x = (i / Math.max(n - 1, 1)) * w;
        const y = h - (Math.min(Math.max(v / s.maxY, 0), 1) * (h - 10) + 5);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (!started) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      if (s.fill) {
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    }
  }, [series, thresholdY]);

  return (
    <canvas
      ref={ref}
      width={440}
      height={height}
      style={{ width: "100%", borderRadius: 6, border: "1px solid #21262d" }}
    />
  );
};

function fmtUptime(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtKb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const cardStyle: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid #21262d",
  borderRadius: 6,
  padding: "6px 8px",
};

const labelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: "0.68rem",
};

export const CpuPanel: React.FC<{
  connected: boolean;
  system: SystemSnapshot | null;
  onSendCmd: (cmd: string) => void;
  onScreenOff: () => void;
}> = ({ connected, system, onSendCmd, onScreenOff }) => {
  if (!connected || system?.connected === false) return <p role="status" style={{ padding: 12 }}>Offline — connect robot to inspect CPU</p>;
  const h = system?.health ?? null;
  const hist = system?.healthHistory ?? [];
  const historySpan = hist.length > 1 ? (hist.at(-1)!.updatedAtMs - hist[0]!.updatedAtMs) / 1000 : null;

  const usbPlugged = h != null && h.usbV != null && h.usbV > 4.0;
  const netRobotMa =
    h != null && usbPlugged && h.usbMa != null && h.batteryMa != null
      ? Math.max(0, h.usbMa - Math.max(0, h.batteryMa))
      : h != null && h.batteryMa != null && h.batteryMa < 0
        ? Math.abs(h.batteryMa)
        : null;

  const core0 = h?.cpu0Load ?? 0;
  const core1 = h?.cpu1Load ?? 0;

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.78rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>CPU Clock</div>
          <strong style={{ color: (h?.cpuMhz ?? 0) <= 80 ? "#3fb950" : "#d29922" }}>
            {h?.cpuMhz !== null && h?.cpuMhz !== undefined ? `${h.cpuMhz.toFixed(0)} MHz` : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>100 Hz Loop Tick</div>
          <strong style={{ color: (h?.tickMs ?? 0) < 5 ? "#3fb950" : "#f85149" }}>
            {h?.tickMs !== null && h?.tickMs !== undefined ? `${h.tickMs.toFixed(2)} / 10 ms` : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Overruns / Uptime</div>
          <strong>
            {h?.overruns !== null && h?.overruns !== undefined ? `${h.overruns}` : "—"} · {fmtUptime(h?.uptimeS ?? null)}
          </strong>
        </div>
      </div>

      {/* Dual-core load bars */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 7 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.74rem", marginBottom: 3 }}>
            <span><strong style={{ color: "#58a6ff" }}>Core 0</strong> (Wi-Fi · HTTP · LCD · Console)</span>
            <strong>{h?.cpu0Load !== null && h?.cpu0Load !== undefined ? `${core0.toFixed(1)}%` : "—"}</strong>
          </div>
          <div style={{ height: 8, background: "#161b22", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, core0)}%`, height: "100%", background: "#58a6ff", transition: "width 0.3s" }} />
          </div>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.74rem", marginBottom: 3 }}>
            <span><strong style={{ color: "#3fb950" }}>Core 1</strong> (100 Hz IMU · Balance)</span>
            <strong>{h?.cpu1Load !== null && h?.cpu1Load !== undefined ? `${core1.toFixed(1)}%` : "—"}</strong>
          </div>
          <div style={{ height: 8, background: "#161b22", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, core1)}%`, height: "100%", background: "#3fb950", transition: "width 0.3s" }} />
          </div>
        </div>
      </div>

      {/* Rolling CPU + Loop Latency Chart */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", marginBottom: 4 }}>
          <span>
            <strong style={{ color: "#58a6ff" }}>Core 0%</strong> ·{" "}
            <strong style={{ color: "#3fb950" }}>Core 1%</strong> ·{" "}
            <strong style={{ color: "#d29922" }}>Tick ×10ms</strong>
          </span>
          <span style={{ color: "var(--muted)" }}>{hist.length} samples{historySpan != null ? ` · ${historySpan.toFixed(1)}s` : ""}</span>
        </div>
        <MiniHistoryCanvas
          series={[
            {
              color: "#58a6ff",
              fill: "rgba(88,166,255,0.10)",
              values: hist.map((x) => x.cpu0Load),
              maxY: 100,
            },
            {
              color: "#3fb950",
              fill: "rgba(63,185,80,0.10)",
              values: hist.map((x) => x.cpu1Load),
              maxY: 100,
            },
            {
              color: "#d29922",
              values: hist.map((x) => (x.tickMs !== null ? x.tickMs * 10 : null)),
              maxY: 100,
            },
          ]}
        />
      </div>

      {/* Power & Radio Efficiency */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Wi-Fi Sleep / TX</div>
          <strong>
            {h?.wifiPs ?? "—"} · {h?.wifiTxDbm !== null && h?.wifiTxDbm !== undefined ? `+${h.wifiTxDbm.toFixed(0)} dBm` : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>PMIC / IMU Temp</div>
          <strong style={{ color: (h?.pmicC ?? 0) >= 46 || (h?.imuC ?? 0) >= 58 ? "#f85149" : (h?.pmicC ?? 0) >= 42 ? "#d29922" : "#3fb950" }}>
            {h?.pmicC !== null && h?.pmicC !== undefined ? `${h.pmicC.toFixed(1)}°` : "—"} / {h?.imuC !== null && h?.imuC !== undefined ? `${h.imuC.toFixed(1)}°C` : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>{usbPlugged ? "Est. Robot Draw" : "Battery Draw"}</div>
          <strong>
            {netRobotMa !== null ? `~${netRobotMa.toFixed(0)} mA` : "—"}
            {h != null && usbPlugged && h.batteryMa != null && h.batteryMa > 0 ? ` (+${h.batteryMa.toFixed(0)} chg)` : ""}
          </strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          style={{ padding: "4px 10px", fontSize: "0.75rem" }}
          onClick={onScreenOff}
        >
          LCD Off (0%) to Cut Heat
        </button>
        <button
          style={{ padding: "4px 10px", fontSize: "0.75rem" }}
          onClick={() => onSendCmd("probe cpu_mhz cpu0_load cpu1_load tick_ms overruns pmic_c imu_c wifi_ps")}
        >
          Probe CPU to Console
        </button>
      </div>
    </div>
  );
};

export const RamPanel: React.FC<{
  connected: boolean;
  system: SystemSnapshot | null;
  onSendCmd: (cmd: string) => void;
}> = ({ connected, system, onSendCmd }) => {
  if (!connected || system?.connected === false) return <p role="status" style={{ padding: 12 }}>Offline — connect robot to inspect RAM</p>;
  const h = system?.health ?? null;
  const hist = system?.healthHistory ?? [];

  const totalKb = h?.ramTotalKb ?? null;
  const usedKb = h?.ramUsedKb ?? (totalKb !== null && h?.ramFreeKb != null ? totalKb - h.ramFreeKb : null);
  const freeKb = h?.ramFreeKb ?? (totalKb !== null && usedKb !== null ? totalKb - usedKb : null);
  const minKb = h?.ramMinKb ?? null;

  const usedPct = usedKb !== null && totalKb ? Math.min(100, Math.max(0, (usedKb / totalKb) * 100)) : 0;
  const peakUsedKb = minKb !== null && totalKb !== null ? Math.max(usedKb ?? 0, totalKb - minKb) : usedKb ?? 0;
  const peakDeltaPct = totalKb ? Math.max(0, Math.min(100 - usedPct, ((peakUsedKb - (usedKb ?? 0)) / totalKb) * 100)) : 0;
  const freeColor = (freeKb ?? 999) < 28 ? "#f85149" : (freeKb ?? 999) < 42 ? "#d29922" : "#3fb950";

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.78rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Used Heap</div>
          <strong style={{ color: "#58a6ff" }}>{usedKb !== null ? `${usedKb.toFixed(1)} KB` : "—"}</strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Free Heap</div>
          <strong style={{ color: freeColor }}>{freeKb !== null ? `${freeKb.toFixed(1)} KB` : "—"}</strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Min Ever Free</div>
          <strong style={{ color: (minKb ?? 999) < 24 ? "#f85149" : "#d29922" }}>
            {minKb !== null ? `${minKb.toFixed(1)} KB` : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Total Heap</div>
          <strong>{h?.ramTotalKb !== null && h?.ramTotalKb !== undefined ? `${h.ramTotalKb.toFixed(0)} KB` : "—"}</strong>
        </div>
      </div>

      {/* Heap Usage Bar */}
      {totalKb !== null && totalKb > 0 && <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.73rem" }}>
          <span>ESP32 Internal DRAM Heap ({usedPct.toFixed(0)}% used)</span>
          <span style={{ color: "var(--muted)" }}>Peak used: {peakUsedKb.toFixed(1)} KB</span>
        </div>
        <div style={{ height: 14, background: "#161b22", borderRadius: 5, overflow: "hidden", display: "flex" }}>
          <div
            title={`Active used: ${usedKb?.toFixed(1) ?? "?"} KB`}
            style={{ width: `${usedPct}%`, background: "#58a6ff", transition: "width 0.3s" }}
          />
          <div
            title={`Peak watermark delta: ${(peakUsedKb - (usedKb ?? 0)).toFixed(1)} KB`}
            style={{ width: `${peakDeltaPct}%`, background: "rgba(210, 153, 34, 0.55)" }}
          />
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: "0.7rem", color: "var(--muted)" }}>
          <span><span style={{ color: "#58a6ff" }}>■</span> Active Used</span>
          <span><span style={{ color: "#d29922" }}>■</span> High-Watermark Band</span>
          <span><span style={{ color: "#3fb950" }}>■</span> Available ({freeKb?.toFixed(1) ?? "—"} KB)</span>
        </div>
      </div>}

      {/* Free Heap History */}
      {totalKb !== null && totalKb > 0 && <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", marginBottom: 4 }}>
          <span>
            <strong style={{ color: "#3fb950" }}>Free Heap (KB)</strong> ·{" "}
            <strong style={{ color: "#d29922" }}>Min Watermark (KB)</strong>
          </span>
          <span style={{ color: "var(--muted)" }}>Scale 0–{totalKb.toFixed(0)} KB</span>
        </div>
        <MiniHistoryCanvas
          series={[
            {
              color: "#3fb950",
              fill: "rgba(63,185,80,0.12)",
              values: hist.map((x) => x.ramFreeKb),
              maxY: totalKb,
            },
            {
              color: "#d29922",
              values: hist.map((x) => x.ramMinKb),
              maxY: totalKb,
            },
          ]}
          thresholdY={{ value: 24, maxY: totalKb, color: "#f85149", label: "24 KB OTA floor" }}
        />
      </div>}

      {/* Telemetry Stream RAM Buffer */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Telemetry RAM Queue</div>
          <strong>
            {h?.streamRamChunks !== null && h?.streamRamChunks !== undefined
              ? `${h.streamRamChunks} chunks (${((h.streamRamBytes ?? 0) / 1024).toFixed(2)} KB)`
              : "—"}
          </strong>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Stream Status</div>
          <strong style={{ color: h?.streamActive ? "#3fb950" : "var(--muted)" }}>
            {h?.streamActive === null || h?.streamActive === undefined ? "—" : h.streamActive ? "Active (100 Hz BXZ2)" : "Stopped (RAM Freed)"}
          </strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          style={{ padding: "4px 10px", fontSize: "0.75rem" }}
          onClick={() => onSendCmd("stream stop")}
        >
          Free Stream RAM (`stream stop`)
        </button>
        <button
          style={{ padding: "4px 10px", fontSize: "0.75rem" }}
          onClick={() => onSendCmd("probe ram_used_kb ram_free_kb ram_min_kb ram_total_kb")}
        >
          Probe RAM to Console
        </button>
      </div>
    </div>
  );
};

const PART_COLORS: Record<string, string> = {
  bootloader: "#6e7681",
  part_table: "#8b949e",
  nvs: "#a371f7",
  otadata: "#d29922",
  phy_init: "#79c0ff",
  factory: "#8957e5",
  ota_0: "#238636",
  ota_1: "#1f6feb",
  telemetry: "#db6d28",
  coredump: "#f85149",
};

export const FLASH_OFFLINE_MESSAGE = "Offline — connect robot to inspect live flash";

export const FlashPanel: React.FC<{
  connected: boolean;
  response: FlashSnapshot | null;
  health: RobotHealth | null;
  onRefresh: () => void;
  onSendCmd: (cmd: string) => void;
}> = ({ connected, response, health, onRefresh, onSendCmd }) => {
  const live = connected && response?.status === "live" ? response.live : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const running = live?.partitions.find((p) => p.flags.includes("running"));
  const boot = live?.partitions.find((p) => p.flags.includes("boot"));
  const next = live?.partitions.find((p) => p.flags.includes("next"));
  const telemetry = live?.partitions.find((p) => p.name === "telemetry");
  const h = connected && response?.connected !== false ? health : null;
  const telemetryBytes = h?.streamFlashBytes ?? null;
  const fill = running?.imageBytes != null ? (running.imageBytes / running.size) * 100 : null;
  const status = !connected || response?.status === "offline"
    ? FLASH_OFFLINE_MESSAGE
    : !response
      ? "Reading live flash…"
      : response.status === "unsupported"
        ? "Update the robot firmware to inspect live flash."
        : response.status === "busy"
          ? "Flash inspection is paused during firmware OTA."
          : response.status === "error"
            ? response.error ?? "Could not inspect live flash."
            : null;

  return (
    <div className="balax-flash-panel" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.78rem" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <button type="button" disabled={!connected || !response || response.status === "offline"} onClick={onRefresh}>
          Refresh flash
        </button>
        {live && <small style={{ color: "var(--muted)" }}>
          Read {Math.max(0, Math.floor((now - live.fetchedAtMs) / 1000))}s ago
        </small>}
      </div>
      {status && <div role="status" style={cardStyle}>{status}</div>}
      {live && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
          <div style={cardStyle}>
            <div style={labelStyle}>Total SPI Flash</div>
            <strong>{fmtKb(live.totalBytes)}</strong>
          </div>
          <div style={cardStyle}>
            <div style={labelStyle}>Running Partition</div>
            <strong style={{ color: "#3fb950", overflowWrap: "anywhere" }}>{running?.name ?? "—"}</strong>
          </div>
          <div style={cardStyle}>
            <div style={labelStyle}>Running Image</div>
            <strong style={{ color: (fill ?? 0) > 90 ? "#f85149" : "#58a6ff" }}>
              {running?.imageBytes != null && fill != null
                ? `${fmtKb(running.imageBytes)} / ${fmtKb(running.size)} (${fill.toFixed(0)}%)`
                : "—"}
            </strong>
          </div>
        </div>

        <div style={{ ...cardStyle, display: "grid", gap: 6 }}>
          <strong>Flash Partition Map</strong>
          <div aria-label="Flash partition offsets" style={{ position: "relative", height: 18, background: "#161b22", borderRadius: 5, overflow: "hidden" }}>
            {live.partitions.map((part) => {
              const pct = (part.size / live.totalBytes) * 100;
              const isRunning = part.flags.includes("running");
              return (
                <div
                  key={part.offset}
                  title={`${part.name} at 0x${part.offset.toString(16)} (${fmtKb(part.size)})`}
                  style={{
                    position: "absolute",
                    left: `${(part.offset / live.totalBytes) * 100}%`,
                    width: `${pct}%`,
                    height: "100%",
                    background: PART_COLORS[part.name] ?? "#6e7681",
                    opacity: part.type === "app" && !isRunning ? 0.65 : 1,
                    textAlign: "center",
                    fontSize: "0.66rem",
                    lineHeight: "18px",
                    fontWeight: isRunning ? 700 : 500,
                    color: "#fff",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pct >= 12 ? part.name : ""}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", color: "var(--muted)" }}>
            <span>Boot on reset <strong>{boot?.name ?? "—"}</strong></span>
            <span>Next OTA <strong>{next?.name ?? "—"}</strong></span>
          </div>
        </div>

        <div style={{ ...cardStyle, overflowX: "auto" }}>
          <table className="balax-flash-table" aria-label="Live flash partitions">
            <thead>
              <tr><th scope="col">Partition</th><th scope="col">Offset</th><th scope="col">Size</th><th scope="col">Image</th><th scope="col">Status</th></tr>
            </thead>
            <tbody>
              {live.partitions.map((part) => (
                <tr key={part.offset}>
                  <th scope="row">
                    <strong>{part.name}</strong>
                    <small>{part.type} · {part.subtype}</small>
                  </th>
                  <td><code>0x{part.offset.toString(16)}</code></td>
                  <td>{fmtKb(part.size)}</td>
                  <td>{part.imageBytes == null ? "—" : fmtKb(part.imageBytes)}</td>
                  <td>
                    {[...part.flags, part.state].filter(Boolean).join(" · ") || "—"}
                    {part.version && <small>{part.version}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}

      {h && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
          <div style={cardStyle}>
            <div style={labelStyle}>NOR Flash Wear (4 KB Sector-Skip)</div>
            <strong style={{ color: "#3fb950" }}>
              {h.flashErases != null ? `${h.flashErases} total erases` : "—"}
            </strong>
            <div style={labelStyle}>Last OTA · {h.otaErased ?? "—"} erased · {h.otaSkipped ?? "—"} skipped</div>
          </div>
          <div style={cardStyle}>
            <div style={labelStyle}>Tier-0 DRAM Applet Cache</div>
            <strong style={{ color: "#58a6ff" }}>
              {h.cacheEntries != null ? `${h.cacheEntries} applets (${(h.cacheKb ?? 0).toFixed(1)} KB)` : "—"}
            </strong>
            <div style={labelStyle}>Hits {h.cacheHits ?? "—"} · Misses {h.cacheMisses ?? "—"} · VM {h.progRunning == null ? "—" : h.progRunning ? "RUNNING" : "IDLE"}</div>
          </div>
          <div style={cardStyle}>
            <div style={labelStyle}>Telemetry Flash Spillover</div>
            <strong>
              {h.streamFlashChunks != null ? `${h.streamFlashChunks} chunks` : "—"}
              {telemetryBytes != null && ` (${fmtKb(telemetryBytes)}${telemetry ? ` / ${fmtKb(telemetry.size)}` : ""})`}
            </strong>
          </div>
          <div style={cardStyle}>
            <div style={labelStyle}>Session Stream Total</div>
            <strong>
              {h.streamSamplesSent != null ? `${h.streamSamplesSent.toLocaleString()} pts` : "—"}
              {h.streamCompressedBytes != null && ` (${fmtKb(h.streamCompressedBytes)})`}
            </strong>
          </div>
        </div>
      </>}
      {connected && response?.connected !== false && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {live && <button type="button" onClick={() => onSendCmd("partitions")}>Partitions to Console</button>}
        <button type="button" onClick={() => onSendCmd("imu")}>Inspect NVS IMU Cal</button>
        <button type="button" onClick={() => onSendCmd("stream")}>Inspect Stream Queue</button>
      </div>}
    </div>
  );
};
