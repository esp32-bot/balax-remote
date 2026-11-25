import React, { useCallback, useEffect, useState } from "react";
import { CAM_USB_BAUD } from "./cameraProtocol";
import type { RobotHealth } from "./SystemMonitorPanels";
import { detectRuntimeMode } from "./runtimeMode";
import { webSerialCam } from "./webSerialCam";
import { webSerialStickC } from "./webSerialStickC";

export interface CommsSnapshot {
  updatedAtMs: number;
  bridge: {
    mdnsHost: string;
    mdnsActive: boolean;
    lanIp: string | null;
    port: number;
    uptimeS: number;
  };
  robot: {
    host: string;
    resolvedIp: string;
    resolvedVia: "ip" | "mdns" | "fallback";
    connected: boolean;
    powerMode: string;
    telemetryAvailable: boolean;
    lastError: string | null;
    lastAckTick: number;
  };
  stream: {
    targetHz: number;
    actualPollHz: number;
    sampleRateHz: number;
    avgRttMs: number;
    pipelinedNonce: boolean;
    totalSamplesReceived: number;
    totalBytesCompressed: number;
    bytesPerSample: number;
  };
  usb: {
    available: boolean;
    port: string | null;
    ports: string[];
  };
  health: RobotHealth | null;
  lastDrive: {
    forward: number;
    turn: number;
    atMs: number;
    seq: number;
  } | null;
  cam: {
    available: boolean;
    optional: true;
    host: string;
    ip: string | null;
    streaming: boolean;
    activeTransport: string;
    powerMode: string;
    cameraOn: boolean;
    fps: number;
    kbps: number;
    codecMode: string;
    rssi: number | null;
    telemSource: string;
    usbPort: string | null;
    transportPreference?: string;
    usbBaud?: number | null;
    badPackets: number;
  } | null;
}

type LinkTone = "active" | "sleep" | "standby" | "warn" | "offline";

const TONE_COLOR: Record<LinkTone, string> = {
  active: "#3fb950",
  sleep: "#58a6ff",
  standby: "#d29922",
  warn: "#f0883e",
  offline: "#6e7681",
};

const cardStyle: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid #21262d",
  borderRadius: 6,
  padding: "8px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const labelStyle: React.CSSProperties = {
  color: "var(--muted, #8b949e)",
  fontSize: "0.68rem",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  fontSize: "0.74rem",
};

const monoValStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.72rem",
  color: "#e6edf3",
  textAlign: "right",
};

function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function rssiQualityPct(rssi: number | null | undefined): number {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) return 0;
  return Math.max(0, Math.min(100, Math.round(((rssi + 90) / 50) * 100)));
}

function rssiColor(rssi: number | null | undefined): string {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) return "#6e7681";
  if (rssi >= -60) return "#3fb950";
  if (rssi >= -72) return "#d29922";
  return "#f85149";
}

function shortPort(port: string | null | undefined): string {
  if (!port) return "—";
  return port.replace(/^\/dev\/cu\./, "");
}

const StatusPill: React.FC<{ label: string; tone: LinkTone }> = ({ label, tone }) => {
  const c = TONE_COLOR[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: "0.66rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: c,
        background: `${c}1a`,
        border: `1px solid ${c}55`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: c,
          boxShadow: tone === "active" ? `0 0 6px ${c}` : undefined,
        }}
      />
      {label}
    </span>
  );
};

interface MeshDiagramProps {
  snap: CommsSnapshot | null;
  wifiTone: LinkTone;
  usbTone: LinkTone;
  joyxTone: LinkTone;
  apTone: LinkTone;
  camTone: LinkTone;
  clientHost: string;
}

const MeshTopologySvg: React.FC<MeshDiagramProps> = ({
  snap,
  wifiTone,
  usbTone,
  joyxTone,
  camTone,
  clientHost,
}) => {
  const h = snap?.health ?? null;
  const r = snap?.robot;
  const s = snap?.stream;
  const u = snap?.usb;
  const c = snap?.cam;

  const stickCTone: LinkTone =
    wifiTone === "active"
      ? "active"
      : wifiTone === "sleep"
        ? "sleep"
        : usbTone === "active"
          ? "standby"
          : "offline";

  // A link is drawn only while that path is actually up. Offline and guessed
  // edges (the JoyX "Bridge" line, standby ESP-NOW, and "Attitude" with no source)
  // are placeholders and stay off the graph.
  const wifiLinkUp = wifiTone === "active" || wifiTone === "sleep";
  const usbLinkUp = usbTone === "active" || usbTone === "sleep";
  const camLinkUp = camTone !== "offline";
  const joyxLinkUp = joyxTone === "active";
  const telemActive = Boolean(c?.available && c.telemSource && c.telemSource !== "none");

  const stickCLinkTone: LinkTone | null = wifiLinkUp ? wifiTone : usbLinkUp ? usbTone : null;

  const stickCLinkCol = stickCLinkTone ? TONE_COLOR[stickCLinkTone] : TONE_COLOR.offline;
  const usbCol = TONE_COLOR[usbTone];
  const joyxCol = TONE_COLOR[joyxTone];
  const camCol = TONE_COLOR[camTone];
  const telemCol = TONE_COLOR.active;

  const stickCLabel = wifiTone === "active"
    ? `Wi-Fi · ${s ? `${s.avgRttMs.toFixed(0)}ms` : "LAN"}${h?.wifiRssi != null ? ` ${h.wifiRssi}dBm` : ""}`
    : wifiTone === "sleep"
      ? `Wi-Fi Sleep${h?.wifiRssi != null ? ` · ${h.wifiRssi}dBm` : ""}`
      : usbTone === "sleep"
        ? "USB Sleep"
        : u?.port
          ? `USB · ${shortPort(u.port)}`
          : "USB";

  const camTransportShort =
    c?.activeTransport === "udp_ecl1"
      ? "UDP"
      : c?.activeTransport === "http_mjpeg"
        ? "HTTP"
        : c?.activeTransport === "usb_ecl1"
          ? "USB"
          : null;

  const camOnUsb = Boolean(
    c &&
      ((c.usbBaud != null && c.usbBaud > 0) ||
        c.activeTransport === "usb_ecl1" ||
        c.transportPreference === "usb" ||
        (c.usbPort && !c.ip)),
  );
  const camBaud = c?.usbBaud && c.usbBaud > 0 ? c.usbBaud : CAM_USB_BAUD;
  const camUsbLabel = c?.usbPort ? `${shortPort(c.usbPort)} ${camBaud}` : `USB ${camBaud}`;

  const camLabel = camOnUsb
    ? camUsbLabel
    : c?.streaming && camTransportShort
      ? `${camTransportShort} · ${c.fps.toFixed(0)}fps`
      : c?.powerMode === "sleep"
        ? "Deep Sleep"
        : c?.powerMode === "idle"
          ? "Cool Idle"
          : c?.available
            ? c.powerMode
            : "Offline";

  const joyxLabel =
    joyxTone === "active"
      ? `ESP-NOW${h?.remoteMsgs != null ? ` · ${Math.round(h.remoteMsgs)}` : ""}`
      : h?.wifiChannel != null
        ? `ESP-NOW · Ch ${Math.round(h.wifiChannel)}`
        : "ESP-NOW";

  const stickCCamLabel = telemActive ? c!.telemSource.toUpperCase() : "";

  const nodeBox = (
    cx: number,
    cy: number,
    w: number,
    hh: number,
    title: string,
    sub: string,
    tone: LinkTone,
  ) => {
    const col = TONE_COLOR[tone];
    return (
      <g>
        <rect
          x={cx - w / 2}
          y={cy - hh / 2}
          width={w}
          height={hh}
          rx={8}
          fill="#0d1117"
          stroke={col}
          strokeWidth={tone === "active" ? 1.7 : 1.15}
          strokeOpacity={tone === "offline" ? 0.55 : 0.92}
        />
        <circle cx={cx - w / 2 + 11} cy={cy - 5} r={3.3} fill={col} />
        <text
          x={cx - w / 2 + 19}
          y={cy - 1.5}
          fill="#e6edf3"
          fontSize="10.2"
          fontWeight="600"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {title}
        </text>
        <text
          x={cx}
          y={cy + 11}
          textAnchor="middle"
          fill="#8b949e"
          fontSize="8.4"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {sub.length > 18 ? `${sub.slice(0, 17)}…` : sub}
        </text>
      </g>
    );
  };

  const edgePill = (x: number, y: number, text: string, col: string) => {
    const w = Math.max(46, text.length * 5.1 + 12);
    return (
      <g>
        <rect
          x={x - w / 2}
          y={y - 7.5}
          width={w}
          height={15}
          rx={4}
          fill="#010409"
          stroke={col}
          strokeWidth={0.85}
          strokeOpacity={0.75}
        />
        <text
          x={x}
          y={y + 2.8}
          textAnchor="middle"
          fill={col}
          fontSize="8"
          fontWeight="600"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {text}
        </text>
      </g>
    );
  };

  // Corner layout (viewBox 420×240). Controllers on the left, robot devices on the right.
  // Sides are the four peer links; the primary StickC link is the diagonal.
  const web = { x: 66, y: 27, w: 114, h: 38 };
  const fpv = { x: 354, y: 27, w: 112, h: 38 };
  const joy = { x: 66, y: 213, w: 112, h: 38 };
  const stick = { x: 354, y: 213, w: 116, h: 38 };

  return (
    <svg
      viewBox="0 0 420 240"
      style={{
        width: "100%",
        height: "auto",
        display: "block",
        background: "#010409",
        borderRadius: 6,
        border: "1px solid #21262d",
      }}
      role="img"
      aria-label="BalaX network topology: Web Remote, StickC, ESP32-FPV, and JoyX"
    >
      <defs>
        <pattern id="comms-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#161b22" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect width="420" height="240" fill="url(#comms-grid)" />

      {stickCLinkTone && (
        <line
          x1={95}
          y1={46}
          x2={325}
          y2={194}
          stroke={stickCLinkCol}
          strokeWidth={stickCLinkTone === "active" ? 2.2 : 1.4}
          strokeDasharray={stickCLinkTone === "active" ? "5 4" : undefined}
        >
          {stickCLinkTone === "active" && (
            <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite" />
          )}
        </line>
      )}

      {wifiLinkUp && u?.available && (
        <path
          d="M 112 46 Q 268 64 352 194"
          fill="none"
          stroke={usbCol}
          strokeWidth={usbTone === "active" ? 1.6 : 1.3}
        />
      )}

      {camLinkUp && (
        <line
          x1={web.x + web.w / 2}
          y1={web.y}
          x2={fpv.x - fpv.w / 2}
          y2={fpv.y}
          stroke={camCol}
          strokeWidth={camTone === "active" ? 2.1 : 1.35}
          strokeDasharray={camTone === "active" ? "5 4" : undefined}
        >
          {camTone === "active" && (
            <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.7s" repeatCount="indefinite" />
          )}
        </line>
      )}

      {joyxLinkUp && (
        <line
          x1={joy.x + joy.w / 2}
          y1={joy.y}
          x2={stick.x - stick.w / 2}
          y2={stick.y}
          stroke={joyxCol}
          strokeWidth={2.1}
          strokeDasharray="5 4"
        >
          <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.8s" repeatCount="indefinite" />
        </line>
      )}

      {telemActive && (
        <line
          x1={fpv.x}
          y1={fpv.y + fpv.h / 2}
          x2={stick.x}
          y2={stick.y - stick.h / 2}
          stroke={telemCol}
          strokeWidth={2}
          strokeDasharray="5 4"
        >
          <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.8s" repeatCount="indefinite" />
        </line>
      )}

      {camLinkUp && edgePill(210, 27, camLabel, camCol)}
      {joyxLinkUp && edgePill(209, 213, joyxLabel, joyxCol)}
      {telemActive && edgePill(354, 120, stickCCamLabel, telemCol)}
      {stickCLinkTone && edgePill(210, 120, stickCLabel, stickCLinkCol)}

      {nodeBox(web.x, web.y, web.w, web.h, "Web Remote", clientHost, "active")}
      {nodeBox(
        joy.x,
        joy.y,
        joy.w,
        joy.h,
        "JoyX",
        h?.wifiChannel != null ? `Ch ${Math.round(h.wifiChannel)}` : "standby",
        joyxTone,
      )}
      {nodeBox(
        fpv.x,
        fpv.y,
        fpv.w,
        fpv.h,
        "ESP32-FPV",
        c?.ip ?? (c?.usbPort ? shortPort(c.usbPort) : c?.host ?? "balax-cam.local"),
        camTone,
      )}
      {nodeBox(stick.x, stick.y, stick.w, stick.h, "StickC", r?.resolvedIp ?? "balax.local", stickCTone)}
    </svg>
  );
};

export const CommunicationsPanel: React.FC<{
  visible: boolean;
  connected: boolean;
  powerMode: string;
  onConnect: () => void;
  onDisconnect: () => void;
}> = ({ visible, connected, powerMode, onConnect, onDisconnect }) => {
  const [snap, setSnap] = useState<CommsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchComms = useCallback(async (opts?: { refresh?: boolean; probeCam?: boolean }) => {
    const mode = await detectRuntimeMode();
    if (mode !== "bridge") {
      const camSt = webSerialCam.getStatus();
      const stickSt = webSerialStickC.getState();
      setSnap({
        updatedAtMs: Date.now(),
        bridge: {
          lanIp: typeof window !== "undefined" ? window.location.hostname : "browser",
          port: 0,
          mdnsHost: "standalone (Web Serial)",
          mdnsActive: false,
          uptimeS: 0,
        },
        robot: {
          host: "balax.local",
          resolvedIp: stickSt.connected ? (stickSt.portLabel ?? "Web Serial") : "balax.local",
          resolvedVia: "fallback",
          connected: false,
          powerMode: stickSt.connected ? "awake" : "unknown",
          telemetryAvailable: false,
          lastError: null,
          lastAckTick: 0,
        },
        stream: {
          targetHz: 0,
          actualPollHz: 0,
          sampleRateHz: 0,
          avgRttMs: 0,
          pipelinedNonce: false,
          totalSamplesReceived: 0,
          totalBytesCompressed: 0,
          bytesPerSample: 0,
        },
        usb: {
          available: stickSt.connected,
          port: stickSt.portLabel,
          ports: stickSt.portLabel ? [stickSt.portLabel] : [],
        },
        health: null,
        lastDrive: null,
        cam: {
          available: camSt.available,
          optional: true,
          host: camSt.host,
          ip: camSt.ip,
          streaming: camSt.streaming,
          activeTransport: camSt.activeTransport,
          powerMode: camSt.powerMode,
          cameraOn: camSt.cameraOn,
          fps: camSt.fps,
          kbps: camSt.kbps,
          codecMode: camSt.codecMode,
          rssi: camSt.rssi,
          telemSource: camSt.telemSource,
          usbPort: camSt.usbPort,
          transportPreference: camSt.transportPreference,
          usbBaud: camSt.usbBaud,
          badPackets: camSt.badPackets,
        },
      });
      setErr(null);
      return;
    }
    const qs = new URLSearchParams();
    if (opts?.refresh) qs.set("refresh", "1");
    if (opts?.probeCam) qs.set("probeCam", "1");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    try {
      const res = await fetch(`/api/bridge/comms${suffix}`, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CommsSnapshot;
      setSnap(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    void fetchComms({ probeCam: true });
    const id = window.setInterval(() => {
      if (active) void fetchComms({ probeCam: false });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [visible, fetchComms]);

  const handleManualProbe = async () => {
    setBusy(true);
    try {
      await fetchComms({ refresh: true, probeCam: true });
    } finally {
      setBusy(false);
    }
  };

  const h = snap?.health ?? null;
  const r = snap?.robot;
  const b = snap?.bridge;
  const s = snap?.stream;
  const u = snap?.usb;
  const c = snap?.cam;
  const effPowerMode = r?.powerMode ?? powerMode;
  const effConnected = r?.connected ?? connected;

  const wifiTone: LinkTone = effConnected
    ? "active"
    : effPowerMode === "wifi-sleep"
      ? "sleep"
      : "offline";

  const usbVbusActive = h?.usbV != null && h.usbV >= 4.0;
  const usbTone: LinkTone =
    u?.available || usbVbusActive
      ? effPowerMode === "usb-sleep"
        ? "sleep"
        : "active"
      : "offline";

  const joyxTone: LinkTone = h?.remoteLive
    ? "active"
    : effConnected || effPowerMode === "wifi-sleep"
      ? "standby"
      : "offline";

  const apTone: LinkTone =
    h?.apClients != null && h.apClients > 0
      ? "active"
      : h?.apSsid
        ? "standby"
        : "offline";

  const camTone: LinkTone = c?.streaming
    ? "active"
    : c?.available
      ? c.powerMode === "sleep"
        ? "sleep"
        : "standby"
      : "offline";

  const activeLinkCount = [wifiTone, usbTone, joyxTone, apTone, camTone].filter(
    (t) => t === "active" || t === "sleep",
  ).length;

  const remoteDeliveryPct =
    h?.remoteMsgs != null && h.remoteMsgs > 0 && h.remoteFailed != null
      ? Math.max(0, 100 - (h.remoteFailed / Math.max(1, h.remoteMsgs + h.remoteFailed)) * 100)
      : null;

  const clientHost = typeof window !== "undefined" ? window.location.host : "localhost";

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.78rem" }}>
      {/* Top status & actions bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <StatusPill
            label={
              effConnected
                ? "MESH LIVE"
                : effPowerMode === "wifi-sleep"
                  ? "WI-FI SLEEP · 15s PASSIVE"
                  : effPowerMode === "usb-sleep"
                    ? "USB SLEEP"
                    : "OFFLINE"
            }
            tone={wifiTone !== "offline" ? wifiTone : usbTone}
          />
          <span style={{ color: "var(--muted, #8b949e)", fontSize: "0.72rem" }}>
            {activeLinkCount}/5 links up
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void handleManualProbe()}
            title="Refresh passive mesh & camera status (never wakes a sleeping robot)"
            style={{ padding: "3px 8px", fontSize: "0.72rem" }}
          >
            {busy ? "Probing…" : "Refresh Mesh"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={effConnected ? onDisconnect : onConnect}
            style={{ padding: "3px 8px", fontSize: "0.72rem" }}
          >
            {effConnected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </div>

      {err && (
        <div style={{ ...cardStyle, borderColor: "#f8514966", color: "#f85149", fontSize: "0.72rem" }}>
          Bridge network query failed: {err}
        </div>
      )}

      {/* Mesh Topology Diagram */}
      <MeshTopologySvg
        snap={snap}
        wifiTone={wifiTone}
        usbTone={usbTone}
        joyxTone={joyxTone}
        apTone={apTone}
        camTone={camTone}
        clientHost={clientHost}
      />

      {/* Link Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: 8 }}>
        {/* 1. Wi-Fi STA LAN */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem" }}>Wi-Fi STA LAN</strong>
            <StatusPill
              label={
                effConnected
                  ? "LIVE"
                  : effPowerMode === "wifi-sleep"
                    ? "SLEEP"
                    : "DOWN"
              }
              tone={wifiTone}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Host / IP</span>
            <span style={monoValStyle}>
              {r ? `${r.host} (${r.resolvedIp})` : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>SSID / Ch</span>
            <span style={monoValStyle}>
              {h?.wifiSsid || "—"}
              {h?.wifiChannel != null ? ` · Ch ${Math.round(h.wifiChannel)}` : ""}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Signal (RSSI)</span>
            <span style={{ ...monoValStyle, color: rssiColor(h?.wifiRssi) }}>
              {h?.wifiRssi != null ? `${Math.round(h.wifiRssi)} dBm (${rssiQualityPct(h.wifiRssi)}%)` : "—"}
            </span>
          </div>
          <div style={{ height: 5, background: "#161b22", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${rssiQualityPct(h?.wifiRssi)}%`,
                height: "100%",
                background: rssiColor(h?.wifiRssi),
                transition: "width 0.3s",
              }}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Radio / PS</span>
            <span style={monoValStyle}>
              {h?.wifiTxDbm != null ? `+${h.wifiTxDbm.toFixed(0)} dBm` : "—"}
              {h?.wifiPs ? ` · ${h.wifiPs}` : ""}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Telemetry RTT</span>
            <span style={monoValStyle}>
              {effConnected && s
                ? `${s.avgRttMs.toFixed(1)} ms · ${s.pipelinedNonce ? "1-RTT" : "2-RTT"}`
                : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Stream Rate</span>
            <span style={monoValStyle}>
              {effConnected && s
                ? `${s.actualPollHz.toFixed(1)}/${s.targetHz} Hz · ${s.sampleRateHz.toFixed(0)} sps`
                : "paused"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Compression</span>
            <span style={monoValStyle}>
              {s && s.totalSamplesReceived > 0
                ? `${s.bytesPerSample} B/smp · ${fmtBytes(s.totalBytesCompressed)}`
                : "—"}
            </span>
          </div>
          {h?.streamRamChunks != null && (
            <div style={rowStyle}>
              <span style={labelStyle}>Robot Buffers</span>
              <span style={monoValStyle}>
                RAM {h.streamRamChunks} · Flash {h.streamFlashChunks ?? 0}
              </span>
            </div>
          )}
        </div>

        {/* 2. ESP-NOW (JoyX) & SoftAP */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem" }}>ESP-NOW &amp; SoftAP</strong>
            <StatusPill
              label={h?.remoteLive ? "JOYX LIVE" : joyxTone === "standby" ? "STANDBY" : "OFFLINE"}
              tone={joyxTone}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>JoyX Peer</span>
            <span style={{ ...monoValStyle, color: h?.remoteLive ? "#3fb950" : "#8b949e" }}>
              {h?.remoteLive === true ? "Connected" : h?.remoteLive === false ? "Idle / Waiting" : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>ESP-NOW Rx</span>
            <span style={monoValStyle}>
              {h?.remoteMsgs != null ? `${Math.round(h.remoteMsgs)} msgs` : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Reply Failures</span>
            <span style={{ ...monoValStyle, color: (h?.remoteFailed ?? 0) > 0 ? "#d29922" : "#e6edf3" }}>
              {h?.remoteFailed != null
                ? `${Math.round(h.remoteFailed)}${remoteDeliveryPct !== null ? ` (${remoteDeliveryPct.toFixed(1)}% ok)` : ""}`
                : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>SoftAP SSID</span>
            <span style={monoValStyle}>{h?.apSsid || "—"}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>AP Clients</span>
            <span style={monoValStyle}>
              {h?.apClients != null ? `${Math.round(h.apClients)}` : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Wi-Fi Phase</span>
            <span style={monoValStyle}>{h?.wifiPhase || "—"}</span>
          </div>
          {snap?.lastDrive && (
            <div style={rowStyle}>
              <span style={labelStyle}>Active Drive Cmd</span>
              <span style={{ ...monoValStyle, color: "#58a6ff" }}>
                F {snap.lastDrive.forward.toFixed(2)} · T {snap.lastDrive.turn.toFixed(2)}
              </span>
            </div>
          )}
        </div>

        {/* 3. Bridge & mDNS */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem" }}>Bridge &amp; mDNS</strong>
            <StatusPill
              label={b?.mdnsActive ? "mDNS UP" : "LOCAL"}
              tone={b?.mdnsActive ? "active" : "standby"}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>mDNS Host</span>
            <span style={monoValStyle}>{b ? `${b.mdnsHost}:${b.port}` : "—"}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Bridge LAN IP</span>
            <span style={monoValStyle}>{b?.lanIp ?? "—"}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Resolution</span>
            <span style={monoValStyle}>
              {r ? `${r.resolvedVia.toUpperCase()} → ${r.resolvedIp}` : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Bridge Uptime</span>
            <span style={monoValStyle}>{fmtDuration(b?.uptimeS)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Robot Power</span>
            <span style={monoValStyle}>
              {effPowerMode}
              {h?.idleS != null ? ` · idle ${fmtDuration(h.idleS)}` : ""}
            </span>
          </div>
          {r?.lastError && (
            <div style={{ fontSize: "0.68rem", color: "#f85149", wordBreak: "break-word", marginTop: 2 }}>
              Last error: {r.lastError}
            </div>
          )}
        </div>

        {/* 4. USB Serial Hardware Link */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem" }}>USB Serial</strong>
            <StatusPill
              label={
                u?.available
                  ? effPowerMode === "usb-sleep"
                    ? "USB SLEEP"
                    : "ATTACHED"
                  : usbVbusActive
                    ? "POWER ONLY"
                    : "UNPLUGGED"
              }
              tone={usbTone}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Active Port</span>
            <span style={monoValStyle}>{shortPort(u?.port)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Detected Ports</span>
            <span style={monoValStyle}>{u ? `${u.ports.length}` : "—"}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>VBUS Rail</span>
            <span style={monoValStyle}>
              {h?.usbV != null ? `${h.usbV.toFixed(2)} V` : "—"}
              {h?.usbMa != null && h.usbV != null && h.usbV >= 4.0 ? ` · ${h.usbMa.toFixed(0)} mA` : ""}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Remote Wake</span>
            <span style={{ ...monoValStyle, color: u?.available ? "#3fb950" : "#8b949e" }}>
              {u?.available ? "RTS→EN ready" : "unavailable"}
            </span>
          </div>
        </div>

        {/* 5. ESP32-CAM Companion Link */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem" }}>ESP32-CAM Companion</strong>
            <StatusPill
              label={
                c?.streaming
                  ? "STREAMING"
                  : c?.available
                    ? c.powerMode.toUpperCase()
                    : "OPTIONAL"
              }
              tone={camTone}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Host / IP</span>
            <span style={monoValStyle}>
              {c ? `${c.host}${c.ip ? ` (${c.ip})` : ""}` : "balax-cam.local"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Transport</span>
            <span style={monoValStyle}>
              {c && c.activeTransport !== "none" ? c.activeTransport.toUpperCase() : "—"}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Video / Codec</span>
            <span style={monoValStyle}>
              {c?.streaming ? `${c.fps.toFixed(1)} fps · ${c.kbps.toFixed(0)} kbps` : "idle"}
              {c?.codecMode && c.streaming ? ` (${c.codecMode})` : ""}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>RSSI / Att</span>
            <span style={monoValStyle}>
              {c?.rssi != null ? `${c.rssi} dBm` : "—"}
              {c?.telemSource && c.telemSource !== "none" ? ` · ${c.telemSource}` : ""}
            </span>
          </div>
          {c && c.badPackets > 0 && (
            <div style={rowStyle}>
              <span style={labelStyle}>Bad Packets</span>
              <span style={{ ...monoValStyle, color: "#d29922" }}>{c.badPackets}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
