# Agent instructions

This repository is the BalaX web remote, 3D Babylon.js visualizer, browser-first calibration/HIL studio, OTA & system monitor, and 100 Hz telemetry bridge (`esp32-bot/balax-remote`).

## Thin-Robot Offload & Continuous Optimization Policy

- **Offload as much work as possible from the robot (`balax`) and JoyX onto this companion web app (`balax-remote` + `@g-ai/rc`)** so it runs on a smartphone, tablet, or laptop while the ESP32 stays cool, tiny, and fast.
- **GitHub Releases OTA** runs here (browser HTTPS fetch + SHA-256 verification + `IndexedDB` caching + `zlib` compression → uniform local LAN push to `balax.local`), keeping TLS/`mbedtls` completely off the robot.
- **JoyX Companion Bridge:** Support JoyX both as a physical joystick and as an ESP-NOW ↔ USB/Wi-Fi bridge feeding this app when no router is available.
- **Optimize continuously using our monitoring tools:** Keep the **CPU**, **RAM**, **Flash**, and thermal warning UI accurate, lightweight, and actionable (e.g. 1-click LCD off, stream stop, pre-flight battery ≥ 30% & thermal gates).

## Dev servers & user testing (0SFS convention)

- **Never leave a background dev server running as the handoff.** A backgrounded dev server started by an agent tool call is tied to that tool turn and cuts out when a new message arrives.
- Stop every temporary server or child process you start before returning, unless the user explicitly asks you to keep it running; leave the user's own servers alone.
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
