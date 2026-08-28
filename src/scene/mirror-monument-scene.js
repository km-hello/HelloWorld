import {
    ACESFilmicToneMapping,
    Color,
    PerspectiveCamera,
    Scene,
    SRGBColorSpace,
    WebGLRenderer,
} from "three";

import { ThreeBodySystem } from "../simulation/physics.js";
import { BodyVisuals } from "./body-visuals.js";
import { MirrorMonument } from "./mirror-monument.js";
import {
    getGlowScale,
    getOffscreenOverflow,
    getPositionScale,
    MAX_RECOVERY_STALL_DURATION,
    updateRecoveryTracking,
} from "./viewport.js";

const BODY_COUNT = 3;
const AXIS_COUNT = 3;
const FIXED_TIME_STEP = 1 / 120;
const MAX_FRAME_DELTA = 0.05;
const MAX_SUBSTEPS = 6;
const CAMERA_DISTANCE = 6;
const CAMERA_FOV = 42;
const CAMERA_NEAR_DISTANCE = 0.05;
const RECOVERY_DEPTH_GAIN = 2.1;
const MIN_RECOVERY_PERSPECTIVE = 0.65;
const MAX_RECOVERY_PERSPECTIVE = 1.62;
const MIN_GLOW_RADIUS = 32;
const MAX_RECOVERY_GLOW_RADIUS = 220;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value) {
    const normalized = clamp(value, 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
}

function getPerspective(positionZ, depthGain, minimum, maximum) {
    const visualDepth = positionZ * depthGain;
    const safeDepth = Math.min(visualDepth, CAMERA_DISTANCE - 0.5);

    return clamp(
        CAMERA_DISTANCE / (CAMERA_DISTANCE - safeDepth),
        minimum,
        maximum,
    );
}

function getRecoveryPerspective(positionZ) {
    return getPerspective(
        positionZ,
        RECOVERY_DEPTH_GAIN,
        MIN_RECOVERY_PERSPECTIVE,
        MAX_RECOVERY_PERSPECTIVE,
    );
}

function getRecoveryDepthIntensity(perspective) {
    return smoothstep(
        (perspective - MIN_RECOVERY_PERSPECTIVE)
        / (MAX_RECOVERY_PERSPECTIVE - MIN_RECOVERY_PERSPECTIVE),
    );
}

export class MirrorMonumentScene {
    constructor(canvas) {
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new TypeError("MirrorMonumentScene requires a canvas element.");
        }

        this.canvas = canvas;
        this.renderer = new WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
            precision: "highp",
        });
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.renderer.setClearColor(0x000000, 1);

        this.scene = new Scene();
        this.scene.background = new Color(0x000000);
        this.camera = new PerspectiveCamera(
            CAMERA_FOV,
            1,
            CAMERA_NEAR_DISTANCE,
            60,
        );
        this.camera.position.set(0, 0, CAMERA_DISTANCE);
        this.camera.lookAt(0, 0, 0);

        this.system = new ThreeBodySystem();
        this.motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.bodyVisuals = null;
        this.monument = new MirrorMonument(this.scene, this.renderer);

        this.cssWidth = 0;
        this.cssHeight = 0;
        this.pixelRatio = 1;
        this.pixelsPerWorldUnit = 1;
        this.positionWorldScale = 1;
        this.glowWorldDiameter = 1;
        this.positionScale = 1;
        this.glowScale = 1;
        this.resizePending = true;

        this.offscreenDuration = new Float64Array(BODY_COUNT);
        this.recoveryStallDuration = new Float64Array(BODY_COUNT);
        this.previousOffscreenOverflow = new Float64Array(BODY_COUNT);
        this.accumulator = 0;
        this.lastTimestamp = 0;
        this.animationFrameId = null;
        this.sceneOpacity = 1;
        this.transitionPhase = 0;
        this.starting = false;
        this.started = false;
        this.destroyed = false;
        this.manuallyPaused = false;
        this.pageSuspended = false;

        this._onAnimationFrame = this._onAnimationFrame.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);
        this._onPageHide = this._onPageHide.bind(this);
        this._onPageShow = this._onPageShow.bind(this);
        this._onMotionPreferenceChange = this._onMotionPreferenceChange.bind(this);
        this._onFallbackResize = this._onFallbackResize.bind(this);
        this._onContextLost = this._onContextLost.bind(this);

        document.addEventListener("visibilitychange", this._onVisibilityChange);
        window.addEventListener("pagehide", this._onPageHide);
        window.addEventListener("pageshow", this._onPageShow);
        this.motionPreference.addEventListener("change", this._onMotionPreferenceChange);
        this.canvas.addEventListener("webglcontextlost", this._onContextLost);

        if ("ResizeObserver" in window) {
            this.resizeObserver = new ResizeObserver(() => {
                this._requestResize();
            });
            this.resizeObserver.observe(document.documentElement);
        } else {
            this.resizeObserver = null;
            window.addEventListener("resize", this._onFallbackResize, { passive: true });
        }
    }

    async start() {
        if (this.destroyed || this.started || this.starting) {
            return;
        }

        this.starting = true;

        try {
            this._resize();
            this.bodyVisuals = new BodyVisuals(this.scene, CAMERA_DISTANCE);
            this.bodyVisuals.resize(
                this.positionWorldScale,
                this.glowWorldDiameter,
            );
            const monumentCreated = await this.monument.create();

            if (!monumentCreated || this.destroyed) {
                return;
            }

            this.bodyVisuals.resetTrails(this.system.positions);
            this.bodyVisuals.updateBodies(
                this.system.positions,
                this.monument.reflectionProbePosition,
            );
            this.monument.updateReflection(this.bodyVisuals, true);
            this._render();

            this.started = true;
            this.canvas.dataset.renderingMode = "webgl-mirror";
            document.body.classList.add("scene-ready");
            this._syncAnimationState();
        } finally {
            this.starting = false;
        }
    }

    pause() {
        this.manuallyPaused = true;
        this._syncAnimationState();
    }

    resume() {
        this.manuallyPaused = false;
        this._syncAnimationState();
    }

    destroy() {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.started = false;
        this._cancelAnimationFrame();

        document.removeEventListener("visibilitychange", this._onVisibilityChange);
        window.removeEventListener("pagehide", this._onPageHide);
        window.removeEventListener("pageshow", this._onPageShow);
        window.removeEventListener("resize", this._onFallbackResize);
        this.motionPreference.removeEventListener("change", this._onMotionPreferenceChange);
        this.canvas.removeEventListener("webglcontextlost", this._onContextLost);

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        this.bodyVisuals?.dispose();
        this.monument.dispose();
        this.scene.clear();
        this.bodyVisuals = null;
        this.renderer.dispose();
        if (this.renderer.extensions.has("WEBGL_lose_context")) {
            this.renderer.forceContextLoss();
        }
        this.canvas.dataset.simulationState = "destroyed";
    }

    _requestResize() {
        if (this.destroyed) {
            return;
        }

        this.resizePending = true;

        if (this.animationFrameId === null && this.started) {
            this._resize();
            this.bodyVisuals.updateBodies(
                this.system.positions,
                this.monument.reflectionProbePosition,
            );
            this.monument.updateReflection(this.bodyVisuals, true);
            this._render();
        }
    }

    _resize() {
        const width = Math.max(
            1,
            document.documentElement.clientWidth || window.innerWidth,
        );
        const height = Math.max(
            1,
            window.innerHeight || document.documentElement.clientHeight,
        );
        const devicePixelRatio = window.devicePixelRatio || 1;
        const isConstrained =
            width < 720
            || (Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4);
        const maximumPixelRatio = isConstrained ? 1.2 : 1.5;
        const pixelRatio = Math.min(devicePixelRatio, maximumPixelRatio);
        const verticalWorldSpan =
            2
            * Math.tan((CAMERA_FOV * Math.PI) / 360)
            * CAMERA_DISTANCE;

        this.cssWidth = width;
        this.cssHeight = height;
        this.pixelRatio = pixelRatio;
        this.pixelsPerWorldUnit = height / verticalWorldSpan;
        this.positionScale = getPositionScale(width, height);
        this.glowScale = getGlowScale(width, height);
        this.positionWorldScale = this.positionScale / this.pixelsPerWorldUnit;
        this.glowWorldDiameter =
            (this.glowScale * 1.1) / this.pixelsPerWorldUnit;
        this.resizePending = false;

        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.bodyVisuals?.resize(
            this.positionWorldScale,
            this.glowWorldDiameter,
        );
        this.monument.resize(
            width,
            this.pixelsPerWorldUnit,
            isConstrained,
        );
        this._resetRecoveryTracking();
    }

    _syncAnimationState() {
        const shouldAnimate =
            this.started
            && !this.destroyed
            && !this.manuallyPaused
            && !this.pageSuspended
            && !document.hidden
            && !this.motionPreference.matches;

        if (shouldAnimate) {
            this.canvas.dataset.simulationState = "running";

            if (this.animationFrameId === null) {
                this.lastTimestamp = 0;
                this.accumulator = 0;
                this.animationFrameId = requestAnimationFrame(this._onAnimationFrame);
            }
            return;
        }

        this._cancelAnimationFrame();

        if (this.motionPreference.matches) {
            this.canvas.dataset.simulationState = "reduced-motion";
        } else if (!this.destroyed) {
            this.canvas.dataset.simulationState = "paused";
        }

        if (!document.hidden && !this.pageSuspended && this.started) {
            this.bodyVisuals.updateBodies(
                this.system.positions,
                this.monument.reflectionProbePosition,
            );
            this.monument.updateReflection(this.bodyVisuals, true);
            this._render();
        }
    }

    _cancelAnimationFrame() {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        this.lastTimestamp = 0;
        this.accumulator = 0;
        this.bodyVisuals?.resetTrailSampling();
    }

    _onAnimationFrame(timestamp) {
        this.animationFrameId = null;

        if (
            this.destroyed
            || !this.started
            || this.manuallyPaused
            || this.pageSuspended
            || document.hidden
            || this.motionPreference.matches
        ) {
            this._syncAnimationState();
            return;
        }

        if (this.resizePending) {
            this._resize();
        }

        let frameDelta = 0;

        if (this.lastTimestamp > 0) {
            frameDelta = Math.min(
                (timestamp - this.lastTimestamp) / 1000,
                MAX_FRAME_DELTA,
            );
        }

        this.lastTimestamp = timestamp;
        this.accumulator += frameDelta;

        let substeps = 0;
        let stateIsSafe = true;

        while (this.accumulator >= FIXED_TIME_STEP && substeps < MAX_SUBSTEPS) {
            stateIsSafe = this.system.step(FIXED_TIME_STEP) && stateIsSafe;
            this.accumulator -= FIXED_TIME_STEP;
            substeps += 1;
        }

        if (substeps === MAX_SUBSTEPS && this.accumulator >= FIXED_TIME_STEP) {
            this.accumulator = 0;
        }

        if (!stateIsSafe) {
            this.sceneOpacity = 0;
            this.transitionPhase = 2;
            this._resetRecoveryTracking();
            this.bodyVisuals.resetTrails(this.system.positions);
        }

        this._advanceResetTransition(frameDelta);
        this.bodyVisuals.updateTrails(frameDelta, this.system.positions);
        this.bodyVisuals.updateBodies(
            this.system.positions,
            this.monument.reflectionProbePosition,
        );
        this._updateOffscreenRecovery(frameDelta);
        this.monument.updateReflection(this.bodyVisuals);
        this._render();
        this.animationFrameId = requestAnimationFrame(this._onAnimationFrame);
    }

    _advanceResetTransition(frameDelta) {
        if (this.transitionPhase === 0) {
            return;
        }

        if (this.transitionPhase === 1) {
            this.sceneOpacity = Math.max(0, this.sceneOpacity - frameDelta / 0.25);

            if (this.sceneOpacity === 0) {
                this.system.reset();
                this._resetRecoveryTracking();
                this.bodyVisuals.resetTrails(this.system.positions);
                this.transitionPhase = 2;
            }
        } else if (this.transitionPhase === 2) {
            this.sceneOpacity = Math.min(1, this.sceneOpacity + frameDelta / 0.45);

            if (this.sceneOpacity === 1) {
                this.transitionPhase = 0;
            }
        }

        this.canvas.style.opacity = String(this.sceneOpacity);
    }

    _render() {
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
    }

    _resetRecoveryTracking() {
        this.offscreenDuration.fill(0);
        this.recoveryStallDuration.fill(0);
        this.previousOffscreenOverflow.fill(0);

        for (let body = 0; body < BODY_COUNT; body += 1) {
            this.system.setRecoveryUrgency(body, 0);
        }
    }

    _updateOffscreenRecovery(frameDelta) {
        const margin = Math.min(this.cssWidth, this.cssHeight) * 0.15;
        const positions = this.system.positions;
        const centerX = this.cssWidth / 2;
        const centerY = this.cssHeight / 2;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const perspective = getRecoveryPerspective(positions[offset + 2]);
            const depthIntensity = getRecoveryDepthIntensity(perspective);
            const projectedX =
                centerX + positions[offset] * this.positionScale * perspective;
            const projectedY =
                centerY - positions[offset + 1] * this.positionScale * perspective;
            const recoveryRadius = clamp(
                this.glowScale
                    * 0.54
                    * perspective
                    * (0.86 + 0.3 * depthIntensity),
                MIN_GLOW_RADIUS,
                MAX_RECOVERY_GLOW_RADIUS,
            );
            const overflow = getOffscreenOverflow(
                projectedX,
                projectedY,
                recoveryRadius * 0.16,
                this.cssWidth,
                this.cssHeight,
                margin,
            );
            const urgency = updateRecoveryTracking(
                this.offscreenDuration,
                this.recoveryStallDuration,
                this.previousOffscreenOverflow,
                body,
                overflow,
                frameDelta,
            );

            this.system.setRecoveryUrgency(body, urgency);

            if (
                this.recoveryStallDuration[body] >= MAX_RECOVERY_STALL_DURATION
                && this.transitionPhase === 0
            ) {
                this.transitionPhase = 1;
            }
        }
    }

    _onVisibilityChange() {
        this._syncAnimationState();
    }

    _onPageHide(event) {
        if (event.persisted) {
            this.pageSuspended = true;
            this._syncAnimationState();
        } else {
            this.destroy();
        }
    }

    _onPageShow() {
        this.pageSuspended = false;
        this._syncAnimationState();
    }

    _onMotionPreferenceChange() {
        this._syncAnimationState();
    }

    _onFallbackResize() {
        this._requestResize();
    }

    _onContextLost(event) {
        event.preventDefault();
        this.pause();
        this.canvas.dataset.simulationState = "context-lost";
    }
}
