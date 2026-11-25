import React, { useEffect, useRef, useState } from "react";
import type { UsbFlashInfo, UsbFlashJob, UsbFlashLayout } from "./usbProtocol";
import { detectRuntimeMode } from "./runtimeMode";

const LAYOUT_LABELS: Record<UsbFlashLayout, string> = {
  standard: "Standard A/B OTA",
  compact: "Compact factory + OTA",
};

export function useUsbFlash() {
  const [info, setInfo] = useState<UsbFlashInfo | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const submitLock = useRef(false);
  const job = info?.job ?? null;
  const running = job?.status === "running";

  useEffect(() => {
    if (submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof window.setTimeout>;
    async function check() {
      const mode = await detectRuntimeMode();
      if (mode !== "bridge") {
        setInfo(null);
        setPollError(null);
        return;
      }
      try {
        const res = await fetch("/api/bridge/usb/info", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!res.ok) throw new Error(`USB status returned HTTP ${res.status}.`);
        const data = (await res.json()) as UsbFlashInfo;
        if (controller.signal.aborted || submitLock.current) return;
        setInfo(data);
        setPollError(null);
      } catch {
        if (controller.signal.aborted) return;
        setPollError(running ? "USB status connection lost. Retrying…" : "USB status is unavailable. Retrying…");
      }
      if (!controller.signal.aborted) {
        timer = window.setTimeout(() => void check(), running ? 700 : 3000);
      }
    }
    void check();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [running, submitting, refreshToken]);

  async function start(port: string, layout: UsbFlashLayout) {
    if (submitLock.current || running) return;
    submitLock.current = true;
    setSubmitting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/bridge/usb/flash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port, layout, confirmed: true }),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { job?: UsbFlashJob; error?: string };
      const startedJob = data.job;
      if (!res.ok || !startedJob) throw new Error(data.error ?? `USB flash returned HTTP ${res.status}.`);
      setInfo((current) => current && { ...current, job: startedJob });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return {
    info, job, pending: submitting || running, submitting, pollError, startError,
    start,
    refresh: () => setRefreshToken((token) => token + 1),
  };
}

type UsbFlashController = ReturnType<typeof useUsbFlash>;

export function UsbFlashCard({ usb, wifiBusy }: { usb: UsbFlashController; wifiBusy: boolean }) {
  const { info, job, pending, submitting, pollError, startError } = usb;
  const [portChoice, setPortChoice] = useState("");
  const [layoutChoice, setLayoutChoice] = useState<UsbFlashLayout | "">("");
  const [review, setReview] = useState<{ port: string; layout: UsbFlashLayout } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const ports = info?.ports ?? [];
  const port = ports.includes(portChoice) ? portChoice : ports.length === 1 ? ports[0]! : "";
  const layoutInfo = layoutChoice ? info?.layouts[layoutChoice] : null;
  const canStart = Boolean(info?.ready && info.local && port && layoutChoice && layoutInfo?.ready
    && !pending && !wifiBusy && !pollError);
  const showingReview = canStart && review?.port === port && review?.layout === layoutChoice;
  const log = job?.log.join("\n") ?? "";

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function startReviewedFlash() {
    if (!showingReview || !review) return;
    setReview(null);
    void usb.start(review.port, review.layout);
  }

  return (
    <section className="balax-usb-flash" aria-label="USB firmware flash">
      <div className="balax-usb-flash-row">
        <strong>USB Firmware Flash</strong>
        {info?.local && <button type="button" disabled={pending} onClick={usb.refresh}>Refresh ports</button>}
      </div>

      {!info && !pollError && <div role="status">Checking USB ports…</div>}
      {info?.local === false && <div>Open the app on the laptop connected to BalaX by USB.</div>}
      {info?.local && <>
        {ports.length === 0 && !pending && <div role="status">Connect BalaX to this laptop with a USB data cable.</div>}
        <div className="balax-usb-flash-row">
          <label>
            Serial port
            <select value={port} disabled={pending || ports.length === 0} onChange={(event) => {
              setPortChoice(event.target.value);
              setReview(null);
            }}>
              <option value="" disabled>{ports.length ? "Select a serial port" : "No USB serial port detected"}</option>
              {ports.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            Partition layout
            <select value={layoutChoice} disabled={pending} onChange={(event) => {
              setLayoutChoice(event.target.value as UsbFlashLayout | "");
              setReview(null);
            }}>
              <option value="">Select a partition layout</option>
              {Object.entries(LAYOUT_LABELS).map(([name, label]) => <option key={name} value={name}>{label}</option>)}
            </select>
          </label>
        </div>
        {!pending && layoutInfo && !layoutInfo.ready && <div role="status">{layoutInfo.error ?? "Build this firmware layout before flashing."}</div>}
        {wifiBusy && <div role="status">USB flashing is available after the current build or Wi-Fi update finishes.</div>}
        {showingReview ? (
          <div className="balax-usb-flash-review">
            <div>Write {LAYOUT_LABELS[review.layout]} to <strong>{review.port}</strong> and reboot BalaX. This updates the partition table and resets OTA selection.</div>
            <div className="balax-usb-flash-row">
              <button type="button" className="danger" onClick={startReviewedFlash}>Confirm USB flash</button>
              <button type="button" onClick={() => setReview(null)}>Cancel</button>
            </div>
          </div>
        ) : <div>
          <button type="button" disabled={!canStart} onClick={() => {
            if (layoutChoice && canStart) setReview({ port, layout: layoutChoice });
          }}>Review USB flash</button>
        </div>}
      </>}

      {pollError && <div role="status">{pollError}</div>}
      {startError && <div role="alert">{startError}</div>}
      {submitting && <div role="status">Starting USB flash…</div>}
      {job && <div className="balax-usb-flash-progress">
        <div role="status">
          {job.status === "running" && (job.phase === "preflight" ? "Checking connected board…" : "Writing firmware over USB…")}
          {job.status === "succeeded" && "USB flash complete. BalaX is rebooting."}
          {job.status === "failed" && "USB flash failed."}
          {" "}{LAYOUT_LABELS[job.layout]} · {job.port}
        </div>
        <progress aria-label="USB flash progress" max={100} value={job.progress} />
        <span>{job.progress}%</span>
        {job.status === "succeeded" && job.layout === "compact" && <small>
          The factory updater can take about a minute to hand off to BalaX.
        </small>}
        {job.error && <div role="alert">{job.error}</div>}
        {log && <pre ref={logRef} aria-label="USB flash messages">{log}</pre>}
      </div>}
    </section>
  );
}
