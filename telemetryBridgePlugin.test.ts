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

type BridgeRequest = Readable & { url: string; method: string; headers: Record<string, string> };
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

  let streamStatus = 200;
  let uptime = 120;
  let partitionsOutput = PARTITIONS;
  let partitionsStatus = 200;
  let partitionReads = 0;
  let streamReads = 0;
  let delayedPartitions: Promise<void> | null = null;
  let partitionsStarted: (() => void) | null = null;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "192.0.2.1");
    if (url.pathname === "/api/challenge") return Response.json({ nonce: "ab".repeat(16) });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-nonce"), "ab".repeat(16));
    assert.match(headers.get("x-signature") ?? "", /^[\da-f]{64}$/);
    if (url.pathname === "/api/stream") {
      streamReads++;
      return new Response(null, { status: streamStatus });
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
    if (cmd === "status") return new Response(`uptime_s ${uptime}\ncpu_mhz 80\nbattery_pct 70\n`);
    assert.ok(cmd === "stream" || cmd === "stream stop");
    return new Response("active no\n");
  });

  let handle: Middleware | null = null;
  const httpServer = new EventEmitter();
  const configure = telemetryBridgePlugin().configureServer;
  assert.equal(typeof configure, "function");
  if (typeof configure !== "function") throw new Error("Missing bridge server hook");
  configure({
    httpServer,
    middlewares: { use(handler: Middleware) { handle = handler; } },
  } as unknown as ViteDevServer);
  t.after(() => { httpServer.emit("close"); });

  async function request(path: string, method = "GET", payload = "") {
    assert.ok(handle);
    const req = Object.assign(Readable.from([payload]), { url: `/api/bridge/${path}`, method, headers: {} });
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

  const ota = request("ota", "POST");
  await Promise.resolve();
  assert.equal((await request("flash")).body.status, "busy");
  assert.equal((await ota).body.ok, true);
  assert.ok(otaProcess);
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
});
