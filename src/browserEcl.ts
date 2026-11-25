import type { WasmTemporalDecoder } from "../eclDecoder.ts";
import {
  CAM_USB_BAUD,
  type CamActiveTransport,
  type CamBridgeStatus,
  type CamResolutionId,
  type CamStabMode,
  type CamSystemStatus,
  type CamThermalState,
  type CamTransportPreference,
  type CamWifiPs,
} from "./cameraProtocol.ts";

export const ECL1_MAGIC = 0x4c43; // 'C', 'L' little-endian
export const ECL1_VERSION = 1;
export const ECL1_HEADER_BYTES = 32;
export const ECL1_TRAILER_BYTES = 4;
export const ECL1_OVERHEAD_BYTES = ECL1_HEADER_BYTES + ECL1_TRAILER_BYTES;
export const ECL1_MAX_CHUNKS = 512;

export const ECL1_FLAG_KEYFRAME = 1 << 0;
export const ECL1_FLAG_HAS_META_ATTITUDE = 1 << 2;

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

export interface BrowserEcl1Header {
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

export interface BrowserAssembledFrame {
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
  jpeg: Uint8Array;
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

/**
 * Pure-browser 8 KB ESP-IDF `otadata` partition image selecting `ota_0` (`ota_seq = 1`).
 * Matches ESP-IDF `esp_rom_crc32_le(UINT32_MAX, &seq, 4)` (CRC32 = 0x4743989a).
 */
export function buildOta0SelectDataBrowser(): Uint8Array {
  const buf = new Uint8Array(0x2000);
  buf.fill(0xff);
  const view = new DataView(buf.buffer);
  const seq = new Uint8Array([1, 0, 0, 0]);
  // ESP-IDF otadata CRC uses crc32_le with initial value 0xFFFFFFFF and no final XOR (~0 -> init 0 before IEEE pre-invert)
  let crc = 0x00000000;
  for (let i = 0; i < seq.length; i++) {
    crc ^= seq[i]!;
    crc = (crc >>> 4) ^ CRC32_NIBBLE_TABLE[crc & 0x0f]!;
    crc = (crc >>> 4) ^ CRC32_NIBBLE_TABLE[crc & 0x0f]!;
  }
  const espCrc = (crc ^ 0xffffffff) >>> 0;
  view.setUint32(0, 1, true);
  view.setUint32(28, espCrc, true);
  return buf;
}

export function codecModeName(mode: number): Ecl1CodecModeName {
  return CODEC_MODE_NAMES[mode] ?? "UNKNOWN";
}

function frameIdNewer(a: number, b: number): boolean {
  return ((a - b) | 0) > 0;
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function parseBrowserEcl1Packet(wire: Uint8Array): {
  header: BrowserEcl1Header;
  payload: Uint8Array;
} | null {
  if (wire.byteLength < ECL1_OVERHEAD_BYTES) return null;
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const magic = view.getUint16(0, true);
  const version = view.getUint8(2);
  if (magic !== ECL1_MAGIC || version !== ECL1_VERSION) return null;
  const payloadLen = view.getUint16(10, true);
  const expected = ECL1_HEADER_BYTES + payloadLen + ECL1_TRAILER_BYTES;
  if (wire.byteLength < expected) return null;
  const expectedCrc = view.getUint32(ECL1_HEADER_BYTES + payloadLen, true);
  const actualCrc = crc32Ieee(wire, ECL1_HEADER_BYTES + payloadLen);
  if (actualCrc !== expectedCrc) return null;

  const chunkCount = view.getUint16(8, true);
  const chunkId = view.getUint16(6, true);
  if (chunkCount === 0 || chunkCount > ECL1_MAX_CHUNKS || chunkId >= chunkCount) return null;

  const header: BrowserEcl1Header = {
    magic,
    version,
    flags: view.getUint8(3),
    streamId: view.getUint8(4),
    codecMode: view.getUint8(5),
    chunkId,
    chunkCount,
    payloadLen,
    frameId: view.getUint32(12, true),
    referenceFrameId: view.getUint32(16, true),
    timestampUsLow: view.getUint32(20, true),
    width: view.getUint16(24, true),
    height: view.getUint16(26, true),
    metaPitchCdeg: view.getInt16(28, true),
    metaRollCdeg: view.getInt16(30, true),
  };
  return {
    header,
    payload: wire.subarray(ECL1_HEADER_BYTES, ECL1_HEADER_BYTES + payloadLen),
  };
}

interface PendingFrameSlot {
  frameId: number;
  createdAtMs: number;
  chunks: (Uint8Array | null)[];
  receivedCount: number;
  wireBytes: number;
}

export class BrowserEcl1Depacketizer {
  private slots = new Map<number, PendingFrameSlot>();
  private lastDeliveredId = 0;
  private lastJpeg: Uint8Array | null = null;
  private wasmDecoder: WasmTemporalDecoder | null = null;
  public badPackets = 0;
  public droppedIncomplete = 0;
  public decodeErrors = 0;

  setWasmDecoder(decoder: WasmTemporalDecoder | null): void {
    this.wasmDecoder = decoder;
  }

  reset(): void {
    this.slots.clear();
    this.lastDeliveredId = 0;
    this.lastJpeg = null;
    this.wasmDecoder?.reset();
  }

  feedPacket(wire: Uint8Array, nowMs = Date.now()): BrowserAssembledFrame | null {
    const parsed = parseBrowserEcl1Packet(wire);
    if (!parsed) {
      this.badPackets++;
      return null;
    }
    const { header, payload } = parsed;

    if (this.lastDeliveredId !== 0 && !frameIdNewer(header.frameId, this.lastDeliveredId)) {
      return null;
    }

    // FRAME_SKIP (codecMode == 1): reuse last JPEG with fresh attitude metadata
    if (header.codecMode === 1) {
      this.lastDeliveredId = header.frameId;
      this.pruneOldSlots(header.frameId);
      if (!this.lastJpeg) return null;
      return {
        frameId: header.frameId,
        referenceFrameId: header.referenceFrameId,
        timestampUsLow: header.timestampUsLow,
        receivedAtMs: nowMs,
        codecMode: header.codecMode,
        codecModeName: codecModeName(header.codecMode),
        isKeyframe: false,
        isSkipped: true,
        hasAttitude: (header.flags & ECL1_FLAG_HAS_META_ATTITUDE) !== 0,
        width: header.width,
        height: header.height,
        pitchCdeg: header.metaPitchCdeg,
        rollCdeg: header.metaRollCdeg,
        jpeg: this.lastJpeg,
        wireBytes: wire.byteLength,
      };
    }

    let slot = this.slots.get(header.frameId);
    if (!slot) {
      if (this.slots.size >= 4) {
        let oldestId: number | null = null;
        let oldestTs = Infinity;
        for (const [id, s] of this.slots) {
          if (s.createdAtMs < oldestTs) {
            oldestTs = s.createdAtMs;
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
        createdAtMs: nowMs,
        chunks: new Array<Uint8Array | null>(header.chunkCount).fill(null),
        receivedCount: 0,
        wireBytes: 0,
      };
      this.slots.set(header.frameId, slot);
    }

    if (slot.chunks.length !== header.chunkCount) {
      this.badPackets++;
      return null;
    }
    if (slot.chunks[header.chunkId] === null) {
      slot.chunks[header.chunkId] = payload.slice();
      slot.receivedCount++;
      slot.wireBytes += wire.byteLength;
    }

    if (slot.receivedCount < slot.chunks.length) {
      return null;
    }

    const joined = concatUint8(slot.chunks as Uint8Array[]);
    this.slots.delete(header.frameId);
    this.lastDeliveredId = header.frameId;
    this.pruneOldSlots(header.frameId);

    const isKeyframe = (header.flags & ECL1_FLAG_KEYFRAME) !== 0;
    let outputJpeg: Uint8Array;

    if (header.codecMode === 0) {
      if (joined.byteLength < 2 || joined[0] !== 0xff || joined[1] !== 0xd8) {
        this.badPackets++;
        return null;
      }
      outputJpeg = joined;
      this.lastJpeg = outputJpeg;
    } else if (this.wasmDecoder) {
      const decoded = this.wasmDecoder.decodeBytes(
        header.codecMode,
        header.frameId,
        header.referenceFrameId,
        isKeyframe,
        header.width,
        header.height,
        joined,
      );
      if (!decoded || decoded.byteLength < 2 || decoded[0] !== 0xff || decoded[1] !== 0xd8) {
        this.decodeErrors++;
        return null;
      }
      outputJpeg = decoded;
      this.lastJpeg = outputJpeg;
    } else if (isKeyframe && joined.byteLength >= 2 && joined[0] === 0xff && joined[1] === 0xd8) {
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

/**
 * Pure-browser framed serial extractor for:
 *   [0xEB, 0x90, len_lo, len_hi, <ECL1 video packet>]
 *   [0xEB, 0x91, len_lo, len_hi, <UTF-8 status JSON>]
 */
export class BrowserSerialEcl1Framer {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder("utf-8");

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  pushFrames(chunk: Uint8Array): {
    packets: Uint8Array[];
    statuses: Record<string, unknown>[];
  } {
    if (this.buf.byteLength > 0) {
      const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.byteLength);
      this.buf = merged;
    } else {
      this.buf = chunk.slice();
    }

    const packets: Uint8Array[] = [];
    const statuses: Record<string, unknown>[] = [];
    let offset = 0;

    while (offset + 4 <= this.buf.byteLength) {
      if (this.buf[offset] !== 0xeb) {
        offset++;
        continue;
      }
      const kind = this.buf[offset + 1];
      if (kind !== 0x90 && kind !== 0x91) {
        offset++;
        continue;
      }
      const pktLen = this.buf[offset + 2]! | (this.buf[offset + 3]! << 8);
      if (kind === 0x90 && (pktLen < ECL1_OVERHEAD_BYTES || pktLen > 2048)) {
        offset += 2;
        continue;
      }
      if (kind === 0x91 && (pktLen < 2 || pktLen > 4096)) {
        offset += 2;
        continue;
      }
      if (offset + 4 + pktLen > this.buf.byteLength) {
        break;
      }
      const payload = this.buf.subarray(offset + 4, offset + 4 + pktLen);
      if (kind === 0x90) {
        packets.push(payload.slice());
      } else {
        try {
          const parsed = JSON.parse(this.decoder.decode(payload)) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") statuses.push(parsed);
        } catch {
          // ignore malformed status JSON
        }
      }
      offset += 4 + pktLen;
    }

    if (offset > 0) {
      this.buf = this.buf.slice(offset);
    }
    if (this.buf.byteLength > 16384) {
      this.buf = this.buf.slice(this.buf.byteLength - 4096);
    }
    return { packets, statuses };
  }
}

export function buildCamStatusFromRawJson(params: {
  raw: Record<string, unknown> | null;
  rawAgeMs: number | null;
  host: string;
  portLabel: string | null;
  streaming: boolean;
  sleepingPaused: boolean;
  activeTransport: CamActiveTransport;
  transportPreference: CamTransportPreference;
  measuredFps: number;
  measuredKbps: number;
  latestFrame: BrowserAssembledFrame | null;
  badPackets: number;
  droppedIncomplete: number;
}): CamBridgeStatus {
  const {
    raw: r,
    rawAgeMs,
    host,
    portLabel,
    streaming,
    sleepingPaused,
    activeTransport,
    transportPreference,
    measuredFps,
    measuredKbps,
    latestFrame,
    badPackets,
    droppedIncomplete,
  } = params;
  const now = Date.now();
  const remoteFresh = r !== null && rawAgeMs !== null && rawAgeMs < 7500;
  const lastFrameAgeMs = latestFrame ? now - latestFrame.receivedAtMs : null;
  const streamFresh = lastFrameAgeMs !== null && lastFrameAgeMs < 3500;
  const available = remoteFresh || streamFresh;

  const pmRaw = sleepingPaused
    ? "sleep"
    : remoteFresh && typeof r?.power_mode === "string"
      ? r.power_mode
      : streamFresh
        ? "streaming"
        : "unknown";
  const powerMode =
    pmRaw === "streaming" || pmRaw === "idle" || pmRaw === "sleep" || pmRaw === "cooldown" || pmRaw === "ota_stub"
      ? pmRaw
      : "unknown";

  const num = (k: string): number | null => (remoteFresh && typeof r?.[k] === "number" ? (r[k] as number) : null);
  const str = (k: string): string | null => (remoteFresh && typeof r?.[k] === "string" ? (r[k] as string) : null);
  const bool = (k: string, fb: boolean): boolean => (remoteFresh && typeof r?.[k] === "boolean" ? (r[k] as boolean) : fb);

  const stabRaw = str("stab_mode");
  const stabMode: CamStabMode =
    stabRaw === "hybrid" || stabRaw === "camera_crop" || stabRaw === "receiver_warp" || stabRaw === "none"
      ? stabRaw
      : "hybrid";
  const resRaw = str("resolution");
  const resolution: CamResolutionId =
    resRaw === "qvga" || resRaw === "vga16" || resRaw === "vga" || resRaw === "svga16" || resRaw === "svga"
      ? resRaw
      : "qvga";
  const psRaw = str("wifi_ps");
  const wifiPs: CamWifiPs = psRaw === "none" || psRaw === "min" || psRaw === "max" ? psRaw : "none";
  const thRaw = str("thermal_state");
  const thermalState: CamThermalState =
    thRaw === "cooldown" || thRaw === "throttled" ? thRaw : "ok";

  const freeDram = num("free_dram");
  const freePsram = num("free_psram");
  const sysRaw = remoteFresh && r?.system && typeof r.system === "object" && !Array.isArray(r.system)
    ? (r.system as Record<string, unknown>)
    : null;
  const pct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  const byt = (v: unknown, min = 0) => typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : null;
  const system: CamSystemStatus | null = sysRaw
    ? {
        cpu0LoadPct: pct(sysRaw.cpu0_load_pct),
        cpu1LoadPct: pct(sysRaw.cpu1_load_pct),
        dramTotalBytes: byt(sysRaw.dram_total_bytes, 1),
        dramMinFreeBytes: byt(sysRaw.dram_min_free_bytes),
        psramTotalBytes: byt(sysRaw.psram_total_bytes, 1),
        psramMinFreeBytes: byt(sysRaw.psram_min_free_bytes),
        flashTotalBytes: byt(sysRaw.flash_total_bytes, 1),
        runningPartition:
          typeof sysRaw.running_partition === "string" && sysRaw.running_partition
            ? sysRaw.running_partition
            : null,
        runningPartitionBytes: byt(sysRaw.running_partition_bytes, 1),
      }
    : null;

  return {
    available,
    optional: true,
    host,
    ip: str("wifi_ip"),
    streaming,
    transportPreference,
    activeTransport: streamFresh ? activeTransport : "none",
    powerMode,
    cameraOn: bool("camera_on", streamFresh),
    cpuMhz: num("cpu_mhz"),
    streamCpuMhz: num("stream_cpu_mhz"),
    cpuDfs: bool("cpu_dfs", true),
    idleCpuMhz: num("idle_cpu_mhz") ?? 40,
    wifiPs,
    wifiTxDbm: num("wifi_tx_dbm") ?? 13,
    resolution,
    xclkMhz: num("xclk_mhz") ?? 12,
    pll2x: bool("pll_2x", true),
    system,
    fps: streamFresh ? measuredFps : (num("fps") ?? 0),
    fpsTarget: num("fps_target"),
    kbps: streamFresh ? measuredKbps : (num("kbps") ?? 0),
    rawKbps: num("raw_kbps") ?? 0,
    savingsPct: num("savings_pct") ?? 0,
    quality: num("quality"),
    effectiveQuality: num("effective_quality"),
    autoQuality: bool("auto_quality", true),
    codecMode: latestFrame?.codecModeName ?? str("codec_mode") ?? "DCT_SPARSE_BLOCK",
    codecSetting: str("codec") === "passthrough" || str("codec") === "raw" ? "passthrough" : "dct",
    sparseThreshold: num("sparse_threshold") ?? 2,
    changedBlocks: num("changed_blocks") ?? 0,
    totalBlocks: num("total_blocks") ?? 0,
    vflip: bool("vflip", true),
    hmirror: bool("hmirror", true),
    stabMode,
    cropAlignPx: num("crop_align_px") ?? 4,
    maxSlewPx: num("max_slew_px") ?? 24,
    vfovDeg: num("vfov_deg") ?? 52,
    cropY: num("crop_y") ?? 0,
    dieTempC: num("die_temp_c"),
    thermalState,
    thermalLimitC: num("thermal_limit_c") ?? 75,
    txDrops: num("tx_drops") ?? 0,
    frameSkipEnabled: bool("frame_skip", true),
    frameId: latestFrame?.frameId ?? (num("frame_id") ?? 0),
    skippedFrames: num("skipped_frames") ?? 0,
    width: latestFrame?.width ?? (num("width") ?? 320),
    height: latestFrame?.height ?? (num("height") ?? 240),
    hasAttitude: latestFrame?.hasAttitude ?? false,
    pitchCdeg: latestFrame?.pitchCdeg ?? (num("pitch_cdeg") ?? 0),
    rollCdeg: latestFrame?.rollCdeg ?? (num("roll_cdeg") ?? 0),
    telemSource: str("telem_source") ?? "none",
    rssi: num("rssi"),
    freePsram,
    freeDram,
    idleS: num("idle_s"),
    deepSleepTimeoutS: num("deep_sleep_timeout_s"),
    usbPort: portLabel,
    usbPorts: portLabel ? [portLabel] : [],
    usbBaud: portLabel ? CAM_USB_BAUD : null,
    badPackets,
    droppedIncomplete,
    lastFrameAgeMs,
    flashJob: null,
    flashReady: Boolean(portLabel),
    message:
      powerMode === "sleep"
        ? "ESP32-FPV in deep sleep (~10 µA) — use Wake (USB RTS→EN)"
        : available
          ? `Connected directly via Web Serial (${portLabel ?? "USB"})`
          : portLabel
            ? `Web Serial open (${portLabel}) — waiting for camera status…`
            : "Connect ESP32-FPV via Web Serial USB",
  };
}
