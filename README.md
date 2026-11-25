# BalaX-remote

Phone/laptop remote and live debug tool for the [BalaX](https://github.com/Felipegalind0/BalaX)
self-balancing robot, built as an installable PWA.

## Local development

Check out BalaX and the remote next to each other under `~/gh/esp32-bot`, with
`rc`, `ui`, and `3d-ui` under `~/gh/g-ai`. Build the shared UI before installing
and running the remote.

```sh
cd ~/gh/g-ai/ui && npm ci && npm run build
cd ~/gh/g-ai/3d-ui && npm ci && npm run build
cd ~/gh/esp32-bot/balax-remote && npm ci
cd ~/gh/esp32-bot/balax-remote && npm run dev
```

Open `http://balax-remote.local:5180` on the same network. The **Camera** tab
controls the ESP32-CAM at `balax-cam.local`. Adjust **Sparse threshold** in
**Codec**, then select **Apply** to send pending settings to the camera. The
**CPU**, **RAM**, and **Flash** tabs show live readings for both boards as
available. The OTA tab labels the firmware binary on the development machine
as a local build.

To flash over USB, open the remote on the computer running the bridge and go
to **Firmware OTA → USB Flash**. Select the port and layout, then confirm the
write. The app shows progress and messages while the local USB tool runs.

## Goals

- **Remote control.** Drive the robot from a phone. The camera livestream doubles as the joystick
  surface.
- **Live debug.** View any robot variable live (angles, PID terms, loop timing, battery) and plot it.
- **Tuning.** Edit settings (PID gains, volume, limits) on the running robot without reflashing.
- **3D view.** Render the robot's live orientation in 3D.
- **Latency.** Sub-15 ms LAN control & telemetry loop with pipelined 1-RTT authentication.

## Links to the robot

| Link | Status |
| --- | --- |
| Wi-Fi (direct to robot) | First and only link for now |
| Bluetooth | Later |
| ESP-NOW long-range relay | Later |

## Related work, done elsewhere

- Camera: an ESP32-CAM gets tilt data from the robot over UART, crops to stabilize, and streams
  over Wi-Fi to the phone.
- Browser-first hardware-in-the-loop (HIL) physics replay simulator and offline scorecard.

See [TODO.md](TODO.md) for planned work.
