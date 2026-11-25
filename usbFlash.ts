import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import type { UsbFlashLayout } from "./src/usbProtocol.ts";
import { classifyUsbSerialDevice, type UsbDeviceKind } from "./src/deviceControls.ts";

const FLASH_SIZE = 4 * 1024 * 1024;
const SECTOR = 0x1000;

function normalizeAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/i, "").split("%")[0];
}

export function isLocalUsbRequest(
  host: string | undefined,
  remoteAddress: string | undefined,
  localAddress: string | undefined,
): boolean {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\]|balax-remote\.local)(?::\d{1,5})?$/i.test(host)) return false;
  const port = host.match(/:(\d+)$/)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  const remote = normalizeAddress(remoteAddress);
  const local = normalizeAddress(localAddress);
  return name === "balax-remote.local"
    ? isIP(remote) !== 0 && remote === local
    : remote === "::1" || (isIP(remote) === 4 && remote.startsWith("127."));
}

export function isSameOriginUsbRequest(
  host: string | undefined, origin: string | undefined, fetchSite: string | string[] | undefined,
): boolean {
  if (!host || !origin || (fetchSite !== undefined && fetchSite !== "same-origin")) return false;
  return origin === `http://${host.toLowerCase()}`;
}

export function usbSerialPorts(): string[] {
  const device = process.platform === "darwin" ? /^cu\.(?:usbserial-|wchusbserial)[\w.-]+$/ : /^ttyUSB\d+$/;
  try {
    return fs.readdirSync("/dev", { withFileTypes: true })
      .filter((entry) => device.test(entry.name) && entry.isCharacterDevice())
      .map((entry) => path.join("/dev", entry.name))
      .sort();
  } catch {
    return [];
  }
}
let cachedPortKindsKey = "";
let cachedPortKindsAtMs = 0;
let cachedPortKinds = new Map<string, UsbDeviceKind>();

export function usbSerialPortKinds(ports: readonly string[]): Map<string, UsbDeviceKind> {
  if (ports.length === 0) return new Map();
  const key = ports.join(",");
  const now = Date.now();
  if (key === cachedPortKindsKey && now - cachedPortKindsAtMs < 2500) {
    return cachedPortKinds;
  }
  const result = new Map<string, UsbDeviceKind>();
  const wanted = new Set(ports);
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-r", "-c", "IOUSBHostDevice", "-l", "-w", "0"], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let curVid: number | null = null;
      let curPid: number | null = null;
      for (const line of out.split("\n")) {
        const vidMatch = line.match(/"idVendor"\s*=\s*(\d+)/);
        if (vidMatch) {
          curVid = Number(vidMatch[1]);
          continue;
        }
        const pidMatch = line.match(/"idProduct"\s*=\s*(\d+)/);
        if (pidMatch) {
          curPid = Number(pidMatch[1]);
          continue;
        }
        const devMatch = line.match(/"IOCalloutDevice"\s*=\s*"([^"]+)"/);
        if (devMatch && wanted.has(devMatch[1]!)) {
          result.set(devMatch[1]!, classifyUsbSerialDevice(curVid, curPid));
        }
      }
    } else if (process.platform === "linux") {
      for (const port of ports) {
        const base = path.basename(port);
        try {
          const vidHex = fs.readFileSync(`/sys/class/tty/${base}/device/../idVendor`, "utf8").trim();
          const pidHex = fs.readFileSync(`/sys/class/tty/${base}/device/../idProduct`, "utf8").trim();
          result.set(port, classifyUsbSerialDevice(parseInt(vidHex, 16), parseInt(pidHex, 16)));
        } catch {
          // Non-USB tty or unavailable sysfs
        }
      }
    }
  } catch {
    // Fallback gracefully to unclassified ("shared") ports
  }
  cachedPortKindsKey = key;
  cachedPortKindsAtMs = now;
  cachedPortKinds = result;
  return result;
}

export function espIdfPython(): string | null {
  const envDir = path.join(os.homedir(), ".espressif/python_env");
  const candidates = process.env.IDF_PYTHON_ENV_PATH ? [process.env.IDF_PYTHON_ENV_PATH] : [];
  try {
    candidates.push(...fs.readdirSync(envDir)
      .filter((name) => /^idf6\.1_py[\d.]+_env$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(envDir, name)));
  } catch {
    // ESP-IDF may be installed on a different machine.
  }
  for (const candidate of candidates) {
    const executable = path.join(candidate, "bin/python");
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch {
      // Continue looking for the ESP-IDF environment.
    }
  }
  return null;
}

interface Partition {
  name: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  flags: number;
}

export function readUsbPartitionTable(bytes: Buffer): Partition[] {
  const partitions: Partition[] = [];
  if (bytes.length <= SECTOR && bytes.length % 32 === 0) {
    for (let i = 0; i < bytes.length; i += 32) {
      const magic = bytes.readUInt16LE(i);
      if (magic === 0xebeb) {
        const expected = crypto.createHash("md5").update(bytes.subarray(0, i)).digest();
        if (expected.equals(bytes.subarray(i + 16, i + 32))) return partitions;
        break;
      }
      if (magic !== 0x50aa) break;
      const label = bytes.subarray(i + 12, i + 28);
      const end = label.indexOf(0);
      const offset = bytes.readUInt32LE(i + 4);
      const size = bytes.readUInt32LE(i + 8);
      if (offset < 0x9000 || offset % SECTOR || !size || size % SECTOR || offset + size > FLASH_SIZE ||
          partitions.some((p) => p.offset < offset + size && offset < p.offset + p.size)) break;
      partitions.push({
        name: label.subarray(0, end === -1 ? label.length : end).toString("ascii"),
        type: bytes[i + 2], subtype: bytes[i + 3], offset, size, flags: bytes.readUInt32LE(i + 28),
      });
    }
  }
  throw new Error("Invalid ESP-IDF partition table. Build the selected layout again.");
}

export interface UsbFlashImage {
  label: string;
  offset: number;
  file: string;
  size: number;
}

export function loadUsbFlashPlan(balaxDir: string, layout: UsbFlashLayout): UsbFlashImage[] {
  const main = path.join(balaxDir, "build");
  const build = layout === "compact" ? path.join(balaxDir, "ota_stub/build") : main;
  const tableFile = path.join(build, "partition_table/partition-table.bin");
  const selectionFile = path.join(build, "ota_data_initial.bin");
  const table = fs.readFileSync(tableFile);
  const partitions = readUsbPartitionTable(table);
  const partition = (name: string, type: number, subtype: number, offset: number) => {
    const entry = partitions.find((p) => p.name === name && p.type === type && p.subtype === subtype &&
      p.offset === offset && p.flags === 0);
    if (!entry) throw new Error(`Build artifacts do not match the ${layout} layout (${name}).`);
    return entry;
  };

  const nvs = partition("nvs", 1, 2, 0x9000);
  const selection = partition("otadata", 1, 0, 0xf000);
  const ota = partition("ota_0", 0, 0x10, layout === "compact" ? 0xc0000 : 0x20000);
  const recovery = layout === "compact" ? partition("factory", 0, 0, 0x20000) : null;
  if (layout === "standard") partition("ota_1", 0, 0x11, 0x200000);
  const selectionData = fs.readFileSync(selectionFile);
  if (nvs.size !== 0x6000 || selection.size !== 0x2000 || selectionData.length !== selection.size ||
      !selectionData.every((byte) => byte === 0xff)) {
    throw new Error("Unexpected NVS or initial OTA selection region. Build the selected layout again.");
  }

  function image(label: string, offset: number, file: string, limit: number): UsbFlashImage {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      const header = Buffer.alloc(1);
      if (!stat.isFile() || stat.size > limit || fs.readSync(fd, header, 0, 1, 0) !== 1 || header[0] !== 0xe9) {
        throw new Error(`${label} does not fit its flash region or is not an ESP32 image.`);
      }
      return { label, offset, file, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  const images = [
    image("Bootloader", 0x1000, path.join(build, "bootloader/bootloader.bin"), 0x7000),
    { label: "Partition table", offset: 0x8000, file: tableFile, size: table.length },
    { label: "OTA selection", offset: selection.offset, file: selectionFile, size: selectionData.length },
  ];
  if (recovery) images.push(image("Factory updater", recovery.offset, path.join(build, "ota_stub.bin"), recovery.size));
  images.push(image("BalaX firmware", ota.offset, path.join(main, "balax.bin"), ota.size));
  return images;
}

export function usbFlashArgs(port: string, images?: readonly UsbFlashImage[]): string[] {
  const args = ["-m", "esptool", "--chip", "esp32", "--port", port, "--baud", "115200",
    "--before", "default-reset", "--after", "hard-reset"];
  if (!images) return [...args, "flash-id"];
  return [...args, "write-flash", "--flash-mode", "dio", "--flash-freq", "80m", "--flash-size", "4MB", "--compress",
    ...images.flatMap((image) => [`0x${image.offset.toString(16)}`, image.file])];
}

export function verifyUsbFlashDevice(output: string): void {
  if (!/^Chip type:\s+ESP32-PICO-D4\b/m.test(output) || !/^Detected flash size:\s+4\s*MB\b/mi.test(output)) {
    throw new Error("USB preflight expected an ESP32-PICO-D4 with 4 MB flash. Check the selected device.");
  }
}

export function usbWriteProgress(line: string, images: readonly UsbFlashImage[]): number | null {
  const progress = line.match(/Writing at\s+(0x[\da-f]+)/i);
  const complete = line.match(/^Wrote\s+\d+.*?\sat\s+(0x[\da-f]+)/i);
  if (!progress && !complete) return null;
  const address = Number((progress ?? complete)?.[1]);
  const total = images.reduce((sum, image) => sum + image.size, 0);
  let written = 0;
  for (const image of images) {
    if (address >= image.offset) {
      written += complete && address === image.offset ? image.size : Math.min(address - image.offset, image.size);
    }
  }
  return Math.round(10 + 88 * written / total);
}

export function usbPowerArgs(
  balaxDir: string, action: "wake" | "usb-sleep" | "off", port: string, force = false,
): string[] {
  const script = path.join(balaxDir, "tools/usb_power.py");
  const normalized = action === "off" ? "usb-sleep" : action;
  const args = [script, normalized, "--port", port];
  if (normalized === "usb-sleep" && force) args.push("--force");
  return args;
}
