import React, { useEffect, useRef, useState } from "react";
import {
  computeStickVector,
  LowLatencySession,
  parseSettingsTable,
  resolveTargetEndpoints,
  StickVector,
  TuningParameter,
  LinkMetrics,
} from "@g-ai/rc";

interface RobotTelemetry {
  angleDeg: number;
  rateDegS: number;
  motorL: number;
  motorR: number;
  batteryPct: number;
  state: string;
}

export default function App() {
  const [targetHost, setTargetHost] = useState(
    () => localStorage.getItem("balax.host") || "192.168.4.1"
  );
  const [stick, setStick] = useState<StickVector>({ x: 0, y: 0 });
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [metrics, setMetrics] = useState<LinkMetrics>({
    rttMs: null,
    jitterMs: null,
    txHz: 0,
    rxHz: 0,
    lossPercent: 0,
    connected: false,
  });
  const [telemetry, setTelemetry] = useState<RobotTelemetry>({
    angleDeg: 0,
    rateDegS: 0,
    motorL: 0,
    motorR: 0,
    batteryPct: 100,
    state: "READY",
  });
  const [gains, setGains] = useState<TuningParameter[]>([
    { name: "k_angle", value: 19, min: 0, max: 1000, help: "Power per degree of tilt" },
    { name: "k_rate", value: 1.3, min: 0, max: 100, help: "Power per deg/s of tilting" },
    { name: "k_speed", value: 0.7, min: 0, max: 100, help: "Damping wheel speed" },
    { name: "k_distance", value: 0.5, min: 0, max: 3000, help: "Holding position" },
    { name: "trim", value: 0, min: -100, max: 100, help: "Forward/back balance trim %" },
  ]);

  const sessionRef = useRef(new LowLatencySession<StickVector, RobotTelemetry>());
  const plotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<{ angle: number[]; motor: number[] }>({ angle: [], motor: [] });

  useEffect(() => {
    const session = sessionRef.current;
    return session.onTelemetry((pkt, snap) => {
      setMetrics(snap);
      if (pkt.state) {
        setTelemetry(pkt.state);
        const h = historyRef.current;
        h.angle.push(pkt.state.angleDeg ?? 0);
        h.motor.push(pkt.state.motorL ?? 0);
        if (h.angle.length > 180) h.angle.shift();
        if (h.motor.length > 180) h.motor.shift();
      }
    });
  }, []);

  // 50 Hz control + plot render loop
  useEffect(() => {
    const timer = setInterval(() => {
      sessionRef.current.sendControl(stick);
      setMetrics(sessionRef.current.diagnostics.snapshot());
      drawPlot();
    }, 20);
    return () => clearInterval(timer);
  }, [stick]);

  function connectWifi() {
    localStorage.setItem("balax.host", targetHost);
    const ep = resolveTargetEndpoints(targetHost);
    sessionRef.current.connectWebSocket(ep.wsUrl);
  }

  function drawPlot() {
    const canvas = plotCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#010409";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#21262d";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const drawSeries = (arr: number[], scale: number, color: string) => {
      if (arr.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / 180) * w;
        const y = h / 2 - (v / scale) * (h * 0.42);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries(historyRef.current.angle, 45, "#58a6ff");
    drawSeries(historyRef.current.motor, 127, "#3fb950");
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          paddingBottom: 12,
          borderBottom: "1px solid var(--border)",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <strong style={{ fontSize: "1.2rem" }}>BalaX Remote</strong>
          <span style={{ fontSize: "0.75rem", color: "var(--accent)", border: "1px solid var(--border)", padding: "2px 8px", borderRadius: 99 }}>
            Powered by @g-ai/rc
          </span>
          <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
            TX {metrics.txHz} Hz · RX {metrics.rxHz} Hz · RTT {metrics.rttMs !== null ? `${metrics.rttMs.toFixed(1)} ms` : "—"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={targetHost}
            onChange={(e) => setTargetHost(e.target.value)}
            placeholder="Robot IP (192.168.4.1)"
            style={{ width: 160 }}
          />
          <button className="primary" onClick={connectWifi}>
            Connect Wi-Fi
          </button>
          <button className="success" onClick={() => sessionRef.current.sendControl(stick, "ARM")}>
            ARM
          </button>
          <button className="danger" onClick={() => sessionRef.current.sendControl(stick, "DISARM")}>
            DISARM
          </button>
          <button onClick={() => sessionRef.current.sendControl(stick, "TAKEOFF")}>
            Takeoff
          </button>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
        {/* Camera + Floating Joystick Surface */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            position: "relative",
            height: 360,
            overflow: "hidden",
            touchAction: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
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
              computeStickVector(origin.x, origin.y, e.clientX - rect.left, e.clientY - rect.top, 90)
            );
          }}
          onPointerUp={() => {
            setOrigin(null);
            setStick({ x: 0, y: 0 });
          }}
        >
          <div style={{ textAlign: "center", color: "var(--muted)", pointerEvents: "none" }}>
            <div style={{ fontSize: "0.95rem", marginBottom: 6 }}>
              Camera Stream + Floating Joystick Surface
            </div>
            <div style={{ fontSize: "0.8rem" }}>
              Touch & drag anywhere · Drive: {(stick.y * 100).toFixed(0)}% · Turn: {(stick.x * 100).toFixed(0)}%
            </div>
          </div>

          {/* 3D Attitude Mini-View */}
          <div
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              width: 96,
              height: 96,
              background: "#010409cc",
              border: "1px solid var(--border)",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                width: 14,
                height: 46,
                background: "var(--accent)",
                borderRadius: 4,
                transform: `rotate(${telemetry.angleDeg}deg)`,
                transition: "transform 20ms linear",
              }}
            />
            <span style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: 6 }}>
              {telemetry.angleDeg.toFixed(1)}° · {telemetry.state}
            </span>
          </div>
        </div>

        {/* Live Telemetry Strip Chart & PID Tuning */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: "0.85rem", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <strong>Live Telemetry (Pitch Angle & Motor Output)</strong>
              <span style={{ color: "var(--muted)" }}>Battery {telemetry.batteryPct}%</span>
            </div>
            <canvas ref={plotCanvasRef} width={460} height={120} style={{ width: "100%", borderRadius: 6 }} />
          </div>

          <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}>
            <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: 8 }}>
              Live Balance Gains (@g-ai/rc/tuning)
            </strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 170, overflowY: "auto" }}>
              {gains.map((g, idx) => (
                <div key={g.name} style={{ display: "grid", gridTemplateColumns: "95px 1fr 64px", gap: 8, alignItems: "center", fontSize: "0.8rem" }}>
                  <span>{g.name}</span>
                  <input
                    type="range"
                    min={g.min}
                    max={g.max}
                    step={(g.max - g.min) <= 100 ? 0.1 : 1}
                    value={g.value}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      const next = [...gains];
                      next[idx] = { ...g, value: val };
                      setGains(next);
                      sessionRef.current.sendControl(stick, `set ${g.name} ${val}`);
                    }}
                  />
                  <span>{g.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
