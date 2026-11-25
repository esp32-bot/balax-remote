import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getRuntimeMode } from "./runtimeMode";
import { webSerialStickC } from "./webSerialStickC";
import {
  DEFAULT_BALAC_PLANT,
  evaluateControlRun,
  identifyBalaCPlant,
  LQR_PROFILES,
  LqrProfileId,
  solveBalaCLqr,
} from "@g-ai/rc";
import type { TraceSample } from "./bxz1";

interface ControlLabPanelProps {
  connected: boolean;
  historyRef: React.MutableRefObject<TraceSample[]>;
  onSendCmd: (cmd: string) => Promise<string | null>;
}

interface StageInfo {
  key: "est" | "ctrl" | "perch" | "shaper" | "takeoff";
  label: string;
  classic: string;
  sota: string;
}

const STAGES: readonly StageInfo[] = [
  { key: "est", label: "1. Estimator", classic: "Classic CF", sota: "VQF 6-DOF" },
  { key: "ctrl", label: "2. Balance Law", classic: "Classic PID", sota: "DARE LQR + ESO" },
  { key: "perch", label: "3. Perch Gate", classic: "Always Active", sota: "Lyapunov u=0" },
  { key: "shaper", label: "4. Motor Shaper", classic: "Punch Cliff", sota: "Smooth Stiction" },
  { key: "takeoff", label: "5. Stand-Up", classic: "127 Bang", sota: "Energy Swing-Up" },
];

interface LiveControlMetrics {
  ctrlMode: string;
  stages: Record<StageInfo["key"], number>;
  perched: boolean;
  eqDeg: number | null;
  dutyPct: number | null;
  perchPct: number | null;
  energyU2: number | null;
}

function parseCtrlStatus(raw: string): Partial<Record<StageInfo["key"], number>> {
  const out: Partial<Record<StageInfo["key"], number>> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(est|ctrl|perch|shaper|takeoff)\s+([01])\b/i);
    if (m) {
      out[m[1]!.toLowerCase() as StageInfo["key"]] = Number(m[2]);
    }
  }
  return out;
}

function parseProbeMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_]+)\s+(.+)$/);
    if (m) map.set(m[1]!, m[2]!.trim());
  }
  return map;
}

export const ControlLabPanel: React.FC<ControlLabPanelProps> = ({
  connected,
  historyRef,
  onSendCmd,
}) => {
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string>("");

  const queryQuiet = useCallback(async (cmd: string): Promise<string | null> => {
    try {
      if (webSerialStickC.isConnected()) {
        return (await webSerialStickC.sendCommand(cmd)).trim();
      }
      if (getRuntimeMode() !== "bridge") return null;
      const res = await fetch("/api/bridge/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd }),
      });
      if (!res.ok) return null;
      return (await res.text()).trim();
    } catch {
      return null;
    }
  }, []);
  const [profile, setProfile] = useState<LqrProfileId>("eco");
  const [omegaN, setOmegaN] = useState<number>(DEFAULT_BALAC_PLANT.omegaN);
  const [wheelDrag, setWheelDrag] = useState<number>(DEFAULT_BALAC_PLANT.wheelDrag);
  const [motorAccel, setMotorAccel] = useState<number>(DEFAULT_BALAC_PLANT.motorAccel);
  const [metrics, setMetrics] = useState<LiveControlMetrics>({
    ctrlMode: "—",
    stages: { est: 0, ctrl: 0, perch: 0, shaper: 0, takeoff: 0 },
    perched: false,
    eqDeg: null,
    dutyPct: null,
    perchPct: null,
    energyU2: null,
  });

  const lqr = useMemo(
    () =>
      solveBalaCLqr(
        { ...DEFAULT_BALAC_PLANT, omegaN, wheelDrag, motorAccel },
        LQR_PROFILES[profile].weights
      ),
    [omegaN, wheelDrag, motorAccel, profile]
  );

  const localScore = useMemo(() => {
    const recent = historyRef.current.slice(-1200);
    return evaluateControlRun(recent, 0.01);
  }, [metrics, historyRef]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!connected) return false;
    const ctrlOut = await queryQuiet("ctrl");
    if (!ctrlOut || /unrecognized command|unknown command/i.test(ctrlOut)) {
      setSupported(false);
      return false;
    }
    const parsed = parseCtrlStatus(ctrlOut);
    if (Object.keys(parsed).length === 0) {
      setSupported(false);
      return false;
    }
    setSupported(true);
    const probeOut = await queryQuiet("probe ctrl_mode perched eq_deg motor_duty perch_pct ctrl_energy");
    setMetrics((prev) => {
      const next = { ...prev, stages: { ...prev.stages } };
      for (const k of Object.keys(parsed) as StageInfo["key"][]) {
        if (parsed[k] !== undefined) next.stages[k] = parsed[k]!;
      }
      if (probeOut && !/unrecognized|unknown/i.test(probeOut)) {
        const kv = parseProbeMap(probeOut);
        const num = (k: string) => {
          const v = Number(kv.get(k));
          return Number.isFinite(v) ? v : null;
        };
        if (kv.has("ctrl_mode")) next.ctrlMode = kv.get("ctrl_mode")!;
        next.perched = kv.get("perched") === "yes";
        next.eqDeg = num("eq_deg");
        next.dutyPct = num("motor_duty");
        next.perchPct = num("perch_pct");
        next.energyU2 = num("ctrl_energy");
      }
      return next;
    });
    return true;
  }, [connected, queryQuiet]);

  useEffect(() => {
    if (!connected) {
      setSupported(null);
      return;
    }
    let cancelled = false;
    let id: number | null = null;
    void refresh().then((ok) => {
      if (cancelled || !ok) return;
      id = window.setInterval(() => {
        void refresh();
      }, 2500);
    });
    return () => {
      cancelled = true;
      if (id !== null) window.clearInterval(id);
    };
  }, [connected, refresh]);

  async function applyPreset(preset: "classic" | "sota") {
    if (!connected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await onSendCmd(`ctrl ${preset}`);
      setNotice(res?.trim() || `Switched to ${preset.toUpperCase()}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleStage(stage: StageInfo["key"]) {
    if (!connected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const nextVal = metrics.stages[stage] ? 0 : 1;
      await onSendCmd(`ctrl ${stage} ${nextVal}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function pushDareGains(saveFlash: boolean) {
    if (!connected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      for (const cmd of lqr.firmwareCommands) {
        await onSendCmd(cmd);
      }
      if (saveFlash) {
        await onSendCmd("save");
        setNotice(`Pushed & saved ${LQR_PROFILES[profile].label} DARE LQR gains to flash`);
      } else {
        setNotice(`Pushed ${LQR_PROFILES[profile].label} DARE LQR gains (RAM)`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function runBrowserSystemId() {
    const recent = historyRef.current.slice(-2000);
    const id = identifyBalaCPlant(recent, 0.01);
    if (!id.valid) {
      setNotice(`Need >=30 active BALANCING samples for System-ID (have ${id.sampleCount})`);
      return;
    }
    setOmegaN(id.estimatedOmegaN);
    setNotice(
      `System-ID fit (${id.sampleCount} samples, R²=${id.rSquared}): ωn=${id.estimatedOmegaN} rad/s, bθ=${id.estimatedBTheta}`
    );
  }

  const allSota = STAGES.every((s) => metrics.stages[s.key] === 1);
  const allClassic = STAGES.every((s) => metrics.stages[s.key] === 0);

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: "0.8rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <strong style={{ fontSize: "0.86rem" }}>Modular Control Pipeline</strong>
          <div style={{ color: "var(--muted)", fontSize: "0.72rem" }}>
            Hot-swap individual stages live · zero heap · +10.7 KB flash
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            disabled={!connected || busy || supported === false}
            className={allClassic ? "primary" : undefined}
            style={{ padding: "4px 10px", fontSize: "0.76rem" }}
            onClick={() => void applyPreset("classic")}
          >
            Classic 2020
          </button>
          <button
            type="button"
            disabled={!connected || busy || supported === false}
            className={allSota ? "success" : undefined}
            style={{ padding: "4px 10px", fontSize: "0.76rem" }}
            onClick={() => void applyPreset("sota")}
          >
            SOTA 2026
          </button>
        </div>
      </div>

      {connected && supported === false && (
        <div
          style={{
            padding: "7px 9px",
            borderRadius: 6,
            border: "1px solid rgba(210, 153, 34, 0.55)",
            background: "rgba(158, 106, 3, 0.16)",
            color: "#e3b341",
            fontSize: "0.74rem",
          }}
        >
          Connected robot is running older firmware without the modular <code>ctrl</code> pipeline. Flash the new build in the <strong>Firmware OTA</strong> tab to enable live stage swapping &amp; SOTA 2026 LQR/Perch.
        </div>
      )}

      {/* Live Energy & Passive Perch Readout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 6,
          padding: 8,
          background: "rgba(15, 23, 42, 0.72)",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <div>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Perch</div>
          <strong style={{ color: metrics.perched ? "#3fb950" : "var(--text)" }}>
            {metrics.perched ? "PERCHED" : metrics.perchPct != null ? `${metrics.perchPct.toFixed(0)}%` : `${localScore.perchPct.toFixed(0)}%`}
          </strong>
        </div>
        <div>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Motor Duty</div>
          <strong>
            {metrics.dutyPct != null ? `${metrics.dutyPct.toFixed(1)}%` : `${localScore.dutyPct.toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Learned EQ</div>
          <strong>{metrics.eqDeg != null ? `${metrics.eqDeg >= 0 ? "+" : ""}${metrics.eqDeg.toFixed(2)}°` : "—"}</strong>
        </div>
        <div>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem" }}>Energy (u²·s)</div>
          <strong>{metrics.energyU2 != null ? metrics.energyU2.toFixed(0) : localScore.energyU2.toFixed(0)}</strong>
        </div>
      </div>

      {/* 5 Independently Swappable Control Stages */}
      <div style={{ display: "grid", gap: 5 }}>
        {STAGES.map((stage) => {
          const isSota = metrics.stages[stage.key] === 1;
          return (
            <div
              key={stage.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                background: "rgba(22, 27, 34, 0.72)",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
            >
              <span>{stage.label}</span>
              <button
                type="button"
                disabled={!connected || busy || supported === false}
                className={isSota ? "success" : undefined}
                style={{ padding: "3px 9px", fontSize: "0.74rem", minWidth: 118 }}
                onClick={() => void toggleStage(stage.key)}
                title={`Click to swap ${stage.label} between ${stage.classic} and ${stage.sota}`}
              >
                {isSota ? stage.sota : stage.classic}
              </button>
            </div>
          );
        })}
      </div>

      {/* Browser-First Joseph-Form DARE LQR Solver */}
      <div
        style={{
          display: "grid",
          gap: 8,
          padding: 9,
          background: "rgba(13, 17, 23, 0.8)",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <strong>In-Browser DARE LQR Solver</strong>
          <div style={{ display: "flex", gap: 4 }}>
            {(["eco", "balanced", "crisp"] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={profile === id ? "primary" : undefined}
                style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                onClick={() => setProfile(id)}
                title={LQR_PROFILES[id].description}
              >
                {LQR_PROFILES[id].label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, fontSize: "0.72rem" }}>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--muted)" }}>ωn (rad/s)</span>
            <input
              type="number"
              step="0.2"
              min="6"
              max="20"
              value={omegaN}
              onChange={(e) => setOmegaN(Number(e.target.value) || DEFAULT_BALAC_PLANT.omegaN)}
              style={{ padding: "3px 6px", fontSize: "0.75rem" }}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--muted)" }}>Back-EMF (1/s)</span>
            <input
              type="number"
              step="1"
              min="2"
              max="60"
              value={wheelDrag}
              onChange={(e) => setWheelDrag(Number(e.target.value) || DEFAULT_BALAC_PLANT.wheelDrag)}
              style={{ padding: "3px 6px", fontSize: "0.75rem" }}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--muted)" }}>Motor Gain</span>
            <input
              type="number"
              step="0.005"
              min="0.01"
              max="0.3"
              value={motorAccel}
              onChange={(e) => setMotorAccel(Number(e.target.value) || DEFAULT_BALAC_PLANT.motorAccel)}
              style={{ padding: "3px 6px", fontSize: "0.75rem" }}
            />
          </label>
        </div>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.72rem", color: "#79c0ff" }}>
          K = [θ:{lqr.lqrTheta}, ω:{lqr.lqrOmega}, v:{lqr.lqrVel}, x:{lqr.lqrPos}] {lqr.converged ? "✓" : "…"}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            style={{ padding: "4px 9px", fontSize: "0.74rem" }}
            onClick={runBrowserSystemId}
            title="Estimate ωn from recent 100 Hz BALANCING telemetry right in the browser"
          >
            System-ID
          </button>
          <button
            type="button"
            className="primary"
            disabled={!connected || busy || supported === false || !lqr.converged}
            style={{ padding: "4px 9px", fontSize: "0.74rem" }}
            onClick={() => void pushDareGains(false)}
          >
            Push Gains
          </button>
          <button
            type="button"
            className="success"
            disabled={!connected || busy || supported === false || !lqr.converged}
            style={{ padding: "4px 9px", fontSize: "0.74rem" }}
            onClick={() => void pushDareGains(true)}
          >
            Push &amp; Save
          </button>
        </div>
      </div>

      {notice && (
        <div style={{ fontSize: "0.73rem", color: "#79c0ff", wordBreak: "break-word" }}>{notice}</div>
      )}
    </div>
  );
};
