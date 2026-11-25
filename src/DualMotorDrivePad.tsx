import { useEffect, useRef, useState } from "react";

export interface DriveStickCommand {
  /** Forward/reverse drive in [-1, 1] (+1 = forward, -1 = reverse) */
  forward: number;
  /** Turn rate in [-1, 1] (+1 = turn right, -1 = turn left) */
  turn: number;
}

export interface DualMotorDrivePadProps {
  connected: boolean;
  robotState: string;
  /** Live left wheel motor PWM from telemetry (-127..127) */
  motorL: number;
  /** Live right wheel motor PWM from telemetry (-127..127) */
  motorR: number;
  /** Optional external/remote stick echo from the bridge (e.g. automated test commands) */
  remoteStick?: DriveStickCommand | null;
  /** Called whenever stick command changes (pointer or keyboard) */
  onChange: (cmd: DriveStickCommand) => void;
}

const MAX_MOTOR = 127;
const DEADZONE = 0.06;

function shapeAxis(raw: number): number {
  const clamped = Math.max(-1, Math.min(1, raw));
  const mag = Math.abs(clamped);
  if (mag <= DEADZONE) return 0;
  const norm = (mag - DEADZONE) / (1 - DEADZONE);
  // Gentle quadratic blend for fine low-speed control while preserving full authority
  const curved = 0.65 * norm + 0.35 * norm * norm;
  return Math.sign(clamped) * Math.min(1, curved);
}

function motorColor(signedNorm: number): string {
  if (Math.abs(signedNorm) < 0.02) return "#475569";
  return signedNorm > 0 ? "#38bdf8" : "#f59e0b";
}

function motorGlow(signedNorm: number): string {
  if (Math.abs(signedNorm) < 0.02) return "none";
  return signedNorm > 0
    ? "0 0 12px rgba(56, 189, 248, 0.55)"
    : "0 0 12px rgba(245, 158, 11, 0.55)";
}

/**
 * Square translucent glass drive joystick with live dual-motor power &
 * direction visualization rendered inside the pad background.
 */
export function DualMotorDrivePad({
  connected,
  robotState,
  motorL,
  motorR,
  remoteStick,
  onChange,
}: DualMotorDrivePadProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [rotorAngles, setRotorAngles] = useState<{ l: number; r: number }>({ l: 0, r: 0 });
  const motorsRef = useRef({ l: 0, r: 0 });
  const keysRef = useRef<Set<string>>(new Set());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const normL = connected ? Math.max(-1, Math.min(1, motorL / MAX_MOTOR)) : 0;
  const normR = connected ? Math.max(-1, Math.min(1, motorR / MAX_MOTOR)) : 0;
  motorsRef.current = { l: normL, r: normR };

  const isBalancing = connected && robotState === "BALANCING";
  const isPerched = isBalancing && Math.abs(motorL) === 0 && Math.abs(motorR) === 0;
  const canDrive = connected && ["BALANCING", "ARMED", "READY"].includes(robotState);

  // Smooth rotor spin animation proportional to live motor PWM & direction
  useEffect(() => {
    let raf = 0;
    let lastTs = performance.now();
    const step = (ts: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000));
      lastTs = ts;
      const { l, r } = motorsRef.current;
      if (Math.abs(l) > 0.015 || Math.abs(r) > 0.015) {
        // Max ~4.5 turns/sec at 100% PWM
        const degPerSec = 1620;
        setRotorAngles((prev) => ({
          l: (prev.l + l * degPerSec * dt) % 360,
          r: (prev.r + r * degPerSec * dt) % 360,
        }));
      }
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Keyboard WASD / Arrow support (ignored when typing in inputs)
  useEffect(() => {
    const emitKeyboard = () => {
      if (pointerIdRef.current !== null) return;
      const keys = keysRef.current;
      const fwdRaw =
        (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
        (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
      const turnRaw =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
        (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      const scale = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 0.5 : 0.85;
      const x = turnRaw * scale;
      const y = -fwdRaw * scale;
      setKnob({ x, y });
      onChangeRef.current({ forward: -y, turn: x });
    };

    const isEditable = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    };

    const DRIVE_KEYS = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "ShiftLeft", "ShiftRight",
    ]);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!connected || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!DRIVE_KEYS.has(e.code)) return;
      if (!keysRef.current.has(e.code)) {
        keysRef.current.add(e.code);
        if (e.code.startsWith("Arrow")) e.preventDefault();
        emitKeyboard();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!keysRef.current.has(e.code)) return;
      keysRef.current.delete(e.code);
      emitKeyboard();
    };

    const onBlur = () => {
      if (keysRef.current.size > 0) {
        keysRef.current.clear();
        setKnob({ x: 0, y: 0 });
        onChangeRef.current({ forward: 0, turn: 0 });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [connected]);

  // Reset stick cleanly on disconnect
  useEffect(() => {
    if (!connected) {
      pointerIdRef.current = null;
      keysRef.current.clear();
      setDragging(false);
      setKnob({ x: 0, y: 0 });
      onChangeRef.current({ forward: 0, turn: 0 });
    }
  }, [connected]);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.max(24, rect.width * 0.38);
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    const turn = shapeAxis(dx);
    const forward = shapeAxis(-dy);
    setKnob({ x: dx, y: dy });
    onChange({ forward, turn });
  };

  const releasePointer = () => {
    pointerIdRef.current = null;
    setDragging(false);
    setKnob({ x: 0, y: 0 });
    onChange({ forward: 0, turn: 0 });
  };

  const renderMotorOrb = (side: "L" | "R", norm: number, angleDeg: number, cx: number) => {
    const absNorm = Math.abs(norm);
    const pct = Math.round(norm * 100);
    const r = 21;
    const circ = 2 * Math.PI * r;
    const dashLen = circ * absNorm;
    const color = motorColor(norm);
    const dirLabel = absNorm < 0.02 ? "•" : norm > 0 ? "▲" : "▼";

    return (
      <g key={side} transform={`translate(${cx}, 80)`}>
        {/* Ambient radial glow */}
        {absNorm >= 0.04 && (
          <circle
            r={24}
            fill={norm > 0 ? "rgba(56, 189, 248, 0.14)" : "rgba(245, 158, 11, 0.14)"}
            opacity={0.35 + absNorm * 0.65}
          />
        )}
        {/* Base wheel ring */}
        <circle
          r={r}
          fill="rgba(2, 6, 23, 0.72)"
          stroke="rgba(148, 163, 184, 0.24)"
          strokeWidth={2.5}
        />
        {/* Rotating rotor spokes (spins forward/reverse with live motor PWM) */}
        <g transform={`rotate(${angleDeg.toFixed(1)})`}>
          <circle
            r={14.5}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="6 6"
            opacity={absNorm < 0.02 ? 0.28 : 0.85}
          />
          <line
            x1={0}
            y1={-15}
            x2={0}
            y2={-8}
            stroke={color}
            strokeWidth={2.2}
            strokeLinecap="round"
            opacity={absNorm < 0.02 ? 0.35 : 1}
          />
        </g>
        {/* Proportional power fill arc */}
        <circle
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeDasharray={`${dashLen.toFixed(1)} ${circ.toFixed(1)}`}
          transform={norm >= 0 ? "rotate(-90)" : "rotate(-90) scale(1,-1)"}
          style={{ filter: absNorm > 0.05 ? `drop-shadow(${motorGlow(norm)})` : undefined }}
        />
        {/* Direction chevron */}
        <text
          x={0}
          y={-3}
          textAnchor="middle"
          fontSize={8.5}
          fontWeight={700}
          fill={color}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
        >
          {dirLabel}
        </text>
        {/* Live numeric motor % */}
        <text
          x={0}
          y={9}
          textAnchor="middle"
          fontSize={8.5}
          fontWeight={700}
          fill={absNorm < 0.02 ? "#94a3b8" : "#f8fafc"}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
        >
          {pct > 0 ? `+${pct}` : `${pct}`}%
        </text>
        {/* Motor side label */}
        <text
          x={0}
          y={33}
          textAnchor="middle"
          fontSize={8}
          fontWeight={600}
          fill="rgba(148, 163, 184, 0.8)"
          style={{ letterSpacing: "0.08em" }}
        >
          {side === "L" ? "LEFT" : "RIGHT"}
        </text>
      </g>
    );
  };

  const localActive = dragging || keysRef.current.size > 0;
  const dispX = localActive ? knob.x : (remoteStick?.turn ?? knob.x);
  const dispY = localActive ? knob.y : (remoteStick ? -remoteStick.forward : knob.y);
  const knobPercentX = dispX * 36;
  const knobPercentY = dispY * 36;

  return (
    <div
      ref={padRef}
      className={`balax-joystick balax-drive-pad${dragging ? " is-dragging" : ""}${!connected ? " is-offline" : ""}`}
      role="application"
      aria-label="Dual-motor drive joystick (drag or use WASD / Arrow keys)"
      title={
        !connected
          ? "Connect BalaX to drive"
          : isBalancing
            ? "Drag or use WASD / Arrow keys to drive (Shift = precision)"
            : "Arm & balance BalaX, then drag or use WASD / Arrow keys to drive"
      }
      onPointerDown={(e) => {
        if (!connected) return;
        e.preventDefault();
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        updateFromPointer(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        updateFromPointer(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        releasePointer();
      }}
      onPointerCancel={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        releasePointer();
      }}
      onLostPointerCapture={() => {
        if (pointerIdRef.current !== null) releasePointer();
      }}
    >
      {/* Background SVG: crosshair, chassis, nose arrow, and live Left/Right motor orbs */}
      <svg className="balax-drive-pad__bg" viewBox="0 0 160 160" aria-hidden="true">
        {/* Subtle crosshair & center deadzone ring */}
        <line x1="80" y1="18" x2="80" y2="142" stroke="rgba(148,163,184,0.14)" strokeWidth="1" />
        <line x1="18" y1="80" x2="142" y2="80" stroke="rgba(148,163,184,0.14)" strokeWidth="1" />
        <circle cx="80" cy="80" r="14" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="1" strokeDasharray="3 3" />

        {/* Top-down BalaX chassis axle bridge & nose arrow */}
        <line x1="57" y1="80" x2="103" y2="80" stroke="rgba(148,163,184,0.28)" strokeWidth="3" strokeLinecap="round" />
        <rect x="70" y="69" width="20" height="22" rx="4" fill="rgba(30,41,59,0.7)" stroke="rgba(148,163,184,0.32)" strokeWidth="1.2" />
        <polygon points="80,55 75,64 85,64" fill="rgba(148,163,184,0.45)" />

        {/* Live Left & Right wheel motor orbs */}
        {renderMotorOrb("L", normL, rotorAngles.l, 36)}
        {renderMotorOrb("R", normR, rotorAngles.r, 124)}

        {/* Active vector tether line from center to knob */}
        {(Math.abs(dispX) > 0.02 || Math.abs(dispY) > 0.02) && (
          <line
            x1="80"
            y1="80"
            x2={(80 + dispX * 58).toFixed(1)}
            y2={(80 + dispY * 58).toFixed(1)}
            stroke="rgba(56, 189, 248, 0.72)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>

      {/* Edge orientation labels */}
      <span className="balax-drive-pad__edge balax-drive-pad__edge--top">FWD</span>
      <span className="balax-drive-pad__edge balax-drive-pad__edge--bottom">
        {isPerched ? (
          <span className="balax-drive-pad__perch">PERCH</span>
        ) : !connected ? (
          "OFFLINE"
        ) : !canDrive ? (
          robotState || "READY"
        ) : (
          "REV"
        )}
      </span>

      {/* Floating translucent thumb knob */}
      <span
        className="balax-drive-pad__knob"
        style={{
          left: `${(50 + knobPercentX).toFixed(2)}%`,
          top: `${(50 + knobPercentY).toFixed(2)}%`,
        }}
      />
    </div>
  );
}
