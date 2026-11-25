import { WasmTemporalDecoder } from "../eclDecoder";
import { CAM_USB_BAUD, type CamBridgeStatus } from "./cameraProtocol";
import {
  BrowserEcl1Depacketizer,
  BrowserSerialEcl1Framer,
  buildCamStatusFromRawJson,
  type BrowserAssembledFrame,
} from "./browserEcl";
import {
  formatSerialPortLabel,
  pulseWebSerialReset,
  requestTargetSerialPort,
} from "./webSerialFlash";

export type WebSerialFrameListener = (frame: BrowserAssembledFrame) => void;
export type WebSerialStatusListener = (status: CamBridgeStatus) => void;

const BAUD_RATE = CAM_USB_BAUD;

export class WebSerialCamClient {
  private port: SerialPort | null = null;
  private portLabel: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly encoder = new TextEncoder();

  private readonly framer = new BrowserSerialEcl1Framer();
  private readonly depacketizer = new BrowserEcl1Depacketizer();
  private wasmReady = false;

  private rawStatus: Record<string, unknown> | null = null;
  private rawStatusAtMs: number | null = null;
  private latestFrame: BrowserAssembledFrame | null = null;
  private wantStream = false;
  private sleepingPaused = false;
  private host = "balax-cam.local";

  private windowFrames = 0;
  private windowBytes = 0;
  private windowStartMs = Date.now();
  private measuredFps = 0;
  private measuredKbps = 0;

  private readonly statusListeners = new Set<WebSerialStatusListener>();
  private readonly frameListeners = new Set<WebSerialFrameListener>();

  constructor() {
    void WasmTemporalDecoder.create()
      .then((dec) => {
        this.depacketizer.setWasmDecoder(dec);
        this.wasmReady = true;
      })
      .catch(() => {
        // Keyframes still decode directly even if WASM fails
      });
  }

  isConnected(): boolean {
    return this.port !== null && this.reader !== null;
  }

  getPort(): SerialPort | null {
    return this.port;
  }

  getPortLabel(): string | null {
    return this.portLabel;
  }

  setHost(host: string): void {
    this.host = host || "balax-cam.local";
  }

  subscribeStatus(fn: WebSerialStatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  subscribeFrames(fn: WebSerialFrameListener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  getStatus(): CamBridgeStatus {
    return buildCamStatusFromRawJson({
      raw: this.rawStatus,
      rawAgeMs: this.rawStatusAtMs !== null ? Date.now() - this.rawStatusAtMs : null,
      host: this.host,
      portLabel: this.portLabel,
      streaming: this.wantStream,
      sleepingPaused: this.sleepingPaused,
      activeTransport: this.wantStream ? "usb_ecl1" : "none",
      transportPreference: "usb",
      measuredFps: this.measuredFps,
      measuredKbps: this.measuredKbps,
      latestFrame: this.latestFrame,
      badPackets: this.depacketizer.badPackets,
      droppedIncomplete: this.depacketizer.droppedIncomplete,
    });
  }

  private emitStatus(): void {
    const snap = this.getStatus();
    for (const fn of this.statusListeners) fn(snap);
  }

  async connect(existingPort?: SerialPort): Promise<CamBridgeStatus> {
    if (this.isConnected()) {
      await this.sendLine("STATUS");
      return this.getStatus();
    }
    const port = existingPort ?? (await requestTargetSerialPort("cam"));
    await port.open({ baudRate: BAUD_RATE, bufferSize: 65536 });
    try {
      // Keep DTR/RTS deasserted so opening the port does NOT reset the camera
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Some adapters ignore setSignals
    }

    this.port = port;
    this.portLabel = formatSerialPortLabel(port);
    this.sleepingPaused = false;
    this.framer.reset();
    this.depacketizer.reset();
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;

    this.startReadLoop();
    this.startKeepaliveLoop();

    // Ask immediately for status (and wait briefly for first framed reply)
    await this.sendLine("STATUS");
    this.emitStatus();
    return this.getStatus();
  }

  private startReadLoop(): void {
    const reader = this.reader;
    if (!reader) return;
    this.readLoopPromise = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const { packets, statuses } = this.framer.pushFrames(value);
          const now = Date.now();
          let statusChanged = false;
          for (const st of statuses) {
            this.rawStatus = st;
            this.rawStatusAtMs = now;
            this.sleepingPaused = st.power_mode === "sleep";
            statusChanged = true;
          }
          if (this.wantStream) {
            for (const pkt of packets) {
              const frame = this.depacketizer.feedPacket(pkt, now);
              if (frame) {
                this.latestFrame = frame;
                this.windowFrames++;
                this.windowBytes += frame.wireBytes;
                const dt = now - this.windowStartMs;
                if (dt >= 1000) {
                  this.measuredFps = (this.windowFrames * 1000) / dt;
                  this.measuredKbps = (this.windowBytes * 8) / dt;
                  this.windowFrames = 0;
                  this.windowBytes = 0;
                  this.windowStartMs = now;
                  statusChanged = true;
                }
                for (const fn of this.frameListeners) fn(frame);
              }
            }
          }
          if (statusChanged) this.emitStatus();
        }
      } catch {
        // Port disconnected or reader cancelled
      } finally {
        if (this.reader === reader) {
          await this.cleanupAfterClose();
        }
      }
    })();
  }

  private startKeepaliveLoop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected() || this.sleepingPaused) return;
      if (this.wantStream) {
        void this.sendLine("SUB");
      } else {
        void this.sendLine("STATUS");
      }
    }, 2000);
  }

  private async sendLine(line: string): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.write(this.encoder.encode(`${line}\n`));
    } catch {
      // ignore transient write errors
    }
  }

  async startStream(): Promise<CamBridgeStatus> {
    if (!this.isConnected()) {
      await this.connect();
    }
    this.wantStream = true;
    this.sleepingPaused = false;
    this.depacketizer.reset();
    this.windowFrames = 0;
    this.windowBytes = 0;
    this.windowStartMs = Date.now();
    await this.sendLine("SUB");
    this.emitStatus();
    return this.getStatus();
  }

  async stopStream(): Promise<CamBridgeStatus> {
    this.wantStream = false;
    this.measuredFps = 0;
    this.measuredKbps = 0;
    if (this.isConnected()) {
      await this.sendLine("UNSUB");
    }
    this.emitStatus();
    return this.getStatus();
  }

  async setConfig(patch: Record<string, unknown>): Promise<CamBridgeStatus> {
    if (!this.isConnected()) {
      throw new Error("Connect ESP32-FPV via Web Serial first.");
    }
    await this.sendLine(`CONFIG ${JSON.stringify(patch)}`);
    await new Promise((r) => setTimeout(r, 120));
    await this.sendLine("STATUS");
    this.emitStatus();
    return this.getStatus();
  }

  async setPower(mode: "idle" | "sleep" | "wake"): Promise<{ ok: boolean; message: string }> {
    if (mode === "wake") {
      if (!this.port) {
        const port = await requestTargetSerialPort("cam");
        await pulseWebSerialReset(port, false);
        await new Promise((r) => setTimeout(r, 600));
        await this.connect(port);
        return { ok: true, message: "Pulsed USB RTS→EN via Web Serial — ESP32-FPV booting Cool Idle" };
      }
      await pulseWebSerialReset(this.port, true);
      this.sleepingPaused = false;
      await new Promise((r) => setTimeout(r, 600));
      await this.sendLine("STATUS");
      this.emitStatus();
      return { ok: true, message: "Pulsed USB RTS→EN via Web Serial — ESP32-FPV booting Cool Idle" };
    }

    if (!this.isConnected()) {
      throw new Error("Connect ESP32-FPV via Web Serial first.");
    }
    this.wantStream = false;
    this.measuredFps = 0;
    this.measuredKbps = 0;
    if (mode === "sleep") {
      this.sleepingPaused = true;
      await this.sendLine("SLEEP");
      this.emitStatus();
      return { ok: true, message: "ESP32-FPV entered ~10 µA deep sleep (wake via Web Serial RTS→EN)" };
    }
    this.sleepingPaused = false;
    await this.sendLine("IDLE");
    await new Promise((r) => setTimeout(r, 120));
    await this.sendLine("STATUS");
    this.emitStatus();
    return { ok: true, message: "ESP32-FPV switched to Cool Idle (OV2640 OFF)" };
  }

  /**
   * Releases reader/writer and closes the serial port while returning the authorized
   * SerialPort handle so esptool-js can flash it without another user picker prompt.
   */
  async detachPortForFlash(): Promise<SerialPort | null> {
    const port = this.port;
    if (!port) return null;
    await this.disconnect();
    return port;
  }

  async disconnect(): Promise<void> {
    if (this.wantStream && this.writer) {
      await this.sendLine("UNSUB");
    }
    this.wantStream = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    await this.readLoopPromise?.catch(() => {});
    this.readLoopPromise = null;

    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      this.writer = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // ignore
      }
      this.port = null;
    }
    this.portLabel = null;
    this.measuredFps = 0;
    this.measuredKbps = 0;
    this.emitStatus();
  }

  private async cleanupAfterClose(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch {
        // ignore
      }
      this.reader = null;
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      this.writer = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // ignore
      }
      this.port = null;
    }
    this.portLabel = null;
    this.wantStream = false;
    this.measuredFps = 0;
    this.measuredKbps = 0;
    this.emitStatus();
  }

  isWasmReady(): boolean {
    return this.wasmReady;
  }
}

export const webSerialCam = new WebSerialCamClient();
