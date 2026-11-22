import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BALAX_PROGRAM_TEMPLATES,
  BalaXArtifactMeta,
  IndexedDbArtifactStore,
  compileBalaXProgram,
  computeRetentionScore,
  sha256Hex,
} from "@g-ai/rc";

interface ProgLog {
  ms: number;
  code: number;
  val: number;
}

interface RobotProgStatus {
  running: boolean;
  name: string;
  sha256: string;
  cache_hit: boolean;
  last_ok: boolean;
  last_aborted: boolean;
  last_steps: number;
  last_trap: string;
  runs_total: number;
  cache?: {
    hits: number;
    misses: number;
    evictions: number;
    used_bytes: number;
    budget_bytes: number;
    entries: number;
  };
  logs: ProgLog[];
}

interface RobotCacheEntry {
  sha256: string;
  name: string;
  bytes: number;
  freq: number;
  score: number;
  pinned: boolean;
}

interface RobotCacheResponse {
  hits: number;
  misses: number;
  evictions: number;
  used_bytes: number;
  budget_bytes: number;
  entries: RobotCacheEntry[];
}

interface ProgramsPanelProps {
  connected: boolean;
}

const cardStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(22, 27, 34, 0.72)",
  border: "1px solid var(--border)",
};

export const ProgramsPanel: React.FC<ProgramsPanelProps> = ({ connected }) => {
  const storeRef = useRef<IndexedDbArtifactStore | null>(null);
  if (!storeRef.current) storeRef.current = new IndexedDbArtifactStore();

  const [selectedTpl, setSelectedTpl] = useState(BALAX_PROGRAM_TEMPLATES[0].id);
  const [progName, setProgName] = useState(BALAX_PROGRAM_TEMPLATES[0].name);
  const [source, setSource] = useState(BALAX_PROGRAM_TEMPLATES[0].source);
  const [pinOnRobot, setPinOnRobot] = useState(false);

  const [robotStatus, setRobotStatus] = useState<RobotProgStatus | null>(null);
  const [robotCache, setRobotCache] = useState<RobotCacheResponse | null>(null);
  const [browserProgs, setBrowserProgs] = useState<BalaXArtifactMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>("");

  const compiled = useMemo(() => compileBalaXProgram(source), [source]);

  const refreshBrowserStore = useCallback(async () => {
    try {
      const list = await storeRef.current!.list("program");
      setBrowserProgs(list);
    } catch {
      /* IndexedDB unavailable */
    }
  }, []);

  const refreshRobot = useCallback(async () => {
    if (!connected) return;
    try {
      const [stRes, caRes] = await Promise.all([
        fetch("/api/bridge/prog/status"),
        fetch("/api/bridge/prog/cache"),
      ]);
      if (stRes.ok) setRobotStatus((await stRes.json()) as RobotProgStatus);
      if (caRes.ok) setRobotCache((await caRes.json()) as RobotCacheResponse);
    } catch {
      /* ignore transient errors */
    }
  }, [connected]);

  useEffect(() => {
    void refreshBrowserStore();
  }, [refreshBrowserStore]);

  useEffect(() => {
    if (!connected) return;
    void refreshRobot();
    const id = window.setInterval(() => void refreshRobot(), robotStatus?.running ? 450 : 2500);
    return () => window.clearInterval(id);
  }, [connected, refreshRobot, robotStatus?.running]);

  const pickTemplate = (id: string) => {
    setSelectedTpl(id);
    const tpl = BALAX_PROGRAM_TEMPLATES.find((t) => t.id === id);
    if (tpl) {
      setProgName(tpl.name);
      setSource(tpl.source);
    }
  };

  const runBytesOnRobot = async (name: string, bytes: Uint8Array, pin: boolean) => {
    setBusy(true);
    setNotice("");
    try {
      const sha = await sha256Hex(bytes);
      // Save/refresh in Tier-1 Browser Cache (IndexedDB) for instant offline reuse
      await storeRef.current!.put({
        id: `prog-${sha.slice(0, 12)}`,
        name,
        kind: "program",
        sha256: sha,
        rawSize: bytes.byteLength,
        createdAt: Date.now(),
        refetchCost: 2.0,
        pinned: pin,
        source: "cache",
        bytes,
      });
      void refreshBrowserStore();

      // 1. Try ZERO-UPLOAD Tier-0 DRAM cache hit by SHA-256 first!
      const hitRes = await fetch(`/api/bridge/prog/run?sha256=${encodeURIComponent(sha)}`, {
        method: "POST",
      });
      if (hitRes.ok) {
        const j = (await hitRes.json()) as { ok?: boolean; cache_hit?: boolean; error?: string };
        if (j.ok) {
          setNotice(`⚡ Instant Tier-0 DRAM cache hit (0 bytes uploaded, 0 flash wear) — ${sha.slice(0, 10)}`);
          void refreshRobot();
          return;
        }
        if (j.error && j.error !== "cache_miss") {
          setNotice(`✗ Robot error: ${j.error}`);
          return;
        }
      }

      // 2. Cache miss -> upload compact .bxp binary into robot's DRAM cache and execute on Core 0
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const upRes = await fetch(
        `/api/bridge/prog/run?name=${encodeURIComponent(name)}&pin=${pin ? "1" : "0"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Prog-Name": name,
            "X-Prog-Pin": pin ? "1" : "0",
          },
          body: copy.buffer,
        },
      );
      const j = (await upRes.json()) as { ok?: boolean; bytes?: number; sha256?: string; error?: string };
      if (!upRes.ok || !j.ok) {
        setNotice(`✗ Launch failed: ${j.error ?? `HTTP ${upRes.status}`}`);
      } else {
        setNotice(`✓ Uploaded ${j.bytes ?? bytes.byteLength} B to DRAM & started (0 flash wear)`);
        void refreshRobot();
      }
    } catch (err) {
      setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRunCurrent = async () => {
    if (!compiled.ok || !compiled.bytes) {
      setNotice(`Compile error: ${compiled.error ?? "invalid"}`);
      return;
    }
    await runBytesOnRobot(progName.trim() || "applet", compiled.bytes, pinOnRobot);
  };

  const handleStop = async () => {
    try {
      await fetch("/api/bridge/prog/stop", { method: "POST" });
      setNotice("Stop signal sent (cooperative abort <= 20 ms).");
      void refreshRobot();
    } catch (err) {
      setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleToggleRobotPin = async (sha: string, nextPin: boolean) => {
    await fetch(`/api/bridge/prog/cache/pin?sha256=${encodeURIComponent(sha)}&pin=${nextPin ? "1" : "0"}`, {
      method: "POST",
    });
    void refreshRobot();
  };

  const handleClearRobotCache = async () => {
    await fetch("/api/bridge/prog/cache", { method: "DELETE" });
    setNotice("Cleared unpinned robot DRAM applets.");
    void refreshRobot();
  };

  const runCachedFromBrowser = async (sha: string) => {
    const art = await storeRef.current!.get(sha);
    if (!art) return;
    await runBytesOnRobot(art.name, art.bytes, art.pinned);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "0.78rem" }}>
      {/* Header & Template Picker */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <strong>Mini-Program VM (Core 0 · Zero Flash Wear)</strong>
          <span
            style={{
              fontSize: "0.7rem",
              padding: "2px 7px",
              borderRadius: 999,
              background: robotStatus?.running ? "rgba(210,153,34,0.2)" : "rgba(63,185,80,0.16)",
              color: robotStatus?.running ? "#d29922" : "#3fb950",
            }}
          >
            {robotStatus?.running ? `RUNNING: ${robotStatus.name}` : "VM IDLE"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={selectedTpl}
            onChange={(e) => pickTemplate(e.target.value)}
            style={{ flex: 1, minWidth: 160, fontSize: "0.76rem", padding: "4px 6px" }}
          >
            {BALAX_PROGRAM_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            value={progName}
            onChange={(e) => setProgName(e.target.value)}
            placeholder="Program name"
            style={{ width: 130, fontSize: "0.76rem", padding: "4px 6px" }}
          />
        </div>

        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          rows={9}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.72rem",
            lineHeight: 1.35,
            background: "#0d1117",
            color: "#e6edf3",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 8,
            resize: "vertical",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: compiled.ok ? "#3fb950" : "#f85149" }}>
            {compiled.ok
              ? `✓ Compiled BXP1: ${compiled.bytes?.byteLength ?? 0} B (${compiled.codeBytes} B code, ${compiled.stringBytes} B strings)`
              : `✗ Line ${compiled.line ?? "?"}: ${compiled.error}`}
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.72rem", color: "var(--muted)" }}>
            <input
              type="checkbox"
              checked={pinOnRobot}
              onChange={(e) => setPinOnRobot(e.target.checked)}
            />
            Pin in DRAM
          </label>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            disabled={!connected || !compiled.ok || busy}
            onClick={() => void handleRunCurrent()}
            style={{
              flex: 1,
              padding: "6px 12px",
              background: "rgba(63,185,80,0.22)",
              borderColor: "#3fb950",
              color: "#3fb950",
              fontWeight: 600,
            }}
          >
            {busy ? "Launching..." : "▶ Compile & Run on BalaX"}
          </button>
          <button
            disabled={!connected}
            onClick={() => void handleStop()}
            style={{
              padding: "6px 12px",
              background: "rgba(248,81,73,0.18)",
              borderColor: "#f85149",
              color: "#f85149",
            }}
          >
            ■ Stop
          </button>
        </div>
        {notice && (
          <div style={{ fontSize: "0.72rem", color: notice.startsWith("✗") ? "#f85149" : "#58a6ff" }}>
            {notice}
          </div>
        )}
      </div>

      {/* Live Execution Logs */}
      {robotStatus && (
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <strong>Last Run & Logs</strong>
            <span style={{ color: "var(--muted)", fontSize: "0.7rem" }}>
              runs={robotStatus.runs_total} · steps={robotStatus.last_steps} ·{" "}
              {robotStatus.last_trap ? `trap:${robotStatus.last_trap}` : robotStatus.last_ok ? "OK" : "—"}
              {robotStatus.cache_hit ? " · ⚡CACHE HIT" : ""}
            </span>
          </div>
          {robotStatus.logs.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: "0.72rem" }}>No log() events yet.</div>
          ) : (
            <div style={{ maxHeight: 90, overflowY: "auto", fontFamily: "monospace", fontSize: "0.7rem" }}>
              {robotStatus.logs.map((l, idx) => (
                <div key={idx}>
                  [{l.ms}ms] code={l.code} val={l.val}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tier-0 Robot DRAM Cache (W-TinyLFU) */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <strong>
            Tier-0 Robot DRAM Cache ({robotCache ? `${(robotCache.used_bytes / 1024).toFixed(1)} / ${(robotCache.budget_bytes / 1024).toFixed(0)} KB` : "—"})
          </strong>
          <button
            disabled={!connected}
            onClick={() => void handleClearRobotCache()}
            style={{ fontSize: "0.68rem", padding: "2px 6px" }}
          >
            Evict Unpinned
          </button>
        </div>
        {robotCache && (
          <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginBottom: 4 }}>
            Hits: {robotCache.hits} · Misses: {robotCache.misses} · Evictions: {robotCache.evictions}
          </div>
        )}
        {(robotCache?.entries ?? []).length === 0 ? (
          <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
            Run any program to cache it in BalaX DRAM for instant 0-byte re-runs.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {robotCache!.entries.map((e) => (
              <div
                key={e.sha256}
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
                  {e.pinned ? "📌 " : ""}
                  <strong>{e.name}</strong> ({e.bytes} B · score {e.score > 1e6 ? "∞" : e.score.toFixed(2)})
                </span>
                <span style={{ display: "flex", gap: 4 }}>
                  <button
                    style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                    onClick={() => void handleToggleRobotPin(e.sha256, !e.pinned)}
                  >
                    {e.pinned ? "Unpin" : "Pin"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier-1 Browser Cache (IndexedDB — Offline, No CAM Required) */}
      {browserProgs.length > 0 && (
        <div style={cardStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            Browser Cache ({browserProgs.length} saved · works offline)
          </strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 100, overflowY: "auto" }}>
            {browserProgs.map((p) => (
              <div
                key={p.sha256}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  fontSize: "0.71rem",
                }}
              >
                <span>
                  {p.pinned ? "📌 " : ""}
                  {p.name} ({p.rawSize} B · score{" "}
                  {Number.isFinite(computeRetentionScore(p)) ? computeRetentionScore(p).toFixed(1) : "∞"})
                </span>
                <button
                  disabled={!connected || busy}
                  style={{ fontSize: "0.68rem", padding: "2px 6px" }}
                  onClick={() => void runCachedFromBrowser(p.sha256)}
                >
                  Run
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
