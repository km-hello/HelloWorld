import { ThreeBodySystem } from "./physics.js";
import {
    getGlowScale,
    getOffscreenOverflow,
    getPositionScale,
    MAX_RECOVERY_STALL_DURATION,
    updateRecoveryTracking,
} from "./viewport.js";

const BODY_COUNT = 3;
const FIXED_TIME_STEP = 1 / 120;
const MAX_FRAME_DELTA = 0.05;
const MAX_SUBSTEPS = 6;
const CAMERA_DISTANCE = 6;
const VISUAL_DEPTH_GAIN = 2.35;
const MIN_PERSPECTIVE = 0.58;
const MAX_PERSPECTIVE = 1.78;
// Keep recovery sensing stable when the artistic projection is tuned.
const RECOVERY_DEPTH_GAIN = 2.1;
const MIN_RECOVERY_PERSPECTIVE = 0.65;
const MAX_RECOVERY_PERSPECTIVE = 1.62;
const HALO_SPRITE_SIZE = 256;
const CORE_SPRITE_SIZE = 128;
const MIN_GLOW_RADIUS = 32;
const MAX_GLOW_RADIUS = 250;
const MAX_RECOVERY_GLOW_RADIUS = 220;
const TRAIL_POINT_CAPACITY = 24;
const TRAIL_SAMPLE_INTERVAL = 1 / 24;
const TRAIL_AXES = 3;

const BODY_STYLES = Object.freeze([
    Object.freeze({
        haloStops: Object.freeze([
            [0, "rgba(132, 241, 255, 0.78)"],
            [0.07, "rgba(91, 225, 255, 0.68)"],
            [0.18, "rgba(50, 199, 255, 0.44)"],
            [0.36, "rgba(34, 171, 255, 0.24)"],
            [0.58, "rgba(27, 137, 255, 0.11)"],
            [0.8, "rgba(24, 109, 255, 0.035)"],
            [1, "rgba(24, 109, 255, 0)"],
        ]),
        coreStops: Object.freeze([
            [0, "rgba(255, 255, 255, 1)"],
            [0.06, "rgba(252, 255, 255, 0.99)"],
            [0.16, "rgba(218, 252, 255, 0.94)"],
            [0.34, "rgba(144, 239, 255, 0.72)"],
            [0.58, "rgba(66, 210, 255, 0.3)"],
            [0.8, "rgba(43, 173, 255, 0.08)"],
            [1, "rgba(45, 184, 255, 0)"],
        ]),
        trail: "rgb(74, 211, 255)",
    }),
    Object.freeze({
        haloStops: Object.freeze([
            [0, "rgba(216, 190, 255, 0.78)"],
            [0.07, "rgba(188, 145, 255, 0.68)"],
            [0.18, "rgba(149, 98, 255, 0.44)"],
            [0.36, "rgba(119, 74, 255, 0.24)"],
            [0.58, "rgba(92, 58, 238, 0.11)"],
            [0.8, "rgba(72, 49, 206, 0.035)"],
            [1, "rgba(72, 49, 206, 0)"],
        ]),
        coreStops: Object.freeze([
            [0, "rgba(255, 255, 255, 1)"],
            [0.06, "rgba(255, 253, 255, 0.99)"],
            [0.16, "rgba(242, 229, 255, 0.94)"],
            [0.34, "rgba(211, 180, 255, 0.72)"],
            [0.58, "rgba(159, 105, 255, 0.3)"],
            [0.8, "rgba(121, 77, 246, 0.08)"],
            [1, "rgba(132, 82, 255, 0)"],
        ]),
        trail: "rgb(174, 126, 255)",
    }),
    Object.freeze({
        haloStops: Object.freeze([
            [0, "rgba(255, 224, 166, 0.78)"],
            [0.07, "rgba(255, 196, 108, 0.68)"],
            [0.18, "rgba(255, 145, 67, 0.44)"],
            [0.36, "rgba(255, 108, 45, 0.24)"],
            [0.58, "rgba(239, 75, 35, 0.11)"],
            [0.8, "rgba(204, 53, 29, 0.035)"],
            [1, "rgba(204, 53, 29, 0)"],
        ]),
        coreStops: Object.freeze([
            [0, "rgba(255, 255, 255, 1)"],
            [0.06, "rgba(255, 254, 250, 0.99)"],
            [0.16, "rgba(255, 241, 213, 0.94)"],
            [0.34, "rgba(255, 210, 149, 0.72)"],
            [0.58, "rgba(255, 146, 71, 0.3)"],
            [0.8, "rgba(238, 94, 42, 0.08)"],
            [1, "rgba(255, 112, 50, 0)"],
        ]),
        trail: "rgb(255, 166, 88)",
    }),
]);

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

function getVisualPerspective(positionZ) {
    return getPerspective(
        positionZ,
        VISUAL_DEPTH_GAIN,
        MIN_PERSPECTIVE,
        MAX_PERSPECTIVE,
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

function getDepthIntensity(
    perspective,
    minimum = MIN_PERSPECTIVE,
    maximum = MAX_PERSPECTIVE,
) {
    return smoothstep(
        (perspective - minimum) / (maximum - minimum),
    );
}

function createRadialSprite(stops, cssSize, pixelRatio) {
    const sprite = document.createElement("canvas");
    const size = Math.round(cssSize * pixelRatio);
    const center = size / 2;

    sprite.width = size;
    sprite.height = size;
    const context = sprite.getContext("2d", { alpha: true });

    if (!context) {
        return sprite;
    }

    const gradient = context.createRadialGradient(
        center,
        center,
        0,
        center,
        center,
        center,
    );

    for (let stop = 0; stop < stops.length; stop += 1) {
        gradient.addColorStop(stops[stop][0], stops[stop][1]);
    }

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return sprite;
}

function createGlowSprites(style, pixelRatio) {
    return {
        halo: createRadialSprite(
            style.haloStops,
            HALO_SPRITE_SIZE,
            pixelRatio,
        ),
        core: createRadialSprite(
            style.coreStops,
            CORE_SPRITE_SIZE,
            pixelRatio,
        ),
    };
}

export class ThreeBodyBackground {
    constructor(canvas) {
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new TypeError("ThreeBodyBackground requires a canvas element.");
        }

        this.canvas = canvas;
        this.context = canvas.getContext("2d", {
            alpha: true,
            desynchronized: true,
        });
        this.system = new ThreeBodySystem();
        this.motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

        this.projectedX = new Float64Array(BODY_COUNT);
        this.projectedY = new Float64Array(BODY_COUNT);
        this.projectedDepth = new Float64Array(BODY_COUNT);
        this.projectedRadius = new Float64Array(BODY_COUNT);
        this.projectedDepthIntensity = new Float64Array(BODY_COUNT);
        this.offscreenDuration = new Float64Array(BODY_COUNT);
        this.recoveryStallDuration = new Float64Array(BODY_COUNT);
        this.previousOffscreenOverflow = new Float64Array(BODY_COUNT);
        this.trailPositions = new Float64Array(
            BODY_COUNT * TRAIL_POINT_CAPACITY * TRAIL_AXES,
        );
        this.trailHeads = new Uint8Array(BODY_COUNT);
        this.trailLengths = new Uint8Array(BODY_COUNT);
        this.sprites = new Array(BODY_COUNT).fill(null);

        this.cssWidth = 0;
        this.cssHeight = 0;
        this.positionScale = 1;
        this.glowScale = 1;
        this.pixelRatio = 1;
        this.spritePixelRatio = 0;
        this.accumulator = 0;
        this.trailSampleAccumulator = 0;
        this.lastTimestamp = 0;
        this.animationFrameId = null;
        this.sceneOpacity = 1;
        this.transitionPhase = 0;
        this.resizePending = true;
        this.started = false;
        this.manuallyPaused = false;
        this.pageSuspended = false;
        this.destroyed = false;

        this._onAnimationFrame = this._onAnimationFrame.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);
        this._onPageHide = this._onPageHide.bind(this);
        this._onPageShow = this._onPageShow.bind(this);
        this._onMotionPreferenceChange = this._onMotionPreferenceChange.bind(this);
        this._onFallbackResize = this._onFallbackResize.bind(this);

        document.addEventListener("visibilitychange", this._onVisibilityChange);
        window.addEventListener("pagehide", this._onPageHide);
        window.addEventListener("pageshow", this._onPageShow);
        this.motionPreference.addEventListener("change", this._onMotionPreferenceChange);

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

    start() {
        if (this.destroyed || this.started) {
            return;
        }

        this.started = true;
        this._resizeCanvas();
        this._clearTrails();
        this._recordTrailPoint();
        this._projectBodies();
        this._render();
        this._syncAnimationState();
    }

    pause() {
        if (this.destroyed) {
            return;
        }

        this.manuallyPaused = true;
        this._syncAnimationState();
    }

    resume() {
        if (this.destroyed) {
            return;
        }

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

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        this.sprites.fill(null);
        this.trailLengths.fill(0);
        this.canvas.dataset.simulationState = "destroyed";
    }

    _requestResize() {
        if (this.destroyed) {
            return;
        }

        this.resizePending = true;

        if (this.animationFrameId === null) {
            this._resizeCanvas();
            this._projectBodies();
            this._render();
        }
    }

    _resizeCanvas() {
        const width = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
        const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
        const dimensionsChanged = width !== this.cssWidth || height !== this.cssHeight;
        const devicePixelRatio = window.devicePixelRatio || 1;
        const isConstrainedDevice =
            width < 720
            || (Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4);
        const maximumPixelRatio = isConstrainedDevice ? 1.5 : 2;
        const pixelRatio = Math.min(devicePixelRatio, maximumPixelRatio);
        const backingWidth = Math.max(1, Math.round(width * pixelRatio));
        const backingHeight = Math.max(1, Math.round(height * pixelRatio));

        this.cssWidth = width;
        this.cssHeight = height;
        this.positionScale = getPositionScale(width, height);
        this.glowScale = getGlowScale(width, height);
        this.pixelRatio = pixelRatio;
        this.resizePending = false;

        if (dimensionsChanged) {
            this._resetRecoveryTracking();
        }

        if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
            this.canvas.width = backingWidth;
            this.canvas.height = backingHeight;
        }

        if (this.context) {
            this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }

        if (this.spritePixelRatio !== pixelRatio) {
            for (let body = 0; body < BODY_COUNT; body += 1) {
                this.sprites[body] = createGlowSprites(
                    BODY_STYLES[body],
                    pixelRatio,
                );
            }
            this.spritePixelRatio = pixelRatio;
        }
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

        if (!document.hidden && !this.pageSuspended) {
            this._projectBodies();
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
        this.trailSampleAccumulator = 0;
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
            this._resizeCanvas();
        }

        let frameDelta = 0;

        if (this.lastTimestamp > 0) {
            frameDelta = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DELTA);
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
            this._clearTrails();
            this._recordTrailPoint();
        }

        this._advanceResetTransition(frameDelta);
        this._updateTrails(frameDelta);
        this._projectBodies();
        this._updateOffscreenRecovery(frameDelta);
        this._render();

        this.animationFrameId = requestAnimationFrame(this._onAnimationFrame);
    }

    _advanceResetTransition(frameDelta) {
        if (this.transitionPhase === 1) {
            this.sceneOpacity = Math.max(0, this.sceneOpacity - frameDelta / 0.25);

            if (this.sceneOpacity === 0) {
                this.system.reset();
                this._resetRecoveryTracking();
                this._clearTrails();
                this._recordTrailPoint();
                this.transitionPhase = 2;
            }
        } else if (this.transitionPhase === 2) {
            this.sceneOpacity = Math.min(1, this.sceneOpacity + frameDelta / 0.45);

            if (this.sceneOpacity === 1) {
                this.transitionPhase = 0;
            }
        }
    }

    _projectBodies() {
        const positions = this.system.positions;
        const centerX = this.cssWidth / 2;
        const centerY = this.cssHeight / 2;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * 3;
            const positionX = positions[offset];
            const positionY = positions[offset + 1];
            const positionZ = positions[offset + 2];
            const perspective = getVisualPerspective(positionZ);
            const depthIntensity = getDepthIntensity(perspective);

            this.projectedX[body] = centerX + positionX * this.positionScale * perspective;
            this.projectedY[body] = centerY - positionY * this.positionScale * perspective;
            this.projectedDepth[body] = positionZ;
            this.projectedRadius[body] = clamp(
                this.glowScale
                * 0.55
                * perspective
                * (0.82 + 0.38 * depthIntensity),
                MIN_GLOW_RADIUS,
                MAX_GLOW_RADIUS,
            );
            this.projectedDepthIntensity[body] = depthIntensity;
        }
    }

    _updateTrails(frameDelta) {
        if (frameDelta <= 0 || this.motionPreference.matches) {
            return;
        }

        this.trailSampleAccumulator += frameDelta;

        while (this.trailSampleAccumulator >= TRAIL_SAMPLE_INTERVAL) {
            this._recordTrailPoint();
            this.trailSampleAccumulator -= TRAIL_SAMPLE_INTERVAL;
        }
    }

    _recordTrailPoint() {
        const positions = this.system.positions;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const trailPoint = this.trailHeads[body];
            const trailOffset =
                (body * TRAIL_POINT_CAPACITY + trailPoint) * TRAIL_AXES;
            const positionOffset = body * TRAIL_AXES;

            this.trailPositions[trailOffset] = positions[positionOffset];
            this.trailPositions[trailOffset + 1] = positions[positionOffset + 1];
            this.trailPositions[trailOffset + 2] = positions[positionOffset + 2];
            this.trailHeads[body] = (trailPoint + 1) % TRAIL_POINT_CAPACITY;
            this.trailLengths[body] = Math.min(
                TRAIL_POINT_CAPACITY,
                this.trailLengths[body] + 1,
            );
        }
    }

    _clearTrails() {
        this.trailHeads.fill(0);
        this.trailLengths.fill(0);
        this.trailSampleAccumulator = 0;
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
            const offset = body * 3;
            const perspective = getRecoveryPerspective(positions[offset + 2]);
            const depthIntensity = getDepthIntensity(
                perspective,
                MIN_RECOVERY_PERSPECTIVE,
                MAX_RECOVERY_PERSPECTIVE,
            );
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
            const coreRadius = recoveryRadius * 0.16;
            const overflow = getOffscreenOverflow(
                projectedX,
                projectedY,
                coreRadius,
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

    _render() {
        if (!this.context || this.cssWidth <= 0 || this.cssHeight <= 0) {
            return;
        }

        const context = this.context;
        context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        context.clearRect(0, 0, this.cssWidth, this.cssHeight);
        context.globalCompositeOperation = "lighter";

        let first = 0;
        let second = 1;
        let third = 2;
        let temporary;

        if (this.projectedDepth[first] > this.projectedDepth[second]) {
            temporary = first;
            first = second;
            second = temporary;
        }
        if (this.projectedDepth[second] > this.projectedDepth[third]) {
            temporary = second;
            second = third;
            third = temporary;
        }
        if (this.projectedDepth[first] > this.projectedDepth[second]) {
            temporary = first;
            first = second;
            second = temporary;
        }

        this._drawTrail(first);
        this._drawTrail(second);
        this._drawTrail(third);
        this._drawBody(first);
        this._drawBody(second);
        this._drawBody(third);

        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
    }

    _drawTrail(body) {
        const trailLength = this.trailLengths[body];

        if (trailLength < 2) {
            return;
        }

        const context = this.context;
        const centerX = this.cssWidth / 2;
        const centerY = this.cssHeight / 2;
        const oldestPoint =
            (this.trailHeads[body] - trailLength + TRAIL_POINT_CAPACITY)
            % TRAIL_POINT_CAPACITY;
        let previousX = 0;
        let previousY = 0;

        context.strokeStyle = BODY_STYLES[body].trail;
        context.lineCap = "round";

        for (let point = 0; point < trailLength; point += 1) {
            const trailPoint = (oldestPoint + point) % TRAIL_POINT_CAPACITY;
            const trailOffset =
                (body * TRAIL_POINT_CAPACITY + trailPoint) * TRAIL_AXES;
            const positionX = this.trailPositions[trailOffset];
            const positionY = this.trailPositions[trailOffset + 1];
            const positionZ = this.trailPositions[trailOffset + 2];
            const perspective = getVisualPerspective(positionZ);
            const depthIntensity = getDepthIntensity(perspective);
            const projectedX = centerX + positionX * this.positionScale * perspective;
            const projectedY = centerY - positionY * this.positionScale * perspective;

            if (point > 0) {
                const ageProgress = point / (trailLength - 1);
                const fade = ageProgress * ageProgress;
                context.globalAlpha =
                    this.sceneOpacity
                    * (0.035 + 0.265 * fade)
                    * (0.25 + 0.75 * depthIntensity);
                context.lineWidth =
                    (0.55 + 3.3 * depthIntensity)
                    * (0.45 + 0.55 * ageProgress);
                context.beginPath();
                context.moveTo(previousX, previousY);
                context.lineTo(projectedX, projectedY);
                context.stroke();
            }

            previousX = projectedX;
            previousY = projectedY;
        }
    }

    _drawBody(body) {
        const sprites = this.sprites[body];

        if (!sprites) {
            return;
        }

        const radius = this.projectedRadius[body];
        const depthIntensity = this.projectedDepthIntensity[body];
        const haloAlpha = 0.32 + 0.63 * depthIntensity;

        this.context.globalAlpha = haloAlpha * this.sceneOpacity;
        this.context.drawImage(
            sprites.halo,
            this.projectedX[body] - radius,
            this.projectedY[body] - radius,
            radius * 2,
            radius * 2,
        );

        const coreRadius = radius * (0.27 + 0.12 * depthIntensity);
        const coreAlpha = 0.4 + 0.6 * depthIntensity;

        this.context.globalAlpha = coreAlpha * this.sceneOpacity;
        this.context.drawImage(
            sprites.core,
            this.projectedX[body] - coreRadius,
            this.projectedY[body] - coreRadius,
            coreRadius * 2,
            coreRadius * 2,
        );
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
        if (this.motionPreference.matches) {
            this._clearTrails();
            this._recordTrailPoint();
        }

        this._syncAnimationState();
    }

    _onFallbackResize() {
        this._requestResize();
    }
}

const canvas = document.querySelector("[data-three-body]");

if (canvas) {
    const background = new ThreeBodyBackground(canvas);
    background.start();
}
