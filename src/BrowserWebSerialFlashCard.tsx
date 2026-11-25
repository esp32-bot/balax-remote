import React, { useState } from "react";
import type { BalaXArtifactMeta, IndexedDbArtifactStore } from "@g-ai/rc";
import { hasWebSerial } from "./runtimeMode";
import { webSerialCam } from "./webSerialCam";
import { webSerialStickC } from "./webSerialStickC";
import {
  flashFirmwareOverWebSerial,
  type WebSerialFlashProgress,
  type WebSerialTarget,
} from "./webSerialFlash";

export interface BrowserWebSerialFlashCardProps {
  target: WebSerialTarget;
  fwStore: IndexedDbArtifactStore;
  cachedFw: BalaXArtifactMeta[];
  onComplete?: (message: string) => void;
}

export const BrowserWebSerialFlashCard: React.FC<BrowserWebSerialFlashCardProps> = ({
  target,
  fwStore,
  cachedFw,
  onComplete,
}) => {
  const [selectedSha, setSelectedSha] = useState<string>("");
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [progress, setProgress] = useState<WebSerialFlashProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const label = target === "cam" ? "ESP32-FPV" : "StickC";
  const defaultOffset = target === "cam" ? 0xb0000 : 0x20000;
  const supported = hasWebSerial();

  const effectiveSha = selectedSha && cachedFw.some((f) => f.sha256 === selectedSha)
    ? selectedSha
    : cachedFw[0]?.sha256 ?? "";

  async function startFlash(source: "cache" | "file") {
    if (flashing || !confirmWrite) return;
    setFlashing(true);
    setLogs([]);
    try {
      let bytes: Uint8Array;
      let name: string;
      if (source === "file") {
        if (!customFile) throw new Error("Choose a .bin firmware file first.");
        bytes = new Uint8Array(await customFile.arrayBuffer());
        name = customFile.name;
      } else {
        if (!effectiveSha) throw new Error("No cached firmware selected.");
        const art = await fwStore.get(effectiveSha);
        if (!art) throw new Error("Cached firmware artifact not found.");
        bytes = art.bytes;
        name = art.name;
      }

      // Reuse already-open Web Serial port if active, cleanly detaching reader/writer first
      const existingPort =
        target === "cam"
          ? await webSerialCam.detachPortForFlash()
          : await webSerialStickC.detachPortForFlash();

      const res = await flashFirmwareOverWebSerial({
        target,
        firmwareBytes: bytes,
        firmwareName: name,
        port: existingPort,
        appOffset: defaultOffset,
        includeOta0Select: target === "cam",
        onProgress: (upd) => setProgress(upd),
        onLog: (line) => setLogs((prev) => [...prev.slice(-24), line]),
      });

      setConfirmWrite(false);
      onComplete?.(res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProgress({ phase: "error", progress: 0, message: msg });
    } finally {
      setFlashing(false);
    }
  }

  return (
    <div
      style={{
        background: "#161b22",
        border: "1px solid rgba(56, 139, 253, 0.35)",
        borderRadius: 6,
        padding: "9px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <strong style={{ fontSize: "0.79rem", color: "#79c0ff" }}>
          Browser USB Flash (Web Serial · esptool-js)
        </strong>
        <span style={{ fontSize: "0.68rem", color: "#3fb950" }}>
          Serverless / GitHub Pages
        </span>
      </div>

      {!supported ? (
        <div style={{ fontSize: "0.72rem", color: "#d29922" }}>
          Web Serial requires Chrome, Edge, or Brave over HTTPS (or localhost).
        </div>
      ) : (
        <>
          <div style={{ fontSize: "0.71rem", color: "#8b949e" }}>
            Flashes {label} directly from your browser at 460800 baud to{" "}
            <code>0x{defaultOffset.toString(16)}</code>
            {target === "cam" ? " (+ ota_0 boot select at 0x9000)" : ""} — zero Python or dev server needed.
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={effectiveSha}
              onChange={(e) => setSelectedSha(e.target.value)}
              disabled={flashing || cachedFw.length === 0}
              style={{ flex: 1, minWidth: 160, padding: "4px 6px", fontSize: "0.72rem" }}
              aria-label={`Cached ${label} firmware`}
            >
              {cachedFw.length === 0 ? (
                <option value="">No cached firmware yet (download from Releases or pick .bin)</option>
              ) : (
                cachedFw.map((fw) => (
                  <option key={fw.sha256} value={fw.sha256}>
                    {fw.name} ({(fw.rawSize / 1024).toFixed(0)} KB)
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="primary"
              disabled={flashing || !confirmWrite || !effectiveSha}
              style={{ fontSize: "0.72rem", padding: "4px 9px" }}
              onClick={() => void startFlash("cache")}
            >
              {flashing ? "Flashing…" : "Flash Cached"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="file"
              accept=".bin,application/octet-stream"
              disabled={flashing}
              onChange={(e) => setCustomFile(e.target.files?.[0] ?? null)}
              style={{ flex: 1, minWidth: 150, fontSize: "0.71rem", padding: "3px 5px" }}
            />
            <button
              type="button"
              disabled={flashing || !confirmWrite || !customFile}
              style={{ fontSize: "0.72rem", padding: "4px 9px" }}
              onClick={() => void startFlash("file")}
            >
              Flash .bin
            </button>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.71rem", color: "#c9d1d9", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={confirmWrite}
              disabled={flashing}
              onChange={(e) => setConfirmWrite(e.target.checked)}
            />
            Confirm writing firmware to {label} over USB
          </label>

          {progress && (
            <div style={{ display: "grid", gap: 4 }}>
              <div
                style={{
                  fontSize: "0.72rem",
                  color:
                    progress.phase === "error"
                      ? "#f85149"
                      : progress.phase === "done"
                        ? "#3fb950"
                        : "#79c0ff",
                }}
              >
                {progress.message}
              </div>
              {progress.phase !== "error" && (
                <progress value={progress.progress} max={100} style={{ width: "100%" }} />
              )}
            </div>
          )}

          {logs.length > 0 && (
            <pre
              style={{
                margin: 0,
                padding: 6,
                maxHeight: 110,
                overflowY: "auto",
                background: "#010409",
                border: "1px solid #30363d",
                borderRadius: 4,
                fontSize: "0.67rem",
                color: "#8b949e",
                whiteSpace: "pre-wrap",
              }}
            >
              {logs.join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
};
