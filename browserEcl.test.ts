import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOta0SelectData } from "./camBridge.ts";
import { WasmTemporalDecoder } from "./eclDecoder.ts";
import {
  BrowserEcl1Depacketizer,
  BrowserSerialEcl1Framer,
  ECL1_FLAG_HAS_META_ATTITUDE,
  ECL1_FLAG_KEYFRAME,
  ECL1_HEADER_BYTES,
  ECL1_MAGIC,
  ECL1_VERSION,
  buildCamStatusFromRawJson,
  buildOta0SelectDataBrowser,
  crc32Ieee,
} from "./src/browserEcl.ts";
import { detectRuntimeMode, getRuntimeMode, setRuntimeMode } from "./src/runtimeMode.ts";

function makeEcl1Packet(opts: {
  frameId: number;
  refFrameId?: number;
  chunkIdx?: number;
  chunkCount?: number;
  codecMode?: number;
  flags?: number;
  width?: number;
  height?: number;
  pitchCdeg?: number;
  rollCdeg?: number;
  payload: Uint8Array;
}): Uint8Array {
  const wire = new Uint8Array(ECL1_HEADER_BYTES + opts.payload.byteLength + 4);
  const dv = new DataView(wire.buffer);
  dv.setUint16(0, ECL1_MAGIC, true);
  dv.setUint8(2, ECL1_VERSION);
  dv.setUint8(3, opts.flags ?? ECL1_FLAG_KEYFRAME);
  dv.setUint8(4, 0);
  dv.setUint8(5, opts.codecMode ?? 0);
  dv.setUint16(6, opts.chunkIdx ?? 0, true);
  dv.setUint16(8, opts.chunkCount ?? 1, true);
  dv.setUint16(10, opts.payload.byteLength, true);
  dv.setUint32(12, opts.frameId, true);
  dv.setUint32(16, opts.refFrameId ?? opts.frameId, true);
  dv.setUint32(20, 123456, true);
  dv.setUint16(24, opts.width ?? 320, true);
  dv.setUint16(26, opts.height ?? 240, true);
  dv.setInt16(28, opts.pitchCdeg ?? 0, true);
  dv.setInt16(30, opts.rollCdeg ?? 0, true);
  wire.set(opts.payload, ECL1_HEADER_BYTES);
  const crc = crc32Ieee(wire, ECL1_HEADER_BYTES + opts.payload.byteLength);
  dv.setUint32(ECL1_HEADER_BYTES + opts.payload.byteLength, crc, true);
  return wire;
}

function wrapSerialFrame(kind: 0x90 | 0x91, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  out[0] = 0xeb;
  out[1] = kind;
  out[2] = payload.byteLength & 0xff;
  out[3] = (payload.byteLength >> 8) & 0xff;
  out.set(payload, 4);
  return out;
}

describe("browserEcl (serverless GitHub Pages ECL1 + OTA helpers)", () => {
  it("buildOta0SelectDataBrowser matches Node buildOta0SelectData byte-for-byte", () => {
    const browserData = buildOta0SelectDataBrowser();
    const nodeData = buildOta0SelectData();
    assert.equal(browserData.byteLength, 8192);
    assert.deepEqual(Array.from(browserData), Array.from(nodeData));
    const dv = new DataView(browserData.buffer);
    assert.equal(dv.getUint32(0, true), 1);
    assert.equal(dv.getUint32(28, true), 0x4743989a);
  });

  it("BrowserSerialEcl1Framer parses fragmented 0xEB 0x90 packets and 0xEB 0x91 JSON statuses", () => {
    const framer = new BrowserSerialEcl1Framer();
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
    const pkt = makeEcl1Packet({ frameId: 7, payload: fakeJpeg });
    const statusJson = new TextEncoder().encode(JSON.stringify({ power_mode: "idle", die_temp_c: 42.5, cpu_mhz: 40 }));

    const noise = new TextEncoder().encode("I (100) boot: ready\r\n");
    const frame1 = wrapSerialFrame(0x90, pkt);
    const frame2 = wrapSerialFrame(0x91, statusJson);
    const combined = new Uint8Array(noise.byteLength + frame1.byteLength + frame2.byteLength);
    combined.set(noise, 0);
    combined.set(frame1, noise.byteLength);
    combined.set(frame2, noise.byteLength + frame1.byteLength);

    const gotPackets: Uint8Array[] = [];
    const gotStatuses: Record<string, unknown>[] = [];
    // Feed 5 bytes at a time to stress chunk boundaries
    for (let i = 0; i < combined.byteLength; i += 5) {
      const res = framer.pushFrames(combined.subarray(i, Math.min(i + 5, combined.byteLength)));
      gotPackets.push(...res.packets);
      gotStatuses.push(...res.statuses);
    }

    assert.equal(gotPackets.length, 1);
    assert.deepEqual(Array.from(gotPackets[0]!), Array.from(pkt));
    assert.equal(gotStatuses.length, 1);
    assert.equal(gotStatuses[0]!.power_mode, "idle");
    assert.equal(gotStatuses[0]!.die_temp_c, 42.5);
  });

  it("BrowserEcl1Depacketizer reassembles multi-chunk PASS_THROUGH and handles FRAME_SKIP", () => {
    const dep = new BrowserEcl1Depacketizer();
    const partA = new Uint8Array([0xff, 0xd8, 0x11, 0x22]);
    const partB = new Uint8Array([0x33, 0x44, 0xff, 0xd9]);
    const p0 = makeEcl1Packet({ frameId: 10, chunkIdx: 0, chunkCount: 2, payload: partA });
    const p1 = makeEcl1Packet({ frameId: 10, chunkIdx: 1, chunkCount: 2, payload: partB });

    assert.equal(dep.feedPacket(p0, 1000), null);
    const assembled = dep.feedPacket(p1, 1005);
    assert.ok(assembled);
    assert.equal(assembled.frameId, 10);
    assert.equal(assembled.isSkipped, false);
    assert.deepEqual(Array.from(assembled.jpeg), [0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9]);

    // FRAME_SKIP reuses last JPEG with updated attitude
    const skipPkt = makeEcl1Packet({
      frameId: 11,
      refFrameId: 10,
      codecMode: 1,
      flags: ECL1_FLAG_HAS_META_ATTITUDE,
      pitchCdeg: -150,
      rollCdeg: 45,
      payload: new Uint8Array(0),
    });
    const skipped = dep.feedPacket(skipPkt, 1040);
    assert.ok(skipped);
    assert.equal(skipped.frameId, 11);
    assert.equal(skipped.isSkipped, true);
    assert.equal(skipped.pitchCdeg, -150);
    assert.equal(skipped.rollCdeg, 45);
    assert.deepEqual(Array.from(skipped.jpeg), Array.from(assembled.jpeg));
  });

  it("WasmTemporalDecoder.decodeBytes initializes and returns Uint8Array cleanly", async () => {
    const dec = await WasmTemporalDecoder.create();
    try {
      // Keyframe payload passes through as Uint8Array; invalid non-keyframe delta returns null safely
      const kf = dec.decodeBytes(5, 1, 1, true, 320, 240, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      assert.ok(kf instanceof Uint8Array);
      assert.deepEqual(Array.from(kf), [0xff, 0xd8, 0xff, 0xd9]);
      const badDelta = dec.decodeBytes(5, 2, 1, false, 320, 240, new Uint8Array(4));
      assert.equal(badDelta, null);
    } finally {
      dec.destroy();
    }
  });

  it("buildCamStatusFromRawJson maps ESP32-FPV JSON status into CamBridgeStatus", () => {
    const st = buildCamStatusFromRawJson({
      raw: {
        power_mode: "idle",
        camera_on: false,
        cpu_mhz: 40,
        die_temp_c: 41.2,
        thermal_state: "throttled",
        resolution: "vga16",
        stab_mode: "camera_crop",
        codec: "passthrough",
        wifi_ip: "192.168.1.50",
        free_dram: 180000,
        free_psram: 3900000,
        system: {
          cpu0_load_pct: 12,
          cpu1_load_pct: 5,
          dram_total_bytes: 320000,
          dram_min_free_bytes: 150000,
          psram_total_bytes: 4194304,
          psram_min_free_bytes: 3800000,
          flash_total_bytes: 4194304,
          running_partition: "ota_0",
          running_partition_bytes: 1572864,
        },
      },
      rawAgeMs: 250,
      host: "balax-cam.local",
      portLabel: "USB 1A86:7523",
      streaming: false,
      sleepingPaused: false,
      activeTransport: "usb_ecl1",
      transportPreference: "usb",
      measuredFps: 0,
      measuredKbps: 0,
      latestFrame: null,
      badPackets: 0,
      droppedIncomplete: 0,
    });

    assert.equal(st.available, true);
    assert.equal(st.powerMode, "idle");
    assert.equal(st.thermalState, "throttled");
    assert.equal(st.resolution, "vga16");
    assert.equal(st.stabMode, "camera_crop");
    assert.equal(st.codecSetting, "passthrough");
    assert.equal(st.usbPort, "USB 1A86:7523");
    assert.equal(st.usbBaud, 921600);
    assert.equal(st.system?.runningPartition, "ota_0");
    assert.equal(st.system?.cpu0LoadPct, 12);
  });

  it("detectRuntimeMode distinguishes static GitHub Pages 404 from local bridge JSON", async () => {
    const origFetch = globalThis.fetch;
    try {
      setRuntimeMode("unknown");
      globalThis.fetch = (async () =>
        new Response("<!doctype html><html>404</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        })) as typeof fetch;
      assert.equal(await detectRuntimeMode(true), "standalone");
      assert.equal(getRuntimeMode(), "standalone");

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ connected: false, robotIp: "balax.local", powerMode: "unknown" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      assert.equal(await detectRuntimeMode(true), "bridge");
      assert.equal(getRuntimeMode(), "bridge");
    } finally {
      globalThis.fetch = origFetch;
      setRuntimeMode("unknown");
    }
  });
});
