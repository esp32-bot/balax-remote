import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  isLocalUsbRequest, isSameOriginUsbRequest, loadUsbFlashPlan, readUsbPartitionTable,
  usbFlashArgs, usbPowerArgs, usbWriteProgress, verifyUsbFlashDevice,
} from "./usbFlash.ts";

test("USB permissions require a known local address and exact browser origin", () => {
  for (const host of ["localhost:5180", "127.0.0.1:5180", "[::1]:5180"]) {
    assert.equal(isLocalUsbRequest(host, "::ffff:127.0.0.1", "127.0.0.1"), true);
    assert.equal(isLocalUsbRequest(host, "192.0.2.1", "192.0.2.2"), false);
  }
  assert.equal(isLocalUsbRequest("balax-remote.local:5180", "::ffff:192.0.2.1", "192.0.2.1"), true);
  assert.equal(isLocalUsbRequest("balax-remote.local:5180", "192.0.2.2", "192.0.2.1"), false);
  assert.equal(isLocalUsbRequest("evil.local:5180", "127.0.0.1", "127.0.0.1"), false);
  assert.equal(isLocalUsbRequest("localhost:99999", "127.0.0.1", "127.0.0.1"), false);
  assert.equal(isSameOriginUsbRequest("localhost:5180", "http://localhost:5180", "same-origin"), true);
  assert.equal(isSameOriginUsbRequest("localhost:5180", "http://localhost:5181", "cross-site"), false);
  assert.equal(isSameOriginUsbRequest("localhost:5180", undefined, undefined), false);
});

type PartitionRow = [name: string, type: number, subtype: number, offset: number, size: number];
function table(rows: PartitionRow[]): Buffer {
  const result = Buffer.alloc((rows.length + 1) * 32);
  rows.forEach(([name, type, subtype, offset, size], index) => {
    const start = index * 32;
    result.writeUInt16LE(0x50aa, start);
    result[start + 2] = type;
    result[start + 3] = subtype;
    result.writeUInt32LE(offset, start + 4);
    result.writeUInt32LE(size, start + 8);
    result.write(name, start + 12, 16, "ascii");
  });
  const digestOffset = rows.length * 32;
  result.fill(0xff, digestOffset, digestOffset + 16);
  result.writeUInt16LE(0xebeb, digestOffset);
  crypto.createHash("md5").update(result.subarray(0, digestOffset)).digest().copy(result, digestOffset + 16);
  return result;
}

test("validated USB plans write only proposed images and the OTA selector", (t) => {
  const work = path.join(import.meta.dirname, "build");
  fs.mkdirSync(work, { recursive: true });
  const root = fs.mkdtempSync(path.join(work, "usb-flash-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common: PartitionRow[] = [["nvs", 1, 2, 0x9000, 0x6000], ["otadata", 1, 0, 0xf000, 0x2000]];
  const build = path.join(root, "build");
  const compact = path.join(root, "ota_stub/build");
  const image = (size: number) => Buffer.alloc(size, 0xe9);
  for (const dir of [build, compact]) {
    fs.mkdirSync(path.join(dir, "partition_table"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bootloader"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bootloader/bootloader.bin"), image(0x6000));
    fs.writeFileSync(path.join(dir, "ota_data_initial.bin"), Buffer.alloc(0x2000, 0xff));
  }
  fs.writeFileSync(path.join(build, "balax.bin"), image(0x100000));
  fs.writeFileSync(path.join(compact, "ota_stub.bin"), image(0x90000));
  const standardTable = table([...common, ["ota_0", 0, 0x10, 0x20000, 0x1e0000],
    ["ota_1", 0, 0x11, 0x200000, 0x1e0000]]);
  const compactTable = table([...common, ["factory", 0, 0, 0x20000, 0xa0000],
    ["ota_0", 0, 0x10, 0xc0000, 0x320000]]);
  fs.writeFileSync(path.join(build, "partition_table/partition-table.bin"), standardTable);
  fs.writeFileSync(path.join(compact, "partition_table/partition-table.bin"), compactTable);
  const plans = { standard: loadUsbFlashPlan(root, "standard"), compact: loadUsbFlashPlan(root, "compact") };
  assert.deepEqual(plans.standard.map((img) => img.offset), [0x1000, 0x8000, 0xf000, 0x20000]);
  assert.deepEqual(plans.compact.map((img) => img.offset), [0x1000, 0x8000, 0xf000, 0x20000, 0xc0000]);
  const port = "/dev/cu.usbserial-test";
  assert.equal(usbFlashArgs(port).at(-1), "flash-id");
  const args = usbFlashArgs(port, plans.compact);
  assert.ok(args.includes("115200") && args.includes("write-flash") && args.includes("--compress"));
  assert.ok(!args.some((word) => word.includes("erase") || word === "read-flash"));
  assert.ok(usbWriteProgress("Writing at 0x00140000", plans.compact)! > 60);
  assert.equal(usbWriteProgress("Wrote 1048576 bytes at 0x000c0000", plans.compact), 98);

  compactTable[19] ^= 1;
  assert.throws(() => readUsbPartitionTable(compactTable), /Invalid ESP-IDF partition table/);
  fs.writeFileSync(path.join(compact, "ota_stub.bin"), image(0xa0001));
  assert.throws(() => loadUsbFlashPlan(root, "compact"), /Factory updater does not fit/);
});

test("USB preflight accepts only the BalaX chip and flash size", () => {
  const output = "Chip type:          ESP32-PICO-D4 (revision v1.0)\nDetected flash size: 4MB\n";
  assert.doesNotThrow(() => verifyUsbFlashDevice(output));
  assert.throws(() => verifyUsbFlashDevice(output.replace("4MB", "8MB")), /USB preflight expected/);
  assert.throws(() => verifyUsbFlashDevice(output.replace("ESP32-PICO-D4", "ESP32-D0WD")), /USB preflight expected/);
});

test("USB power helper builds exact usb_power.py command arguments", () => {
  const dir = "/tmp/balax-test";
  const port = "/dev/cu.usbserial-test";
  assert.deepEqual(usbPowerArgs(dir, "wake", port), [
    path.join(dir, "tools", "usb_power.py"),
    "wake",
    "--port",
    port,
  ]);
  assert.deepEqual(usbPowerArgs(dir, "usb-sleep", port), [
    path.join(dir, "tools", "usb_power.py"),
    "usb-sleep",
    "--port",
    port,
  ]);
  assert.deepEqual(usbPowerArgs(dir, "off", port, true), [
    path.join(dir, "tools", "usb_power.py"),
    "usb-sleep",
    "--port",
    port,
    "--force",
  ]);
});
