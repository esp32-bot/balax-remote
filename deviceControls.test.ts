import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUsbSerialDevice,
  filterCamUsbPorts,
  filterStickCUsbPorts,
  reconcileStickCPowerMode,
  resolveCamComm,
  resolveCamStateDisplay,
  resolveStickCComm,
  resolveStickCSleepProbeMiss,
  resolveStickCStateDisplay,
} from "./src/deviceControls.ts";

test("filterStickCUsbPorts excludes confirmed ESP32-CAM USB port", () => {
  assert.deepEqual(
    filterStickCUsbPorts(["/dev/cu.usbserial-110"], "/dev/cu.usbserial-110"),
    [],
  );
  assert.deepEqual(
    filterStickCUsbPorts(["/dev/cu.usbserial-110", "/dev/cu.usbserial-220"], "/dev/cu.usbserial-110"),
    ["/dev/cu.usbserial-220"],
  );
  assert.deepEqual(
    filterStickCUsbPorts(["/dev/cu.usbserial-110"], null),
    ["/dev/cu.usbserial-110"],
  );
});

test("reconcileStickCPowerMode clears false/stale usb-sleep when StickC USB is not connected", () => {
  // Unplugged host-usb sleep clears immediately to unknown (Offline)
  assert.deepEqual(
    reconcileStickCPowerMode({
      connected: false,
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: "/dev/cu.usbserial-220",
      stickCUsbPorts: [],
    }),
    { powerMode: "unknown", usbSleepOrigin: null, usbSleepPort: null },
  );

  // Unknown-origin usb-sleep with no StickC USB port clears to unknown
  assert.deepEqual(
    reconcileStickCPowerMode({
      connected: false,
      powerMode: "usb-sleep",
      usbSleepOrigin: null,
      usbSleepPort: null,
      stickCUsbPorts: [],
    }),
    { powerMode: "unknown", usbSleepOrigin: null, usbSleepPort: null },
  );

  // Still plugged on the same StickC USB port stays usb-sleep
  assert.deepEqual(
    reconcileStickCPowerMode({
      connected: false,
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: "/dev/cu.usbserial-220",
      stickCUsbPorts: ["/dev/cu.usbserial-220"],
    }),
    {
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: "/dev/cu.usbserial-220",
    },
  );

  // Explicit LAN wall-charger usb-sleep stays usb-sleep without host port
  assert.deepEqual(
    reconcileStickCPowerMode({
      connected: false,
      powerMode: "usb-sleep",
      usbSleepOrigin: "lan-wall",
      usbSleepPort: null,
      stickCUsbPorts: [],
    }),
    { powerMode: "usb-sleep", usbSleepOrigin: "lan-wall", usbSleepPort: null },
  );

  // Reconnecting over Wi-Fi always promotes to awake
  assert.deepEqual(
    reconcileStickCPowerMode({
      connected: true,
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: "/dev/cu.usbserial-220",
      stickCUsbPorts: ["/dev/cu.usbserial-220"],
    }),
    { powerMode: "awake", usbSleepOrigin: null, usbSleepPort: null },
  );
});

test("resolveStickCSleepProbeMiss never infers usb-sleep without both StickC USB port and 5V USB power", () => {
  // No StickC USB ports (e.g. only ESP32-CAM plugged in) -> stays wifi-sleep then goes offline (unknown)
  assert.equal(
    resolveStickCSleepProbeMiss({ sleepProbeMisses: 2, stickCUsbPorts: [], lastUsbV: 5.0 }).powerMode,
    "wifi-sleep",
  );
  assert.equal(
    resolveStickCSleepProbeMiss({ sleepProbeMisses: 3, stickCUsbPorts: [], lastUsbV: 5.0 }).powerMode,
    "unknown",
  );

  // Unidentified serial port present, but StickC had no USB power (battery only) -> NEVER usb-sleep!
  assert.equal(
    resolveStickCSleepProbeMiss({
      sleepProbeMisses: 2,
      stickCUsbPorts: ["/dev/cu.usbserial-110"],
      lastUsbV: 0.0,
    }).powerMode,
    "wifi-sleep",
  );
  assert.equal(
    resolveStickCSleepProbeMiss({
      sleepProbeMisses: 3,
      stickCUsbPorts: ["/dev/cu.usbserial-110"],
      lastUsbV: null,
    }).powerMode,
    "unknown",
  );

  // Both StickC USB port AND StickC 5V USB rail present -> valid host-usb usb-sleep inference
  assert.deepEqual(
    resolveStickCSleepProbeMiss({
      sleepProbeMisses: 2,
      stickCUsbPorts: ["/dev/cu.usbserial-220"],
      lastUsbV: 4.95,
    }),
    {
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: "/dev/cu.usbserial-220",
    },
  );
});

test("resolveStickCComm and resolveStickCStateDisplay handle auto defaults and forced overrides", () => {
  const autoOnline = resolveStickCComm({
    choice: "auto",
    connected: true,
    powerMode: "awake",
    usbAvailable: false,
    usbV: 0,
  });
  assert.equal(autoOnline.label, "Auto · Wi-Fi");
  assert.equal(autoOnline.canUsbSleep, false);

  const forcedUsb = resolveStickCComm({
    choice: "usb",
    connected: false,
    powerMode: "unknown",
    usbAvailable: true,
    usbV: null,
  });
  assert.equal(forcedUsb.label, "USB");
  assert.equal(forcedUsb.isAuto, false);
  assert.equal(forcedUsb.tone, "usb");

  const stAuto = resolveStickCStateDisplay({
    forcedState: "auto",
    connected: false,
    powerMode: "unknown",
    otaActive: false,
  });
  assert.equal(stAuto.label, "Auto · Offline");
  assert.equal(stAuto.isForced, false);

  const stForcedDiverged = resolveStickCStateDisplay({
    forcedState: "awake",
    connected: false,
    powerMode: "wifi-sleep",
    otaActive: false,
  });
  assert.equal(stForcedDiverged.label, "Awake (Wi-Fi Sleep)");
  assert.equal(stForcedDiverged.isForced, true);
});

test("resolveCamComm and resolveCamStateDisplay handle auto defaults and forced overrides", () => {
  const autoUdp = resolveCamComm({
    choice: "auto",
    activeTransport: "udp_ecl1",
    usbPort: "/dev/cu.usbserial-110",
    ip: "10.0.0.202",
    available: true,
  });
  assert.equal(autoUdp.label, "Auto · UDP");
  assert.equal(autoUdp.tone, "wifi");

  const forcedUsb = resolveCamComm({
    choice: "usb",
    activeTransport: "none",
    usbPort: "/dev/cu.usbserial-110",
    ip: null,
    available: true,
  });
  assert.equal(forcedUsb.label, "USB");
  assert.equal(forcedUsb.isAuto, false);
  assert.equal(forcedUsb.tone, "usb");

  const camAutoIdle = resolveCamStateDisplay({
    forcedState: "auto",
    status: { available: true, streaming: false, powerMode: "idle", activeTransport: "none" },
  });
  assert.equal(camAutoIdle.label, "Auto · Cool Idle");
  assert.equal(camAutoIdle.tone, "idle");

  const camForcedStream = resolveCamStateDisplay({
    forcedState: "streaming",
    status: { available: true, streaming: true, powerMode: "streaming", activeTransport: "udp_ecl1" },
  });
  assert.equal(camForcedStream.label, "Streaming");
  assert.equal(camForcedStream.isForced, true);
  assert.equal(camForcedStream.tone, "online");
});

test("classifyUsbSerialDevice separates CH340 ESP32-CAM from FTDI/CH9102 M5StickC Plus", () => {
  assert.equal(classifyUsbSerialDevice(0x1a86, 0x7523), "cam"); // CH340
  assert.equal(classifyUsbSerialDevice(0x0403, 0x6001), "stickc"); // FTDI
  assert.equal(classifyUsbSerialDevice(0x1a86, 0x55d4), "stickc"); // CH9102
  assert.equal(classifyUsbSerialDevice(0x10c4, 0xea60), "shared"); // CP210x
  assert.equal(classifyUsbSerialDevice(null, null), "shared");

  const kinds = new Map([
    ["/dev/cu.usbserial-110", classifyUsbSerialDevice(0x1a86, 0x7523)],
    ["/dev/cu.usbserial-220", classifyUsbSerialDevice(0x0403, 0x6010)],
  ]);
  assert.deepEqual(
    filterStickCUsbPorts(["/dev/cu.usbserial-110", "/dev/cu.usbserial-220"], null, kinds),
    ["/dev/cu.usbserial-220"],
  );
  assert.deepEqual(
    filterStickCUsbPorts(["/dev/cu.usbserial-110"], null, kinds),
    [],
  );
  assert.deepEqual(
    filterCamUsbPorts(["/dev/cu.usbserial-110", "/dev/cu.usbserial-220"], kinds),
    ["/dev/cu.usbserial-110"],
  );
});
