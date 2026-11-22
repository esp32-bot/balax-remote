import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActiveImuCalibration,
  evaluateHilCapture,
  HIL_MANEUVER_PRESETS,
  HilCapture,
  HilScorecard,
  LeverArmCalibrationResult,
  SixFaceCalibrationResult,
  solveLeverArmFromRotation,
  solveSixFaceAccelEllipsoid,
  unapplyAccelCalibration,
  Vec3Tuple,
} from "@g-ai/rc";
import { TraceSample } from "./bxz1";

interface CalibrationHilPanelProps {
  connected: boolean;
  latest: TraceSample | null;
  historyRef: React.MutableRefObject<TraceSample[]>;
  activeCal: ActiveImuCalibration;
  onRefreshCal: () => Promise<ActiveImuCalibration | null>;
  onSendCmd: (cmd: string) => Promise<string>;
  onZeroImu: () => Promise<void>;
  onCalibrationApplied: (cal: ActiveImuCalibration) => void;
  onReplayCapture: (capture: HilCapture) => void;
  replayingName: string | null;
  onStopReplay: () => void;
}

type SideId = "standing" | "upside_down" | "screen_up" | "screen_down" | "left_side" | "right_side";

interface SideSpec {
  id: SideId;
  name: string;
  shortHint: string;
}

const SIDES: readonly SideSpec[] = [
  { id: "standing", name: "Standing", shortHint: "On its wheels" },
  { id: "upside_down", name: "Upside Down", shortHint: "Wheels in the air" },
  { id: "screen_up", name: "Screen Up", shortHint: "Flat on its back" },
  { id: "screen_down", name: "Screen Down", shortHint: "Flat face-down" },
  { id: "left_side", name: "Left Side", shortHint: "Resting on left wheel" },
  { id: "right_side", name: "Right Side", shortHint: "Resting on right wheel" },
];

const SIDE_NOTES_HZ = [880, 988, 1109, 1245, 1397, 1760];
const HOLD_TARGET_SAMPLES = 100; // ~1.0s held still at 100 Hz

/**
 * Classifies which of the 6 sides BalaX is resting on from its raw or calibrated accel vector.
 * Verified M5StickC Plus in BalaC:
 *   Standing upright:  ay ≈ -1g
 *   Upside down:       ay ≈ +1g
 *   Screen facing up:  az ≈ +1g
 *   Screen facing down:az ≈ -1g
 *   Resting on left:   ax ≈ +1g (right side points up)
 *   Resting on right:  ax ≈ -1g (left side points up)
 */
function detectSideFromAccel(a: Vec3Tuple): SideId | null {
  const norm = Math.hypot(a[0], a[1], a[2]);
  if (norm < 0.45) return null;
  const nx = a[0] / norm;
  const ny = a[1] / norm;
  const nz = a[2] / norm;
  const THRESH = 0.76; // forgiving ~40 deg cone around each side
  if (ny < -THRESH) return "standing";
  if (ny > THRESH) return "upside_down";
  if (nz > THRESH) return "screen_up";
  if (nz < -THRESH) return "screen_down";
  if (nx > THRESH) return "left_side";
  if (nx < -THRESH) return "right_side";
  return null;
}

/** Tiny crystal-clear cartoon SVG of BalaX in each of the 6 poses. */
function SidePoseIcon({ side, done, active }: { side: SideId; done: boolean; active: boolean }) {
  const body = done ? "#3fb950" : active ? "#58a6ff" : "#f0883e";
  const screen = done ? "#a7f3d0" : "#58a6ff";
  const wheel = "#8b949e";
  const floor = "#30363d";

  return (
    <svg width="42" height="32" viewBox="0 0 42 32" style={{ flexShrink: 0 }}>
      <line x1="3" y1="29" x2="39" y2="29" stroke={floor} strokeWidth="1.5" strokeLinecap="round" />
      {side === "standing" && (
        <g>
          <rect x="16" y="4" width="10" height="19" rx="2" fill={body} />
          <rect x="18" y="7" width="6" height="9" rx="1" fill={screen} />
          <circle cx="14" cy="24" r="4" fill={wheel} />
          <circle cx="28" cy="24" r="4" fill={wheel} />
        </g>
      )}
      {side === "upside_down" && (
        <g>
          <rect x="16" y="9" width="10" height="19" rx="2" fill={body} />
          <rect x="18" y="16" width="6" height="9" rx="1" fill={screen} />
          <circle cx="14" cy="8" r="4" fill={wheel} />
          <circle cx="28" cy="8" r="4" fill={wheel} />
        </g>
      )}
      {side === "screen_up" && (
        <g>
          <rect x="11" y="19" width="20" height="9" rx="2" fill={body} />
          <rect x="15" y="17" width="11" height="3" rx="1" fill={screen} />
          <circle cx="11" cy="23" r="4.5" fill={wheel} />
          <path d="M21 13 L21 6 M18 9 L21 6 L24 9" stroke={screen} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
      )}
      {side === "screen_down" && (
        <g>
          <rect x="11" y="18" width="20" height="9" rx="2" fill={body} />
          <rect x="15" y="26" width="11" height="2.5" rx="1" fill={screen} />
          <circle cx="11" cy="22" r="4.5" fill={wheel} />
          <path d="M21 6 L21 13 M18 10 L21 13 L24 10" stroke={screen} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
      )}
      {side === "left_side" && (
        <g>
          <rect x="14" y="16" width="19" height="9" rx="2" fill={body} />
          <rect x="18" y="18" width="10" height="5" rx="1" fill={screen} />
          <ellipse cx="12" cy="26" rx="4" ry="2.2" fill={wheel} />
          <ellipse cx="12" cy="14" rx="4" ry="2.2" fill={wheel} />
        </g>
      )}
      {side === "right_side" && (
        <g>
          <rect x="9" y="16" width="19" height="9" rx="2" fill={body} />
          <rect x="14" y="18" width="10" height="5" rx="1" fill={screen} />
          <ellipse cx="30" cy="26" rx="4" ry="2.2" fill={wheel} />
          <ellipse cx="30" cy="14" rx="4" ry="2.2" fill={wheel} />
        </g>
      )}
    </svg>
  );
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function CalibrationHilPanel({
  connected,
  latest,
  historyRef,
  activeCal,
  onRefreshCal,
  onSendCmd,
  onZeroImu,
  onCalibrationApplied,
  onReplayCapture,
  replayingName,
  onStopReplay,
}: CalibrationHilPanelProps) {
  const [view, setView] = useState<"calibrate" | "hil">("calibrate");
  const [showTech, setShowTech] = useState(false);

  // Active wizard mode: none | six_side | spin_cg | hil_record
  const [mode, setMode] = useState<"idle" | "six_side" | "spin_cg" | "hil_record">("idle");
  const [bannerText, setBannerText] = useState("");
  const [bannerTone, setBannerTone] = useState<"ok" | "info" | "warn">("info");

  // --- Auto 6-Side Calibration State ---
  const [capturedSides, setCapturedSides] = useState<Partial<Record<SideId, Vec3Tuple>>>({});
  const [liveSide, setLiveSide] = useState<SideId | null>(null);
  const [holdProgress, setHoldProgress] = useState(0); // 0..1
  const [isHoldingStill, setIsHoldingStill] = useState(false);
  const [sixSideResult, setSixSideResult] = useState<SixFaceCalibrationResult | null>(null);

  // --- Auto Spin (CG) Calibration State ---
  const [spinBars, setSpinBars] = useState<{ nod: number; tilt: number; twist: number }>({
    nod: 0,
    tilt: 0,
    twist: 0,
  });
  const [cgResult, setCgResult] = useState<LeverArmCalibrationResult | null>(null);
  const spinSamplesRef = useRef<TraceSample[]>([]);
  const spinEnergyRef = useRef({ nod: 0, tilt: 0, twist: 0 });
  const spinDoneBeepedRef = useRef({ nod: false, tilt: false, twist: false });

  // --- HIL Benchmark State ---
  const [hilBusyLabel, setHilBusyLabel] = useState("");
  const [hilProgress, setHilProgress] = useState(0);
  const [captures, setCaptures] = useState<HilCapture[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Refs for fresh state inside interval loops
  const activeCalRef = useRef(activeCal);
  activeCalRef.current = activeCal;
  const capturedSidesRef = useRef<Partial<Record<SideId, Vec3Tuple>>>({});
  capturedSidesRef.current = capturedSides;
  const savingRef = useRef(false);

  // Load any saved HIL captures from local dev bridge
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/bridge/hil");
        if (!res.ok) return;
        const data = (await res.json()) as { captures?: { name: string }[] };
        if (!alive || !data.captures?.length) return;
        const loaded: HilCapture[] = [];
        for (const item of data.captures.slice(-12)) {
          const r = await fetch(`/api/bridge/hil?name=${encodeURIComponent(item.name)}`);
          if (r.ok) {
            const cap = (await r.json()) as HilCapture;
            if (Array.isArray(cap.samples) && cap.samples.length > 0) loaded.push(cap);
          }
        }
        if (alive && loaded.length > 0) setCaptures(loaded);
      } catch {
        // Standalone browser mode
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function saveHilToBridge(capture: HilCapture) {
    try {
      await fetch("/api/bridge/hil", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(capture),
      });
    } catch {
      // Optional local bridge mirror
    }
  }

  // Gently track live side while idle
  useEffect(() => {
    if (mode === "six_side" || !latest) return;
    const raw = unapplyAccelCalibration(
      [latest.accelXG ?? 0, latest.accelYG ?? -1, latest.accelZG ?? 0],
      activeCalRef.current
    );
    setLiveSide(detectSideFromAccel(raw));
  }, [mode, latest]);

  // Drive live auto-capture loop when in six_side mode (depends ONLY on [mode] so holdBuf persists!)
  useEffect(() => {
    if (mode !== "six_side") return;

    let holdSide: SideId | null = null;
    let holdBuf: Vec3Tuple[] = [];
    let lastTick = historyRef.current[historyRef.current.length - 1]?.tick ?? 0;
    let finishing = false;

    const timer = window.setInterval(() => {
      if (finishing) return;
      const hist = historyRef.current;
      const fresh: TraceSample[] = [];
      for (let i = 0; i < hist.length; i++) {
        const s = hist[i]!;
        if (s.tick > lastTick) {
          fresh.push(s);
          lastTick = s.tick;
        }
      }
      if (fresh.length === 0) return;

      // Check recent 25 samples (~0.25s) for stillness + current resting side
      const recent = hist.slice(-25);
      if (recent.length < 10) return;

      let sax = 0, say = 0, saz = 0;
      let minGx = Infinity, maxGx = -Infinity;
      let minGy = Infinity, maxGy = -Infinity;
      let minGz = Infinity, maxGz = -Infinity;
      for (const s of recent) {
        const raw = unapplyAccelCalibration(
          [s.accelXG ?? 0, s.accelYG ?? -1, s.accelZG ?? 0],
          activeCalRef.current
        );
        sax += raw[0]; say += raw[1]; saz += raw[2];
        const gx = s.gyroXDps ?? 0, gy = s.gyroYDps ?? 0, gz = s.gyroZDps ?? 0;
        if (gx < minGx) minGx = gx; if (gx > maxGx) maxGx = gx;
        if (gy < minGy) minGy = gy; if (gy > maxGy) maxGy = gy;
        if (gz < minGz) minGz = gz; if (gz > maxGz) maxGz = gz;
      }
      const meanRaw: Vec3Tuple = [sax / recent.length, say / recent.length, saz / recent.length];
      let varA = 0;
      for (const s of recent) {
        const raw = unapplyAccelCalibration(
          [s.accelXG ?? 0, s.accelYG ?? -1, s.accelZG ?? 0],
          activeCalRef.current
        );
        const dx = raw[0] - meanRaw[0], dy = raw[1] - meanRaw[1], dz = raw[2] - meanRaw[2];
        varA += dx * dx + dy * dy + dz * dz;
      }
      const accelStd = Math.sqrt(varA / recent.length);
      const gyroSpread = Math.max(maxGx - minGx, maxGy - minGy, maxGz - minGz);
      const stillNow = gyroSpread < 22 && accelStd < 0.055;
      const side = detectSideFromAccel(meanRaw);

      setLiveSide(side);
      setIsHoldingStill(stillNow);

      const alreadyDone = side ? Boolean(capturedSidesRef.current[side]) : false;

      if (!side || alreadyDone || !stillNow) {
        holdSide = null;
        holdBuf = [];
        setHoldProgress(0);
        return;
      }

      if (holdSide !== side) {
        holdSide = side;
        holdBuf = [];
      }

      for (const s of fresh) {
        holdBuf.push(
          unapplyAccelCalibration(
            [s.accelXG ?? 0, s.accelYG ?? -1, s.accelZG ?? 0],
            activeCalRef.current
          )
        );
      }

      const pct = Math.min(1, holdBuf.length / HOLD_TARGET_SAMPLES);
      setHoldProgress(pct);

      if (holdBuf.length >= HOLD_TARGET_SAMPLES) {
        // Lock in this side!
        const n = holdBuf.length;
        const avg: Vec3Tuple = [
          holdBuf.reduce((sum, v) => sum + v[0], 0) / n,
          holdBuf.reduce((sum, v) => sum + v[1], 0) / n,
          holdBuf.reduce((sum, v) => sum + v[2], 0) / n,
        ];
        const nextMap: Partial<Record<SideId, Vec3Tuple>> = {
          ...capturedSidesRef.current,
          [side]: avg,
        };
        capturedSidesRef.current = nextMap;
        setCapturedSides(nextMap);
        holdSide = null;
        holdBuf = [];
        setHoldProgress(0);

        const doneCount = Object.keys(nextMap).length;
        const noteHz = SIDE_NOTES_HZ[Math.min(doneCount - 1, SIDE_NOTES_HZ.length - 1)]!;
        void onSendCmd(`beep ${noteHz} 90`);

        if (doneCount >= 6) {
          finishing = true;
          void finishSixSideCalibration(nextMap);
        }
      }
    }, 50);

    return () => window.clearInterval(timer);
  }, [mode]);

  async function finishSixSideCalibration(sideMap: Partial<Record<SideId, Vec3Tuple>>) {
    if (savingRef.current) return;
    savingRef.current = true;
    setBannerTone("info");
    setBannerText("All 6 sides done! Saving calibration to robot...");
    try {
      const vectors = Object.values(sideMap).filter((v): v is Vec3Tuple => Boolean(v));
      const solved = solveSixFaceAccelEllipsoid(vectors);
      setSixSideResult(solved);
      const [bx, by, bz] = solved.biasG;
      const [sx, sy, sz] = solved.scale;
      await onSendCmd(
        `imu accel ${bx.toFixed(5)} ${by.toFixed(5)} ${bz.toFixed(5)} ${sx.toFixed(5)} ${sy.toFixed(5)} ${sz.toFixed(5)}`
      );
      const refreshed = await onRefreshCal();
      if (refreshed) onCalibrationApplied(refreshed);
      const accPct = Math.max(0, 100 * (1 - solved.afterMaxErrG));
      setBannerTone("ok");
      setBannerText(`Level & gravity saved to robot! (${accPct.toFixed(1)}% accurate across all 6 sides)`);
      setMode("idle");
    } catch (err) {
      setBannerTone("warn");
      setBannerText(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      setMode("idle");
    } finally {
      savingRef.current = false;
    }
  }

  function startSixSideWizard() {
    setCapturedSides({});
    capturedSidesRef.current = {};
    setSixSideResult(null);
    setHoldProgress(0);
    setBannerText("");
    setMode("six_side");
    void onSendCmd("beep 800 80");
  }

  // --- Auto Spin (CG) Calibration Live Loop ---
  useEffect(() => {
    if (mode !== "spin_cg") return;

    spinSamplesRef.current = [];
    spinEnergyRef.current = { nod: 0, tilt: 0, twist: 0 };
    spinDoneBeepedRef.current = { nod: false, tilt: false, twist: false };
    setSpinBars({ nod: 0, tilt: 0, twist: 0 });

    let lastTick = historyRef.current[historyRef.current.length - 1]?.tick ?? 0;
    let finishing = false;

    // Excitation target per axis: sum( (rad/s)^2 * dt ) during brisk motion (|w| > 30 deg/s)
    // ~5.5 rad^2/s corresponds to ~2-3 clean back-and-forth wiggles on that axis.
    const TARGET_ENERGY = 5.5;
    const DEG2RAD = Math.PI / 180;

    const timer = window.setInterval(() => {
      if (finishing) return;
      const hist = historyRef.current;
      for (let i = 0; i < hist.length; i++) {
        const s = hist[i]!;
        if (s.tick > lastTick) {
          lastTick = s.tick;
          spinSamplesRef.current.push(s);
          // M5StickC Plus axes: gyroX = Nod (pitch), gyroY = Twist (yaw), gyroZ = Tilt (roll)
          const wx = (s.gyroXDps ?? 0) * DEG2RAD;
          const wy = (s.gyroYDps ?? 0) * DEG2RAD;
          const wz = (s.gyroZDps ?? 0) * DEG2RAD;
          if (Math.abs(wx) > 0.55) spinEnergyRef.current.nod += wx * wx * 0.01;
          if (Math.abs(wz) > 0.55) spinEnergyRef.current.tilt += wz * wz * 0.01;
          if (Math.abs(wy) > 0.55) spinEnergyRef.current.twist += wy * wy * 0.01;
        }
      }

      const nodPct = Math.min(1, spinEnergyRef.current.nod / TARGET_ENERGY);
      const tiltPct = Math.min(1, spinEnergyRef.current.tilt / TARGET_ENERGY);
      const twistPct = Math.min(1, spinEnergyRef.current.twist / TARGET_ENERGY);
      setSpinBars({ nod: nodPct, tilt: tiltPct, twist: twistPct });

      if (nodPct >= 1 && !spinDoneBeepedRef.current.nod) {
        spinDoneBeepedRef.current.nod = true;
        void onSendCmd("beep 1050 75");
      }
      if (tiltPct >= 1 && !spinDoneBeepedRef.current.tilt) {
        spinDoneBeepedRef.current.tilt = true;
        void onSendCmd("beep 1320 75");
      }
      if (twistPct >= 1 && !spinDoneBeepedRef.current.twist) {
        spinDoneBeepedRef.current.twist = true;
        void onSendCmd("beep 1680 75");
      }

      if (nodPct >= 1 && tiltPct >= 1 && twistPct >= 1 && spinSamplesRef.current.length >= 150) {
        finishing = true;
        void finishSpinCgCalibration();
      }
    }, 50);

    return () => window.clearInterval(timer);
  }, [mode]);

  async function finishSpinCgCalibration() {
    if (savingRef.current) return;
    savingRef.current = true;
    const samples = [...spinSamplesRef.current];
    if (samples.length < 60) {
      setBannerTone("warn");
      setBannerText("Not enough motion yet — wiggle BalaX for a couple seconds first.");
      savingRef.current = false;
      setMode("idle");
      return;
    }

    setBannerTone("info");
    setBannerText("Solving balance point & saving to robot...");
    try {
      const solved = solveLeverArmFromRotation(samples, 0.01);
      setCgResult(solved);
      const [rx, ry, rz] = solved.leverArmM;
      await onSendCmd(`imu cg ${rx.toFixed(5)} ${ry.toFixed(5)} ${rz.toFixed(5)}`);
      const refreshed = await onRefreshCal();
      if (refreshed) {
        onCalibrationApplied(refreshed);
      } else {
        onCalibrationApplied({ ...activeCalRef.current, leverArmM: solved.leverArmM });
      }
      const cap: HilCapture = {
        name: "02_rotate_cg",
        recordedAt: new Date().toISOString(),
        durationSec: samples.length * 0.01,
        calibration: activeCalRef.current,
        samples,
      };
      setCaptures((prev) => [...prev.filter((c) => c.name !== cap.name), cap]);
      void saveHilToBridge(cap);
      setBannerTone("ok");
      setBannerText(
        `Balance point saved to robot! (Offset: ${(rx * 100).toFixed(1)}, ${(ry * 100).toFixed(1)}, ${(rz * 100).toFixed(1)} cm)`
      );
      setMode("idle");
    } catch (err) {
      setBannerTone("warn");
      setBannerText(`Spin calibration failed: ${err instanceof Error ? err.message : String(err)}`);
      setMode("idle");
    } finally {
      savingRef.current = false;
    }
  }

  function startSpinWizard() {
    setCgResult(null);
    setBannerText("");
    setMode("spin_cg");
    void onSendCmd("beep 950 90");
  }

  // --- HIL Preset Recording ---
  async function recordHilPreset(presetId: string, label: string, durationSec: number) {
    if (mode !== "idle") return;
    setMode("hil_record");
    setHilBusyLabel(label);
    setHilProgress(0);
    setBannerText("");
    try {
      await onSendCmd("beep 1200 90").catch(() => "");
      const startTick = historyRef.current[historyRef.current.length - 1]?.tick ?? 0;
      const startMs = performance.now();
      const targetMs = durationSec * 1000;
      const collected: TraceSample[] = [];
      let lastTick = startTick;

      await new Promise<void>((resolve) => {
        const iv = window.setInterval(() => {
          const hist = historyRef.current;
          for (let i = 0; i < hist.length; i++) {
            const s = hist[i]!;
            if (s.tick > lastTick) {
              collected.push(s);
              lastTick = s.tick;
            }
          }
          const elapsed = performance.now() - startMs;
          setHilProgress(Math.min(1, elapsed / targetMs));
          if (elapsed >= targetMs) {
            window.clearInterval(iv);
            resolve();
          }
        }, 40);
      });

      await onSendCmd("beep 800 140").catch(() => "");

      if (collected.length < 20) {
        setBannerTone("warn");
        setBannerText("No samples received — check Wi-Fi connection.");
        return;
      }

      const cap: HilCapture = {
        name: presetId,
        recordedAt: new Date().toISOString(),
        durationSec: collected.length * 0.01,
        calibration: activeCal,
        samples: collected,
      };
      setCaptures((prev) => [...prev.filter((c) => c.name !== cap.name), cap]);
      void saveHilToBridge(cap);
      setBannerTone("ok");
      setBannerText(`Recorded "${label}" (${collected.length} samples) & saved to recordings/hil/.`);
    } finally {
      setHilBusyLabel("");
      setHilProgress(0);
      setMode("idle");
    }
  }

  const scorecards = useMemo(() => {
    const map = new Map<string, HilScorecard>();
    for (const cap of captures) {
      map.set(cap.name, evaluateHilCapture(cap.samples, { leverArmM: activeCal.leverArmM }));
    }
    return map;
  }, [captures, activeCal.leverArmM]);

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as HilCapture;
        if (!Array.isArray(parsed.samples)) throw new Error("Missing samples array");
        const cap: HilCapture = {
          name: parsed.name || file.name.replace(/\.json$/, ""),
          recordedAt: parsed.recordedAt || new Date().toISOString(),
          durationSec: parsed.durationSec || parsed.samples.length * 0.01,
          calibration: parsed.calibration,
          samples: parsed.samples,
        };
        setCaptures((prev) => [...prev.filter((c) => c.name !== cap.name), cap]);
        setBannerTone("ok");
        setBannerText(`Imported ${cap.name} (${cap.samples.length} samples).`);
      } catch (err) {
        setBannerTone("warn");
        setBannerText(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Friendly live coaching text for 6-side wizard
  const doneSideCount = Object.keys(capturedSides).length;
  const liveSideSpec = SIDES.find((s) => s.id === liveSide);
  const sixSideCoach = (() => {
    if (!liveSide || !liveSideSpec) {
      return `Set BalaX gently on any gray side (${doneSideCount}/6 done)`;
    }
    if (capturedSides[liveSide]) {
      return `Already got "${liveSideSpec.name}" ✓ — flip onto any gray side!`;
    }
    if (!isHoldingStill) {
      return `On "${liveSideSpec.name}" — hold still...`;
    }
    return `Hold still on "${liveSideSpec.name}"... ${Math.round(holdProgress * 100)}%`;
  })();

  // Friendly live coaching text for spin wizard
  const spinCoach = (() => {
    const { nod, tilt, twist } = spinBars;
    if (nod >= 1 && tilt >= 1 && twist >= 1) return "Awesome! Saving...";
    if (nod <= tilt && nod <= twist) return "Hold by the wheels & NOD forward/back ↕️";
    if (tilt <= nod && tilt <= twist) return "Now TILT side-to-side ↔️";
    return "Now TWIST left & right like a steering wheel 🔄";
  })();

  const hasCgCal = Math.hypot(...activeCal.leverArmM) > 0.0005;
  const liveNormG = latest
    ? Math.hypot(latest.accelXG ?? 0, latest.accelYG ?? 0, latest.accelZG ?? 0)
    : 0;

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 9, fontSize: "0.78rem" }}>
      {/* Simple 2-Tab Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button
          className={view === "calibrate" ? "primary" : ""}
          style={{ padding: "5px 8px", fontSize: "0.78rem", fontWeight: 600 }}
          onClick={() => setView("calibrate")}
        >
          Calibrate Robot
        </button>
        <button
          className={view === "hil" ? "primary" : ""}
          style={{ padding: "5px 8px", fontSize: "0.78rem", fontWeight: 600 }}
          onClick={() => setView("hil")}
        >
          Test &amp; Replay ({captures.length})
        </button>
      </div>

      {/* Feedback Banner */}
      {bannerText && (
        <div
          style={{
            padding: "6px 9px",
            borderRadius: 6,
            fontSize: "0.74rem",
            background:
              bannerTone === "ok"
                ? "rgba(63, 185, 80, 0.14)"
                : bannerTone === "warn"
                ? "rgba(248, 81, 73, 0.14)"
                : "rgba(56, 139, 253, 0.14)",
            border: `1px solid ${
              bannerTone === "ok" ? "#3fb950" : bannerTone === "warn" ? "#f85149" : "#388bfd"
            }`,
            color:
              bannerTone === "ok" ? "#7ee787" : bannerTone === "warn" ? "#ffa198" : "#79c0ff",
          }}
        >
          {bannerText}
        </div>
      )}

      {view === "calibrate" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {/* STEP 1: AUTO 6-SIDE CALIBRATION */}
          <div
            style={{
              background: "#0d1117",
              border: mode === "six_side" ? "1px solid #388bfd" : "1px solid #21262d",
              borderRadius: 8,
              padding: 9,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "0.84rem" }}>1. Level &amp; Gravity (6 Sides)</strong>
              <span
                style={{
                  fontSize: "0.69rem",
                  padding: "2px 7px",
                  borderRadius: 99,
                  background: activeCal.accel6Face ? "rgba(63,185,80,0.18)" : "rgba(210,153,34,0.18)",
                  color: activeCal.accel6Face ? "#3fb950" : "#e3b341",
                  fontWeight: 600,
                }}
              >
                {activeCal.accel6Face ? "✓ Saved" : "Needs setup"}
              </span>
            </div>

            {mode !== "six_side" ? (
              <>
                <div style={{ color: "var(--muted)", fontSize: "0.73rem", lineHeight: 1.35 }}>
                  Rest BalaX on each of its 6 sides in <strong>any order</strong>. It watches the live sensor, captures automatically when you hold still, and beeps when each side is done!
                </div>
                <button
                  className="primary"
                  disabled={!connected || mode !== "idle"}
                  style={{ padding: "7px 12px", fontSize: "0.8rem", fontWeight: 600 }}
                  onClick={startSixSideWizard}
                >
                  {activeCal.accel6Face ? "Recalibrate 6 Sides" : "Start 6-Side Calibration"}
                </button>
              </>
            ) : (
              <>
                {/* Live Coaching Hero Prompt */}
                <div
                  style={{
                    background: holdProgress > 0 ? "rgba(56,139,253,0.16)" : "#161b22",
                    border: holdProgress > 0 ? "1px solid #58a6ff" : "1px solid #30363d",
                    borderRadius: 6,
                    padding: "7px 9px",
                  }}
                >
                  <div style={{ fontWeight: 600, color: "#f0f6fc", fontSize: "0.79rem", marginBottom: 5 }}>
                    {sixSideCoach}
                  </div>
                  <div style={{ height: 6, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${holdProgress * 100}%`,
                        height: "100%",
                        background: holdProgress > 0.75 ? "#3fb950" : "#58a6ff",
                        transition: "width 60ms linear",
                      }}
                    />
                  </div>
                </div>

                {/* Visual 6-Side Tiles (zero clicking needed!) */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {SIDES.map((s) => {
                    const done = Boolean(capturedSides[s.id]);
                    const isHere = liveSide === s.id;
                    const filling = isHere && !done && holdProgress > 0;
                    return (
                      <div
                        key={s.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "6px 7px",
                          borderRadius: 7,
                          position: "relative",
                          overflow: "hidden",
                          background: done
                            ? "rgba(63, 185, 80, 0.14)"
                            : isHere
                            ? "rgba(56, 139, 253, 0.16)"
                            : "#161b22",
                          border: `1px solid ${
                            done ? "#3fb950" : isHere ? "#58a6ff" : "#30363d"
                          }`,
                        }}
                      >
                        {filling && (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: `${holdProgress * 100}%`,
                              background: "rgba(88, 166, 255, 0.22)",
                              pointerEvents: "none",
                            }}
                          />
                        )}
                        <SidePoseIcon side={s.id} done={done} active={isHere && !done} />
                        <div style={{ minWidth: 0, zIndex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: "0.74rem", color: done ? "#7ee787" : "#f0f6fc" }}>
                            {s.name} {done ? "✓" : isHere ? "●" : ""}
                          </div>
                          <div style={{ fontSize: "0.66rem", color: "var(--muted)" }}>
                            {done ? "Done!" : filling ? "Hold still..." : s.shortHint}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                    {doneSideCount} of 6 sides captured — no clicking needed
                  </span>
                  <button
                    style={{ padding: "3px 9px", fontSize: "0.72rem" }}
                    onClick={() => setMode("idle")}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>

          {/* STEP 2: AUTO SPIN / BALANCE POINT CALIBRATION */}
          <div
            style={{
              background: "#0d1117",
              border: mode === "spin_cg" ? "1px solid #388bfd" : "1px solid #21262d",
              borderRadius: 8,
              padding: 9,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "0.84rem" }}>2. Spin / Balance Point</strong>
              <span
                style={{
                  fontSize: "0.69rem",
                  padding: "2px 7px",
                  borderRadius: 99,
                  background: hasCgCal ? "rgba(63,185,80,0.18)" : "rgba(139,148,158,0.16)",
                  color: hasCgCal ? "#3fb950" : "var(--muted)",
                  fontWeight: 600,
                }}
              >
                {hasCgCal ? "✓ Saved" : "Not set"}
              </span>
            </div>

            {mode !== "spin_cg" ? (
              <>
                <div style={{ color: "var(--muted)", fontSize: "0.73rem", lineHeight: 1.35 }}>
                  Hold BalaX by its wheels in one spot and wiggle it all 3 ways until the 3 bars turn green. Stops spinning from sliding the 3D robot.
                </div>
                <button
                  className={activeCal.accel6Face && !hasCgCal ? "primary" : ""}
                  disabled={!connected || mode !== "idle"}
                  style={{ padding: "7px 12px", fontSize: "0.8rem", fontWeight: 600 }}
                  onClick={startSpinWizard}
                >
                  {hasCgCal ? "Recalibrate Spin Point" : "Start Spin Calibration"}
                </button>
              </>
            ) : (
              <>
                <div
                  style={{
                    background: "rgba(56,139,253,0.14)",
                    border: "1px solid #58a6ff",
                    borderRadius: 6,
                    padding: "6px 9px",
                    fontWeight: 600,
                    color: "#f0f6fc",
                    fontSize: "0.78rem",
                  }}
                >
                  {spinCoach}
                </div>

                {(
                  [
                    { key: "nod", label: "↕️ Nod (Forward / Back)", val: spinBars.nod },
                    { key: "tilt", label: "↔️ Tilt (Side to Side)", val: spinBars.tilt },
                    { key: "twist", label: "🔄 Twist (Spin Left / Right)", val: spinBars.twist },
                  ] as const
                ).map((bar) => (
                  <div key={bar.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem" }}>
                      <span>{bar.label}</span>
                      <strong style={{ color: bar.val >= 1 ? "#3fb950" : "#58a6ff" }}>
                        {bar.val >= 1 ? "Done ✓" : `${Math.round(bar.val * 100)}%`}
                      </strong>
                    </div>
                    <div style={{ height: 7, background: "#21262d", borderRadius: 4, overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${bar.val * 100}%`,
                          height: "100%",
                          background: bar.val >= 1 ? "#3fb950" : "#58a6ff",
                          transition: "width 80ms linear",
                        }}
                      />
                    </div>
                  </div>
                ))}

                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <button
                    style={{ padding: "4px 9px", fontSize: "0.72rem" }}
                    onClick={() => void finishSpinCgCalibration()}
                  >
                    Finish Now
                  </button>
                  <button
                    style={{ padding: "4px 9px", fontSize: "0.72rem" }}
                    onClick={() => setMode("idle")}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>

          {/* STEP 3: QUICK DRIFT ZERO */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              disabled={!connected || mode !== "idle"}
              style={{ flex: 1, padding: "6px 10px", fontSize: "0.76rem" }}
              onClick={() => void onZeroImu()}
            >
              Quick Zero Drift (Set Still 1s)
            </button>
            <button
              style={{ padding: "6px 9px", fontSize: "0.72rem", color: "var(--muted)" }}
              onClick={() => setShowTech((v) => !v)}
            >
              {showTech ? "Hide details ▾" : "Details ▸"}
            </button>
          </div>

          {/* COLLAPSIBLE TECHNICAL DETAILS (for engineers / debugging) */}
          {showTech && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                borderRadius: 6,
                padding: "7px 9px",
                fontSize: "0.69rem",
                color: "var(--muted)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  Live ||a||:{" "}
                  <strong style={{ color: Math.abs(liveNormG - 1) <= 0.015 ? "#3fb950" : "#e3b341" }}>
                    {liveNormG > 0 ? `${liveNormG.toFixed(3)} g` : "—"}
                  </strong>
                </span>
                <button
                  style={{ padding: "2px 7px", fontSize: "0.68rem" }}
                  onClick={() => void onRefreshCal()}
                  disabled={!connected}
                >
                  Sync from Robot
                </button>
              </div>
              <div>Gyro bias: ({activeCal.gyroBiasDps.map((v) => v.toFixed(2)).join(", ")}) dps</div>
              <div>Accel bias: ({activeCal.accelBiasG.map((v) => v.toFixed(4)).join(", ")}) g</div>
              <div>Accel scale: ({activeCal.accelScale.map((v) => v.toFixed(4)).join(", ")})</div>
              <div>CG → IMU: ({activeCal.leverArmM.map((v) => (v * 100).toFixed(2)).join(", ")}) cm</div>
              {sixSideResult && (
                <div style={{ color: "#7ee787" }}>
                  Last 6-side fit: max err {sixSideResult.beforeMaxErrG.toFixed(3)}g →{" "}
                  {sixSideResult.afterMaxErrG.toFixed(4)}g
                </div>
              )}
              {cgResult && (
                <div style={{ color: "#7ee787" }}>
                  Last spin fit: RMS {cgResult.rmsBeforeMps2.toFixed(3)} →{" "}
                  {cgResult.rmsAfterMps2.toFixed(3)} m/s² ({cgResult.excitationSamples} samples)
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: TEST & REPLAY (HIL BENCHMARK STUDIO) */}
      {view === "hil" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ color: "var(--muted)", fontSize: "0.72rem" }}>
            Record short moves to test &amp; improve tracking. Each capture is scored in-browser and saved to{" "}
            <code>recordings/hil/</code>.
          </div>

          {hilBusyLabel && (
            <div style={{ background: "#161b22", border: "1px solid #388bfd", borderRadius: 6, padding: "6px 8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: "0.74rem" }}>
                <strong style={{ color: "#58a6ff" }}>{hilBusyLabel}</strong>
                <span>{Math.round(hilProgress * 100)}%</span>
              </div>
              <div style={{ height: 5, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${hilProgress * 100}%`, height: "100%", background: "#58a6ff" }} />
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {HIL_MANEUVER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                disabled={!connected || mode !== "idle"}
                title={`${preset.instruction} (${preset.expectedMetric})`}
                style={{ padding: "4px 8px", fontSize: "0.72rem" }}
                onClick={() => void recordHilPreset(preset.id, preset.label, preset.durationSec)}
              >
                ● {preset.label}
              </button>
            ))}
            <button
              style={{ padding: "4px 8px", fontSize: "0.72rem" }}
              onClick={() => fileInputRef.current?.click()}
            >
              Import JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={handleImportJson}
            />
          </div>

          {replayingName && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#162436",
                border: "1px solid #388bfd",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: "0.73rem",
              }}
            >
              <span style={{ color: "#58a6ff" }}>
                Replaying <strong>{replayingName}</strong> in 3D...
              </span>
              <button style={{ padding: "2px 8px", fontSize: "0.7rem" }} onClick={onStopReplay}>
                Stop
              </button>
            </div>
          )}

          {captures.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: "0.72rem", padding: "8px 4px" }}>
              No recordings yet. Click any test button above (robot beeps on start &amp; finish).
            </div>
          ) : (
            <div style={{ overflowX: "auto", border: "1px solid #21262d", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.7rem" }}>
                <thead>
                  <tr style={{ background: "#0d1117", color: "var(--muted)", textAlign: "left" }}>
                    <th style={{ padding: "4px 6px" }}>Test</th>
                    <th style={{ padding: "4px 4px" }}>Rest%</th>
                    <th style={{ padding: "4px 4px" }}>||a||</th>
                    <th style={{ padding: "4px 4px" }}>Max</th>
                    <th style={{ padding: "4px 4px" }}>End</th>
                    <th style={{ padding: "4px 4px" }}>Yaw</th>
                    <th style={{ padding: "4px 6px" }}>Play</th>
                  </tr>
                </thead>
                <tbody>
                  {captures.map((cap) => {
                    const sc = scorecards.get(cap.name);
                    return (
                      <tr key={cap.name} style={{ borderTop: "1px solid #21262d" }}>
                        <td style={{ padding: "4px 6px", fontWeight: 600 }}>{cap.name}</td>
                        <td style={{ padding: "4px 4px" }}>{sc ? `${sc.restPercent.toFixed(0)}%` : "—"}</td>
                        <td style={{ padding: "4px 4px" }}>{sc ? sc.accelNormMeanG.toFixed(3) : "—"}</td>
                        <td style={{ padding: "4px 4px" }}>{sc ? `${sc.maxDispCm.toFixed(1)}cm` : "—"}</td>
                        <td style={{ padding: "4px 4px" }}>{sc ? `${sc.returnErrCm.toFixed(1)}cm` : "—"}</td>
                        <td style={{ padding: "4px 4px" }}>{sc ? `${sc.yawDeltaDeg.toFixed(0)}°` : "—"}</td>
                        <td style={{ padding: "4px 6px", display: "flex", gap: 3 }}>
                          <button
                            style={{ padding: "1px 5px", fontSize: "0.66rem" }}
                            onClick={() => onReplayCapture(cap)}
                          >
                            3D
                          </button>
                          <button
                            style={{ padding: "1px 5px", fontSize: "0.66rem" }}
                            onClick={() => downloadJson(`${cap.name}.json`, cap)}
                          >
                            JSON
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
