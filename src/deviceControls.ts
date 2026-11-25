export type StickCPowerMode = "awake" | "wifi-sleep" | "usb-sleep" | "unknown";
export type UsbSleepOrigin = "host-usb" | "lan-wall" | null;

export type StickCCommChoice = "auto" | "wifi" | "usb";
export type StickCStateChoice = "auto" | "awake" | "wifi-sleep" | "usb-sleep" | "offline";

export type CamCommChoice = "auto" | "udp" | "http" | "usb";
export type CamStateChoice = "auto" | "streaming" | "idle" | "sleep";

export type UsbDeviceKind = "stickc" | "cam" | "shared";

/**
 * Classify a USB-UART bridge chip by USB VID/PID without opening the serial port:
 * - WCH CH340/CH341 (0x1a86:0x7523 / 0x5523) -> "cam" (ESP32-CAM-MB; never used by M5StickC Plus)
 * - FTDI (0x0403:*) and WCH CH9102 (0x1a86:0x55d4) -> "stickc" (M5StickC Plus v1.0 / v1.1)
 * - Other / unknown -> "shared"
 */
export function classifyUsbSerialDevice(
  vid: number | null | undefined,
  pid: number | null | undefined,
): UsbDeviceKind {
  if (vid == null || pid == null) return "shared";
  if (vid === 0x1a86 && (pid === 0x7523 || pid === 0x5523)) return "cam";
  if (vid === 0x0403) return "stickc";
  if (vid === 0x1a86 && pid === 0x55d4) return "stickc";
  return "shared";
}

/**
 * Filter host USB serial ports down to candidate M5StickC Plus ports by excluding
 * any port confirmed to belong to ESP32-CAM or identified by USB VID/PID as a
 * CH340/CH341 ESP32-CAM-MB bridge.
 */
export function filterStickCUsbPorts(
  allPorts: readonly string[],
  camConfirmedPort: string | null,
  portKinds?: ReadonlyMap<string, UsbDeviceKind>,
): string[] {
  return allPorts.filter((port) => {
    if (camConfirmedPort && port === camConfirmedPort) return false;
    if (portKinds?.get(port) === "cam") return false;
    return true;
  });
}

/**
 * Filter host USB serial ports down to candidate ESP32-CAM ports by excluding
 * ports whose USB VID/PID identifies them as an M5StickC Plus (FTDI / CH9102).
 */
export function filterCamUsbPorts(
  allPorts: readonly string[],
  portKinds?: ReadonlyMap<string, UsbDeviceKind>,
): string[] {
  return allPorts.filter((port) => portKinds?.get(port) !== "stickc");
}

/**
 * Reconcile cached StickC powerMode against live connection & USB presence so
 * disconnected / unplugged devices never stay stuck reporting "usb-sleep".
 */
export function reconcileStickCPowerMode(params: {
  connected: boolean;
  powerMode: StickCPowerMode;
  usbSleepOrigin: UsbSleepOrigin;
  usbSleepPort: string | null;
  stickCUsbPorts: readonly string[];
}): {
  powerMode: StickCPowerMode;
  usbSleepOrigin: UsbSleepOrigin;
  usbSleepPort: string | null;
} {
  const { connected, powerMode, usbSleepOrigin, usbSleepPort, stickCUsbPorts } = params;
  if (connected) {
    return { powerMode: "awake", usbSleepOrigin: null, usbSleepPort: null };
  }
  if (powerMode === "usb-sleep") {
    // Only an explicit LAN usb-sleep issued while powered from a wall charger
    // (no host USB port attached) can remain "usb-sleep" without a host USB port.
    if (usbSleepOrigin === "lan-wall") {
      return { powerMode, usbSleepOrigin, usbSleepPort: null };
    }
    if (usbSleepPort !== null && !stickCUsbPorts.includes(usbSleepPort)) {
      return { powerMode: "unknown", usbSleepOrigin: null, usbSleepPort: null };
    }
    if (stickCUsbPorts.length === 0) {
      return { powerMode: "unknown", usbSleepOrigin: null, usbSleepPort: null };
    }
  }
  return { powerMode, usbSleepOrigin, usbSleepPort };
}

/**
 * Decide how StickC powerMode should update when passive wifi-sleep probes fail.
 * Never infer "usb-sleep" unless StickC itself reported USB 5V power AND a
 * non-camera StickC USB port is actually attached to this host.
 */
export function resolveStickCSleepProbeMiss(params: {
  sleepProbeMisses: number;
  stickCUsbPorts: readonly string[];
  lastUsbV: number | null;
}): {
  powerMode: StickCPowerMode;
  usbSleepOrigin: UsbSleepOrigin;
  usbSleepPort: string | null;
} {
  const { sleepProbeMisses, stickCUsbPorts, lastUsbV } = params;
  const hasStickCUsbPower = lastUsbV !== null && lastUsbV >= 4.0;
  if (sleepProbeMisses >= 2 && stickCUsbPorts.length > 0 && hasStickCUsbPower) {
    return {
      powerMode: "usb-sleep",
      usbSleepOrigin: "host-usb",
      usbSleepPort: stickCUsbPorts[0]!,
    };
  }
  if (sleepProbeMisses >= 3) {
    return {
      powerMode: "unknown",
      usbSleepOrigin: null,
      usbSleepPort: null,
    };
  }
  return {
    powerMode: "wifi-sleep",
    usbSleepOrigin: null,
    usbSleepPort: null,
  };
}

export function resolveStickCComm(params: {
  choice: StickCCommChoice;
  connected: boolean;
  powerMode: StickCPowerMode;
  usbAvailable: boolean;
  usbV: number | null;
}): {
  active: "wifi" | "usb";
  isAuto: boolean;
  label: string;
  tone: "usb" | "wifi" | "muted";
  usbReady: boolean;
  usbPowered: boolean;
  canUsbWake: boolean;
  canUsbSleep: boolean;
} {
  const { choice, connected, powerMode, usbAvailable, usbV } = params;
  const usbReady = usbAvailable;
  const usbPowered = usbAvailable || (usbV !== null && usbV >= 4.0);
  const autoActive: "wifi" | "usb" =
    powerMode === "usb-sleep" && usbReady
      ? "usb"
      : connected || powerMode === "wifi-sleep"
        ? "wifi"
        : usbReady
          ? "usb"
          : "wifi";
  const active: "wifi" | "usb" = choice === "auto" ? autoActive : choice;
  const activeText = active === "usb" ? "USB" : "Wi-Fi";
  const isAuto = choice === "auto";
  const label = isAuto ? `Auto · ${activeText}` : activeText;
  const tone: "usb" | "wifi" | "muted" =
    active === "usb"
      ? (usbReady ? "usb" : "muted")
      : (connected || powerMode === "wifi-sleep" ? "wifi" : "muted");

  return {
    active,
    isAuto,
    label,
    tone,
    usbReady,
    usbPowered,
    canUsbWake: usbReady,
    canUsbSleep: connected ? usbPowered : usbReady,
  };
}

export function resolveStickCStateDisplay(params: {
  forcedState: StickCStateChoice;
  connected: boolean;
  powerMode: StickCPowerMode;
  otaActive: boolean;
  otaPhase?: string;
  otaProgress?: number;
}): {
  liveState: "online" | "wifi-sleep" | "usb-sleep" | "offline" | "ota";
  liveLabel: string;
  label: string;
  isForced: boolean;
  tone: "online" | "sleep" | "offline" | "accent";
} {
  const { forcedState, connected, powerMode, otaActive, otaPhase, otaProgress } = params;
  if (otaActive) {
    const otaText = otaPhase === "building" ? "Building…" : `OTA ${otaProgress ?? 0}%`;
    return {
      liveState: "ota",
      liveLabel: otaText,
      label: otaText,
      isForced: false,
      tone: "accent",
    };
  }

  const liveState: "online" | "wifi-sleep" | "usb-sleep" | "offline" = connected
    ? "online"
    : powerMode === "wifi-sleep"
      ? "wifi-sleep"
      : powerMode === "usb-sleep"
        ? "usb-sleep"
        : "offline";

  const liveLabel =
    liveState === "online"
      ? "Online"
      : liveState === "wifi-sleep"
        ? "Wi-Fi Sleep"
        : liveState === "usb-sleep"
          ? "USB Sleep"
          : "Offline";

  const tone: "online" | "sleep" | "offline" =
    liveState === "online" ? "online" : liveState === "offline" ? "offline" : "sleep";

  if (forcedState === "auto") {
    return {
      liveState,
      liveLabel,
      label: `Auto · ${liveLabel}`,
      isForced: false,
      tone,
    };
  }

  const forcedLabel =
    forcedState === "awake"
      ? "Awake"
      : forcedState === "wifi-sleep"
        ? "Wi-Fi Sleep"
        : forcedState === "usb-sleep"
          ? "USB Sleep"
          : "Offline";

  const matches =
    (forcedState === "awake" && liveState === "online") ||
    (forcedState === "wifi-sleep" && liveState === "wifi-sleep") ||
    (forcedState === "usb-sleep" && liveState === "usb-sleep") ||
    (forcedState === "offline" && liveState === "offline");

  return {
    liveState,
    liveLabel,
    label: matches ? forcedLabel : `${forcedLabel} (${liveLabel})`,
    isForced: true,
    tone,
  };
}

export function resolveCamComm(params: {
  choice: CamCommChoice;
  activeTransport: string | null | undefined;
  usbPort: string | null | undefined;
  ip: string | null | undefined;
  available: boolean;
}): {
  active: "udp" | "http" | "usb" | "none";
  isAuto: boolean;
  label: string;
  tone: "usb" | "wifi" | "muted";
} {
  const { choice, activeTransport, usbPort, ip, available } = params;
  const active: "udp" | "http" | "usb" | "none" =
    activeTransport === "udp_ecl1"
      ? "udp"
      : activeTransport === "http_mjpeg"
        ? "http"
        : activeTransport === "usb_ecl1"
          ? "usb"
          : "none";

  const isAuto = choice === "auto";
  if (isAuto) {
    if (active === "usb") return { active, isAuto, label: "Auto · USB", tone: "usb" };
    if (active === "udp") return { active, isAuto, label: "Auto · UDP", tone: "wifi" };
    if (active === "http") return { active, isAuto, label: "Auto · HTTP", tone: "wifi" };
    if (available && ip) return { active, isAuto, label: "Auto · Wi-Fi", tone: "wifi" };
    if (usbPort) return { active, isAuto, label: "Auto · USB", tone: "usb" };
    return { active, isAuto, label: "Auto", tone: "muted" };
  }

  if (choice === "usb") {
    return { active, isAuto, label: "USB", tone: usbPort ? "usb" : "muted" };
  }
  if (choice === "udp") {
    return { active, isAuto, label: "UDP", tone: available || active === "udp" ? "wifi" : "muted" };
  }
  return { active, isAuto, label: "HTTP", tone: available || active === "http" ? "wifi" : "muted" };
}

export function resolveCamStateDisplay(params: {
  forcedState: CamStateChoice;
  status: {
    available: boolean;
    streaming: boolean;
    powerMode: string;
    activeTransport?: string;
    flashJob?: { status: string; progress: number } | null;
  } | null;
}): {
  liveState: "streaming" | "idle" | "sleep" | "cooldown" | "ota" | "offline";
  liveLabel: string;
  label: string;
  isForced: boolean;
  tone: "online" | "idle" | "sleep" | "warn" | "offline" | "accent";
} {
  const { forcedState, status } = params;
  const job = status?.flashJob;
  if (job && job.status === "running") {
    const label = `Flash ${job.progress}%`;
    return { liveState: "ota", liveLabel: label, label, isForced: false, tone: "accent" };
  }

  let liveState: "streaming" | "idle" | "sleep" | "cooldown" | "ota" | "offline" = "offline";
  let liveLabel = "Offline";
  let tone: "online" | "idle" | "sleep" | "warn" | "offline" | "accent" = "offline";

  if (status?.powerMode === "sleep") {
    liveState = "sleep";
    liveLabel = "Deep Sleep";
    tone = "sleep";
  } else if (status?.powerMode === "cooldown") {
    liveState = "cooldown";
    liveLabel = "Cooldown";
    tone = "warn";
  } else if (status?.powerMode === "ota_stub") {
    liveState = "ota";
    liveLabel = "OTA Stub";
    tone = "accent";
  } else if (
    status?.powerMode === "streaming" ||
    (status?.activeTransport && status.activeTransport !== "none")
  ) {
    liveState = "streaming";
    liveLabel = "Streaming";
    tone = "online";
  } else if (status?.powerMode === "idle" || status?.available) {
    liveState = "idle";
    liveLabel = "Cool Idle";
    tone = "idle";
  }

  if (forcedState === "auto") {
    return {
      liveState,
      liveLabel,
      label: `Auto · ${liveLabel}`,
      isForced: false,
      tone,
    };
  }

  const forcedLabel =
    forcedState === "streaming"
      ? "Streaming"
      : forcedState === "idle"
        ? "Cool Idle"
        : "Deep Sleep";

  const matches =
    (forcedState === "streaming" && liveState === "streaming") ||
    (forcedState === "idle" && liveState === "idle") ||
    (forcedState === "sleep" && liveState === "sleep");

  return {
    liveState,
    liveLabel,
    label: matches ? forcedLabel : `${forcedLabel} (${liveLabel})`,
    isForced: true,
    tone,
  };
}
