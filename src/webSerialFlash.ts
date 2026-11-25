import { ESPLoader, Transport } from "esptool-js";
import { buildOta0SelectDataBrowser } from "./browserEcl";

export type WebSerialTarget = "cam" | "stickc";

export interface WebSerialFlashProgress {
  phase: "connecting" | "flashing" | "resetting" | "done" | "error";
  progress: number;
  message: string;
  chip?: string;
}

export interface WebSerialFlashResult {
  ok: boolean;
  chip: string;
  bytesWritten: number;
  message: string;
}

const CAM_USB_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // WCH CH340 (ESP32-CAM-MB)
  { usbVendorId: 0x1a86, usbProductId: 0x5523 }, // WCH CH341
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // Silicon Labs CP210x
];

const STICKC_USB_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x0403 }, // FTDI (M5StickC Plus v1.0)
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }, // WCH CH9102 (M5StickC Plus v1.1)
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
];

export function formatSerialPortLabel(port: SerialPort): string {
  const info = port.getInfo?.();
  if (!info || (info.usbVendorId == null && info.usbProductId == null)) {
    return "Web Serial USB";
  }
  const vid = info.usbVendorId ?? 0;
  const pid = info.usbProductId ?? 0;
  if (vid === 0x1a86 && (pid === 0x7523 || pid === 0x5523)) return "USB CH340 (ESP32-FPV)";
  if (vid === 0x0403) return "USB FTDI (StickC)";
  if (vid === 0x1a86 && pid === 0x55d4) return "USB CH9102 (StickC)";
  if (vid === 0x10c4 && pid === 0xea60) return "USB CP210x";
  return `USB ${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;
}

export async function requestTargetSerialPort(target: WebSerialTarget): Promise<SerialPort> {
  const serial = typeof navigator !== "undefined" ? navigator.serial : undefined;
  if (!serial) {
    throw new Error("Web Serial is not supported in this browser. Use Chrome, Edge, or Brave.");
  }
  const filters = target === "cam" ? CAM_USB_FILTERS : STICKC_USB_FILTERS;
  try {
    return await serial.requestPort({ filters });
  } catch (err) {
    // Allow fallback to unfiltered picker only if user didn't cancel
    if (err instanceof DOMException && err.name === "NotFoundError") {
      throw new Error("No USB serial port selected.");
    }
    throw err;
  }
}

/**
 * Pulses RTS -> EN (DTR=false, RTS=true 60 ms -> RTS=false) directly from the browser
 * via Web Serial to wake an ESP32 from deep sleep / usb-sleep without touching the board.
 */
export async function pulseWebSerialReset(port: SerialPort, alreadyOpen = false): Promise<void> {
  if (!alreadyOpen) {
    await port.open({ baudRate: 115200 });
  }
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, 65));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    if (!alreadyOpen) {
      try {
        await port.close();
      } catch {
        // ignore close race
      }
    }
  }
}

/**
 * Flashes an ESP32 / ESP32-PICO-D4 firmware image directly from the browser using
 * esptool-js over Web Serial — zero Python, zero local server (works on GitHub Pages!).
 */
export async function flashFirmwareOverWebSerial(params: {
  target: WebSerialTarget;
  firmwareBytes: Uint8Array;
  firmwareName: string;
  port?: SerialPort | null;
  appOffset?: number;
  includeOta0Select?: boolean;
  baudRate?: number;
  onProgress?: (update: WebSerialFlashProgress) => void;
  onLog?: (line: string) => void;
}): Promise<WebSerialFlashResult> {
  const {
    target,
    firmwareBytes,
    firmwareName,
    onProgress,
    onLog,
  } = params;

  if (firmwareBytes.byteLength < 0x1000 || firmwareBytes[0] !== 0xe9) {
    throw new Error(`Invalid ESP32 app image "${firmwareName}" (missing 0xE9 magic header).`);
  }

  const port = params.port ?? (await requestTargetSerialPort(target));
  const baudRate = params.baudRate ?? 460800;
  const appOffset = params.appOffset ?? (target === "cam" ? 0xb0000 : 0x20000);
  const includeOta0Select = params.includeOta0Select ?? target === "cam";

  const emitLog = (text: string) => {
    const cleaned = text.replace(/\r/g, "").trim();
    if (cleaned) onLog?.(cleaned);
  };

  onProgress?.({
    phase: "connecting",
    progress: 3,
    message: `Connecting to ${target === "cam" ? "ESP32-FPV" : "StickC"} bootloader via Web Serial…`,
  });

  const transport = new Transport(port, false);
  const terminal = {
    clean: () => {},
    writeLine: (data: string) => emitLog(data),
    write: (data: string) => {
      if (data.includes("\n")) emitLog(data);
    },
  };

  const loader = new ESPLoader({
    transport,
    baudrate: baudRate,
    romBaudrate: 115200,
    terminal,
  });

  try {
    const chip = await loader.main("default_reset");
    onProgress?.({
      phase: "flashing",
      progress: 8,
      chip,
      message: `Connected (${chip}). Writing ${firmwareName} to 0x${appOffset.toString(16)}…`,
    });

    const fileArray: { data: Uint8Array; address: number }[] = [];
    if (includeOta0Select) {
      fileArray.push({
        address: 0x9000,
        data: buildOta0SelectDataBrowser(),
      });
    }
    fileArray.push({
      address: appOffset,
      data: firmwareBytes,
    });

    const totalBytes = fileArray.reduce((sum, f) => sum + f.data.byteLength, 0);
    const doneByFile = new Array<number>(fileArray.length).fill(0);

    await loader.writeFlash({
      fileArray,
      flashSize: "4MB",
      flashMode: "dio",
      flashFreq: "80m",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        doneByFile[fileIndex] = Math.min(written, total);
        const sumWritten = doneByFile.reduce((a, b) => a + b, 0);
        const pct = Math.max(8, Math.min(98, Math.round(8 + (sumWritten / Math.max(1, totalBytes)) * 90)));
        onProgress?.({
          phase: "flashing",
          progress: pct,
          chip,
          message: `Flashing ${firmwareName}… ${pct}% (${(sumWritten / 1024).toFixed(0)}/${(totalBytes / 1024).toFixed(0)} KB)`,
        });
      },
    });

    onProgress?.({
      phase: "resetting",
      progress: 99,
      chip,
      message: "Verifying & rebooting device…",
    });

    await loader.after("hard_reset");

    const doneMsg =
      target === "cam"
        ? `Flashed ${firmwareName} (${(firmwareBytes.byteLength / 1024).toFixed(0)} KB) via Web Serial — booting Cool Idle`
        : `Flashed ${firmwareName} (${(firmwareBytes.byteLength / 1024).toFixed(0)} KB) via Web Serial — rebooting StickC`;

    onProgress?.({
      phase: "done",
      progress: 100,
      chip,
      message: doneMsg,
    });

    return {
      ok: true,
      chip,
      bytesWritten: totalBytes,
      message: doneMsg,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.({
      phase: "error",
      progress: 0,
      message: `Web Serial flash failed: ${msg}`,
    });
    throw err;
  } finally {
    try {
      await transport.disconnect();
    } catch {
      try {
        await port.close();
      } catch {
        // ignore close race
      }
    }
  }
}
