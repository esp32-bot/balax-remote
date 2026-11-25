import {
  formatSerialPortLabel,
  pulseWebSerialReset,
  requestTargetSerialPort,
} from "./webSerialFlash";

export interface WebSerialStickCState {
  connected: boolean;
  portLabel: string | null;
  lastLine: string;
}

type StickCListener = (state: WebSerialStickCState) => void;

export class WebSerialStickCClient {
  private port: SerialPort | null = null;
  private portLabel: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8");
  private lineBuf = "";
  private lastLine = "";
  private activeCollector: { lines: string[]; resolve: (out: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly listeners = new Set<StickCListener>();

  isConnected(): boolean {
    return this.port !== null && this.reader !== null;
  }

  getState(): WebSerialStickCState {
    return {
      connected: this.isConnected(),
      portLabel: this.portLabel,
      lastLine: this.lastLine,
    };
  }

  subscribe(fn: StickCListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getState();
    for (const fn of this.listeners) fn(snap);
  }

  async connect(existingPort?: SerialPort): Promise<WebSerialStickCState> {
    if (this.isConnected()) return this.getState();
    const port = existingPort ?? (await requestTargetSerialPort("stickc"));
    await port.open({ baudRate: 115200 });
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // ignore
    }
    this.port = port;
    this.portLabel = formatSerialPortLabel(port);
    this.lineBuf = "";
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    this.startReadLoop();
    this.emit();
    return this.getState();
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
          this.lineBuf += this.decoder.decode(value, { stream: true });
          const parts = this.lineBuf.split(/\r?\n/);
          this.lineBuf = parts.pop() ?? "";
          for (const raw of parts) {
            const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
            if (!clean) continue;
            this.lastLine = clean;
            if (this.activeCollector) {
              this.activeCollector.lines.push(clean);
            }
          }
          if (this.lineBuf.length > 4096) this.lineBuf = this.lineBuf.slice(-1024);
        }
      } catch {
        // disconnected
      } finally {
        if (this.reader === reader) {
          await this.disconnect();
        }
      }
    })();
  }

  async sendCommand(cmd: string, waitMs = 350): Promise<string> {
    if (!this.isConnected() || !this.writer) {
      throw new Error("Connect StickC via Web Serial first.");
    }
    if (this.activeCollector) {
      clearTimeout(this.activeCollector.timer);
      this.activeCollector.resolve(this.activeCollector.lines.join("\n"));
      this.activeCollector = null;
    }
    const promise = new Promise<string>((resolve) => {
      const collector = {
        lines: [] as string[],
        resolve,
        timer: setTimeout(() => {
          if (this.activeCollector === collector) {
            this.activeCollector = null;
            resolve(collector.lines.join("\n"));
          }
        }, waitMs),
      };
      this.activeCollector = collector;
    });
    await this.writer.write(this.encoder.encode(`${cmd.trim()}\n`));
    return promise;
  }

  async wake(): Promise<string> {
    if (!this.port) {
      const port = await requestTargetSerialPort("stickc");
      await pulseWebSerialReset(port, false);
      return `Pulsed USB RTS→EN on ${formatSerialPortLabel(port)} — StickC waking`;
    }
    await pulseWebSerialReset(this.port, true);
    return `Pulsed USB RTS→EN on ${this.portLabel ?? "StickC"} — StickC waking`;
  }

  async detachPortForFlash(): Promise<SerialPort | null> {
    const port = this.port;
    if (!port) return null;
    await this.disconnect();
    return port;
  }

  async disconnect(): Promise<void> {
    if (this.activeCollector) {
      clearTimeout(this.activeCollector.timer);
      this.activeCollector.resolve(this.activeCollector.lines.join("\n"));
      this.activeCollector = null;
    }
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try { await reader.cancel(); } catch { /* ignore */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    await this.readLoopPromise?.catch(() => {});
    this.readLoopPromise = null;
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* ignore */ }
      this.writer = null;
    }
    if (this.port) {
      try { await this.port.close(); } catch { /* ignore */ }
      this.port = null;
    }
    this.portLabel = null;
    this.emit();
  }
}

export const webSerialStickC = new WebSerialStickCClient();
