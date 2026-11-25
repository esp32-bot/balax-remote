import React, { useEffect, useRef } from "react";
import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateBox,
  CreateCylinder,
  CreateDisc,
  CreateGround,
  CreateLines,
  DirectionalLight,
  Engine,
  HemisphericLight,
  LinesMesh,
  Mesh,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  attachOrbitCameraInput,
  CameraInputSettings,
  createWheeledRobotPhysics,
  readSavedCameraInputSettings,
  RobotKinematicState,
  WheeledRobotPhysicsSimulator,
} from "@g-ai/rc";
import { TraceSample } from "./bxz1";

export interface BalaXSceneProps {
  latest: TraceSample | null;
  history: TraceSample[];
  cameraSettings?: CameraInputSettings;
  /** Increment to recenter 3D position (X, Y, Z) & zero yaw heading. */
  resetPoseToken?: number;
  /** Increment after firmware `imu zero` to also clear online residual bias. */
  resetAllToken?: number;
  /** CG->IMU lever-arm vector in robot body frame (+X Left, +Y Up, +Z Forward), meters. */
  leverArmM?: readonly [number, number, number];
  /** Throttled (~15 Hz) callback with live 6-DOF fused kinematics. */
  onKinematics?: (k: RobotKinematicState) => void;
  onWebGlUnavailable?: () => void;
}

export function BalaXBabylonScene({
  latest,
  history,
  cameraSettings,
  resetPoseToken = 0,
  resetAllToken = 0,
  leverArmM,
  onKinematics,
  onWebGlUnavailable,
}: BalaXSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraSettingsRef = useRef<CameraInputSettings | undefined>(cameraSettings);
  cameraSettingsRef.current = cameraSettings;
  const onKinematicsRef = useRef<BalaXSceneProps["onKinematics"]>(onKinematics);
  onKinematicsRef.current = onKinematics;
  const onWebGlUnavailableRef = useRef(onWebGlUnavailable);
  onWebGlUnavailableRef.current = onWebGlUnavailable;

  const physicsRef = useRef<WheeledRobotPhysicsSimulator | null>(null);
  if (!physicsRef.current) {
    physicsRef.current = createWheeledRobotPhysics();
  }

  const sceneStateRef = useRef<{
    robotRoot: TransformNode;
    wheelHubL: TransformNode;
    wheelHubR: TransformNode;
    ledMat: StandardMaterial;
    scene: Scene;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: Engine;
    try {
      engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    } catch {
      onWebGlUnavailableRef.current?.();
      return;
    }
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.01, 0.02, 0.04, 1.0);

    const camera = new ArcRotateCamera(
      "chase-cam",
      -Math.PI / 3,
      Math.PI / 3.1,
      0.48,
      new Vector3(0, 0.065, 0),
      scene
    );
    camera.minZ = 0.01;
    camera.lowerBetaLimit = 0.08;
    camera.upperBetaLimit = Math.PI - 0.08;
    camera.lowerRadiusLimit = 0.14;
    camera.upperRadiusLimit = 2.5;

    // Attach shared camera gestures and inertial glide to Babylon's ArcRotateCamera.
    const detachCameraInput = attachOrbitCameraInput(canvas, camera, {
      scene,
      getSettings: () => cameraSettingsRef.current ?? readSavedCameraInputSettings(),
    });

    const hemi = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new Color3(0.08, 0.11, 0.16);

    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1.0, -0.4), scene);
    sun.intensity = 0.7;

    // Ground & metric coordinate grid lines
    const ground = CreateGround("ground", { width: 4, height: 4 }, scene);
    const groundMat = new StandardMaterial("ground-mat", scene);
    groundMat.diffuseColor = new Color3(0.04, 0.06, 0.09);
    groundMat.specularColor = new Color3(0.02, 0.02, 0.02);
    ground.material = groundMat;

    const gridPoints: Vector3[][] = [];
    for (let i = -20; i <= 20; i++) {
      const c = i * 0.1;
      gridPoints.push([new Vector3(c, 0.0005, -2), new Vector3(c, 0.0005, 2)]);
      gridPoints.push([new Vector3(-2, 0.0005, c), new Vector3(2, 0.0005, c)]);
    }
    for (const seg of gridPoints) {
      const l = CreateLines("grid", { points: seg }, scene);
      l.color = new Color3(0.11, 0.16, 0.23);
    }

    // Origin XYZ reference triad on the floor (Red=+X Right, Green=+Y Up, Blue=+Z Forward)
    const axisLen = 0.12;
    const axX = CreateLines("axis-x", { points: [new Vector3(0, 0.002, 0), new Vector3(axisLen, 0.002, 0)] }, scene);
    axX.color = new Color3(0.9, 0.25, 0.25);
    const axY = CreateLines("axis-y", { points: [new Vector3(0, 0.002, 0), new Vector3(0, axisLen, 0)] }, scene);
    axY.color = new Color3(0.25, 0.85, 0.35);
    const axZ = CreateLines("axis-z", { points: [new Vector3(0, 0.002, 0), new Vector3(0, 0.002, axisLen)] }, scene);
    axZ.color = new Color3(0.35, 0.65, 1.0);

    // Ground drop-shadow disc & vertical lift line to visualize 3D linear translation (X, Y, Z)
    const shadowDisc = CreateDisc("robot-shadow", { radius: 0.042, tessellation: 24 }, scene);
    shadowDisc.rotation.x = Math.PI / 2;
    shadowDisc.position.y = 0.0012;
    const shadowMat = new StandardMaterial("shadow-mat", scene);
    shadowMat.diffuseColor = new Color3(0.01, 0.02, 0.03);
    shadowMat.emissiveColor = new Color3(0.08, 0.24, 0.42);
    shadowMat.alpha = 0.45;
    shadowDisc.material = shadowMat;

    const dropPoints = [new Vector3(0, 0.001, 0), new Vector3(0, 0.021, 0)];
    let dropLine: LinesMesh = CreateLines("lift-drop-line", { points: dropPoints, updatable: true }, scene);
    dropLine.color = new Color3(0.34, 0.65, 1.0);

    // Single quaternion-driven 6-DOF robot root (zero Euler gimbal lock in ANY 3D orientation!)
    const wheelRadius = 0.021;
    const robotRoot = new TransformNode("balax-root", scene);
    robotRoot.position.y = wheelRadius;
    const robotQuat = new Quaternion(0, 0, 0, 1);
    robotRoot.rotationQuaternion = robotQuat;

    // Materials
    const orangeMat = new StandardMaterial("m5-orange", scene);
    orangeMat.diffuseColor = Color3.FromHexString("#ff6b00");
    orangeMat.specularColor = new Color3(0.25, 0.25, 0.25);

    const darkCradleMat = new StandardMaterial("balac-dark", scene);
    darkCradleMat.diffuseColor = Color3.FromHexString("#1f242d");

    const screenMat = new StandardMaterial("m5-screen", scene);
    screenMat.diffuseColor = Color3.FromHexString("#051525");
    screenMat.emissiveColor = Color3.FromHexString("#0c2d48");

    const btnMat = new StandardMaterial("m5-btn", scene);
    btnMat.diffuseColor = Color3.FromHexString("#d0d7de");

    const ledMat = new StandardMaterial("m5-led", scene);
    ledMat.diffuseColor = Color3.FromHexString("#3fb950");
    ledMat.emissiveColor = Color3.FromHexString("#3fb950");

    const tireMat = new StandardMaterial("wheel-tire", scene);
    tireMat.diffuseColor = Color3.FromHexString("#161b22");

    const spokeMat = new StandardMaterial("wheel-spoke", scene);
    spokeMat.diffuseColor = Color3.FromHexString("#58a6ff");

    // BalaC STM32 motor base cradle
    const baseCradle = CreateBox("balac-cradle", { width: 0.056, height: 0.022, depth: 0.024 }, scene);
    baseCradle.parent = robotRoot;
    baseCradle.position.y = 0.008;
    baseCradle.material = darkCradleMat;

    // M5StickC Plus body (25mm wide, 68mm tall, 14mm deep).
    // The HAT plugs into the BalaC, so the shell is upside down versus handheld:
    // button A (USB end) is at the top, and the LED (HAT end) is just above the cradle.
    const stickBody = CreateBox("stick-body", { width: 0.025, height: 0.068, depth: 0.015 }, scene);
    stickBody.parent = robotRoot;
    stickBody.position.y = 0.048;
    stickBody.material = orangeMat;

    // 1.14" IPS LCD, facing +Z. Glass sits below the button once the shell is flipped.
    const lcd = CreateBox("stick-lcd", { width: 0.018, height: 0.034, depth: 0.001 }, scene);
    lcd.parent = robotRoot;
    lcd.position = new Vector3(0, 0.040, 0.0078);
    lcd.material = screenMat;

    // Home "M5" button A, at the top of the robot.
    const btnA = CreateBox("stick-btn-a", { width: 0.012, height: 0.009, depth: 0.0015 }, scene);
    btnA.parent = robotRoot;
    btnA.position = new Vector3(0, 0.068, 0.0079);
    btnA.material = btnMat;

    // Status LED on the exposed front face just above the cradle (180° also swaps its side).
    const led = CreateBox("stick-led", { width: 0.005, height: 0.003, depth: 0.003 }, scene);
    led.parent = robotRoot;
    led.position = new Vector3(-0.007, 0.023, 0.006);
    led.material = ledMat;

    // Left & Right wheels parented via axle hubs directly under robotRoot
    const makeWheelHub = (name: string, xOffset: number): TransformNode => {
      const hub = new TransformNode(`${name}-hub`, scene);
      hub.parent = robotRoot;
      hub.position.x = xOffset;

      const wheel: Mesh = CreateCylinder(
        name,
        { diameter: wheelRadius * 2, height: 0.009, tessellation: 32 },
        scene
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.parent = hub;
      wheel.material = tireMat;

      const spoke = CreateBox(`${name}-spoke`, { width: 0.01, height: wheelRadius * 1.75, depth: 0.004 }, scene);
      spoke.parent = wheel;
      spoke.material = spokeMat;
      return hub;
    };

    const wheelHubL = makeWheelHub("wheel-L", -0.034);
    const wheelHubR = makeWheelHub("wheel-R", 0.034);

    const camTarget = new Vector3(0, 0.056, 0);
    camera.setTarget(camTarget);

    sceneStateRef.current = {
      robotRoot,
      wheelHubL,
      wheelHubR,
      ledMat,
      scene,
    };

    let lastFrameMs = performance.now();
    let lastUiPublishMs = 0;

    engine.runRenderLoop(() => {
      const nowMs = performance.now();
      const dtSec = Math.max(0.001, Math.min(0.05, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      const phys = physicsRef.current;
      if (phys) {
        const k = phys.step(dtSec);

        // Apply full 6-DOF quaternion orientation + 3-axis (X, Y, Z) position
        robotQuat.set(k.quat.x, k.quat.y, k.quat.z, k.quat.w);
        robotRoot.position.set(k.posX, k.posY, k.posZ);
        wheelHubL.rotation.x = k.wheelAngleL;
        wheelHubR.rotation.x = k.wheelAngleR;

        // Keep orbit camera smoothly centered on the robot's 3D position
        const followAlpha = 1 - Math.exp(-dtSec * 18);
        camTarget.x += (k.posX - camTarget.x) * followAlpha;
        camTarget.y += (k.posY + 0.035 - camTarget.y) * followAlpha;
        camTarget.z += (k.posZ - camTarget.z) * followAlpha;
        camera.setTarget(camTarget);

        // Update ground projection shadow & elevation drop-line
        shadowDisc.position.x = k.posX;
        shadowDisc.position.z = k.posZ;
        const lift = Math.max(0, k.posY - k.floorY);
        const shadowScale = Math.max(0.45, 1.0 - lift * 1.4);
        shadowDisc.scaling.set(shadowScale, shadowScale, 1);

        dropLine.isVisible = lift > 0.004;
        if (dropLine.isVisible) {
          dropPoints[0]!.set(k.posX, 0.0015, k.posZ);
          dropPoints[1]!.set(k.posX, k.posY, k.posZ);
          dropLine = CreateLines("lift-drop-line", { points: dropPoints, instance: dropLine });
        }

        if (onKinematicsRef.current && nowMs - lastUiPublishMs >= 66) {
          lastUiPublishMs = nowMs;
          onKinematicsRef.current({
            ...k,
            quat: { ...k.quat },
            vel: { ...k.vel },
            linearAccel: { ...k.linearAccel },
          });
        }
      }

      scene.render();
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);
    return () => {
      sceneStateRef.current = null;
      detachCameraInput();
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      scene.dispose();
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    if (resetPoseToken > 0) {
      physicsRef.current?.resetPose();
    }
  }, [resetPoseToken]);

  useEffect(() => {
    if (resetAllToken > 0) {
      physicsRef.current?.resetAll();
    }
  }, [resetAllToken]);

  useEffect(() => {
    if (leverArmM) {
      physicsRef.current?.setLeverArm(leverArmM);
    }
  }, [leverArmM?.[0], leverArmM?.[1], leverArmM?.[2]]);

  useEffect(() => {
    const st = sceneStateRef.current;
    const phys = physicsRef.current;
    if (!phys) return;

    // Feed recent 100 Hz samples from history into the physics playback queue
    if (history.length > 0) {
      const tail = history.slice(-24);
      phys.pushSamples(tail);
    } else if (latest) {
      phys.setLatestSample(latest);
    }

    if (!st || !latest) return;

    // Update status LED color from state
    if (latest.state === "FALLEN") {
      st.ledMat.emissiveColor = Color3.FromHexString("#f85149");
    } else if (latest.state === "BALANCING") {
      st.ledMat.emissiveColor = Color3.FromHexString("#3fb950");
    } else {
      st.ledMat.emissiveColor = Color3.FromHexString("#d29922");
    }
  }, [latest, history.length]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: "var(--foss-world-top, 0px)",
        width: "100%",
        height: "calc(100% - var(--foss-world-top, 0px))",
        display: "block",
        borderRadius: 10,
        outline: "none",
        touchAction: "none",
      }}
    />
  );
}
