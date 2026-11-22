/**
 * BXZ1 / BXZ2 binary delta+varint telemetry stream decoder.
 * Matches `telemetry_stream::encode_bxz1_block` in BalaX firmware (`main/telemetry_stream.cpp`).
 * - BXZ1: 11-field legacy stream
 * - BXZ2: 18-field full 6-axis IMU (`accelXG`, `accelYG`, `accelZG`, `gyroXDps`, `gyroYDps`, `gyroZDps`, `yawDeg`) stream
 */

export const BALANCE_STATES = [
  "CALIBRATING",
  "READY",
  "ARMED",
  "LEVELING",
  "TAKEOFF",
  "BALANCING",
  "FALLEN",
] as const;

export const BALANCE_FAULTS = ["NONE", "TILT", "OVERPOWER", "SENSOR"] as const;

export interface TraceSample {
  tick: number;
  state: string;
  fault: string;
  motorL: number;
  motorR: number;
  pitchDeg: number;
  pitchDps: number;
  angleI: number;
  rateI: number;
  speed: number;
  distance: number;
  power: number;
  // Full 6-axis IMU & yaw at 100 Hz
  accelXG: number;
  accelYG: number;
  accelZG: number;
  gyroXDps: number;
  gyroYDps: number;
  gyroZDps: number;
  yawDeg: number;
}

function zigzagDecode(u: number): number {
  return (u >>> 1) ^ -(u & 1);
}

function readVarint(bytes: Uint8Array, pos: number, end: number): { value: number; next: number } | null {
  let out = 0;
  let shift = 0;
  for (let i = 0; i < 5 && pos + i < end; i++) {
    const b = bytes[pos + i];
    out |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: out >>> 0, next: pos + i + 1 };
    }
    shift += 7;
  }
  return null;
}

function readU16LE(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8);
}

function readU32LE(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function signInt8(v: number): number {
  const b = v & 0xff;
  return b >= 128 ? b - 256 : b;
}

export function decodeBxz1Stream(bytes: Uint8Array): TraceSample[] {
  const samples: TraceSample[] = [];
  let offset = 0;

  while (offset + 16 <= bytes.length) {
    const versionByte = bytes[offset + 3];
    if (
      bytes[offset] !== 0x42 || // "B"
      bytes[offset + 1] !== 0x58 || // "X"
      bytes[offset + 2] !== 0x5a || // "Z"
      (versionByte !== 0x31 && versionByte !== 0x32) // "1" or "2"
    ) {
      break;
    }
    const numFields = versionByte === 0x32 ? 18 : 11;
    const startTick = readU32LE(bytes, offset + 4);
    const count = readU16LE(bytes, offset + 12);
    const payloadLen = readU16LE(bytes, offset + 14);
    const blockEnd = offset + 16 + payloadLen;
    if (blockEnd > bytes.length) {
      break;
    }

    let pos = offset + 16;
    let prevTick = 0;
    let prevStateFault = 0;
    let prevMotorL = 0;
    let prevMotorR = 0;
    let prevPitchCdeg = 0;
    let prevRateDdps = 0;
    let prevAngleID = 0;
    let prevRateID = 0;
    let prevSpeedC = 0;
    let prevDistanceD = 0;
    let prevPowerD = 0;
    let prevAccelXCg = 0;
    let prevAccelYCg = 0;
    let prevAccelZCg = 0;
    let prevGyroXDdps = 0;
    let prevGyroYDdps = 0;
    let prevGyroZDdps = 0;
    let prevYawDdeg = 0;

    for (let i = 0; i < count; i++) {
      const deltas = new Int32Array(18);
      let ok = true;
      for (let f = 0; f < numFields; f++) {
        const res = readVarint(bytes, pos, blockEnd);
        if (!res) {
          ok = false;
          break;
        }
        pos = res.next;
        deltas[f] = zigzagDecode(res.value);
      }
      if (!ok) break;

      const tick = i === 0 ? startTick : (prevTick + 1 + deltas[0]) >>> 0;
      const stateFault = (prevStateFault + deltas[1]) & 0xff;
      const motorL = signInt8(prevMotorL + deltas[2]);
      const motorR = signInt8(prevMotorR + deltas[3]);
      const pitchCdeg = prevPitchCdeg + deltas[4];
      const rateDdps = prevRateDdps + deltas[5];
      const angleID = prevAngleID + deltas[6];
      const rateID = prevRateID + deltas[7];
      const speedC = prevSpeedC + deltas[8];
      const distanceD = prevDistanceD + deltas[9];
      const powerD = prevPowerD + deltas[10];
      const accelXCg = prevAccelXCg + deltas[11];
      const accelYCg = prevAccelYCg + deltas[12];
      const accelZCg = prevAccelZCg + deltas[13];
      const gyroXDdps = prevGyroXDdps + deltas[14];
      const gyroYDdps = prevGyroYDdps + deltas[15];
      const gyroZDdps = prevGyroZDdps + deltas[16];
      const yawDdeg = prevYawDdeg + deltas[17];

      const stateIdx = stateFault & 0x0f;
      const faultIdx = (stateFault >> 4) & 0x0f;

      const pitchDeg = pitchCdeg / 100.0;
      const pitchDps = rateDdps / 10.0;

      // For BXZ1 fallback, synthesize approximate gravity vector from pitchDeg
      const approxForwardG = Math.max(-1, Math.min(1, pitchDeg / 57.2957795));
      const approxUpG = Math.sqrt(Math.max(0, 1 - approxForwardG * approxForwardG));

      samples.push({
        tick,
        state: BALANCE_STATES[stateIdx] ?? "READY",
        fault: BALANCE_FAULTS[faultIdx] ?? "NONE",
        motorL,
        motorR,
        pitchDeg,
        pitchDps,
        angleI: angleID / 10.0,
        rateI: rateID / 10.0,
        speed: speedC / 100.0,
        distance: distanceD / 10.0,
        power: powerD / 10.0,
        accelXG: numFields === 18 ? accelXCg / 100.0 : 0,
        accelYG: numFields === 18 ? accelYCg / 100.0 : approxUpG,
        accelZG: numFields === 18 ? accelZCg / 100.0 : approxForwardG,
        gyroXDps: numFields === 18 ? gyroXDdps / 10.0 : pitchDps,
        gyroYDps: numFields === 18 ? gyroYDdps / 10.0 : 0,
        gyroZDps: numFields === 18 ? gyroZDdps / 10.0 : 0,
        yawDeg: numFields === 18 ? yawDdeg / 10.0 : 0,
      });

      prevTick = tick;
      prevStateFault = stateFault;
      prevMotorL = motorL;
      prevMotorR = motorR;
      prevPitchCdeg = pitchCdeg;
      prevRateDdps = rateDdps;
      prevAngleID = angleID;
      prevRateID = rateID;
      prevSpeedC = speedC;
      prevDistanceD = distanceD;
      prevPowerD = powerD;
      prevAccelXCg = accelXCg;
      prevAccelYCg = accelYCg;
      prevAccelZCg = accelZCg;
      prevGyroXDdps = gyroXDdps;
      prevGyroYDdps = gyroYDdps;
      prevGyroZDdps = gyroZDdps;
      prevYawDdeg = yawDdeg;
    }

    offset = blockEnd;
  }

  return samples;
}
