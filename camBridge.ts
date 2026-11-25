import dgram from "node:dgram";
import dns from "node:dns/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { WasmTemporalDecoder } from "./eclDecoder.ts";
import {
  CAM_USB_BAUD,
  type CamActiveTransport,
  type CamBinaryArtifactInfo,
  type CamBridgeStatus,
  type CamFlashJob,
  type CamOtaInfoResponse,
  type CamResolutionId,
  type CamStabMode,
  type CamSystemStatus,
  type CamThermalState,
  type CamTransportPreference,
  type CamWifiPs,
} from "./src/cameraProtocol.ts";
import { espIdfPython, usbSerialPortKinds, usbSerialPorts, usbWriteProgress } from "./usbFlash.ts";
import { filterCamUsbPorts } from "./src/deviceControls.ts";

export type {
  CamActiveTransport,
  CamBinaryArtifactInfo,
  CamBridgeStatus,
  CamFlashJob,
  CamOtaInfoResponse,
  CamResolutionId,
  CamStabMode,
  CamSystemStatus,
  CamThermalState,
  CamTransportPreference,
  CamWifiPs,
} from "./src/cameraProtocol.ts";

// Wire-format constants matching esp32-cam/transport/include/ecl/protocol.hpp
export const ECL1_MAGIC = 0x4c43; // 'C', 'L' little-endian
export const ECL1_VERSION = 1;
export const ECL1_HEADER_BYTES = 32;
export const ECL1_TRAILER_BYTES = 4;
export const ECL1_OVERHEAD_BYTES = ECL1_HEADER_BYTES + ECL1_TRAILER_BYTES;
export const ECL1_MAX_CHUNKS = 512;

export const ECL1_FLAG_KEYFRAME = 1 << 0;
export const ECL1_FLAG_LAST_CHUNK = 1 << 1;
export const ECL1_FLAG_HAS_META_ATTITUDE = 1 << 2;
export const ECL1_FLAG_END_OF_STREAM = 1 << 3;

export const CODEC_MODE_NAMES = [
  "PASS_THROUGH",
  "FRAME_SKIP",
  "GENERIC_ZLIB",
  "DCT_DC_RESIDUAL",
  "DCT_LOW_AC_RESIDUAL",
  "DCT_FULL_RESIDUAL",
  "DCT_SPARSE_BLOCK",
] as const;

export type Ecl1CodecModeName = (typeof CODEC_MODE_NAMES)[number] | "UNKNOWN";

export interface Ecl1Header {
  magic: number;
  version: number;
  flags: number;
  streamId: number;
  codecMode: number;
  chunkId: number;
  chunkCount: number;
  payloadLen: number;
  frameId: number;
  referenceFrameId: number;
  timestampUsLow: number;
  width: number;
  height: number;
  metaPitchCdeg: number;
  metaRollCdeg: number;
}

export interface AssembledFrame {
  frameId: number;
  referenceFrameId: number;
  timestampUsLow: number;
  receivedAtMs: number;
  codecMode: number;
  codecModeName: Ecl1CodecModeName;
  isKeyframe: boolean;
  isSkipped: boolean;
  hasAttitude: boolean;
  width: number;
  height: number;
  pitchCdeg: number;
  rollCdeg: number;
  jpeg: Buffer;
  wireBytes: number;
}

const CRC32_NIBBLE_TABLE = new Uint32Array([
  0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac,
  0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
  0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c,
  0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
]);

export function crc32Ieee(buf: Uint8Array, len = buf.length): number {
  let crc = 0xffffffff;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i]!;
    crc = (crc >>> 4) ^ CRC32_NIBBLE_TABLE[crc & 0x0f]!;
    crc = (crc >>> 4) ^ CRC32_NIBBLE_TABLE[crc & 0x0f]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function codecModeName(mode: number): Ecl1CodecModeName {
  return CODEC_MODE_NAMES[mode] ?? "UNKNOWN";
}

export function frameIdNewer(a: number, b: number): boolean {
  return ((a - b) | 0) > 0;
}

export function packEcl1Packet(hdr: Partial<Ecl1Header>, payload: Uint8Array): Buffer {
  const payloadLen = payload.length;
  const out = Buffer.alloc(ECL1_HEADER_BYTES + payloadLen + ECL1_TRAILER_BYTES);
  out.writeUInt16LE(hdr.magic ?? ECL1_MAGIC, 0);
  out.writeUInt8(hdr.version ?? ECL1_VERSION, 2);
  out.writeUInt8(hdr.flags ?? 0, 3);
  out.writeUInt8(hdr.streamId ?? 0, 4);
  out.writeUInt8(hdr.codecMode ?? 0, 5);
  out.writeUInt16LE(hdr.chunkId ?? 0, 6);
  out.writeUInt16LE(hdr.chunkCount ?? 1, 8);
  out.writeUInt16LE(payloadLen, 10);
  out.writeUInt32LE((hdr.frameId ?? 0) >>> 0, 12);
  out.writeUInt32LE((hdr.referenceFrameId ?? 0) >>> 0, 16);
  out.writeUInt32LE((hdr.timestampUsLow ?? 0) >>> 0, 20);
  out.writeUInt16LE(hdr.width ?? 320, 24);
  out.writeUInt16LE(hdr.height ?? 240, 26);
  out.writeInt16LE(hdr.metaPitchCdeg ?? 0, 28);
  out.writeInt16LE(hdr.metaRollCdeg ?? 0, 30);
  if (payloadLen > 0) {
    out.set(payload, ECL1_HEADER_BYTES);
  }
  const crc = crc32Ieee(out, ECL1_HEADER_BYTES + payloadLen);
  out.writeUInt32LE(crc, ECL1_HEADER_BYTES + payloadLen);
  return out;
}

export function unpackEcl1Packet(wire: Buffer): { header: Ecl1Header; payload: Buffer } | null {
  if (wire.length < ECL1_OVERHEAD_BYTES) return null;
  const magic = wire.readUInt16LE(0);
  if (magic !== ECL1_MAGIC) return null;
  const version = wire.readUInt8(2);
  if (version !== ECL1_VERSION) return null;

  const chunkId = wire.readUInt16LE(6);
  const chunkCount = wire.readUInt16LE(8);
  const payloadLen = wire.readUInt16LE(10);
  if (chunkCount === 0 || chunkCount > ECL1_MAX_CHUNKS || chunkId >= chunkCount) return null;
  if (wire.length !== ECL1_HEADER_BYTES + payloadLen + ECL1_TRAILER_BYTES) return null;

  const expectedCrc = wire.readUInt32LE(ECL1_HEADER_BYTES + payloadLen);
  const actualCrc = crc32Ieee(wire, ECL1_HEADER_BYTES + payloadLen);
  if (expectedCrc !== actualCrc) return null;

  const header: Ecl1Header = {
    magic,
    version,
    flags: wire.readUInt8(3),
    streamId: wire.readUInt8(4),
    codecMode: wire.readUInt8(5),
    chunkId,
    chunkCount,
    payloadLen,
    frameId: wire.readUInt32LE(12),
    referenceFrameId: wire.readUInt32LE(16),
    timestampUsLow: wire.readUInt32LE(20),
    width: wire.readUInt16LE(24),
    height: wire.readUInt16LE(26),
    metaPitchCdeg: wire.readInt16LE(28),
    metaRollCdeg: wire.readInt16LE(30),
  };
  const payload = wire.subarray(ECL1_HEADER_BYTES, ECL1_HEADER_BYTES + payloadLen);
  return { header, payload };
}

interface PendingSlot {
  frameId: number;
  header: Ecl1Header;
  chunks: Array<Buffer | null>;
  receivedCount: number;
  wireBytes: number;
  firstSeenMs: number;
}

export class Ecl1Depacketizer {
  private readonly slots = new Map<number, PendingSlot>();
  private readonly maxSlots: number;
  private lastDeliveredId: number | null = null;
  private lastJpeg: Buffer | null = null;
  private wasmDecoder: WasmTemporalDecoder | null = null;
  public badPackets = 0;
  public droppedIncomplete = 0;
  public decodeErrors = 0;

  constructor(maxSlots = 4, wasmDecoder: WasmTemporalDecoder | null = null) {
    this.maxSlots = maxSlots;
    this.wasmDecoder = wasmDecoder;
  }

  setWasmDecoder(dec: WasmTemporalDecoder | null): void {
    this.wasmDecoder = dec;
  }

  reset(): void {
    this.slots.clear();
    this.lastDeliveredId = null;
    this.lastJpeg = null;
    this.wasmDecoder?.reset();
  }

  feedPacket(wire: Buffer, nowMs = Date.now()): AssembledFrame | null {
    const parsed = unpackEcl1Packet(wire);
    if (!parsed) {
      this.badPackets++;
      return null;
    }
    const { header, payload } = parsed;

    // Drop frames older than already delivered
    if (this.lastDeliveredId !== null && !frameIdNewer(header.frameId, this.lastDeliveredId)) {
      return null;
    }

    // Handle FRAME_SKIP (codec_mode == 1): reuse cached JPEG with fresh attitude metadata!
    if (header.codecMode === 1 && header.chunkCount === 1) {
      if (!this.lastJpeg) return null;
      this.lastDeliveredId = header.frameId;
      this.pruneOldSlots(header.frameId);
      return {
        frameId: header.frameId,
        referenceFrameId: header.referenceFrameId,
        timestampUsLow: header.timestampUsLow,
        receivedAtMs: nowMs,
        codecMode: header.codecMode,
        codecModeName: "FRAME_SKIP",
        isKeyframe: false,
        isSkipped: true,
        hasAttitude: (header.flags & ECL1_FLAG_HAS_META_ATTITUDE) !== 0,
        width: header.width,
        height: header.height,
        pitchCdeg: header.metaPitchCdeg,
        rollCdeg: header.metaRollCdeg,
        jpeg: this.lastJpeg,
        wireBytes: wire.length,
      };
    }

    let slot = this.slots.get(header.frameId);
    if (!slot) {
      if (this.slots.size >= this.maxSlots) {
        // Evict oldest incomplete slot
        let oldestId: number | null = null;
        let oldestMs = Infinity;
        for (const [id, s] of this.slots) {
          if (s.firstSeenMs < oldestMs) {
            oldestMs = s.firstSeenMs;
            oldestId = id;
          }
        }
        if (oldestId !== null) {
          this.slots.delete(oldestId);
          this.droppedIncomplete++;
        }
      }
      slot = {
        frameId: header.frameId,
        header,
        chunks: new Array<Buffer | null>(header.chunkCount).fill(null),
        receivedCount: 0,
        wireBytes: 0,
        firstSeenMs: nowMs,
      };
      this.slots.set(header.frameId, slot);
    }

    if (slot.chunks.length !== header.chunkCount) {
      this.badPackets++;
      return null;
    }
    if (slot.chunks[header.chunkId] === null) {
      slot.chunks[header.chunkId] = Buffer.from(payload);
      slot.receivedCount++;
      slot.wireBytes += wire.length;
    }

    if (slot.receivedCount < slot.chunks.length) {
      return null;
    }

    const joined = Buffer.concat(slot.chunks as Buffer[]);
    this.slots.delete(header.frameId);
    this.lastDeliveredId = header.frameId;
    this.pruneOldSlots(header.frameId);

    const isKeyframe = (header.flags & ECL1_FLAG_KEYFRAME) !== 0;
    let outputJpeg: Buffer;

    if (header.codecMode === 0) {
      // PASS_THROUGH: raw JPEG bytes directly from OV2640
      if (joined.length < 2 || joined[0] !== 0xff || joined[1] !== 0xd8) {
        this.badPackets++;
        return null;
      }
      outputJpeg = joined;
      this.lastJpeg = outputJpeg;
    } else if (this.wasmDecoder) {
      // Real temporal DCT reconstruction (DCT_SPARSE_BLOCK, DCT_FULL_RESIDUAL, etc.) via 34 KB WASM libcodec!
      const decoded = this.wasmDecoder.decode(
        header.codecMode,
        header.frameId,
        header.referenceFrameId,
        isKeyframe,
        header.width,
        header.height,
        joined,
      );
      if (!decoded || decoded.length < 2 || decoded[0] !== 0xff || decoded[1] !== 0xd8) {
        this.decodeErrors++;
        return null;
      }
      outputJpeg = decoded;
      this.lastJpeg = outputJpeg;
    } else if (isKeyframe && joined.length >= 2 && joined[0] === 0xff && joined[1] === 0xd8) {
      // Fallback before WASM finishes async init: display keyframes directly
      outputJpeg = joined;
      this.lastJpeg = outputJpeg;
    } else {
      return null;
    }

    return {
      frameId: header.frameId,
      referenceFrameId: header.referenceFrameId,
      timestampUsLow: header.timestampUsLow,
      receivedAtMs: nowMs,
      codecMode: header.codecMode,
      codecModeName: codecModeName(header.codecMode),
      isKeyframe,
      isSkipped: false,
      hasAttitude: (header.flags & ECL1_FLAG_HAS_META_ATTITUDE) !== 0,
      width: header.width,
      height: header.height,
      pitchCdeg: header.metaPitchCdeg,
      rollCdeg: header.metaRollCdeg,
      jpeg: outputJpeg,
      wireBytes: slot.wireBytes,
    };
  }

  private pruneOldSlots(deliveredId: number): void {
    for (const id of this.slots.keys()) {
      if (!frameIdNewer(id, deliveredId)) {
        this.slots.delete(id);
        this.droppedIncomplete++;
      }
    }
  }
}

// Framed serial extractor for:
//   [0xEB, 0x90, len_lo, len_hi, <ECL1 video packet>]
//   [0xEB, 0x91, len_lo, len_hi, <UTF-8 status JSON>]
export class SerialEcl1Framer {
  private buf = Buffer.alloc(0);

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  push(chunk: Buffer): Buffer[] {
    return this.pushFrames(chunk).packets;
  }

  pushFrames(chunk: Buffer): { packets: Buffer[]; statuses: Record<string, unknown>[] } {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const packets: Buffer[] = [];
    const statuses: Record<string, unknown>[] = [];
    let offset = 0;

    while (offset + 4 <= this.buf.length) {
      if (this.buf[offset] !== 0xeb) {
        offset++;
        continue;
      }
      const kind = this.buf[offset + 1];
      if (kind !== 0x90 && kind !== 0x91) {
        offset++;
        continue;
      }
      const pktLen = this.buf.readUInt16LE(offset + 2);
      if (kind === 0x90 && (pktLen < ECL1_OVERHEAD_BYTES || pktLen > 2048)) {
        offset += 2;
        continue;
      }
      if (kind === 0x91 && (pktLen < 2 || pktLen > 4096)) {
        offset += 2;
        continue;
      }
      if (offset + 4 + pktLen > this.buf.length) {
        break; // wait for more bytes
      }
      const payload = this.buf.subarray(offset + 4, offset + 4 + pktLen);
      if (kind === 0x90) {
        packets.push(Buffer.from(payload));
      } else {
        try {
          const parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") statuses.push(parsed);
        } catch {
          // ignore malformed status JSON
        }
      }
      offset += 4 + pktLen;
    }

    if (offset > 0) {
      this.buf = this.buf.subarray(offset);
    }
    if (this.buf.length > 16384) {
      this.buf = this.buf.subarray(this.buf.length - 4096);
    }
    return { packets, statuses };
  }
}

export const CAM_PUSH_MAGIC = 0x464d4342; // 'B','C','M','F' little-endian
export const CAM_PUSH_HEADER_BYTES = 24;

/**
 * Builds an 8 KB ESP-IDF `otadata` partition image selecting `ota_0` (`ota_seq = 1`).
 * Without this, a partition table containing both `factory` (OTA stub) and `ota_0`
 * boots `factory` when `otadata` is blank (0xFF).
 */
export function buildOta0SelectData(): Buffer {
  const buf = Buffer.alloc(0x2000, 0xff);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(1, 0);
  const crc = zlib.crc32(seqBuf, 0xffffffff) >>> 0;
  seqBuf.copy(buf, 0);
  buf.writeUInt32LE(crc, 28);
  return buf;
}

export function encodeBinaryPushFrame(frame: AssembledFrame): Buffer {
  const hdr = Buffer.allocUnsafe(CAM_PUSH_HEADER_BYTES);
  hdr.writeUInt32LE(CAM_PUSH_MAGIC, 0);
  hdr.writeUInt32LE(frame.frameId >>> 0, 4);
  hdr.writeUInt16LE(frame.width & 0xffff, 8);
  hdr.writeUInt16LE(frame.height & 0xffff, 10);
  hdr.writeInt16LE(Math.max(-32768, Math.min(32767, frame.pitchCdeg)), 12);
  hdr.writeInt16LE(Math.max(-32768, Math.min(32767, frame.rollCdeg)), 14);
  const flags =
    (frame.hasAttitude ? 1 : 0) |
    (frame.isSkipped ? 2 : 0) |
    (frame.isKeyframe ? 4 : 0);
  hdr.writeUInt8(flags, 16);
  hdr.writeUInt8(frame.codecMode & 0xff, 17);
  hdr.writeUInt16LE(0, 18);
  hdr.writeUInt32LE(frame.jpeg.length >>> 0, 20);
  return Buffer.concat([hdr, frame.jpeg]);
}

function readCamSystemStatus(raw: unknown): CamSystemStatus | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const percent = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  const bytes = (value: unknown, minimum = 0) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : null;
  return {
    cpu0LoadPct: percent(data.cpu0_load_pct),
    cpu1LoadPct: percent(data.cpu1_load_pct),
    dramTotalBytes: bytes(data.dram_total_bytes, 1),
    dramMinFreeBytes: bytes(data.dram_min_free_bytes),
    psramTotalBytes: bytes(data.psram_total_bytes, 1),
    psramMinFreeBytes: bytes(data.psram_min_free_bytes),
    flashTotalBytes: bytes(data.flash_total_bytes, 1),
    runningPartition: typeof data.running_partition === "string" && data.running_partition ? data.running_partition : null,
    runningPartitionBytes: bytes(data.running_partition_bytes, 1),
  };
}

const MJPEG_BOUNDARY = "balax_cam_frame";

export class CamBridgeManager {
  private host = "balax-cam.local";
  private hostRevision = 0;
  private resolvedIp: string | null = null;
  private readonly camPort = 5000;
  private preference: CamTransportPreference = "auto";
  private activeTransport: CamActiveTransport = "none";
  private wantStream = false;
  private sleepingPaused = false;

  private udpSock: dgram.Socket | null = null;
  private subTimer: NodeJS.Timeout | null = null;
  private httpAbort: AbortController | null = null;
  private usbChild: ChildProcess | null = null;
  private usbPortInUse: string | null = null;
  private confirmedUsbPort: string | null = null;

  private readonly depacketizer = new Ecl1Depacketizer(4);
  private wasmDecoder: WasmTemporalDecoder | null = null;
  private readonly wasmReady: Promise<void>;

  constructor() {
    this.wasmReady = WasmTemporalDecoder.create(131072, 4096)
      .then((dec) => {
        this.wasmDecoder = dec;
        this.depacketizer.setWasmDecoder(dec);
      })
      .catch(() => {
        // Fallback to keyframes/PASS_THROUGH if WASM unavailable
      });
  }
  private readonly serialFramer = new SerialEcl1Framer();
  private latestFrame: AssembledFrame | null = null;
  private mjpegClients = new Set<ServerResponse>();
  private binaryPushClients = new Set<ServerResponse>();
  private usbStatusWaiters: Array<(st: Record<string, unknown>) => void> = [];
  private usbSessionStartedAtMs = 0;
  private usbReceivedAny = false;
  private usbBackoffUntilMs = 0;
  private readonly usbBaud = CAM_USB_BAUD;

  // Rolling 1s live metrics
  private winStartMs = Date.now();
  private winFrames = 0;
  private winBytes = 0;
  private winSkipped = 0;
  private measuredFps = 0;
  private measuredKbps = 0;
  private totalSkipped = 0;

  // Last passive remote status snapshot
  private remoteStatus: Record<string, unknown> | null = null;
  private remoteStatusAtMs = 0;
  private udpStatusProbe: { ip: string | null; atMs: number } | null = null;
  private flashJob: CamFlashJob | null = null;
  private readonly camBuildDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../balax-cam/firmware/esp32cam_balax/build");
  private readonly camBuildScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../balax-cam/scripts/build_firmware.sh");
  private readonly camFirmwarePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../balax-cam/firmware/esp32cam_balax/build/balax_cam_fw.bin");
  private readonly camStubBuildDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../esp32-cam/firmware/ota_stub/build");
  private readonly camStubPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../esp32-cam/firmware/ota_stub/build/esp32cam_ota_stub.bin");

  setHost(host: string): void {
    const clean = host.trim() || "balax-cam.local";
    if (clean !== this.host) {
      this.host = clean;
      this.hostRevision++;
      this.resolvedIp = null;
      this.remoteStatus = null;
      this.remoteStatusAtMs = 0;
      this.udpStatusProbe = null;
      this.sleepingPaused = false;
    }
  }

  private candidateUsbPorts(): string[] {
    const all = usbSerialPorts();
    return filterCamUsbPorts(all, usbSerialPortKinds(all));
  }

  getConfirmedUsbPort(): string | null {
    if (this.confirmedUsbPort && !usbSerialPorts().includes(this.confirmedUsbPort)) {
      this.confirmedUsbPort = null;
    }
    return this.confirmedUsbPort;
  }

  async setTransportPreference(pref: CamTransportPreference): Promise<void> {
    this.preference = pref;
    if (this.wantStream) {
      await this.startStream(pref);
      return;
    }
    if (pref === "usb") {
      this.usbBackoffUntilMs = 0;
      if (!this.sleepingPaused && this.candidateUsbPorts().length > 0) {
        this.ensureUsbSession(false);
      }
    } else if (pref === "udp" || pref === "http") {
      this.stopUsbChild();
    }
  }

  getLatestFrame(): AssembledFrame | null {
    return this.latestFrame;
  }

  private async resolveCamIp(timeoutMs = 1000): Promise<string | null> {
    const revision = this.hostRevision;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.host)) {
      this.resolvedIp = this.host;
      return this.host;
    }
    try {
      const res = await Promise.race([
        dns.lookup(this.host, { family: 4 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (revision !== this.hostRevision) return null;
      if (res && "address" in res) {
        this.resolvedIp = res.address;
        return res.address;
      }
    } catch {
      // Fallback to UDP broadcast discovery below
    }
    return revision === this.hostRevision ? this.resolvedIp : null;
  }

  private ensureUdpSocket(): dgram.Socket {
    if (this.udpSock) return this.udpSock;
    const sock = dgram.createSocket("udp4");
    sock.on("error", () => {
      // ignore transient socket errors
    });
    sock.on("message", (msg, rinfo) => {
      // Check if it's a JSON status response to WHO/STATUS
      if (msg.length > 2 && msg[0] === 0x7b) {
        const probe = this.udpStatusProbe;
        if (!probe || Date.now() - probe.atMs >= 1500 || (probe.ip && probe.ip !== rinfo.address)) return;
        try {
          const parsed = JSON.parse(msg.toString("utf8")) as Record<string, unknown>;
          if (typeof parsed.camera === "string") {
            this.udpStatusProbe = null;
            this.resolvedIp = rinfo.address;
            this.remoteStatus = parsed;
            this.remoteStatusAtMs = Date.now();
          }
        } catch {
          // ignore malformed json
        }
        return;
      }
      if (!this.wantStream) return;
      const frame = this.depacketizer.feedPacket(msg, Date.now());
      if (frame) {
        this.resolvedIp = rinfo.address;
        this.onFrameReceived(frame, "udp_ecl1");
      }
    });
    sock.bind(0, "0.0.0.0", () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // ignore
      }
    });
    this.udpSock = sock;
    return sock;
  }

  private onFrameReceived(frame: AssembledFrame, transport: CamActiveTransport): void {
    this.latestFrame = frame;
    this.activeTransport = transport;
    this.sleepingPaused = false;

    this.winFrames++;
    this.winBytes += frame.wireBytes;
    if (frame.isSkipped) {
      this.winSkipped++;
      this.totalSkipped++;
    }
    const now = Date.now();
    const dt = now - this.winStartMs;
    if (dt >= 1000) {
      this.measuredFps = Math.round((this.winFrames * 10000) / dt) / 10;
      this.measuredKbps = Math.round((this.winBytes * 8) / dt);
      this.winStartMs = now;
      this.winFrames = 0;
      this.winBytes = 0;
      this.winSkipped = 0;
    }

    // Fan out to any attached browser MJPEG viewers
    if (this.mjpegClients.size > 0 && frame.jpeg.length > 0) {
      const header = Buffer.from(
        `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n` +
          `X-Pitch-Cdeg: ${frame.pitchCdeg}\r\nX-Roll-Cdeg: ${frame.rollCdeg}\r\n\r\n`,
      );
      const tail = Buffer.from("\r\n");
      for (const client of Array.from(this.mjpegClients)) {
        if (client.writableEnded || client.destroyed) {
          this.mjpegClients.delete(client);
          continue;
        }
        try {
          client.write(header);
          client.write(frame.jpeg);
          client.write(tail);
        } catch {
          this.mjpegClients.delete(client);
        }
      }
    }

    // Fan out to zero-poll low-latency binary push clients (drop-stale if browser is behind!)
    if (this.binaryPushClients.size > 0 && frame.jpeg.length > 0) {
      const payload = encodeBinaryPushFrame(frame);
      for (const client of this.binaryPushClients) {
        if (client.writableEnded || client.destroyed) {
          this.binaryPushClients.delete(client);
          continue;
        }
        if (client.writableNeedDrain) {
          continue;
        }
        try {
          client.write(payload);
        } catch {
          this.binaryPushClients.delete(client);
        }
      }
    }
  }

  async startStream(pref?: CamTransportPreference): Promise<void> {
    await this.wasmReady;
    if (pref) this.preference = pref;
    this.wantStream = true;
    this.sleepingPaused = false;
    this.depacketizer.reset();
    this.winStartMs = Date.now();
    this.winFrames = 0;
    this.winBytes = 0;

    // Tear down LAN workers before starting cleanly; reuse persistent USB session if active
    this.stopLanWorkersOnly();
    this.usbBackoffUntilMs = 0;

    if (this.preference === "usb") {
      this.ensureUsbSession(true);
      return;
    }
    if (this.preference === "http") {
      this.stopUsbChild();
      void this.startHttpMjpegFallback();
      return;
    }

    // If we already have a live USB camera session and Wi-Fi isn't fresh, start USB stream immediately!
    if (this.usbChild && this.usbReceivedAny) {
      this.ensureUsbSession(true);
    }

    // Tier 1: UDP ECL1 (lowest latency on LAN)
    const sock = this.ensureUdpSocket();
    const sendSub = async () => {
      if (!this.wantStream) return;
      const ip = (await this.resolveCamIp(600)) ?? "255.255.255.255";
      const pkt = Buffer.from("SUB");
      try {
        sock.send(pkt, this.camPort, ip);
      } catch {
        // ignore
      }
      // In auto mode, if no UDP frame arrived after 2.0s, fall back to HTTP MJPEG AND/OR USB Serial!
      if (this.preference === "auto" && this.wantStream) {
        const lastAge = this.latestFrame ? Date.now() - this.latestFrame.receivedAtMs : Infinity;
        if (lastAge > 2000) {
          if (this.resolvedIp && !this.httpAbort) {
            void this.startHttpMjpegFallback();
          }
          if (this.candidateUsbPorts().length > 0 && Date.now() >= this.usbBackoffUntilMs) {
            this.ensureUsbSession(true);
          }
        } else if (this.activeTransport === "udp_ecl1") {
          // UDP is healthy — stop any fallback worker to save power!
          if (this.httpAbort) {
            this.httpAbort.abort();
            this.httpAbort = null;
          }
          this.stopUsbChild();
        }
      }
    };

    void sendSub();
    this.subTimer = setInterval(() => {
      void sendSub();
    }, 2000);
  }

  async stopStream(): Promise<void> {
    this.wantStream = false;
    this.activeTransport = "none";
    this.measuredFps = 0;
    this.measuredKbps = 0;

    // Immediately notify ESP32-CAM to drop subscriber and cut OV2640 power!
    if (this.udpSock) {
      const target = this.resolvedIp ?? "255.255.255.255";
      try {
        this.udpSock.send(Buffer.from("UNSUB"), this.camPort, target);
      } catch {
        // ignore
      }
    }
    // Keep persistent USB session alive in Cool Idle (OV2640 OFF) so we never reset the camera on reopen!
    if (this.usbChild?.stdin?.writable) {
      try {
        this.usbChild.stdin.write("__STREAM_OFF__\n");
      } catch {
        // ignore
      }
    }
    this.stopLanWorkersOnly();
  }

  private stopLanWorkersOnly(): void {
    if (this.subTimer) {
      clearInterval(this.subTimer);
      this.subTimer = null;
    }
    if (this.httpAbort) {
      this.httpAbort.abort();
      this.httpAbort = null;
    }
  }

  private stopWorkersOnly(): void {
    this.stopLanWorkersOnly();
    this.stopUsbChild();
  }

  private stopUsbChild(): void {
    if (this.usbChild) {
      try {
        this.usbChild.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.usbChild = null;
      this.usbPortInUse = null;
    }
  }

  private async startHttpMjpegFallback(): Promise<void> {
    if (this.httpAbort || !this.wantStream) return;
    const ip = await this.resolveCamIp(1000);
    if (!ip || !this.wantStream) return;

    const ac = new AbortController();
    this.httpAbort = ac;

    try {
      const res = await fetch(`http://${ip}/api/stream`, { signal: ac.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      let acc = Buffer.alloc(0);
      let seq = 1;

      while (this.wantStream && !ac.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        acc = acc.length > 0 ? Buffer.concat([acc, Buffer.from(value)]) : Buffer.from(value);

        // Extract complete JPEG SOI (FF D8) .. EOI (FF D9) frames
        while (true) {
          const soi = acc.indexOf(Buffer.from([0xff, 0xd8]));
          if (soi < 0) {
            if (acc.length > 131072) acc = acc.subarray(acc.length - 1024);
            break;
          }
          const eoi = acc.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
          if (eoi < 0) {
            if (soi > 0) acc = acc.subarray(soi);
            break;
          }
          const headerText = acc.subarray(0, soi).toString("latin1");
          const pitchM = headerText.match(/X-Pitch-Cdeg:\s*(-?\d+)/i);
          const rollM = headerText.match(/X-Roll-Cdeg:\s*(-?\d+)/i);
          const jpeg = Buffer.from(acc.subarray(soi, eoi + 2));
          acc = acc.subarray(eoi + 2);

          this.onFrameReceived(
            {
              frameId: seq++,
              referenceFrameId: 0,
              timestampUsLow: (Date.now() * 1000) >>> 0,
              receivedAtMs: Date.now(),
              codecMode: 0,
              codecModeName: "PASS_THROUGH",
              isKeyframe: true,
              isSkipped: false,
              hasAttitude: Boolean(pitchM || rollM),
              width: 320,
              height: 240,
              pitchCdeg: pitchM ? Number(pitchM[1]) : 0,
              rollCdeg: rollM ? Number(rollM[1]) : 0,
              jpeg,
              wireBytes: jpeg.length,
            },
            "http_mjpeg",
          );
        }
      }
    } catch {
      // Expected on abort or disconnect
    } finally {
      if (this.httpAbort === ac) this.httpAbort = null;
    }
  }

  private ensureUsbSession(streaming: boolean): void {
    if (this.flashJob?.status === "running") return;
    if (this.usbChild?.stdin?.writable) {
      try {
        this.usbChild.stdin.write(streaming ? "__STREAM_ON__\n" : "__STREAM_OFF__\n");
      } catch {
        // ignore
      }
      return;
    }
    if (this.usbChild) return;

    const py = espIdfPython();
    const ports = this.candidateUsbPorts();
    if (!py || ports.length === 0) return;

    const port = ports[0]!;
    this.usbPortInUse = port;
    this.usbSessionStartedAtMs = Date.now();
    this.usbReceivedAny = false;
    this.serialFramer.reset();

    const script = [
      "import serial, sys, time, threading",
      "s = serial.Serial()",
      `s.port = ${JSON.stringify(port)}`,
      `s.baudrate = ${this.usbBaud}`,
      "s.timeout = 0.02",
      "s.dtr = False; s.rts = False",
      "s.open()",
      "s.dtr = False; s.rts = False",
      "wlock = threading.Lock()",
      "stop = False",
      `want_stream = ${streaming ? "True" : "False"}`,
      "def send_line(b):",
      "    with wlock:",
      "        s.write(b); s.flush()",
      "def keepalive():",
      "    # Stagger initial STATUS probes to catch boot completion after macOS open() reset",
      "    for delay in (0.15, 0.55, 0.70, 0.80):",
      "        if stop: return",
      "        time.sleep(delay)",
      "        try:",
      "            send_line(b'SUB\\n' if want_stream else b'STATUS\\n')",
      "        except Exception: return",
      "    while not stop:",
      "        try:",
      "            send_line(b'SUB\\n' if want_stream else b'STATUS\\n')",
      "        except Exception: break",
      "        time.sleep(1.8)",
      "def stdin_pump():",
      "    global want_stream",
      "    for raw in sys.stdin.buffer:",
      "        if stop: break",
      "        cmd = raw.strip()",
      "        if cmd == b'__STREAM_ON__':",
      "            want_stream = True",
      "            try: send_line(b'SUB\\n')",
      "            except Exception: break",
      "        elif cmd == b'__STREAM_OFF__':",
      "            want_stream = False",
      "            try: send_line(b'UNSUB\\n')",
      "            except Exception: break",
      "        elif cmd:",
      "            try: send_line(raw)",
      "            except Exception: break",
      "threading.Thread(target=keepalive, daemon=True).start()",
      "threading.Thread(target=stdin_pump, daemon=True).start()",
      "try:",
      "    while True:",
      "        d = s.read(4096)",
      "        if d: sys.stdout.buffer.write(d); sys.stdout.buffer.flush()",
      "except KeyboardInterrupt: pass",
      "finally:",
      "    stop = True",
      "    try:",
      "        if want_stream: send_line(b'UNSUB\\n')",
      "        s.close()",
      "    except Exception: pass",
    ].join("\n");

    const child = spawn(py, ["-u", "-c", script], { stdio: ["pipe", "pipe", "ignore"] });
    this.usbChild = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      const { packets, statuses } = this.serialFramer.pushFrames(chunk);
      if (statuses.length > 0 || packets.length > 0) {
        this.usbReceivedAny = true;
        if (this.usbPortInUse) this.confirmedUsbPort = this.usbPortInUse;
      }
      for (const st of statuses) {
        this.remoteStatus = st;
        this.remoteStatusAtMs = Date.now();
        const waiters = this.usbStatusWaiters.splice(0);
        for (const w of waiters) w(st);
      }
      if (!this.wantStream) return;
      for (const pkt of packets) {
        const frame = this.depacketizer.feedPacket(pkt, Date.now());
        if (frame) {
          this.onFrameReceived(frame, "usb_ecl1");
        }
      }
    });
    child.on("exit", () => {
      if (this.usbChild === child) {
        this.usbChild = null;
        this.usbPortInUse = null;
      }
    });
  }

  private async sendUsbCommand(line: string, waitStatusMs = 1500): Promise<Record<string, unknown> | null> {
    if (this.flashJob?.status === "running") return null;
    if (!this.usbChild) {
      this.ensureUsbSession(this.wantStream);
      // Give the newly opened persistent session a moment to finish boot after macOS open()
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.usbChild?.stdin?.writable) return null;

    const promise = waitStatusMs > 0
      ? new Promise<Record<string, unknown> | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), waitStatusMs);
          this.usbStatusWaiters.push((st) => {
            clearTimeout(timer);
            resolve(st);
          });
        })
      : Promise.resolve(null);
    try {
      this.usbChild.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    } catch {
      return null;
    }
    return promise;
  }

  attachBinaryPushClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    this.binaryPushClients.add(res);
    if (!this.wantStream) {
      void this.startStream();
    } else if (this.latestFrame && this.latestFrame.jpeg.length > 0) {
      try {
        res.write(encodeBinaryPushFrame(this.latestFrame));
      } catch {
        this.binaryPushClients.delete(res);
      }
    }
    res.on("close", () => {
      this.binaryPushClients.delete(res);
    });
  }

  attachMjpegClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
    });
    this.mjpegClients.add(res);
    if (!this.wantStream) {
      void this.startStream();
    }
    res.on("close", () => {
      this.mjpegClients.delete(res);
    });
  }

  async setPower(mode: "idle" | "sleep" | "wake", via: "auto" | "lan" | "usb" = "auto"): Promise<{
    ok: boolean;
    mode: string;
    via: string;
    message: string;
  }> {
    if (mode === "sleep" || mode === "idle") {
      await this.stopStream();
      if (mode === "sleep") this.sleepingPaused = true;
    }

    // Wake over USB: pulse RTS->EN (remote reboot out of deep sleep without button press!)
    if (mode === "wake" && (via === "usb" || (via === "auto" && this.candidateUsbPorts().length > 0))) {
      this.stopUsbChild();
      this.usbBackoffUntilMs = 0;
      await new Promise((r) => setTimeout(r, 120));
      const py = espIdfPython();
      const ports = this.candidateUsbPorts();
      if (py && ports.length > 0) {
        const port = ports[0]!;
        await new Promise<void>((resolve) => {
          const script = [
            "import serial, time",
            `s = serial.Serial(${JSON.stringify(port)}, 115200, timeout=0.1)`,
            "s.dtr = False; s.rts = True; time.sleep(0.06)",
            "s.rts = False; time.sleep(0.05); s.close()",
          ].join("\n");
          const c = spawn(py, ["-c", script], { stdio: "ignore" });
          c.on("exit", () => resolve());
          setTimeout(() => resolve(), 1500);
        });
        this.sleepingPaused = false;
        return { ok: true, mode: "wake", via: "usb", message: `Pulsed RTS->EN on ${port} (ESP32-CAM booting cool idle)` };
      }
    }

    // Try LAN HTTP /api/power first
    if (via !== "usb") {
      const ip = await this.resolveCamIp(800);
      if (ip) {
        try {
          const r = await fetch(`http://${ip}/api/power`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
            signal: AbortSignal.timeout(1500),
          });
          if (r.ok) {
            if (mode === "wake") this.sleepingPaused = false;
            return {
              ok: true,
              mode,
              via: "lan",
              message: mode === "sleep"
                ? "ESP32-CAM entered ~10 uA deep sleep (ice-cold; wake via USB or Reset)"
                : mode === "idle"
                  ? "ESP32-CAM cut OV2640 power (GPIO32=HIGH) -> 40-80 MHz cool Wi-Fi idle"
                  : "ESP32-CAM awake in cool idle",
            };
          }
        } catch {
          // fall through to UDP or USB
        }
      }
      // UDP fallback for IDLE / SLEEP
      if (mode === "sleep" || mode === "idle") {
        const sock = this.ensureUdpSocket();
        const target = this.resolvedIp ?? "255.255.255.255";
        try {
          sock.send(Buffer.from(mode === "sleep" ? "SLEEP" : "IDLE"), this.camPort, target);
        } catch {
          // ignore
        }
      }
    }

    // USB serial command fallback ("SLEEP\n" / "IDLE\n")
    const py = espIdfPython();
    const ports = usbSerialPorts();
    if (py && ports.length > 0 && (mode === "sleep" || mode === "idle")) {
      const port = ports[0]!;
      const cmd = mode === "sleep" ? "SLEEP\\n" : "IDLE\\n";
      await new Promise<void>((resolve) => {
        const script = [
          "import serial, time",
          `s = serial.Serial(${JSON.stringify(port)}, ${this.usbBaud}, timeout=0.1)`,
          "s.dtr = False; s.rts = False",
          `s.write(b"${cmd}"); s.flush(); time.sleep(0.05); s.close()`,
        ].join("\n");
        const c = spawn(py, ["-c", script], { stdio: "ignore" });
        c.on("exit", () => resolve());
        setTimeout(() => resolve(), 1500);
      });
      return { ok: true, mode, via: "usb", message: `Sent ${mode.toUpperCase()} over USB (${port})` };
    }

    return {
      ok: mode !== "wake",
      mode,
      via: "lan",
      message: mode === "sleep"
        ? "Sent SLEEP command (paused polling)"
        : "ESP32-CAM unreachable (may already be in deep sleep — use Wake USB)",
    };
  }

  getFlashJob(): CamFlashJob | null {
    return this.flashJob;
  }

  private inspectBinary(filePath: string): CamBinaryArtifactInfo {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 4096) {
        return { exists: false, sizeBytes: 0, modifiedAtMs: 0, sha256Short: "", path: filePath };
      }
      const bytes = fs.readFileSync(filePath);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      return {
        exists: true,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        sha256Short: sha.slice(0, 12),
        path: filePath,
      };
    } catch {
      return { exists: false, sizeBytes: 0, modifiedAtMs: 0, sha256Short: "", path: filePath };
    }
  }

  hasCamFirmwareBinary(): boolean {
    try {
      return fs.statSync(this.camFirmwarePath).size > 65536;
    } catch {
      return false;
    }
  }

  private hasFullFlashArtifacts(): boolean {
    const required = [
      path.join(this.camBuildDir, "bootloader/bootloader.bin"),
      path.join(this.camBuildDir, "partition_table/partition-table.bin"),
      this.camStubPath,
      this.camFirmwarePath,
    ];
    return required.every((f) => {
      try { return fs.statSync(f).isFile(); } catch { return false; }
    });
  }

  async getOtaInfo(probeRemote = true): Promise<CamOtaInfoResponse> {
    const st = await this.getStatus(probeRemote);
    const binary = this.inspectBinary(this.camFirmwarePath);
    const stubBinary = this.inspectBinary(this.camStubPath);
    const isStub = st.powerMode === "ota_stub" || st.system?.runningPartition === "factory";
    return {
      ok: true,
      host: this.host,
      available: st.available,
      ip: st.ip,
      powerMode: st.powerMode,
      runningPartition: st.system?.runningPartition ?? (isStub ? "factory" : null),
      isStub,
      dieTempC: st.dieTempC,
      thermalState: st.thermalState,
      ports: st.usbPorts,
      pythonReady: Boolean(espIdfPython()),
      binary,
      stubBinary,
      fullFlashReady: this.hasFullFlashArtifacts() && Boolean(espIdfPython()),
      job: this.flashJob,
    };
  }

  async startBuild(): Promise<CamFlashJob> {
    if (this.flashJob?.status === "running") {
      throw new Error(`ESP32-CAM job is already running (${this.flashJob.message}).`);
    }
    if (!fs.existsSync(this.camBuildScript)) {
      throw new Error(`ESP32-CAM build script missing: ${this.camBuildScript}`);
    }

    const job: CamFlashJob = {
      id: crypto.randomUUID(),
      kind: "build",
      port: "",
      status: "running",
      phase: "building",
      progress: 8,
      message: "Building balax_cam_fw.bin (ESP-IDF)…",
      error: null,
    };
    this.flashJob = job;

    void (async () => {
      const startMs = Date.now();
      const progressTimer = setInterval(() => {
        if (job.status === "running" && job.progress < 90) {
          job.progress = Math.min(90, job.progress + 4);
        }
      }, 1000);
      try {
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn("bash", [this.camBuildScript], {
            cwd: path.dirname(this.camBuildScript),
            stdio: ["ignore", "pipe", "pipe"],
          });
          let text = "";
          child.stdout.on("data", (d: Buffer) => { text = (text + d.toString("utf8")).slice(-3000); });
          child.stderr.on("data", (d: Buffer) => { text = (text + d.toString("utf8")).slice(-3000); });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve(text.trim());
            else reject(new Error(text.trim().split(/\r?\n/).slice(-8).join("\n") || `build exited ${code}`));
          });
        });
        const bin = this.inspectBinary(this.camFirmwarePath);
        const sec = ((Date.now() - startMs) / 1000).toFixed(1);
        job.status = "done";
        job.phase = "done";
        job.progress = 100;
        job.message = `Built balax_cam_fw.bin (${(bin.sizeBytes / 1024).toFixed(0)} KB · #${bin.sha256Short}) in ${sec}s`;
        job.detail = out;
      } catch (err) {
        job.status = "error";
        job.phase = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.message = `ESP32-CAM build failed: ${job.error.split("\n")[0]}`;
      } finally {
        clearInterval(progressTimer);
      }
    })();

    return job;
  }

  async startUsbFlash(
    requestedPort?: string,
    options: { full?: boolean; customBytes?: Buffer; customName?: string } = {},
  ): Promise<CamFlashJob> {
    if (this.flashJob?.status === "running") {
      throw new Error("ESP32-CAM flash/build job is already running.");
    }
    const py = espIdfPython();
    if (!py) throw new Error("ESP-IDF Python environment not found.");
    const full = Boolean(options.full) && !options.customBytes;
    if (full && !this.hasFullFlashArtifacts()) {
      throw new Error("Full flash artifacts missing (build esp32cam_ota_stub and balax_cam_fw first).");
    }
    if (!full && !options.customBytes && !this.hasCamFirmwareBinary()) {
      throw new Error(`ESP32-CAM firmware binary missing: ${this.camFirmwarePath}`);
    }
    if (options.customBytes) {
      if (options.customBytes.length < 32768 || options.customBytes[0] !== 0xe9) {
        throw new Error("Uploaded file is not a valid ESP32 firmware image (missing 0xE9 magic).");
      }
      if (options.customBytes.length > 0x330000) {
        throw new Error("Uploaded firmware exceeds ESP32-CAM ota_0 partition size (3.19 MB).");
      }
    }
    const ports = usbSerialPorts();
    const port = requestedPort && ports.includes(requestedPort) ? requestedPort : ports[0];
    if (!port) throw new Error("No USB serial port detected for ESP32-CAM.");

    await this.stopStream();
    this.stopUsbChild();
    await new Promise((r) => setTimeout(r, 150));
    this.sleepingPaused = false;

    const job: CamFlashJob = {
      id: crypto.randomUUID(),
      kind: full ? "usb_full" : "usb",
      port,
      status: "running",
      phase: "preflight",
      progress: 0,
      message: `Verifying ESP32-CAM on ${port}…`,
      error: null,
    };
    this.flashJob = job;

    void (async () => {
      let tempFile: string | null = null;
      let otaDataFile: string | null = null;
      try {
        const chipOut = await new Promise<string>((resolve, reject) => {
          const child = spawn(py, [
            "-m", "esptool", "--chip", "esp32", "--port", port, "--baud", "115200",
            "--before", "default-reset", "--after", "no-reset", "flash-id",
          ], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
          child.stderr.on("data", (d: Buffer) => { out += d.toString("utf8"); });
          child.on("error", reject);
          child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(out.trim().split(/\r?\n/).slice(-3).join(" "))));
        });

        if (/ESP32-PICO-D4/i.test(chipOut)) {
          throw new Error("Detected BalaX (ESP32-PICO-D4), not ESP32-CAM! Refusing to flash camera firmware onto robot.");
        }
        if (!/Detected flash size:\s*4MB/i.test(chipOut)) {
          throw new Error("Expected 4 MB flash on ESP32-CAM.");
        }

        let appFile = this.camFirmwarePath;
        let appLabel = "balax_cam_fw.bin";
        if (options.customBytes) {
          tempFile = path.join(this.camBuildDir, `.upload-${Date.now()}.bin`);
          fs.mkdirSync(this.camBuildDir, { recursive: true });
          fs.writeFileSync(tempFile, options.customBytes);
          appFile = tempFile;
          appLabel = options.customName || "custom.bin";
        }

        // Write explicit otadata selecting ota_0 (ota_seq=1) so the ESP32 boots balax_cam_fw
        // directly instead of stalling in the factory OTA rescue stub!
        otaDataFile = path.join(this.camBuildDir, `.otadata-ota0-${Date.now()}.bin`);
        fs.mkdirSync(this.camBuildDir, { recursive: true });
        fs.writeFileSync(otaDataFile, buildOta0SelectData());

        const images = full
          ? [
              { label: "bootloader", offset: 0x1000, file: path.join(this.camBuildDir, "bootloader/bootloader.bin"), size: fs.statSync(path.join(this.camBuildDir, "bootloader/bootloader.bin")).size },
              { label: "partition-table", offset: 0x8000, file: path.join(this.camBuildDir, "partition_table/partition-table.bin"), size: fs.statSync(path.join(this.camBuildDir, "partition_table/partition-table.bin")).size },
              { label: "otadata (ota_0)", offset: 0xf000, file: otaDataFile, size: 0x2000 },
              { label: "factory-stub", offset: 0x20000, file: this.camStubPath, size: fs.statSync(this.camStubPath).size },
              { label: appLabel, offset: 0xb0000, file: appFile, size: fs.statSync(appFile).size },
            ]
          : [
              { label: "otadata (ota_0)", offset: 0xf000, file: otaDataFile, size: 0x2000 },
              { label: appLabel, offset: 0xb0000, file: appFile, size: fs.statSync(appFile).size },
            ];

        job.phase = "flashing";
        job.progress = 5;
        job.message = full
          ? `Full-flashing bootloader + partition table + OTA stub + ${appLabel} on ${port}…`
          : `Flashing ${appLabel} to ota_0 (0xB0000) on ${port}…`;

        const esptoolArgs = [
          "-m", "esptool", "--chip", "esp32", "--port", port, "--baud", "460800",
          "--before", "default-reset", "--after", "hard-reset", "write-flash",
          "--flash-mode", "dio", "--flash-freq", "80m", "--flash-size", "4MB", "--compress",
          ...images.flatMap((img) => [`0x${img.offset.toString(16)}`, img.file]),
        ];

        await new Promise<void>((resolve, reject) => {
          const child = spawn(py, esptoolArgs, { stdio: ["ignore", "pipe", "pipe"] });
          let tail = "";
          const onData = (chunk: Buffer) => {
            try {
              const text = chunk.toString("utf8");
              tail = (tail + text).slice(-1200);
              for (const line of text.split(/[\r\n]+/)) {
                const pct = usbWriteProgress(line, images);
                if (pct !== null && pct > job.progress) {
                  job.progress = Math.min(99, pct);
                  job.message = `${full ? "Full-flashing" : "Writing"} ${appLabel}… ${job.progress}%`;
                }
              }
            } catch { /* ignore */ }
          };
          child.stdout.on("data", onData);
          child.stderr.on("data", onData);
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(tail.trim().split(/\r?\n/).slice(-3).join(" ") || `esptool exited ${code}`));
          });
        });

        job.status = "done";
        job.phase = "done";
        job.progress = 100;
        job.message = full
          ? "ESP32-CAM full-flashed (bootloader + compact partition table + OTA stub + app) — booting Cool Idle"
          : `ESP32-CAM flashed (${appLabel}) cleanly — booting Cool Idle (OV2640 OFF)`;
        this.confirmedUsbPort = port;
        this.remoteStatus = null;
        this.remoteStatusAtMs = 0;
        this.usbBackoffUntilMs = 0;
      } catch (err) {
        job.status = "error";
        job.phase = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.message = `ESP32-CAM flash failed: ${job.error}`;
      } finally {
        if (tempFile) {
          try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        }
        if (otaDataFile) {
          try { fs.unlinkSync(otaDataFile); } catch { /* ignore */ }
        }
      }
    })();

    return job;
  }

  async startWifiOta(options: { customBytes?: Buffer; customName?: string } = {}): Promise<CamFlashJob> {
    if (this.flashJob?.status === "running") {
      throw new Error("ESP32-CAM flash/build job is already running.");
    }
    const rawBytes = options.customBytes ?? (this.hasCamFirmwareBinary() ? fs.readFileSync(this.camFirmwarePath) : null);
    if (!rawBytes || rawBytes.length < 32768 || rawBytes[0] !== 0xe9) {
      throw new Error("Valid ESP32-CAM firmware binary not found (build or upload a .bin first).");
    }
    if (rawBytes.length > 0x330000) {
      throw new Error("Firmware exceeds ESP32-CAM ota_0 partition limit (3.19 MB).");
    }
    const fwName = options.customName || "balax_cam_fw.bin";
    await this.stopStream();
    this.sleepingPaused = false;

    const job: CamFlashJob = {
      id: crypto.randomUUID(),
      kind: "wifi_ota",
      port: this.host,
      status: "running",
      phase: "preflight",
      progress: 4,
      message: `Preparing Wi-Fi OTA for ${fwName} (${(rawBytes.length / 1024).toFixed(0)} KB)…`,
      error: null,
    };
    this.flashJob = job;

    void (async () => {
      try {
        const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
        const compressed = zlib.deflateSync(rawBytes, { level: 6 });
        const ratioPct = Math.round((1 - compressed.length / rawBytes.length) * 100);

        let ip = await this.resolveCamIp(1500);
        if (!ip) {
          throw new Error(`ESP32-CAM (${this.host}) not reachable on Wi-Fi LAN.`);
        }

        let inStub = false;
        try {
          const stRes = await fetch(`http://${ip}/api/status`, { signal: AbortSignal.timeout(2000) });
          if (stRes.ok) {
            const st = (await stRes.json()) as Record<string, unknown>;
            inStub = st.is_stub === true || st.power_mode === "ota_stub";
          }
        } catch { /* ignore */ }

        if (!inStub) {
          job.phase = "rebooting_stub";
          job.progress = 12;
          job.message = "Rebooting ESP32-CAM into factory OTA rescue stub (OV2640 OFF)…";
          const prep = await fetch(`http://${ip}/api/ota/prepare`, {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          });
          if (!prep.ok) {
            throw new Error(`Camera refused /api/ota/prepare (HTTP ${prep.status}). Full-flash the factory OTA stub over USB once first.`);
          }

          const deadline = Date.now() + 28000;
          await new Promise((r) => setTimeout(r, 1500));
          while (Date.now() < deadline) {
            const nextIp: string = (await this.resolveCamIp(800)) ?? ip;
            if (nextIp) {
              try {
                const probe = await fetch(`http://${nextIp}/api/status`, { signal: AbortSignal.timeout(1200) });
                if (probe.ok) {
                  const pj = (await probe.json()) as Record<string, unknown>;
                  if (pj.is_stub === true || pj.power_mode === "ota_stub") {
                    ip = nextIp;
                    inStub = true;
                    break;
                  }
                }
              } catch { /* still rebooting */ }
            }
            job.progress = Math.min(30, job.progress + 2);
            await new Promise((r) => setTimeout(r, 800));
          }
          if (!inStub) {
            throw new Error("Timed out waiting for ESP32-CAM factory OTA stub on Wi-Fi. If stub was never flashed, run Full Flash over USB once.");
          }
        }

        job.phase = "flashing";
        job.progress = 35;
        job.message = `Uploading ${fwName} via zlib OTA (${(compressed.length / 1024).toFixed(0)} KB, −${ratioPct}% wire)…`;

        const chunkSize = 8192;
        let sent = 0;
        const bodyStream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= compressed.length) {
              controller.close();
              return;
            }
            const end = Math.min(compressed.length, sent + chunkSize);
            controller.enqueue(compressed.subarray(sent, end));
            sent = end;
            job.progress = Math.min(92, 35 + Math.round((sent / compressed.length) * 57));
            job.message = `Streaming ${fwName} to ota_0 (zlib + sector-skip)… ${job.progress}%`;
          },
        });

        const otaRes = await fetch(`http://${ip}/api/ota`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-balax-zlib",
            "Content-Length": String(compressed.length),
            "X-Sha256": sha256,
          },
          body: bodyStream,
          // @ts-expect-error Node fetch supports duplex: "half" for streaming request bodies
          duplex: "half",
          signal: AbortSignal.timeout(90000),
        });

        const respText = await otaRes.text();
        if (!otaRes.ok) {
          throw new Error(`OTA stub rejected image (HTTP ${otaRes.status}): ${respText}`);
        }

        let summary = "";
        try {
          const j = JSON.parse(respText) as Record<string, unknown>;
          summary = ` (${j.sectors_erased ?? "?"} erased, ${j.sectors_skipped ?? "?"} skipped)`;
        } catch { /* ignore */ }

        job.phase = "verifying";
        job.progress = 95;
        job.message = `Verified & rebooting ESP32-CAM into ota_0${summary}…`;
        this.remoteStatus = null;
        this.remoteStatusAtMs = 0;

        await new Promise((r) => setTimeout(r, 2000));
        job.status = "done";
        job.phase = "done";
        job.progress = 100;
        job.message = `ESP32-CAM Wi-Fi OTA complete${summary} — booting Cool Idle`;
        job.detail = respText;
      } catch (err) {
        job.status = "error";
        job.phase = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.message = `ESP32-CAM Wi-Fi OTA failed: ${job.error}`;
      }
    })();

    return job;
  }

  async setConfig(cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const revision = this.hostRevision;

    if (this.preference === "usb" || this.activeTransport === "usb_ecl1") {
      const usbRes = await this.sendUsbCommand(`CONFIG ${JSON.stringify(cfg)}`, 1000);
      if (usbRes) return usbRes;
    }

    const ip = await this.resolveCamIp(1000);
    if (ip && revision === this.hostRevision) {
      try {
        const r = await fetch(`http://${ip}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const j = (await r.json()) as Record<string, unknown>;
          if (revision === this.hostRevision) {
            this.remoteStatus = j;
            this.remoteStatusAtMs = Date.now();
          }
          return j;
        }
      } catch { /* fall through to USB */ }
    }

    const usbRes = await this.sendUsbCommand(`CONFIG ${JSON.stringify(cfg)}`, 1000);
    if (usbRes) return usbRes;

    throw new Error("ESP32-CAM not reachable on Wi-Fi LAN or USB serial");
  }

  async getStatus(probeRemote = true): Promise<CamBridgeStatus> {
    const now = Date.now();
    const ports = this.candidateUsbPorts();
    const usbPort = this.usbPortInUse ?? ports[0] ?? null;

    if (probeRemote && !this.sleepingPaused && this.flashJob?.status !== "running" && now - this.remoteStatusAtMs > 1500) {
      const revision = this.hostRevision;
      const ip = this.preference === "usb" ? null : await this.resolveCamIp(700);
      const canProbe = revision === this.hostRevision && !this.sleepingPaused;
      let probed = false;
      if (canProbe && ip && !this.httpAbort) {
        try {
          const r = await fetch(`http://${ip}/api/status`, { signal: AbortSignal.timeout(900) });
          if (r.ok) {
            const status = (await r.json()) as Record<string, unknown>;
            if (revision === this.hostRevision && !this.sleepingPaused) {
              this.remoteStatus = status;
              this.remoteStatusAtMs = Date.now();
              probed = true;
            }
          }
        } catch { /* unreachable */ }
      } else if (canProbe && (ip || (this.preference !== "usb" && this.host === "balax-cam.local"))) {
        try {
          const sock = this.ensureUdpSocket();
          this.udpStatusProbe = { ip, atMs: Date.now() };
          sock.send(Buffer.from(ip ? "STATUS" : "WHO"), this.camPort, ip ?? "255.255.255.255");
        } catch { /* ignore */ }
      }

      const stillCurrent = revision === this.hostRevision && !this.sleepingPaused;
      if (probed && this.preference !== "usb" && this.usbChild && !this.wantStream) {
        // Wi-Fi is reachable — release USB port unless user explicitly selected USB transport.
        this.stopUsbChild();
      } else if (!probed && stillCurrent && usbPort) {
        if (this.usbChild) {
          // If auto-probed port sent no camera frames after 4.5s, release it (might be BalaX or another serial device).
          if (this.preference !== "usb" && !this.usbReceivedAny && now - this.usbSessionStartedAtMs > 4500) {
            this.stopUsbChild();
            this.usbBackoffUntilMs = now + 15_000;
          }
        } else if (now >= this.usbBackoffUntilMs) {
          this.ensureUsbSession(this.wantStream);
        }
      }
    }

    const r = this.remoteStatus;
    const remoteFresh = r !== null && now - this.remoteStatusAtMs < 6000;
    const lastFrameAgeMs = this.latestFrame ? now - this.latestFrame.receivedAtMs : null;
    const streamFresh = lastFrameAgeMs !== null && lastFrameAgeMs < 3500;
    const available = remoteFresh || streamFresh;

    const powerModeRaw = this.sleepingPaused
      ? "sleep"
      : remoteFresh && typeof r.power_mode === "string"
        ? r.power_mode
        : streamFresh
          ? "streaming"
          : "unknown";
    const powerMode =
      powerModeRaw === "idle" || powerModeRaw === "streaming" || powerModeRaw === "sleep" ||
      powerModeRaw === "cooldown" || powerModeRaw === "ota_stub"
        ? powerModeRaw
        : "unknown";
    const deviceMetrics = remoteFresh && powerMode !== "sleep" ? r : null;

    const resRaw = remoteFresh && typeof r.resolution === "string" ? r.resolution : "qvga";
    const resolution: CamResolutionId =
      resRaw === "qvga" || resRaw === "vga16" || resRaw === "vga" || resRaw === "svga16" || resRaw === "svga"
        ? resRaw
        : "qvga";
    const stabRaw = remoteFresh && typeof r.stab_mode === "string" ? r.stab_mode : "hybrid";
    const stabMode: CamStabMode =
      stabRaw === "hybrid" || stabRaw === "camera_crop" || stabRaw === "receiver_warp" || stabRaw === "none"
        ? stabRaw
        : stabRaw === "ov2640_crop_experimental"
          ? "camera_crop"
          : "hybrid";
    const wifiPsRaw = remoteFresh && typeof r.wifi_ps === "string" ? r.wifi_ps : "none";
    const wifiPs: CamWifiPs = wifiPsRaw === "min" || wifiPsRaw === "max" ? wifiPsRaw : "none";
    const thermRaw = remoteFresh && typeof r.thermal_state === "string" ? r.thermal_state : "ok";
    const thermalState: CamThermalState = thermRaw === "throttled" || thermRaw === "cooldown" ? thermRaw : "ok";

    return {
      available,
      optional: true,
      host: this.host,
      ip: this.resolvedIp ?? (remoteFresh && typeof r.ip === "string" && r.ip ? r.ip : null),
      streaming: this.wantStream,
      transportPreference: this.preference,
      activeTransport: streamFresh ? this.activeTransport : "none",
      powerMode,
      cameraOn: remoteFresh ? Boolean(r.camera_on) : streamFresh,
      cpuMhz: typeof deviceMetrics?.cpu_mhz === "number" ? deviceMetrics.cpu_mhz : null,
      streamCpuMhz: typeof deviceMetrics?.stream_cpu_mhz === "number" ? deviceMetrics.stream_cpu_mhz : null,
      cpuDfs: remoteFresh && typeof r.cpu_dfs === "boolean" ? r.cpu_dfs : true,
      idleCpuMhz: remoteFresh && typeof r.idle_cpu_mhz === "number" ? r.idle_cpu_mhz : 40,
      wifiPs,
      wifiTxDbm: remoteFresh && typeof r.wifi_tx_dbm === "number" ? r.wifi_tx_dbm : 13,
      resolution,
      xclkMhz: remoteFresh && typeof r.xclk_mhz === "number" ? r.xclk_mhz : 12,
      pll2x: remoteFresh && typeof r.pll_2x === "boolean" ? r.pll_2x : true,
      system: readCamSystemStatus(deviceMetrics?.system),
      fps: streamFresh ? this.measuredFps : remoteFresh && typeof r.fps_actual === "number" ? r.fps_actual : 0,
      fpsTarget: remoteFresh && typeof r.fps_target === "number" ? r.fps_target : null,
      kbps: streamFresh ? this.measuredKbps : remoteFresh && typeof r.kbps === "number" ? r.kbps : 0,
      rawKbps: remoteFresh && typeof r.raw_kbps === "number" ? r.raw_kbps : 0,
      savingsPct: remoteFresh && typeof r.savings_pct === "number" ? r.savings_pct : 0,
      quality: remoteFresh && typeof r.quality === "number" ? r.quality : null,
      effectiveQuality: remoteFresh && typeof r.effective_quality === "number" ? r.effective_quality : null,
      autoQuality: remoteFresh && typeof r.auto_quality === "boolean" ? r.auto_quality : true,
      codecMode: this.latestFrame && streamFresh
        ? this.latestFrame.codecModeName
        : remoteFresh && typeof r.codec === "string"
          ? r.codec.toUpperCase()
          : "DCT_SPARSE_BLOCK",
      codecSetting: remoteFresh && r.codec === "passthrough" ? "passthrough" : "dct",
      sparseThreshold: remoteFresh && typeof r.sparse_threshold === "number" ? r.sparse_threshold : 2,
      changedBlocks: remoteFresh && typeof r.changed_blocks === "number" ? r.changed_blocks : 0,
      totalBlocks: remoteFresh && typeof r.total_blocks === "number" ? r.total_blocks : 0,
      vflip: remoteFresh && typeof r.vflip === "boolean" ? r.vflip : true,
      hmirror: remoteFresh && typeof r.hmirror === "boolean" ? r.hmirror : true,
      stabMode,
      cropAlignPx: remoteFresh && typeof r.crop_align_px === "number" ? r.crop_align_px : 4,
      maxSlewPx: remoteFresh && typeof r.max_slew_px === "number" ? r.max_slew_px : 24,
      vfovDeg: remoteFresh && typeof r.vfov_deg === "number" ? r.vfov_deg : 52,
      cropY: remoteFresh && typeof r.crop_y === "number" ? r.crop_y : 0,
      dieTempC: typeof deviceMetrics?.die_temp_c === "number" ? deviceMetrics.die_temp_c : null,
      thermalState,
      thermalLimitC: remoteFresh && typeof r.thermal_limit_c === "number" ? r.thermal_limit_c : 75,
      txDrops: remoteFresh && typeof r.tx_drops === "number" ? r.tx_drops : 0,
      frameSkipEnabled: remoteFresh ? Boolean(r.frame_skip) : true,
      frameId: this.latestFrame?.frameId ?? (remoteFresh && typeof r.frame === "number" ? r.frame : 0),
      skippedFrames: this.totalSkipped || (remoteFresh && typeof r.skipped_frames === "number" ? r.skipped_frames : 0),
      width: this.latestFrame?.width ?? (remoteFresh && typeof r.width === "number" ? r.width : 320),
      height: this.latestFrame?.height ?? (remoteFresh && typeof r.height === "number" ? r.height : 240),
      hasAttitude: this.latestFrame?.hasAttitude ?? false,
      pitchCdeg: streamFresh && this.latestFrame?.hasAttitude
        ? this.latestFrame.pitchCdeg
        : remoteFresh && typeof r.pitch_cdeg === "number"
          ? r.pitch_cdeg
          : 0,
      rollCdeg: streamFresh && this.latestFrame?.hasAttitude
        ? this.latestFrame.rollCdeg
        : remoteFresh && typeof r.roll_cdeg === "number"
          ? r.roll_cdeg
          : 0,
      telemSource: remoteFresh && typeof r.telem_source === "string" ? r.telem_source : "none",
      rssi: remoteFresh && typeof r.rssi === "number" ? r.rssi : null,
      freePsram: typeof deviceMetrics?.free_psram === "number" ? deviceMetrics.free_psram : null,
      freeDram: typeof deviceMetrics?.free_dram === "number" ? deviceMetrics.free_dram : null,
      idleS: remoteFresh && typeof r.idle_s === "number" ? r.idle_s : null,
      deepSleepTimeoutS: remoteFresh && typeof r.deep_sleep_timeout_s === "number" ? r.deep_sleep_timeout_s : null,
      usbPort,
      usbPorts: ports,
      usbBaud:
        this.usbPortInUse != null || this.activeTransport === "usb_ecl1" || this.preference === "usb"
          ? this.usbBaud
          : null,
      badPackets: this.depacketizer.badPackets,
      droppedIncomplete: this.depacketizer.droppedIncomplete,
      lastFrameAgeMs,
      flashJob: this.flashJob,
      flashReady: this.hasCamFirmwareBinary() && Boolean(espIdfPython()) && ports.length > 0,
      message: this.sleepingPaused
        ? "ESP32-CAM in deep sleep (polling paused — click Wake USB or Reset to wake)"
        : available
          ? undefined
          : "ESP32-CAM not connected (optional — Browser Cache works offline)",
    };
  }

  close(): void {
    this.wantStream = false;
    this.stopWorkersOnly();
    for (const c of this.mjpegClients) {
      try { c.end(); } catch { /* ignore */ }
    }
    this.mjpegClients.clear();
    for (const c of this.binaryPushClients) {
      try { c.end(); } catch { /* ignore */ }
    }
    this.binaryPushClients.clear();
    if (this.udpSock) {
      try { this.udpSock.close(); } catch { /* ignore */ }
      this.udpSock = null;
    }
    if (this.wasmDecoder) {
      this.wasmDecoder.destroy();
      this.wasmDecoder = null;
    }
  }
}
