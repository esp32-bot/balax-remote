/* Status contract shared by the local bridge and browser. */
export type CamTransportPreference = "auto" | "udp" | "http" | "usb";

/** USB ECL1 serial rate for ESP32-FPV. Web Serial and the local bridge both use this. */
export const CAM_USB_BAUD = 921600;
export type CamActiveTransport = "none" | "udp_ecl1" | "http_mjpeg" | "usb_ecl1";
export type CamResolutionId = "qvga" | "vga16" | "vga" | "svga16" | "svga";
export type CamStabMode = "hybrid" | "camera_crop" | "receiver_warp" | "none";
export type CamWifiPs = "none" | "min" | "max";
export type CamThermalState = "ok" | "throttled" | "cooldown";

export interface CamFlashJob {
  id: string;
  kind?: "usb" | "usb_full" | "wifi_ota" | "build";
  port: string;
  status: "running" | "done" | "error";
  phase: "preflight" | "building" | "rebooting_stub" | "flashing" | "verifying" | "done" | "error";
  progress: number;
  message: string;
  detail?: string;
  error: string | null;
}

export interface CamBinaryArtifactInfo {
  exists: boolean;
  sizeBytes: number;
  modifiedAtMs: number;
  sha256Short: string;
  path: string;
}

export interface CamOtaInfoResponse {
  ok: boolean;
  host: string;
  available: boolean;
  ip: string | null;
  powerMode: string;
  runningPartition: string | null;
  isStub: boolean;
  dieTempC: number | null;
  thermalState: CamThermalState;
  ports: string[];
  pythonReady: boolean;
  binary: CamBinaryArtifactInfo;
  stubBinary: CamBinaryArtifactInfo;
  fullFlashReady: boolean;
  job: CamFlashJob | null;
}

export interface CamSystemStatus {
  cpu0LoadPct: number | null;
  cpu1LoadPct: number | null;
  dramTotalBytes: number | null;
  dramMinFreeBytes: number | null;
  psramTotalBytes: number | null;
  psramMinFreeBytes: number | null;
  flashTotalBytes: number | null;
  runningPartition: string | null;
  runningPartitionBytes: number | null;
}

export interface CamBridgeStatus {
  available: boolean;
  optional: true;
  host: string;
  ip: string | null;
  streaming: boolean;
  transportPreference: CamTransportPreference;
  activeTransport: CamActiveTransport;
  powerMode: "idle" | "streaming" | "sleep" | "cooldown" | "ota_stub" | "unknown";
  cameraOn: boolean;
  cpuMhz: number | null;
  streamCpuMhz: number | null;
  cpuDfs: boolean;
  idleCpuMhz: number;
  wifiPs: CamWifiPs;
  wifiTxDbm: number;
  resolution: CamResolutionId;
  xclkMhz: number;
  pll2x: boolean;
  system: CamSystemStatus | null;
  fps: number;
  fpsTarget: number | null;
  kbps: number;
  rawKbps: number;
  savingsPct: number;
  quality: number | null;
  effectiveQuality: number | null;
  autoQuality: boolean;
  codecMode: string;
  codecSetting: "dct" | "passthrough";
  sparseThreshold: number;
  changedBlocks: number;
  totalBlocks: number;
  vflip: boolean;
  hmirror: boolean;
  stabMode: CamStabMode;
  cropAlignPx: number;
  maxSlewPx: number;
  vfovDeg: number;
  cropY: number;
  dieTempC: number | null;
  thermalState: CamThermalState;
  thermalLimitC: number;
  txDrops: number;
  frameSkipEnabled: boolean;
  frameId: number;
  skippedFrames: number;
  width: number;
  height: number;
  hasAttitude: boolean;
  pitchCdeg: number;
  rollCdeg: number;
  telemSource: string;
  rssi: number | null;
  freePsram: number | null;
  freeDram: number | null;
  idleS: number | null;
  deepSleepTimeoutS: number | null;
  usbPort: string | null;
  usbPorts: string[];
  /** Set while this camera link is USB serial. Null on Wi-Fi. */
  usbBaud: number | null;
  badPackets: number;
  droppedIncomplete: number;
  lastFrameAgeMs: number | null;
  flashJob: CamFlashJob | null;
  flashReady: boolean;
  message?: string;
}
