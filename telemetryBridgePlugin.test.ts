import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { ViteDevServer } from "vite";
import { parseFlashPartitions } from "./src/flashProtocol.ts";

// The columns and padding follow print_region and partitions_command in BalaX main/commands.cpp.
const PARTITIONS = `flash_size 0x400000
# label type subtype offset size image flags state version
bootloader bootloader primary  0x001000 0x007000 0x006120 -            -       v6.1.1
part_table partition_table primary  0x008000 0x001000 -        -            -       -
nvs        data       nvs      0x009000 0x006000 -        enc,ro       -       -
ota_0      app        ota_0    0x020000 0x1e0000 0x100130 running,boot valid   224e4a8 dirty build
ota_1      app        ota_1    0x200000 0x1e0000 -        next         -       -
telemetry  data       0x99     0x3e0000 0x010000 -        -            -       -
`;

test("parse firmware flash size, bootloader, app flags, and free-text version", () => {
  const flash = parseFlashPartitions(PARTITIONS.replaceAll("\n", "\r\n"), 123);
  assert.equal(flash.totalBytes, 0x400000);
  assert.equal(flash.fetchedAtMs, 123);
  assert.equal(flash.partitions.length, 6);
  assert.equal(flash.partitions[1].type, "partition_table");
  assert.deepEqual(flash.partitions[3], {
    name: "ota_0", type: "app", subtype: "ota_0", offset: 0x20000,
    size: 0x1e0000, imageBytes: 0x100130, flags: ["running", "boot"],
    state: "valid", version: "224e4a8 dirty build",
  });
  assert.equal(flash.partitions[4].imageBytes, null);
  assert.equal(flash.partitions[4].state, null);
  assert.equal(flash.partitions[4].version, null);
  assert.deepEqual(flash.partitions[2].flags, ["enc", "ro"]);
  assert.equal(flash.partitions[5].subtype, "0x99");
  assert.equal(parseFlashPartitions(PARTITIONS.replace("nvs        ", "config store ")).partitions[2].name, "config store");
  assert.throws(() => parseFlashPartitions("flash_size 0x400000\n"), /Invalid flash partition/);
  assert.throws(() => parseFlashPartitions(PARTITIONS.replace("0x400000", "0x100000")), /Invalid flash partition/);
});

test("parse rows emitted by the firmware's C++ formatter", (t) => {
  const firmwareSource = new URL("../balax/main/commands.cpp", import.meta.url);
  const compiler = process.env.CXX || "c++";
  if (!fs.existsSync(firmwareSource) || childProcess.spawnSync(compiler, ["--version"], { stdio: "ignore" }).error) {
    t.skip("requires the sibling BalaX checkout and a host C++ compiler");
    return;
  }
  const source = fs.readFileSync(firmwareSource, "utf8");
  const formatter = source.match(/^void print_region\([\s\S]*?^}/m)?.[0];
  const headers = source.match(/^    printf\("flash_size [^\n]*\n    printf\("# label [^\n]*/m)?.[0];
  assert.ok(formatter && headers, "Locate the firmware's partition output format");
  const fixture = `
#include <cstdint>
#include <cstdio>
${formatter}
int main() {
    uint32_t flash_size = 0x400000;
${headers}
    print_region("bootloader", "bootloader", "primary", 0x1000u, 0x7000u, 0x6120u, "", "-", "v6.1.1");
    print_region("part_table", "partition_table", "primary", 0x8000u, 0x1000u, 0, "", "-", "");
    print_region("ota_0", "app", "ota_0", 0x20000u, 0x1e0000u, 0x100130u, "running,boot", "valid", "224e4a8 dirty build");
    print_region("ota_1", "app", "ota_1", 0x200000u, 0x1e0000u, 0, "next", "-", "");
}
`;
  const buildDir = path.join(import.meta.dirname, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const fixtureDir = fs.mkdtempSync(path.join(buildDir, "partition-formatter-"));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const executable = path.join(fixtureDir, "emit");
  const compile = childProcess.spawnSync(compiler, ["-std=c++17", "-x", "c++", "-", "-o", executable], {
    input: fixture, encoding: "utf8",
  });
  assert.equal(compile.status, 0, compile.stderr);
  const actual = childProcess.spawnSync(executable, { encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr);
  const parsed = parseFlashPartitions(actual.stdout);
  assert.equal(parsed.totalBytes, 0x400000);
  assert.deepEqual(parsed.partitions.map((p) => p.name), ["bootloader", "part_table", "ota_0", "ota_1"]);
  assert.deepEqual(parsed.partitions[2].flags, ["running", "boot"]);
  assert.equal(parsed.partitions[2].version, "224e4a8 dirty build");
  assert.equal(parsed.partitions[3].imageBytes, null);
});

type BridgeRequest = Readable & {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string; localAddress: string };
};
type BridgeResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
};
type Middleware = (req: BridgeRequest, res: BridgeResponse, next: () => void) => Promise<void>;

test("Flash bridge lifecycle with authenticated console and simulated robot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 50_000 });
  let otaProcess: EventEmitter | null = null;
  t.mock.module("node:child_process", {
    exports: {
      ...childProcess,
      spawn(cmd: string) {
        assert.equal(cmd, "curl");
        const proc = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        otaProcess = proc;
        setImmediate(() => {
          proc.stderr.emit("data", Buffer.from("\r########## 50.0%\r"));
          proc.stdout.emit("data", Buffer.from('{"ok":true,"partition":"ota_1"}'));
          proc.emit("close", 0);
        });
        return proc;
      },
    },
  });
  const { telemetryBridgePlugin } = await import("./telemetryBridgePlugin.ts");

  const binary = Buffer.from("simulated firmware");
  const isSecrets = (file: unknown) => String(file).endsWith("/balax/secrets/wifi.json");
  const isBinary = (file: unknown) => String(file).endsWith("/balax/build/balax.bin");
  t.mock.method(fs, "mkdirSync", () => undefined);
  t.mock.method(fs, "existsSync", (file) => isSecrets(file) || isBinary(file));
  t.mock.method(fs, "readFileSync", (file) => {
    if (isSecrets(file)) return JSON.stringify({ lan_auth: { key_hex: "42".repeat(32) } });
    assert.ok(isBinary(file), `Unexpected disk dependency ${file}`);
    return binary;
  });
  t.mock.method(fs, "statSync", (file) => {
    assert.ok(isBinary(file));
    return { size: binary.length, mtimeMs: 1000 };
  });
  // The USB serial ports the bridge finds in /dev: none until a step plugs one in.
  let devSerialNames: string[] = [];
  const realReaddirSync = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (dir: fs.PathLike, options?: unknown) => {
    if (String(dir) !== "/dev") return (realReaddirSync as (dir: fs.PathLike, options?: unknown) => unknown)(dir, options);
    return devSerialNames.map((name) => ({ name, isCharacterDevice: () => true }));
  });

  let streamStatus = 200;
  let streamPowerHeader: string | null = null;
  let offReply = "Entering USB-charge off (deep sleep; reboot via USB RTS->EN).\n";
  const sentPowerCmds: string[] = [];
  const sentDriveBodies: string[] = [];
  let sleepProbeCount = 0;
  let probeFails = false;
  let probeUsbV = 0.0;
  let uptime = 120;
  let partitionsOutput = PARTITIONS;
  let partitionsStatus = 200;
  let partitionReads = 0;
  let streamReads = 0;
  let hasFactory = false;
  let isStub = false;
  let enterStatus = 500;
  let delayedPartitions: Promise<void> | null = null;
  let partitionsStarted: (() => void) | null = null;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "192.0.2.1");
    if (url.pathname === "/api/challenge") {
      return Response.json({ nonce: "ab".repeat(16), has_factory: hasFactory, is_stub: isStub, partition: isStub ? "factory" : "ota_0" });
    }
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-nonce"), "ab".repeat(16));
    assert.match(headers.get("x-signature") ?? "", /^[\da-f]{64}$/);
    if (url.pathname === "/api/ota/enter") return new Response(null, { status: enterStatus });
    if (url.pathname === "/api/stream") {
      streamReads++;
      const resHeaders: Record<string, string> = {};
      if (streamPowerHeader) resHeaders["X-Power-Mode"] = streamPowerHeader;
      return new Response(null, { status: streamStatus, headers: resHeaders });
    }
    if (url.pathname === "/api/drive") {
      assert.equal(init?.method, "POST");
      const payload = Buffer.from(init?.body as Uint8Array).toString("utf8");
      sentDriveBodies.push(payload);
      return new Response("ok", { status: 200, headers: { "X-Next-Nonce": "ab".repeat(16) } });
    }
    assert.equal(url.pathname, "/api/cmd");
    assert.equal(init?.method, "POST");
    const cmd = String(init?.body);
    if (cmd === "partitions") {
      partitionReads++;
      partitionsStarted?.();
      await delayedPartitions;
      return new Response(partitionsOutput, { status: partitionsStatus });
    }
    if (cmd === "status") {
      return new Response(
        `uptime_s ${uptime}\ncpu_mhz 80\nbattery_pct 70\nwifi connected\nwifi_ssid HomeNet\nwifi_ip 192.0.2.1\nwifi_channel 6\nwifi_rssi -52\nap_ssid BalaX-AP\nap_clients 1\nremote_live yes\nremote_msgs 142\nremote_failed 2\n`
      );
    }
    if (cmd.startsWith("probe ")) {
      sleepProbeCount++;
      if (probeFails) throw new TypeError("fetch failed");
      return new Response(
        `power_mode wifi-sleep\npmic_c 31.5\nbattery_pct 68\nbattery_v 3.92\nusb_v ${probeUsbV.toFixed(2)}\nwifi connected\nwifi_rssi -55\nwifi_channel 6\nap_ssid BalaX-AP\nap_clients 0\nremote_live no\nremote_msgs 142\nremote_failed 2\nuptime_s ${uptime + 15}\n`
      );
    }
    if (cmd === "wifi-sleep" || cmd === "wifi-sleep force" || cmd === "sleep" || cmd === "sleep force") {
      sentPowerCmds.push(cmd);
      return new Response("Entering wifi-sleep.\n");
    }
    if (cmd === "usb-sleep" || cmd === "usb-sleep force" || cmd === "off" || cmd === "off force") {
      sentPowerCmds.push(cmd);
      return new Response(offReply);
    }
    if (cmd === "wake") {
      sentPowerCmds.push(cmd);
      return new Response("Awake.\n");
    }
    assert.ok(cmd === "stream" || cmd === "stream stop");
    return new Response("active no\n");
  });

  let handle: Middleware | null = null;
  const httpServer = new EventEmitter();
  const configure = telemetryBridgePlugin().configureServer;
  assert.equal(typeof configure, "function");
  if (typeof configure !== "function") throw new Error("Missing bridge server hook");
  const wsPayloads: unknown[] = [];
  let serverRestarts = 0;
  configure({
    httpServer,
    ws: { send(payload: unknown) { wsPayloads.push(payload); } },
    async restart() { serverRestarts++; },
    middlewares: { use(handler: Middleware) { handle = handler; } },
  } as unknown as ViteDevServer);
  t.after(() => { httpServer.emit("close"); });

  async function request(path: string, method = "GET", payload = "", options: {
    headers?: Record<string, string>;
    socket?: BridgeRequest["socket"];
  } = {}) {
    assert.ok(handle);
    const req = Object.assign(Readable.from([payload]), {
      url: `/api/bridge/${path}`, method, headers: options.headers ?? {},
      socket: options.socket ?? { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
    });
    const headers = new Headers();
    let response = "";
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: (body: string) => { response = body; },
    };
    await handle(req, res, () => assert.fail(`Missing ${path} route`));
    return { statusCode: res.statusCode, headers, body: JSON.parse(response) };
  }
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const connect = () => request("connect", "POST", '{"ip":"192.0.2.1"}');

  const remoteUsb = await request("usb/info", "GET", "", {
    headers: { host: "balax-remote.local:5180" },
    socket: { remoteAddress: "192.0.2.1", localAddress: "192.0.2.2" },
  });
  assert.equal(remoteUsb.body.local, false);
  assert.deepEqual(remoteUsb.body.ports, []);
  assert.equal(remoteUsb.headers.get("access-control-allow-origin"), null);
  const crossOriginUsb = await request("usb/flash", "POST", "{}", {
    headers: { host: "localhost:5180", origin: "https://example.com" },
  });
  assert.equal(crossOriginUsb.statusCode, 403);
  const unconfirmedUsb = await request("usb/flash", "POST", "{}", {
    headers: { host: "localhost:5180", origin: "http://localhost:5180", "content-type": "application/json" },
  });
  assert.equal(unconfirmedUsb.statusCode, 400);

  const offline = await request("flash");
  assert.equal(offline.body.status, "offline");
  assert.equal(offline.body.live, null);
  assert.equal(partitionReads, 0);
  assert.equal((await connect()).body.connected, true);
  await settle();

  const initial = await request("flash");
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal(initial.body.status, "live");
  assert.equal("localBuild" in initial.body, false);
  assert.equal(initial.body.live.partitions[3].imageBytes, 0x100130);
  assert.equal((await request("flash")).body.live.fetchedAtMs, initial.body.live.fetchedAtMs);
  assert.equal(partitionReads, 1);
  assert.equal("flash" in (await request("system")).body, false);
  t.mock.timers.tick(30_001);
  await settle();
  assert.ok((await request("flash")).body.live.fetchedAtMs > initial.body.live.fetchedAtMs);
  assert.equal(partitionReads, 2);

  partitionsStatus = 401;
  assert.equal((await request("flash?refresh=1")).body.status, "error");
  assert.equal((await request("flash")).body.live, null);
  partitionsStatus = 200;
  await request("flash");

  let releasePartitions = () => {};
  delayedPartitions = new Promise<void>((resolve) => { releasePartitions = resolve; });
  const started = new Promise<void>((resolve) => { partitionsStarted = resolve; });
  const stale = request("flash?refresh=1");
  await started;
  const readsBeforeDisconnect = partitionReads;
  const coalesced = request("flash?refresh=1");
  const disconnect = request("disconnect", "POST");
  await settle();
  assert.equal(partitionReads, readsBeforeDisconnect);
  assert.equal((await request("flash")).body.status, "offline");
  releasePartitions();
  assert.equal((await stale).body.live, null);
  assert.equal((await coalesced).body.live, null);
  await disconnect;
  delayedPartitions = null;
  assert.equal((await request("system")).body.health, null);
  assert.deepEqual((await request("system")).body.healthHistory, []);

  streamStatus = 404;
  partitionsOutput = "Unrecognized command: partitions\n";
  assert.equal((await connect()).body.connected, true);
  const old = await request("flash");
  assert.equal(old.body.status, "unsupported");
  assert.match(old.body.error, /Update BalaX firmware/);
  assert.equal(old.body.live, null);
  assert.equal((await request("trace")).body.telemetryAvailable, false);
  assert.ok(old.body.revision > initial.body.revision);
  const beforeOldPoll = streamReads;
  t.mock.timers.tick(600);
  await settle();
  assert.equal(streamReads, beforeOldPoll);

  // Uptime can reset before the bridge sees a transport drop or any new trace sample.
  streamStatus = 200;
  uptime = 1;
  partitionsOutput = PARTITIONS;
  t.mock.timers.tick(3100);
  await settle();
  const rebooted = await request("flash");
  assert.ok(rebooted.body.revision > old.body.revision);
  assert.equal(rebooted.body.status, "live");
  assert.equal((await request("trace")).body.flashRevision, rebooted.body.revision);

  hasFactory = true;
  const rejectedFactory = await request("ota", "POST");
  assert.equal(rejectedFactory.statusCode, 502);
  assert.match(rejectedFactory.body.error, /Factory OTA updater rejected boot selection/);
  assert.equal(otaProcess, null);
  enterStatus = 200;
  const missingFactory = request("ota", "POST");
  await settle();
  t.mock.timers.tick(20_001);
  assert.match((await missingFactory).body.error, /Factory OTA updater did not come online/);
  assert.equal(otaProcess, null);
  hasFactory = false;

  const ota = request("ota", "POST");
  await Promise.resolve();
  assert.equal((await request("flash")).body.status, "busy");
  const traceDuringOta = await request("trace");
  assert.equal(traceDuringOta.body.otaJob?.active, true);
  assert.equal((await ota).body.ok, true);
  assert.ok(otaProcess);
  const traceAfterOta = await request("trace");
  assert.equal(traceAfterOta.body.otaJob?.active, false);
  assert.equal(traceAfterOta.body.otaJob?.status, "done");
  assert.equal(traceAfterOta.body.otaJob?.progress, 100);
  assert.equal(traceAfterOta.body.otaJob?.partition, "ota_1");
  const rebooting = await request("flash");
  assert.equal(rebooting.body.status, "offline");
  assert.ok(rebooting.body.revision > rebooted.body.revision);
  const beforeOtaPoll = streamReads;
  t.mock.timers.tick(100);
  await settle();
  assert.equal(streamReads, beforeOtaPoll);
  t.mock.timers.tick(600);
  await settle();
  assert.equal((await request("flash")).body.status, "live");

  streamStatus = 503;
  t.mock.timers.tick(100);
  await settle();
  assert.equal((await request("flash")).body.status, "offline");
  streamStatus = 200;
  const beforeRecovery = partitionReads;
  t.mock.timers.tick(600);
  await settle();
  assert.equal((await request("flash")).body.status, "live");
  assert.equal(partitionReads, beforeRecovery + 1);

  // Power mode: Wi-Fi sleep pauses bridge polling without waking the robot.
  const sleepRes = await request("power", "POST", JSON.stringify({ mode: "wifi-sleep", via: "lan" }));
  assert.equal(sleepRes.statusCode, 200);
  assert.equal(sleepRes.body.powerMode, "wifi-sleep");
  assert.equal((await request("trace")).body.powerMode, "wifi-sleep");
  assert.equal((await request("trace")).body.connected, false);
  const readsWhileAsleep = streamReads;
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(streamReads, readsWhileAsleep);

  // Wake over Wi-Fi resumes polling and reconnects.
  const wakeRes = await request("power", "POST", JSON.stringify({ mode: "wake", via: "lan" }));
  assert.equal(wakeRes.statusCode, 200);
  assert.equal(wakeRes.body.powerMode, "awake");
  assert.equal((await request("trace")).body.connected, true);

  // Anti-wake: robot self-sleeping (X-Power-Mode: sleep header) pauses bridge immediately.
  streamPowerHeader = "wifi-sleep";
  t.mock.timers.tick(100);
  await settle();
  assert.equal((await request("trace")).body.powerMode, "wifi-sleep");
  assert.equal((await request("trace")).body.connected, false);
  const readsAfterSelfSleep = streamReads;
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(streamReads, readsAfterSelfSleep);
  streamPowerHeader = null;

  // During wifi-sleep, slow passive probe updates health on a 15s cadence without calling /api/stream.
  const probesBeforeSleepTick = sleepProbeCount;
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(sleepProbeCount, probesBeforeSleepTick, "Passive sleep probe should stay quiet inside 15s interval");
  t.mock.timers.tick(15_500);
  await settle();
  await settle();
  assert.ok(sleepProbeCount > probesBeforeSleepTick, "Expected passive sleep probe to run after 15s interval");
  assert.equal(streamReads, readsAfterSelfSleep, "Passive sleep probe must not touch /api/stream");
  const sleepTrace = await request("trace");
  assert.equal(sleepTrace.body.powerMode, "wifi-sleep");
  assert.equal(sleepTrace.body.connected, false);
  assert.equal(sleepTrace.body.health?.batteryPct, 68);
  assert.equal(sleepTrace.body.health?.pmicC, 31.5);

  // /api/bridge/comms reports full mesh topology passively while in wifi-sleep without waking robot.
  const sleepComms = await request("comms");
  assert.equal(sleepComms.statusCode, 200);
  assert.equal(sleepComms.body.bridge.mdnsHost, "balax-remote.local");
  assert.equal(sleepComms.body.robot.powerMode, "wifi-sleep");
  assert.equal(sleepComms.body.health?.apSsid, "BalaX-AP");
  assert.equal(sleepComms.body.health?.remoteLive, false);
  assert.equal(sleepComms.body.health?.remoteMsgs, 142);
  assert.equal(sleepComms.body.health?.remoteFailed, 2);
  assert.equal(streamReads, readsAfterSelfSleep, "/api/bridge/comms must not wake sleeping robot");

  // Missed Wi-Fi sleep probes while StickC had usb_v = 0.00 (e.g. only ESP32-CAM on USB)
  // must NEVER falsely claim usb-sleep; after 3 misses StickC becomes offline ("unknown").
  devSerialNames = ["cu.usbserial-mock-stickc", "ttyUSB0"];
  probeFails = true;
  t.mock.timers.tick(2_001); // past the bridge's 2 s USB port cache
  const firstMissedNoUsbV = await request("comms?refresh=1");
  assert.equal(firstMissedNoUsbV.statusCode, 200);
  assert.equal(firstMissedNoUsbV.body.robot.powerMode, "wifi-sleep");
  const secondMissedNoUsbV = await request("comms?refresh=1");
  assert.equal(secondMissedNoUsbV.statusCode, 200);
  assert.equal(secondMissedNoUsbV.body.robot.powerMode, "wifi-sleep");
  const thirdMissedNoUsbV = await request("comms?refresh=1");
  assert.equal(thirdMissedNoUsbV.statusCode, 200);
  assert.equal(thirdMissedNoUsbV.body.robot.powerMode, "unknown");

  // Re-enter wifi-sleep with StickC reporting 5.00 V USB power; 2 missed probes with
  // a StickC USB port present validly infer usb-sleep, and unplugging USB clears it.
  probeFails = false;
  probeUsbV = 5.0;
  const reSleep = await request("power", "POST", JSON.stringify({ mode: "wifi-sleep", localOnly: true }), { headers: { host: "localhost:5180" } });
  assert.equal(reSleep.statusCode, 200);
  await request("comms?refresh=1"); // records usb_v = 5.00 in health
  probeFails = true;
  const firstMissedUsbV = await request("comms?refresh=1");
  assert.equal(firstMissedUsbV.body.robot.powerMode, "wifi-sleep");
  const secondMissedUsbV = await request("comms?refresh=1");
  assert.equal(secondMissedUsbV.body.robot.powerMode, "usb-sleep");
  devSerialNames = [];
  t.mock.timers.tick(2_001);
  const afterUsbUnplug = await request("comms");
  assert.equal(afterUsbUnplug.body.robot.powerMode, "unknown");
  probeFails = false;
  probeUsbV = 0.0;

  // Wake again, verify /api/bridge/drive routes to authenticated /api/drive, then test USB-off refusal (409) vs acceptance (200).
  await request("power", "POST", JSON.stringify({ mode: "wake", via: "lan" }));
  const driveRes = await request("drive", "POST", JSON.stringify({ forward: 0.65, turn: -0.25 }));
  assert.equal(driveRes.statusCode, 200);
  assert.equal(driveRes.body.ok, true);
  assert.equal(sentDriveBodies.at(-1), "0.650 -0.250");

  // Awake /api/bridge/comms?refresh=1 parses full Wi-Fi + ESP-NOW + SoftAP + lastDrive mesh status.
  const awakeComms = await request("comms?refresh=1");
  assert.equal(awakeComms.statusCode, 200);
  assert.equal(awakeComms.body.robot.connected, true);
  assert.equal(awakeComms.body.health?.wifiPhase, "connected");
  assert.equal(awakeComms.body.health?.apClients, 1);
  assert.equal(awakeComms.body.health?.remoteLive, true);
  assert.equal(awakeComms.body.lastDrive?.forward, 0.65);
  offReply = "Refusing off: USB not connected (0.00V < 4.0V). Use 'sleep' for Wi-Fi.\n";
  const refusedOff = await request("power", "POST", JSON.stringify({ mode: "off", via: "lan" }));
  assert.equal(refusedOff.statusCode, 409);
  assert.match(refusedOff.body.error, /Refusing off/);

  offReply = "Entering USB-charge off (deep sleep; reboot via USB RTS->EN).\n";
  const acceptedOff = await request("power", "POST", JSON.stringify({ mode: "usb-sleep", via: "lan" }));
  assert.equal(acceptedOff.statusCode, 200);
  assert.equal(acceptedOff.body.powerMode, "usb-sleep");
  assert.equal((await request("trace")).body.powerMode, "usb-sleep");

  // Local-only CLI sync pauses bridge without contacting robot; remote origin rejected.
  const cmdsBeforeSync = sentPowerCmds.length;
  const syncOk = await request("power", "POST", JSON.stringify({ mode: "sleep", localOnly: true }), {
    headers: { host: "localhost:5180" },
  });
  assert.equal(syncOk.statusCode, 200);
  assert.equal(sentPowerCmds.length, cmdsBeforeSync);
  const syncRemote = await request("power", "POST", JSON.stringify({ mode: "sleep", localOnly: true }), {
    headers: { host: "localhost:5180" },
    socket: { remoteAddress: "192.0.2.99", localAddress: "192.0.2.1" },
  });
  assert.equal(syncRemote.statusCode, 403);

  // Cross-origin USB wake request is rejected with 403.
  const crossOriginUsbPower = await request("power", "POST", JSON.stringify({ mode: "wake", via: "usb" }), {
    headers: { host: "localhost:5180", origin: "http://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossOriginUsbPower.statusCode, 403);

  // Already-booted factory stub should upload without calling /api/cmd (which stub doesn't serve).
  isStub = true;
  const stubOta = await request("ota", "POST");
  assert.equal(stubOta.statusCode, 200);
  assert.equal(stubOta.body.ok, true);
  isStub = false;

  // Forced page reload and in-process Vite server restart (local only).
  const reloadRes = await request("reload", "POST", "{}", { headers: { host: "localhost:5180" } });
  assert.equal(reloadRes.statusCode, 200);
  assert.equal(reloadRes.body.action, "full-reload");
  assert.deepEqual(wsPayloads.at(-1), { type: "full-reload", path: "*" });

  const restartRes = await request("reload", "POST", JSON.stringify({ restart: true }), {
    headers: { host: "localhost:5180" },
  });
  assert.equal(restartRes.statusCode, 200);
  assert.equal(restartRes.body.action, "restart");
  t.mock.timers.tick(60);
  assert.equal(serverRestarts, 1);

  const remoteReload = await request("reload", "POST", "{}", {
    headers: { host: "localhost:5180" },
    socket: { remoteAddress: "192.0.2.99", localAddress: "192.0.2.1" },
  });
  assert.equal(remoteReload.statusCode, 403);
});
