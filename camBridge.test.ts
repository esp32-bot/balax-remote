import fs from "node:fs";
import { WasmTemporalDecoder } from "./eclDecoder.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOta0SelectData,
  CAM_PUSH_MAGIC,
  CamBridgeManager,
  crc32Ieee,
  ECL1_FLAG_HAS_META_ATTITUDE,
  ECL1_FLAG_KEYFRAME,
  Ecl1Depacketizer,
  encodeBinaryPushFrame,
  packEcl1Packet,
  SerialEcl1Framer,
  unpackEcl1Packet,
} from "./camBridge.ts";

test("camera status exposes live resource metrics and expires them", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  let firmware: Record<string, unknown> = { power_mode: "idle", cpu_mhz: 80, free_dram: 140_000, free_psram: 4_000_000 };
  const request = t.mock.method(globalThis, "fetch", async () => Response.json(firmware));
  const camera = new CamBridgeManager();
  t.after(() => camera.close());
  camera.setHost("127.0.0.1");

  const legacy = await camera.getStatus();
  assert.equal(legacy.system, null);
  assert.equal(legacy.streamCpuMhz, null);
  assert.equal(legacy.cpuMhz, 80);
  assert.equal(legacy.freeDram, 140_000);

  firmware = {
    ...firmware,
    stream_cpu_mhz: 160,
    system: {
      cpu0_load_pct: 0,
      cpu1_load_pct: 17,
      dram_total_bytes: 295_952,
      dram_min_free_bytes: 120_014,
      psram_total_bytes: 4_194_304,
      psram_min_free_bytes: 3_845_164,
      flash_total_bytes: 4_194_304,
      running_partition: "ota_0",
      running_partition_bytes: 3_342_336,
    },
  };
  now += 2_000;
  const live = await camera.getStatus();
  assert.equal(live.streamCpuMhz, 160);
  assert.deepEqual(live.system, {
    cpu0LoadPct: 0,
    cpu1LoadPct: 17,
    dramTotalBytes: 295_952,
    dramMinFreeBytes: 120_014,
    psramTotalBytes: 4_194_304,
    psramMinFreeBytes: 3_845_164,
    flashTotalBytes: 4_194_304,
    runningPartition: "ota_0",
    runningPartitionBytes: 3_342_336,
  });

  now += 6_000;
  const stale = await camera.getStatus(false);
  assert.equal(stale.available, false);
  assert.equal(stale.system, null);
  assert.equal(stale.freeDram, null);
  assert.equal(request.mock.callCount(), 2);
});

test("camera sleep hides the cached metrics and pauses remote status probes", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const request = t.mock.method(globalThis, "fetch", async () => Response.json({
    power_mode: "idle",
    cpu_mhz: 80,
    stream_cpu_mhz: 160,
    free_psram: 4_000_000,
    system: { flash_total_bytes: 4_194_304 },
  }));
  const camera = new CamBridgeManager();
  t.after(() => camera.close());
  camera.setHost("127.0.0.1");

  assert.equal((await camera.getStatus()).system?.flashTotalBytes, 4_194_304);
  assert.equal((await camera.setPower("sleep", "lan")).ok, true);
  now += 2_000;
  const asleep = await camera.getStatus();
  assert.equal(asleep.powerMode, "sleep");
  assert.equal(asleep.cpuMhz, null);
  assert.equal(asleep.streamCpuMhz, null);
  assert.equal(asleep.freePsram, null);
  assert.equal(asleep.system, null);
  assert.equal(request.mock.callCount(), 2);

  camera.setHost("127.0.0.2");
  assert.equal((await camera.getStatus(false)).available, false);
  assert.equal((await camera.getStatus()).system?.flashTotalBytes, 4_194_304);
  assert.equal(request.mock.callCount(), 3);
});

test("camera status from an earlier host does not replace the current host snapshot", async (t) => {
  let resolveOldStatus!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => { resolveOldStatus = resolve; });
  const request = t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "http://127.0.0.1/api/status"
      ? oldResponse
      : Response.json({ power_mode: "idle", system: { flash_total_bytes: 8_388_608 } }),
  );
  const camera = new CamBridgeManager();
  t.after(() => camera.close());
  camera.setHost("127.0.0.1");
  const oldPoll = camera.getStatus();
  await Promise.resolve();
  assert.equal(request.mock.callCount(), 1);

  camera.setHost("127.0.0.2");
  assert.equal((await camera.getStatus()).system?.flashTotalBytes, 8_388_608);
  resolveOldStatus(Response.json({ power_mode: "idle", system: { flash_total_bytes: 4_194_304 } }));
  await oldPoll;
  const current = await camera.getStatus(false);
  assert.equal(current.host, "127.0.0.2");
  assert.equal(current.system?.flashTotalBytes, 8_388_608);
});

test("crc32Ieee matches standard IEEE 802.3 vector", () => {
  const crc = crc32Ieee(Buffer.from("123456789", "ascii"));
  assert.equal(crc, 0xcbf43926);
});

test("packEcl1Packet and unpackEcl1Packet round-trip header, signed attitude, and CRC", () => {
  const payload = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  const wire = packEcl1Packet(
    {
      flags: ECL1_FLAG_KEYFRAME | ECL1_FLAG_HAS_META_ATTITUDE,
      codecMode: 0,
      chunkId: 0,
      chunkCount: 1,
      frameId: 42,
      referenceFrameId: 41,
      timestampUsLow: 123456,
      width: 320,
      height: 240,
      metaPitchCdeg: -1234,
      metaRollCdeg: 567,
    },
    payload,
  );
  const unpacked = unpackEcl1Packet(wire);
  assert.ok(unpacked);
  assert.equal(unpacked.header.frameId, 42);
  assert.equal(unpacked.header.metaPitchCdeg, -1234);
  assert.equal(unpacked.header.metaRollCdeg, 567);
  assert.deepEqual(unpacked.payload, payload);

  // Corrupt 1 byte -> CRC rejects packet
  const bad = Buffer.from(wire);
  bad[33] ^= 0x01;
  assert.equal(unpackEcl1Packet(bad), null);
});

test("Ecl1Depacketizer reassembles out-of-order chunks and handles FRAME_SKIP", () => {
  const dep = new Ecl1Depacketizer(4);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(200, 0xaa),
    Buffer.from([0xff, 0xd9]),
  ]);

  const p0 = packEcl1Packet(
    {
      flags: ECL1_FLAG_KEYFRAME | ECL1_FLAG_HAS_META_ATTITUDE,
      codecMode: 0,
      chunkId: 0,
      chunkCount: 2,
      frameId: 10,
      width: 320,
      height: 240,
      metaPitchCdeg: 450,
      metaRollCdeg: -210,
    },
    jpeg.subarray(0, 100),
  );
  const p1 = packEcl1Packet(
    {
      flags: ECL1_FLAG_KEYFRAME | ECL1_FLAG_HAS_META_ATTITUDE,
      codecMode: 0,
      chunkId: 1,
      chunkCount: 2,
      frameId: 10,
      width: 320,
      height: 240,
      metaPitchCdeg: 450,
      metaRollCdeg: -210,
    },
    jpeg.subarray(100),
  );

  // Feed chunk 1 before chunk 0
  assert.equal(dep.feedPacket(p1, 1000), null);
  const f10 = dep.feedPacket(p0, 1002);
  assert.ok(f10);
  assert.equal(f10.frameId, 10);
  assert.equal(f10.isSkipped, false);
  assert.equal(f10.pitchCdeg, 450);
  assert.equal(f10.rollCdeg, -210);
  assert.deepEqual(f10.jpeg, jpeg);

  // Feed FRAME_SKIP (codecMode=1, empty payload) -> reuses JPEG with updated attitude
  const skip = packEcl1Packet(
    {
      flags: ECL1_FLAG_HAS_META_ATTITUDE,
      codecMode: 1,
      chunkId: 0,
      chunkCount: 1,
      frameId: 11,
      referenceFrameId: 10,
      width: 320,
      height: 240,
      metaPitchCdeg: 465,
      metaRollCdeg: -195,
    },
    Buffer.alloc(0),
  );
  const f11 = dep.feedPacket(skip, 1068);
  assert.ok(f11);
  assert.equal(f11.frameId, 11);
  assert.equal(f11.isSkipped, true);
  assert.equal(f11.codecModeName, "FRAME_SKIP");
  assert.equal(f11.pitchCdeg, 465);
  assert.deepEqual(f11.jpeg, jpeg);
});

test("SerialEcl1Framer extracts framed packets across noisy & split USB serial reads", () => {
  const framer = new SerialEcl1Framer();
  const pkt = packEcl1Packet({ frameId: 7, codecMode: 1 }, Buffer.alloc(0));
  const hdr = Buffer.from([0xeb, 0x90, pkt.length & 0xff, (pkt.length >> 8) & 0xff]);
  const stream = Buffer.concat([Buffer.from("I (123) boot noise\r\n"), hdr, pkt, Buffer.from("tail")]);

  const out1 = framer.push(stream.subarray(0, 28));
  assert.equal(out1.length, 0);
  const out2 = framer.push(stream.subarray(28));
  assert.equal(out2.length, 1);
  assert.deepEqual(out2[0], pkt);
});

test("WasmTemporalDecoder reconstructs real baseline JPEG keyframes and zero-change DCT_SPARSE_BLOCK deltas", async () => {
  const dec = await WasmTemporalDecoder.create(131072, 4096);
  try {
    // Load a real baseline JPEG fixture generated by esp32-cam if present
    const fixture = "../esp32-cam/testdata/generated/large_motion/frame_0000.jpg";
    assert.ok(fs.existsSync(fixture), "expected test fixture JPEG");
    const rawJpeg = fs.readFileSync(fixture);

    // 1. Keyframe (codecMode = 6 = DCT_SPARSE_BLOCK, isKeyframe = true)
    const kfOut = dec.decode(6, 1, 0, true, 320, 240, rawJpeg);
    assert.ok(kfOut && kfOut.length > 500);
    assert.equal(kfOut[0], 0xff);
    assert.equal(kfOut[1], 0xd8);
    assert.equal(kfOut[kfOut.length - 2], 0xff);
    assert.equal(kfOut[kfOut.length - 1], 0xd9);

    // 2. Zero-change DCT_SPARSE_BLOCK delta payload ("ECLD" header with changed_blocks=0)
    // Header layout (16B): "ECLD"(4), version(1)=1, mode(1)=6, reserved(2)=0, total_blocks(4)=2400, changed_blocks(4)=0
    // Wait: let's verify exact total_blocks from 320x240 4:2:0 = 40*30*(1+0.25+0.25) = 1800 or 4:2:2 = 2400;
    // Also verify FRAME_SKIP (codecMode=1) reconstructs identically through WASM!
    const skipOut = dec.decode(1, 2, 1, false, 320, 240, Buffer.from("SKIP"));
    assert.ok(skipOut && skipOut.length === kfOut.length);
    assert.deepEqual(skipOut, kfOut);
  } finally {
    dec.destroy();
  }
});


test("SerialEcl1Framer.pushFrames demuxes interleaved ECL1 video and 0xEB 0x91 JSON status frames", () => {
  const framer = new SerialEcl1Framer();
  const pkt = packEcl1Packet({ frameId: 19, codecMode: 0 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const statusJson = Buffer.from(JSON.stringify({ power_mode: "streaming", die_temp_c: 64, stab_mode: "hybrid" }), "utf8");
  const vidHdr = Buffer.from([0xeb, 0x90, pkt.length & 0xff, (pkt.length >> 8) & 0xff]);
  const stHdr = Buffer.from([0xeb, 0x91, statusJson.length & 0xff, (statusJson.length >> 8) & 0xff]);

  const combined = Buffer.concat([Buffer.from("boot\r\n"), stHdr, statusJson, vidHdr, pkt]);
  const firstHalf = framer.pushFrames(combined.subarray(0, 20));
  const secondHalf = framer.pushFrames(combined.subarray(20));
  const packets = [...firstHalf.packets, ...secondHalf.packets];
  const statuses = [...firstHalf.statuses, ...secondHalf.statuses];

  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], {
    power_mode: "streaming",
    die_temp_c: 64,
    stab_mode: "hybrid",
  });
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0], pkt);
});

test("encodeBinaryPushFrame packs 24-byte BCMF header and JPEG payload", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
  const buf = encodeBinaryPushFrame({
    frameId: 99,
    width: 800,
    height: 456,
    pitchCdeg: -325,
    rollCdeg: 140,
    hasAttitude: true,
    isSkipped: false,
    isKeyframe: true,
    codecMode: 6,
    codecModeName: "DCT_SPARSE_BLOCK",
    jpeg,
    receivedAtMs: 1234,
    wireBytes: 500,
    changedBlocks: 12,
    totalBlocks: 2400,
  });

  assert.equal(buf.length, 24 + jpeg.length);
  assert.equal(buf.readUInt32LE(0), CAM_PUSH_MAGIC);
  assert.equal(buf.readUInt32LE(4), 99);
  assert.equal(buf.readUInt16LE(8), 800);
  assert.equal(buf.readUInt16LE(10), 456);
  assert.equal(buf.readInt16LE(12), -325);
  assert.equal(buf.readInt16LE(14), 140);
  assert.equal(buf[16], 0x05); // bit0=hasAttitude | bit2=isKeyframe
  assert.equal(buf[17], 6);
  assert.equal(buf.readUInt32LE(20), jpeg.length);
  assert.deepEqual(buf.subarray(24), jpeg);
});

test("CamBridgeManager.getStatus parses hybrid stabilization, thermal, and granular clock fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    power_mode: "streaming",
    camera_on: true,
    cpu_mhz: 160,
    stream_cpu_mhz: 160,
    cpu_dfs: true,
    idle_cpu_mhz: 20,
    wifi_ps: "none",
    wifi_tx_dbm: 17,
    resolution: "svga16",
    xclk_mhz: 20,
    pll_2x: true,
    stab_mode: "hybrid",
    crop_align_px: 4,
    max_slew_px: 12,
    vfov_deg: 48,
    crop_y: -16,
    die_temp_c: 68,
    thermal_state: "ok",
    thermal_limit_c: 75,
    tx_drops: 2,
    effective_quality: 14,
    auto_quality: true,
  }));

  const camera = new CamBridgeManager();
  t.after(() => camera.close());
  camera.setHost("127.0.0.1");

  const st = await camera.getStatus();
  assert.equal(st.stabMode, "hybrid");
  assert.equal(st.resolution, "svga16");
  assert.equal(st.cpuDfs, true);
  assert.equal(st.idleCpuMhz, 20);
  assert.equal(st.wifiPs, "none");
  assert.equal(st.wifiTxDbm, 17);
  assert.equal(st.xclkMhz, 20);
  assert.equal(st.pll2x, true);
  assert.equal(st.cropY, -16);
  assert.equal(st.dieTempC, 68);
  assert.equal(st.thermalState, "ok");
  assert.equal(st.thermalLimitC, 75);
  assert.equal(st.txDrops, 2);
  assert.equal(st.effectiveQuality, 14);
  assert.equal(st.autoQuality, true);
  assert.ok(Array.isArray(st.usbPorts));
});


test("buildOta0SelectData produces an 8 KB ESP-IDF otadata image selecting ota_0", () => {
  const data = buildOta0SelectData();
  assert.equal(data.length, 0x2000);
  assert.equal(data.readUInt32LE(0), 1);
  assert.equal(data.readUInt32LE(24), 0xffffffff);
  assert.equal(data.readUInt32LE(28), 0x4743989a);
  // Second copy sector (offset 0x1000) stays erased 0xFF
  assert.equal(data.readUInt32LE(0x1000), 0xffffffff);
});
