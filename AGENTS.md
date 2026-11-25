# Agent instructions

This repository is the BalaX web remote, 3D Babylon.js visualizer, browser-first calibration/HIL studio, OTA & system monitor, and 100 Hz telemetry bridge (`esp32-bot/balax-remote`).

## Thin-Robot Offload & Continuous Optimization Policy

- **Offload as much work as possible from the robot (`balax`) and JoyX onto this companion web app (`balax-remote` + `@g-ai/rc`)** so it runs on a smartphone, tablet, or laptop while the ESP32 stays cool, tiny, and fast.
- **GitHub Releases OTA** runs here (browser HTTPS fetch + SHA-256 verification + `IndexedDB` caching + `zlib` compression → uniform local LAN push to `balax.local`), keeping TLS/`mbedtls` completely off the robot.
- **JoyX Companion Bridge:** Support JoyX both as a physical joystick and as an ESP-NOW ↔ USB/Wi-Fi bridge feeding this app when no router is available.
- **Optimize continuously using our monitoring tools:** Keep the **CPU**, **RAM**, **Flash**, and thermal warning UI accurate, lightweight, and actionable (e.g. 1-click LCD off, stream stop, pre-flight battery ≥ 30% & thermal gates).

## USB flashing

- Ask before writing firmware over USB. When this app is open, route USB flashes through the web UI or its local bridge and display the progress bar and messages in the app.
- Skip backing up installed firmware unless the user explicitly requests a backup.
- Use a direct terminal USB flash only when this app is closed. If the open app cannot handle the requested image or partition layout, report the blocker and pause the flash.

## Idle power, sleep & USB off

- **Do not leave the bridge polling a robot that should stay cool.** When BalaX is not being actively driven, tuned, or flashed, put it into **`off`** (when USB-plugged, so it charges cool in deep sleep and can reboot via **Wake USB** / `./tools/bx wake --usb`) or **`sleep`** (when wireless, keeping Wi-Fi reachable via **Wake Wi-Fi** / `./tools/bx wake`).
- **Companion power controls:** Use the top-bar **Sleep**, **Off (USB)**, **Wake Wi-Fi**, and **Wake USB** controls or `POST /api/bridge/power` (`{ mode: "sleep" | "off" | "wake", via: "lan" | "usb" }`). USB wake/off requires a local same-origin request to this bridge.
- **Anti-wake behavior:** When BalaX reports `X-Power-Mode: sleep` on `/api/stream` or `power_mode sleep` in health status (or receives a local CLI `localOnly: true` sync), the bridge immediately pauses stream and health polling so it does not keep Wi-Fi awake or wake the robot.

## Dev servers & user testing (0SFS convention)

- **Never leave a background dev server running as the handoff.** A backgrounded dev server started by an agent tool call is tied to that tool turn and cuts out when a new message arrives.
- Stop every temporary server or child process you start before returning, unless the user explicitly asks you to keep it running; leave the user's own servers alone.
- **Force reload / plugin restart without killing the user's dev server:** `curl -sX POST http://localhost:5180/api/bridge/reload` triggers a browser full reload in all open tabs via Vite WebSocket; pass `-d '{"restart":true}'` to restart Vite in-process (reloading `telemetryBridgePlugin.ts` / `usbFlash.ts`) and auto-reload clients.
- For user testing, give them the command below to run in their own terminal:

```sh
cd ~/gh/esp32-bot/balax-remote && npm run dev
```

## Browser-first TS/WASM tooling

- **Do as much as possible in TypeScript/WASM inside the browser web app** (paired with reusable solvers in `@g-ai/rc`), rather than PC-only Python scripts.
- Calibration wizards (6-face accel ellipsoid, CG lever-arm offset, IMU zeroing), HIL maneuver capture/replay, GitHub OTA fetching, browser `IndexedDB` firmware/program storage, and CPU/RAM/Flash diagnostics belong in the browser tabbed UI (`WorkspaceDockSlot`).

## Shared components

- Camera orbit/zoom gestures and inertial glide come from `@g-ai/rc` (`attachOrbitCameraInput`, `createCameraGlide`).
- The docked workspace (`WindowOverlay`) and floating notices (`GameLogOverlay`) come from `@g-ai/3d-ui`.
- 6-DOF IMU fusion, linear kinematics, and calibration/HIL solvers come from `@g-ai/rc` (`imuPhysics.ts`, `imuCalibration.ts`).
