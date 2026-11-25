import {
  createBrowserSettingsRegistry,
  type ParameterSpec,
  type ParameterValue,
  type SettingsRegistry,
} from "@g-ai/ui";
import type {
  CamBridgeStatus,
  CamResolutionId,
  CamStabMode,
  CamTransportPreference,
  CamWifiPs,
} from "./cameraProtocol";

export const DEFAULT_CAMERA_HOST = "balax-cam.local";
const STORAGE_KEY = "balax.camera.settings.v2";
const TAB = "camera";

export const CAMERA_SETTING = {
  transport: "camera.stream.transport",
  host: "camera.stream.host",
  resolution: "camera.stream.resolution",
  fps: "camera.stream.fps",
  quality: "camera.sensor.quality",
  autoQuality: "camera.sensor.autoQuality",
  xclkMhz: "camera.sensor.xclkMhz",
  pll2x: "camera.sensor.pll2x",
  flip: "camera.sensor.vflip",
  mirror: "camera.sensor.hmirror",
  codec: "camera.codec.mode",
  sparseThreshold: "camera.codec.sparseThreshold",
  frameSkip: "camera.codec.frameSkip",
  stabilization: "camera.stabilization.mode",
  receiverWarp: "camera.stabilization.receiverWarp",
  cropAlignPx: "camera.stabilization.cropAlignPx",
  maxSlewPx: "camera.stabilization.maxSlewPx",
  vfovDeg: "camera.stabilization.vfovDeg",
  clock: "camera.power.streamCpuMhz",
  cpuDfs: "camera.power.cpuDfs",
  idleCpuMhz: "camera.power.idleCpuMhz",
  wifiPs: "camera.power.wifiPs",
  wifiTxDbm: "camera.power.wifiTxDbm",
  thermalLimitC: "camera.power.thermalLimitC",
  sleepTimeout: "camera.power.deepSleepTimeoutS",
  hud: "camera.display.hud",
} as const;

export const CAMERA_SETTINGS_SECTIONS = [
  { id: "stream", title: "Stream & resolution" },
  { id: "stabilization", title: "Stabilization" },
  { id: "sensor", title: "Sensor & clock" },
  { id: "codec", title: "Compression" },
  { id: "power", title: "CPU, power & thermal" },
  { id: "display", title: "Display" },
] as const;

function readBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type CameraParameterSpec = Omit<ParameterSpec, "id" | "home" | "appliesLive" | "source">;

function parameter(id: string, section: (typeof CAMERA_SETTINGS_SECTIONS)[number]["id"], spec: CameraParameterSpec): ParameterSpec {
  return {
    ...spec,
    id,
    home: { tab: TAB, section, level: "main" },
    appliesLive: true,
    source: "src/cameraSettings.ts",
  };
}

const PARAMETERS: ParameterSpec[] = [
  parameter(CAMERA_SETTING.transport, "stream", {
    label: "Transport",
    description: "Chooses how the local bridge reads video from the camera. USB uses 921600-baud serial with full config/status control.",
    kind: "choice", unit: "none", default: "auto" satisfies CamTransportPreference,
    defaultReason: "Auto prefers low-latency UDP, then HTTP MJPEG, then USB serial.",
    choices: [
      { id: "auto", label: "Auto (UDP → HTTP → USB)" },
      { id: "udp", label: "Wi-Fi UDP (ECL1)" },
      { id: "http", label: "Wi-Fi HTTP (MJPEG)" },
      { id: "usb", label: "USB Serial (921600)" },
    ],
  }),
  parameter(CAMERA_SETTING.host, "stream", {
    label: "Camera address",
    description: "Hostname or IP address used to reach the camera over Wi-Fi.",
    kind: "text", unit: "none", default: DEFAULT_CAMERA_HOST,
    defaultReason: "This is the ESP32-CAM's advertised mDNS hostname.",
  }),
  parameter(CAMERA_SETTING.resolution, "stream", {
    label: "Resolution",
    description: "Switches OV2640 output & crop window live without rebooting. 16:9 modes give ±72 px pitch stabilization margin and hit up to 40 fps.",
    kind: "choice", unit: "none", default: "qvga" satisfies CamResolutionId,
    defaultReason: "QVGA (320×240) supports temporal DCT + on-camera pitch crop at minimal bandwidth and heat.",
    choices: [
      { id: "qvga", label: "QVGA 320×240 (±28px crop · DCT)" },
      { id: "vga16", label: "VGA16 640×360 (±72px crop · 16:9)" },
      { id: "vga", label: "VGA 640×480 (±60px crop · 4:3)" },
      { id: "svga16", label: "SVGA16 800×456 (±72px crop · 40 fps)" },
      { id: "svga", label: "SVGA 800×600 (Full 4:3 · 30+ fps)" },
    ],
  }),
  parameter(CAMERA_SETTING.fps, "stream", {
    label: "Frame rate cap",
    description: "Limits capture cadence (2–45 fps). Set to 0 for uncapped sensor speed (minimum latency).",
    kind: "number", unit: "fps", default: 20,
    defaultReason: "20 fps balances low latency with cool operation; set 0 for uncapped 30–40 fps.",
    bounds: () => ({ min: 0, max: 45 }), step: 1,
  }),
  parameter(CAMERA_SETTING.stabilization, "stabilization", {
    label: "Stabilization mode",
    description: "Hybrid (default) stabilizes pitch on-camera via OV2640 hardware DSP crop (cutting wire bytes & heat) and sends tiny residual pitch+roll for browser cleanup.",
    kind: "choice", unit: "none", default: "hybrid" satisfies CamStabMode,
    defaultReason: "On-camera OV2640 crop stabilizes pitch at 0% ESP32 CPU and cuts temporal bitrate by ~40%.",
    choices: [
      { id: "hybrid", label: "Camera + Client (Default)" },
      { id: "camera_crop", label: "Camera Only (OV2640)" },
      { id: "receiver_warp", label: "Client Only (Full FoV)" },
      { id: "none", label: "Off" },
    ],
  }),
  parameter(CAMERA_SETTING.receiverWarp, "stabilization", {
    label: "Browser horizon warp",
    description: "Applies client-side pitch/roll warp in Hybrid or Client Only modes. Automatically bypassed in Camera Only or Off modes.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Cleans up roll and sub-4px residual pitch in the browser canvas.",
  }),
  parameter(CAMERA_SETTING.cropAlignPx, "stabilization", {
    label: "On-camera crop step",
    description: "OV2640 DSP crop quantization step in pixels. 4 px gives best PSNR and lowest DCT bitrate.",
    kind: "choice", unit: "none", default: "4",
    defaultReason: "4 px alignment outperformed 16 px by +1.7 dB and −40% wire bytes in ablation.",
    choices: [
      { id: "4", label: "4 px (Best)" },
      { id: "8", label: "8 px" },
      { id: "16", label: "16 px (MCU)" },
    ],
  }),
  parameter(CAMERA_SETTING.maxSlewPx, "stabilization", {
    label: "Crop max slew",
    description: "Maximum vertical crop shift per frame in pixels.",
    kind: "number", unit: "px", default: 24,
    defaultReason: "Tracks fast BalaX balancing pitch oscillations cleanly without jarring jumps.",
    bounds: () => ({ min: 4, max: 64 }), step: 4,
  }),
  parameter(CAMERA_SETTING.vfovDeg, "stabilization", {
    label: "Vertical FoV",
    description: "Lens vertical field of view in degrees (stock OV2640 2.8mm lens ≈ 52°).",
    kind: "number", unit: "deg", default: 52,
    defaultReason: "Matches the stock AI-Thinker OV2640 module.",
    bounds: () => ({ min: 25, max: 95 }), step: 1,
  }),
  parameter(CAMERA_SETTING.quality, "sensor", {
    label: "Base JPEG quality (QS)",
    description: "Lower numbers preserve more detail and use more bandwidth (10 = best, 63 = smallest).",
    kind: "number", unit: "none", default: 14,
    defaultReason: "QS 14 is crisp while keeping frame sizes compact.",
    bounds: () => ({ min: 10, max: 63 }), step: 1,
  }),
  parameter(CAMERA_SETTING.autoQuality, "sensor", {
    label: "Adaptive JPEG quality",
    description: "Automatically raises QS slightly on Wi-Fi/USB congestion or thermal throttle to hold smooth FPS without drops.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Prevents DMA/TX stalls on complex textures and USB serial links.",
  }),
  parameter(CAMERA_SETTING.xclkMhz, "sensor", {
    label: "OV2640 XCLK",
    description: "Sensor input clock. 12 MHz runs cool (up to 30 fps with 2× PLL); 16 MHz unlocks 40 fps on 800×456 / 640×480.",
    kind: "choice", unit: "none", default: "12",
    defaultReason: "12 MHz minimizes LEDC & OV2640 switching heat while hitting 30 fps with 2× PLL.",
    choices: [
      { id: "10", label: "10 MHz (Coolest)" },
      { id: "12", label: "12 MHz (Balanced · 30 fps)" },
      { id: "16", label: "16 MHz (Fast · 40 fps)" },
      { id: "20", label: "20 MHz (Overclock)" },
    ],
  }),
  parameter(CAMERA_SETTING.pll2x, "sensor", {
    label: "OV2640 2× PLL doubler",
    description: "Enables OV2640 CLKRC bit 7 (clk_2x=1), doubling SVGA sensor frame rate from ~15 fps to 30–40 fps.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Halves sensor scanout latency and matches/beats 800×600 @ 30 fps.",
  }),
  parameter(CAMERA_SETTING.flip, "sensor", {
    label: "Vertical flip",
    description: "Flips the image vertically in the sensor.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Matches the camera's mounting orientation on BalaX.",
  }),
  parameter(CAMERA_SETTING.mirror, "sensor", {
    label: "Horizontal mirror",
    description: "Mirrors the image horizontally in the sensor.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Matches the camera's mounting orientation on BalaX.",
  }),
  parameter(CAMERA_SETTING.codec, "codec", {
    label: "Compression",
    description: "Temporal DCT sends only changed 8×8 blocks on QVGA. Higher resolutions automatically use Spatial JPEG + Frame Skip.",
    kind: "choice", unit: "none", default: "dct",
    defaultReason: "Temporal DCT + on-camera crop cuts QVGA traffic by ~67%.",
    choices: [
      { id: "passthrough", label: "Spatial JPEG (Lowest latency)" },
      { id: "dct", label: "Temporal DCT (QVGA · Lowest BW)" },
    ],
  }),
  parameter(CAMERA_SETTING.sparseThreshold, "codec", {
    label: "Sparse threshold",
    description: "Temporal DCT omits coefficient changes at or below this threshold (0 = exact, 2 = visually lossless).",
    kind: "number", unit: "none", default: 2,
    defaultReason: "Threshold 2 delivers major bitrate savings with minimal visual change.",
    bounds: () => ({ min: 0, max: 8 }), step: 1, alwaysShowTrack: true,
  }),
  parameter(CAMERA_SETTING.frameSkip, "codec", {
    label: "Skip identical frames",
    description: "Suppresses repeated JPEG frames in spatial mode to cut radio heat and bandwidth on static scenes.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Avoids transmitting duplicate static frames.",
  }),
  parameter(CAMERA_SETTING.clock, "power", {
    label: "Active CPU clock",
    description: "Maximum ESP32 PLL clock while streaming (80, 160, or 240 MHz — all classic ESP32 PLL steps).",
    kind: "choice", unit: "none", default: "160",
    defaultReason: "160 MHz handles DCT & 30 fps cleanly; choose 240 MHz for max FPS or 80 MHz for lowest heat.",
    choices: [
      { id: "80", label: "80 MHz (Coolest)" },
      { id: "160", label: "160 MHz (Balanced)" },
      { id: "240", label: "240 MHz (Max Speed)" },
    ],
  }),
  parameter(CAMERA_SETTING.cpuDfs, "power", {
    label: "Dynamic DFS between frames",
    description: "Bursts CPU to Active Clock during capture/encode and drops to 80 MHz between frames to save power & heat. Disable for zero-jitter fixed clock.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "Cuts average MCU heat significantly without hurting capture speed.",
  }),
  parameter(CAMERA_SETTING.idleCpuMhz, "power", {
    label: "Cool Idle CPU clock",
    description: "Minimum ESP32 XTAL divider clock when no viewer is watching (OV2640 is powered off via GPIO32).",
    kind: "choice", unit: "none", default: "40",
    defaultReason: "40 MHz with tickless light sleep stays responsive while running cool.",
    choices: [
      { id: "10", label: "10 MHz (Ultra Cool)" },
      { id: "20", label: "20 MHz (Very Cool)" },
      { id: "40", label: "40 MHz (Balanced)" },
      { id: "80", label: "80 MHz (No XTAL drop)" },
    ],
  }),
  parameter(CAMERA_SETTING.wifiPs, "power", {
    label: "Streaming Wi-Fi sleep",
    description: "Wi-Fi modem sleep while streaming. None eliminates 100 ms DTIM latency spikes. Cool Idle always uses Max modem sleep.",
    kind: "choice", unit: "none", default: "none" satisfies CamWifiPs,
    defaultReason: "WIFI_PS_NONE minimizes streaming latency.",
    choices: [
      { id: "none", label: "Off (Min Latency)" },
      { id: "min", label: "Min Modem (Balanced)" },
      { id: "max", label: "Max Modem (Coolest)" },
    ],
  }),
  parameter(CAMERA_SETTING.wifiTxDbm, "power", {
    label: "Wi-Fi TX power",
    description: "Radio transmit power cap (8–20 dBm). Lower power reduces heat and brownout risk.",
    kind: "number", unit: { id: "dBm", text: "dBm" }, default: 13,
    defaultReason: "+13 dBm prevents brownouts on USB-powered ESP32-CAM boards.",
    bounds: () => ({ min: 8, max: 20 }), step: 1,
  }),
  parameter(CAMERA_SETTING.thermalLimitC, "power", {
    label: "Thermal throttle limit",
    description: "Die temperature soft-throttle limit (55–95 °C). Hard cooldown cuts OV2640 power at +10 °C above this limit.",
    kind: "number", unit: { id: "C", text: "°C" }, default: 75,
    defaultReason: "ESP32-CAM runs hotter than M5StickC Plus; 75 °C throttle / 85 °C cooldown protects hardware.",
    bounds: () => ({ min: 55, max: 95 }), step: 1,
  }),
  parameter(CAMERA_SETTING.sleepTimeout, "power", {
    label: "Deep sleep after idle",
    description: "Time awake in Cool Idle after the last activity. Zero disables automatic deep sleep.",
    kind: "number", numberControl: "field", unit: "s", default: 300,
    defaultReason: "Five idle minutes let the camera stay reachable briefly before deep sleep.",
    bounds: () => ({ min: 0, max: 86400 }), step: 1,
  }),
  parameter(CAMERA_SETTING.hud, "display", {
    label: "Preview HUD",
    description: "Shows the horizon guide, pitch, roll, resolution, latency, die temp and attitude source on the preview.",
    kind: "boolean", unit: "none", default: true,
    defaultReason: "The overlay shows stabilization mode, latency, and thermal telemetry at a glance.",
  }),
];

export function createCameraSettings(): SettingsRegistry {
  const localStorage = readBrowserStorage();
  const settings = createBrowserSettingsRegistry(localStorage ? {
    storage: {
      getItem: () => localStorage.getItem(STORAGE_KEY),
      setItem: (_, value) => localStorage.setItem(STORAGE_KEY, value),
    },
  } : {});
  settings.register(PARAMETERS);
  for (const section of CAMERA_SETTINGS_SECTIONS) settings.setSectionTitle(TAB, section.id, section.title);
  return settings;
}

export const CAMERA_DEVICE_SETTINGS = {
  resolution: CAMERA_SETTING.resolution,
  fps: CAMERA_SETTING.fps,
  quality: CAMERA_SETTING.quality,
  auto_quality: CAMERA_SETTING.autoQuality,
  xclk_mhz: CAMERA_SETTING.xclkMhz,
  pll_2x: CAMERA_SETTING.pll2x,
  vflip: CAMERA_SETTING.flip,
  hmirror: CAMERA_SETTING.mirror,
  codec: CAMERA_SETTING.codec,
  sparse_threshold: CAMERA_SETTING.sparseThreshold,
  frame_skip: CAMERA_SETTING.frameSkip,
  stab_mode: CAMERA_SETTING.stabilization,
  crop_align_px: CAMERA_SETTING.cropAlignPx,
  max_slew_px: CAMERA_SETTING.maxSlewPx,
  vfov_deg: CAMERA_SETTING.vfovDeg,
  cpu_mhz: CAMERA_SETTING.clock,
  cpu_dfs: CAMERA_SETTING.cpuDfs,
  idle_cpu_mhz: CAMERA_SETTING.idleCpuMhz,
  wifi_ps: CAMERA_SETTING.wifiPs,
  wifi_tx_dbm: CAMERA_SETTING.wifiTxDbm,
  thermal_limit_c: CAMERA_SETTING.thermalLimitC,
  deep_sleep_timeout_s: CAMERA_SETTING.sleepTimeout,
} as const;

export function readCameraConfig(settings: SettingsRegistry, defaults = false) {
  const read = <T extends ParameterValue>(id: string) => defaults
    ? settings.inspect(id).defaultValue as T
    : settings.get<T>(id);
  return {
    resolution: read<CamResolutionId>(CAMERA_DEVICE_SETTINGS.resolution),
    fps: read<number>(CAMERA_DEVICE_SETTINGS.fps),
    quality: read<number>(CAMERA_DEVICE_SETTINGS.quality),
    auto_quality: read<boolean>(CAMERA_DEVICE_SETTINGS.auto_quality),
    xclk_mhz: Number(read<string>(CAMERA_DEVICE_SETTINGS.xclk_mhz)),
    pll_2x: read<boolean>(CAMERA_DEVICE_SETTINGS.pll_2x),
    vflip: read<boolean>(CAMERA_DEVICE_SETTINGS.vflip),
    hmirror: read<boolean>(CAMERA_DEVICE_SETTINGS.hmirror),
    codec: read<CamBridgeStatus["codecSetting"]>(CAMERA_DEVICE_SETTINGS.codec),
    sparse_threshold: read<number>(CAMERA_DEVICE_SETTINGS.sparse_threshold),
    frame_skip: read<boolean>(CAMERA_DEVICE_SETTINGS.frame_skip),
    stab_mode: read<CamStabMode>(CAMERA_DEVICE_SETTINGS.stab_mode),
    crop_align_px: Number(read<string>(CAMERA_DEVICE_SETTINGS.crop_align_px)),
    max_slew_px: read<number>(CAMERA_DEVICE_SETTINGS.max_slew_px),
    vfov_deg: read<number>(CAMERA_DEVICE_SETTINGS.vfov_deg),
    cpu_mhz: Number(read<string>(CAMERA_DEVICE_SETTINGS.cpu_mhz)),
    cpu_dfs: read<boolean>(CAMERA_DEVICE_SETTINGS.cpu_dfs),
    idle_cpu_mhz: Number(read<string>(CAMERA_DEVICE_SETTINGS.idle_cpu_mhz)),
    wifi_ps: read<CamWifiPs>(CAMERA_DEVICE_SETTINGS.wifi_ps),
    wifi_tx_dbm: read<number>(CAMERA_DEVICE_SETTINGS.wifi_tx_dbm),
    thermal_limit_c: read<number>(CAMERA_DEVICE_SETTINGS.thermal_limit_c),
    deep_sleep_timeout_s: read<number>(CAMERA_DEVICE_SETTINGS.deep_sleep_timeout_s),
  };
}

export type CameraConfig = ReturnType<typeof readCameraConfig>;

const STRING_CHOICE_KEYS = new Set<keyof CameraConfig>(["cpu_mhz", "idle_cpu_mhz", "xclk_mhz", "crop_align_px"]);

export function readAppliedCameraConfig(status: CamBridgeStatus | null, lastApplied?: CameraConfig): CameraConfig | undefined {
  if (status?.fpsTarget == null || status.quality == null) return lastApplied;
  const clockFromStream = status.cameraOn && (status.codecSetting === "passthrough" || status.cpuMhz === 240)
    ? status.cpuMhz : null;
  return {
    resolution: status.resolution ?? lastApplied?.resolution ?? "qvga",
    fps: status.fpsTarget,
    quality: status.quality,
    auto_quality: status.autoQuality ?? lastApplied?.auto_quality ?? true,
    xclk_mhz: status.xclkMhz ?? lastApplied?.xclk_mhz ?? 12,
    pll_2x: status.pll2x ?? lastApplied?.pll_2x ?? true,
    vflip: status.vflip,
    hmirror: status.hmirror,
    codec: status.codecSetting,
    sparse_threshold: status.sparseThreshold,
    frame_skip: status.frameSkipEnabled,
    stab_mode: status.stabMode,
    crop_align_px: status.cropAlignPx ?? lastApplied?.crop_align_px ?? 4,
    max_slew_px: status.maxSlewPx ?? lastApplied?.max_slew_px ?? 24,
    vfov_deg: status.vfovDeg ?? lastApplied?.vfov_deg ?? 52,
    cpu_mhz: status.streamCpuMhz ?? clockFromStream ?? lastApplied?.cpu_mhz ?? 160,
    cpu_dfs: status.cpuDfs ?? lastApplied?.cpu_dfs ?? true,
    idle_cpu_mhz: status.idleCpuMhz ?? lastApplied?.idle_cpu_mhz ?? 40,
    wifi_ps: status.wifiPs ?? lastApplied?.wifi_ps ?? "none",
    wifi_tx_dbm: status.wifiTxDbm ?? lastApplied?.wifi_tx_dbm ?? 13,
    thermal_limit_c: status.thermalLimitC ?? lastApplied?.thermal_limit_c ?? 75,
    deep_sleep_timeout_s: status.deepSleepTimeoutS ?? lastApplied?.deep_sleep_timeout_s ?? 300,
  };
}

export function cameraConfigDiff(config: CameraConfig, applied: CameraConfig): Partial<CameraConfig> {
  const keys = Object.keys(config) as (keyof CameraConfig)[];
  return Object.fromEntries(keys.filter(key => config[key] !== applied[key]).map(key => [key, config[key]]));
}

export function writeCameraConfig(settings: SettingsRegistry, config: CameraConfig, preserveEdits?: ReadonlySet<string>): void {
  const keys = Object.keys(CAMERA_DEVICE_SETTINGS) as (keyof CameraConfig)[];
  for (const key of keys) {
    const id = CAMERA_DEVICE_SETTINGS[key];
    if (preserveEdits && (preserveEdits.has(id) || settings.inspect(id).layers.saved !== undefined)) continue;
    const value = STRING_CHOICE_KEYS.has(key) ? String(config[key]) : config[key];
    if (settings.get(id) !== value) settings.set(id, value);
  }
}

export type CameraTransport = CamTransportPreference;
export type CameraSettingValue = ParameterValue;
