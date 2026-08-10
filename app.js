import {
    ACESFilmicToneMapping,
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Color,
    CubeCamera,
    DynamicDrawUsage,
    LinearFilter,
    LinearMipmapLinearFilter,
    Line,
    LineBasicMaterial,
    Mesh,
    MeshPhysicalMaterial,
    Object3D,
    PerspectiveCamera,
    PointLight,
    Scene,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    WebGLCubeRenderTarget,
    WebGLRenderer,
} from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";

import { ThreeBodySystem } from "./physics.js";
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
// Rendering-only depth exaggeration. Physics and offscreen recovery keep their
// own coordinates and projection constants below.
const VISUAL_DEPTH_GAIN = 3.1;
const MIN_PERSPECTIVE = 0.44;
const MAX_PERSPECTIVE = 2.18;
const RECOVERY_DEPTH_GAIN = 2.1;
const MIN_RECOVERY_PERSPECTIVE = 0.65;
const MAX_RECOVERY_PERSPECTIVE = 1.62;
const MIN_GLOW_RADIUS = 32;
const MAX_RECOVERY_GLOW_RADIUS = 220;
const TRAIL_POINT_CAPACITY = 40;
const TRAIL_SAMPLE_INTERVAL = 1 / 30;
const TEXT_CONTENT = "HELLO WORLD !";
const TEXT_DEPTH = 0.3;
const MONUMENT_PITCH = -0.11;
const MONUMENT_YAW = -0.14;
const DESKTOP_REFLECTION_SIZE = 64;
const CONSTRAINED_REFLECTION_SIZE = 64;
const REFLECTION_MAX_ANGULAR_RADIUS = Math.PI / 24;
const REFLECTION_NEAR_FADE_START = 0.1;
const REFLECTION_NEAR_FADE_END = 0.42;
const REFLECTION_HALO_OPACITY_SCALE = 0.45;
const REFLECTION_CORE_OPACITY_SCALE = 0.7;
const FAR_HALO_OPACITY = 0.46;
const FAR_CORE_OPACITY = 0.58;

const BODY_STYLES = Object.freeze([
    Object.freeze({
        color: 0x52ddff,
        trailOpacity: 0.52,
        lightIntensity: 15,
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
            [1, "rgba(43, 173, 255, 0)"],
        ]),
    }),
    Object.freeze({
        color: 0xa87cff,
        trailOpacity: 0.56,
        lightIntensity: 17,
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
            [1, "rgba(121, 77, 246, 0)"],
        ]),
    }),
    Object.freeze({
        color: 0xffaa5c,
        trailOpacity: 0.58,
        lightIntensity: 18,
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
            [1, "rgba(238, 94, 42, 0)"],
        ]),
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
    return smoothstep((perspective - minimum) / (maximum - minimum));
}

function getVisualZ(positionZ) {
    const perspective = getVisualPerspective(positionZ);
    return CAMERA_DISTANCE - CAMERA_DISTANCE / perspective;
}

function createRadialTexture(stops) {
    const canvas = document.createElement("canvas");
    const size = 256;
    const center = size / 2;
    const context = canvas.getContext("2d", { alpha: true });

    canvas.width = size;
    canvas.height = size;

    if (context) {
        const gradient = context.createRadialGradient(
            center,
            center,
            0,
            center,
            center,
            center,
        );

        for (const [offset, color] of stops) {
            gradient.addColorStop(offset, color);
        }
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    return texture;
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
        this.backgroundColor = new Color(0x000000);
        this.reflectionBackground = new Color(0x000000);
        this.scene.background = this.backgroundColor;
        this.camera = new PerspectiveCamera(
            CAMERA_FOV,
            1,
            0.05,
            60,
        );
        this.camera.position.set(0, 0, CAMERA_DISTANCE);
        this.camera.lookAt(0, 0, 0);

        this.system = new ThreeBodySystem();
        this.motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.bodyVisuals = [];
        this.trailVisuals = [];
        this.trailHistory = [];
        this.mirrorMaterials = [];
        this.spriteTextures = [];
        this.textGeometry = null;
        this.textMesh = null;
        this.textLocalWidth = 1;
        this.reflectionTarget = null;
        this.cubeCamera = null;
        this.reflectionSize = 0;
        this.reflectionStride = 1;
        this.reflectionFrame = 0;
        this.reflectionUpdates = 0;

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
        this.trailSampleAccumulator = 0;
        this.lastTimestamp = 0;
        this.animationFrameId = null;
        this.sceneOpacity = 1;
        this.transitionPhase = 0;
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
        if (this.destroyed || this.started) {
            return;
        }

        this._resize();
        this._createBodies();
        await this._createMonument();
        this._resetTrails();
        this._updateBodyVisuals();
        this._updateTrailGeometry();
        this._updateDynamicReflection();
        this._render();

        this.started = true;
        this.canvas.dataset.renderingMode = "webgl-mirror";
        document.body.classList.add("scene-ready");
        this._syncAnimationState();
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
        }

        this.textGeometry?.dispose();
        for (const texture of this.spriteTextures) {
            texture.dispose();
        }
        this.reflectionTarget?.dispose();

        for (const material of this.mirrorMaterials) {
            material.dispose();
        }
        for (const visual of this.bodyVisuals) {
            visual.core.material.dispose();
            visual.halo.material.dispose();
            visual.reflectionCore.material.dispose();
            visual.reflectionHalo.material.dispose();
        }
        for (const visual of this.trailVisuals) {
            visual.geometry.dispose();
            visual.material.dispose();
        }
        this.renderer.dispose();
        this.canvas.dataset.simulationState = "destroyed";
    }

    _createBodies() {
        for (let body = 0; body < BODY_COUNT; body += 1) {
            const style = BODY_STYLES[body];
            const group = new Object3D();
            const haloTexture = createRadialTexture(style.haloStops);
            const coreTexture = createRadialTexture(style.coreStops);
            const halo = new Sprite(
                new SpriteMaterial({
                    map: haloTexture,
                    transparent: true,
                    opacity: 0.82,
                    blending: AdditiveBlending,
                    depthTest: true,
                    depthWrite: false,
                    toneMapped: false,
                }),
            );
            const core = new Sprite(
                new SpriteMaterial({
                    map: coreTexture,
                    transparent: true,
                    opacity: 0.9,
                    blending: AdditiveBlending,
                    depthTest: true,
                    depthWrite: false,
                    toneMapped: false,
                }),
            );
            const reflectionHalo = new Sprite(
                new SpriteMaterial({
                    map: haloTexture,
                    transparent: true,
                    opacity: 0,
                    blending: AdditiveBlending,
                    depthTest: true,
                    depthWrite: false,
                    toneMapped: false,
                }),
            );
            const reflectionCore = new Sprite(
                new SpriteMaterial({
                    map: coreTexture,
                    transparent: true,
                    opacity: 0,
                    blending: AdditiveBlending,
                    depthTest: true,
                    depthWrite: false,
                    toneMapped: false,
                }),
            );
            reflectionHalo.visible = false;
            reflectionCore.visible = false;
            const pointLight = new PointLight(
                style.color,
                style.lightIntensity,
                // No cutoff: the constant-power emitter follows inverse-square
                // falloff all the way into the distance.
                0,
                2,
            );

            group.add(halo, core, reflectionHalo, reflectionCore, pointLight);
            this.scene.add(group);
            this.bodyVisuals.push({
                group,
                core,
                halo,
                reflectionCore,
                reflectionHalo,
                pointLight,
            });
            this.spriteTextures.push(haloTexture, coreTexture);

            const trailPositions = new Float32Array(TRAIL_POINT_CAPACITY * AXIS_COUNT);
            const trailColors = new Float32Array(TRAIL_POINT_CAPACITY * AXIS_COUNT);
            const trailGeometry = new BufferGeometry();
            const positionAttribute = new BufferAttribute(trailPositions, AXIS_COUNT);
            const colorAttribute = new BufferAttribute(trailColors, AXIS_COUNT);
            const trailColor = new Color(style.color);

            positionAttribute.setUsage(DynamicDrawUsage);

            for (let point = 0; point < TRAIL_POINT_CAPACITY; point += 1) {
                const progress = point / (TRAIL_POINT_CAPACITY - 1);
                const intensity = 0.015 + 0.985 * progress * progress;
                const offset = point * AXIS_COUNT;

                trailColors[offset] = trailColor.r * intensity;
                trailColors[offset + 1] = trailColor.g * intensity;
                trailColors[offset + 2] = trailColor.b * intensity;
            }

            trailGeometry.setAttribute("position", positionAttribute);
            trailGeometry.setAttribute("color", colorAttribute);
            const trailMaterial = new LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: style.trailOpacity,
                blending: AdditiveBlending,
                depthTest: true,
                depthWrite: false,
                toneMapped: false,
            });
            const trailLine = new Line(trailGeometry, trailMaterial);

            trailLine.frustumCulled = false;
            this.scene.add(trailLine);
            this.trailVisuals.push({
                line: trailLine,
                geometry: trailGeometry,
                material: trailMaterial,
                positionAttribute,
            });
            this.trailHistory.push(
                new Float64Array(TRAIL_POINT_CAPACITY * AXIS_COUNT),
            );
        }
    }

    async _createMonument() {
        const fontUrl = new URL(
            "./assets/helvetiker_bold.typeface.json",
            import.meta.url,
        );
        const font = await new FontLoader().loadAsync(fontUrl.href);
        const geometry = new TextGeometry(TEXT_CONTENT, {
            font,
            size: 1,
            depth: TEXT_DEPTH,
            curveSegments: 10,
            steps: 1,
            bevelEnabled: true,
            bevelThickness: 0.055,
            bevelSize: 0.028,
            bevelOffset: 0,
            bevelSegments: 4,
        });

        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox;

        if (!bounds) {
            throw new Error("Unable to measure the monument text geometry.");
        }

        const centerX = (bounds.min.x + bounds.max.x) / 2;
        const centerY = (bounds.min.y + bounds.max.y) / 2;
        const centerZ = (bounds.min.z + bounds.max.z) / 2;

        geometry.translate(-centerX, -centerY, -centerZ);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        this.textLocalWidth = bounds.max.x - bounds.min.x;
        this.textGeometry = geometry;

        const frontMaterial = new MeshPhysicalMaterial({
            color: 0xf4f5f7,
            metalness: 1,
            roughness: 0.008,
            clearcoat: 1,
            clearcoatRoughness: 0.006,
            envMapIntensity: 1.35,
        });
        const sideMaterial = new MeshPhysicalMaterial({
            color: 0xb5bac2,
            metalness: 1,
            roughness: 0.02,
            clearcoat: 1,
            clearcoatRoughness: 0.012,
            envMapIntensity: 1.2,
        });

        this.mirrorMaterials = [frontMaterial, sideMaterial];
        this.textMesh = new Mesh(geometry, this.mirrorMaterials);
        this.textMesh.position.z = 0;
        this.textMesh.rotation.set(MONUMENT_PITCH, MONUMENT_YAW, 0);
        this.scene.add(this.textMesh);
        this._resizeMonument();
        this._ensureReflectionTarget();
    }

    _ensureReflectionTarget() {
        const isConstrained =
            this.cssWidth < 720
            || (Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4);
        const desiredSize = isConstrained
            ? CONSTRAINED_REFLECTION_SIZE
            : DESKTOP_REFLECTION_SIZE;

        this.reflectionStride = isConstrained ? 2 : 1;

        if (this.reflectionTarget && desiredSize === this.reflectionSize) {
            for (const material of this.mirrorMaterials) {
                if (material.envMap !== this.reflectionTarget.texture) {
                    material.envMap = this.reflectionTarget.texture;
                    material.needsUpdate = true;
                }
            }
            return;
        }

        const previousTarget = this.reflectionTarget;
        const target = new WebGLCubeRenderTarget(desiredSize, {
            generateMipmaps: true,
            minFilter: LinearMipmapLinearFilter,
            magFilter: LinearFilter,
            depthBuffer: true,
        });

        this.reflectionTarget = target;
        this.reflectionSize = desiredSize;

        if (!this.cubeCamera) {
            this.cubeCamera = new CubeCamera(0.08, 40, target);
            this.cubeCamera.position.set(0, 0, 0.06);
            this.scene.add(this.cubeCamera);
        } else {
            this.cubeCamera.renderTarget = target;
        }

        for (const material of this.mirrorMaterials) {
            material.envMap = target.texture;
            material.needsUpdate = true;
        }

        previousTarget?.dispose();
    }

    _requestResize() {
        if (this.destroyed) {
            return;
        }

        this.resizePending = true;

        if (this.animationFrameId === null && this.started) {
            this._resize();
            this._updateBodyVisuals();
            this._updateTrailGeometry();
            this._updateDynamicReflection();
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
        this._resizeMonument();
        this._ensureReflectionTarget();
        this._resetRecoveryTracking();
    }

    _resizeMonument() {
        if (!this.textMesh || this.textLocalWidth <= 0 || this.cssWidth <= 0) {
            return;
        }

        const widthRatio = this.cssWidth < 600 ? 0.9 : 0.67;
        const desiredPixelWidth = Math.min(this.cssWidth * widthRatio, 1120);
        const desiredWorldWidth = desiredPixelWidth / this.pixelsPerWorldUnit;
        const scale = desiredWorldWidth / this.textLocalWidth;

        this.textMesh.scale.setScalar(scale);
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
            this._updateBodyVisuals();
            this._updateTrailGeometry();
            this._updateDynamicReflection();
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
            this._resetTrails();
        }

        this._advanceResetTransition(frameDelta);
        this._updateTrails(frameDelta);
        this._updateBodyVisuals();
        this._updateTrailGeometry();
        this._updateOffscreenRecovery(frameDelta);

        this.reflectionFrame += 1;
        if (this.reflectionFrame % this.reflectionStride === 0) {
            this._updateDynamicReflection();
        }

        this._render();
        this.animationFrameId = requestAnimationFrame(this._onAnimationFrame);
    }

    _advanceResetTransition(frameDelta) {
        if (this.transitionPhase === 1) {
            this.sceneOpacity = Math.max(0, this.sceneOpacity - frameDelta / 0.25);

            if (this.sceneOpacity === 0) {
                this.system.reset();
                this._resetRecoveryTracking();
                this._resetTrails();
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

    _updateBodyVisuals() {
        const positions = this.system.positions;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const positionZ = positions[offset + 2];
            const perspective = getVisualPerspective(positionZ);
            const depthIntensity = getDepthIntensity(perspective);
            const diameter =
                this.glowWorldDiameter * (0.58 + 0.82 * depthIntensity);
            const visual = this.bodyVisuals[body];

            visual.group.position.set(
                positions[offset] * this.positionWorldScale,
                positions[offset + 1] * this.positionWorldScale,
                getVisualZ(positionZ),
            );
            visual.halo.scale.set(diameter, diameter, 1);
            visual.halo.material.opacity =
                FAR_HALO_OPACITY + (0.95 - FAR_HALO_OPACITY) * depthIntensity;
            const coreDiameter = diameter * (0.27 + 0.12 * depthIntensity);
            visual.core.scale.set(coreDiameter, coreDiameter, 1);
            visual.core.material.opacity =
                FAR_CORE_OPACITY + (1 - FAR_CORE_OPACITY) * depthIntensity;

            const reflectionDistance = this.cubeCamera
                ? visual.group.position.distanceTo(this.cubeCamera.position)
                : Number.POSITIVE_INFINITY;
            const maximumReflectionDiameter = Number.isFinite(reflectionDistance)
                ? 2
                    * reflectionDistance
                    * Math.tan(REFLECTION_MAX_ANGULAR_RADIUS)
                : diameter;
            const reflectionDiameter = Math.min(
                diameter,
                maximumReflectionDiameter,
            );
            const reflectionNearFade = Number.isFinite(reflectionDistance)
                ? smoothstep(
                    (reflectionDistance - REFLECTION_NEAR_FADE_START)
                    / (REFLECTION_NEAR_FADE_END - REFLECTION_NEAR_FADE_START),
                )
                : 1;

            visual.reflectionHalo.scale.set(
                reflectionDiameter,
                reflectionDiameter,
                1,
            );
            visual.reflectionHalo.material.opacity =
                visual.halo.material.opacity
                * REFLECTION_HALO_OPACITY_SCALE
                * reflectionNearFade;
            const reflectionCoreDiameter =
                reflectionDiameter * (0.27 + 0.12 * depthIntensity);
            visual.reflectionCore.scale.set(
                reflectionCoreDiameter,
                reflectionCoreDiameter,
                1,
            );
            visual.reflectionCore.material.opacity =
                visual.core.material.opacity
                * REFLECTION_CORE_OPACITY_SCALE
                * reflectionNearFade;
            visual.pointLight.intensity = BODY_STYLES[body].lightIntensity;
        }
    }

    _updateTrails(frameDelta) {
        if (frameDelta <= 0) {
            return;
        }

        this.trailSampleAccumulator += frameDelta;

        while (this.trailSampleAccumulator >= TRAIL_SAMPLE_INTERVAL) {
            this._recordTrailPoint();
            this.trailSampleAccumulator -= TRAIL_SAMPLE_INTERVAL;
        }
    }

    _resetTrails() {
        const positions = this.system.positions;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const history = this.trailHistory[body];
            const positionOffset = body * AXIS_COUNT;

            for (let point = 0; point < TRAIL_POINT_CAPACITY; point += 1) {
                const trailOffset = point * AXIS_COUNT;
                history[trailOffset] = positions[positionOffset];
                history[trailOffset + 1] = positions[positionOffset + 1];
                history[trailOffset + 2] = positions[positionOffset + 2];
            }
        }

        this.trailSampleAccumulator = 0;
        this._updateTrailGeometry();
    }

    _recordTrailPoint() {
        const positions = this.system.positions;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const history = this.trailHistory[body];
            const positionOffset = body * AXIS_COUNT;
            const newestOffset = history.length - AXIS_COUNT;

            history.copyWithin(0, AXIS_COUNT);
            history[newestOffset] = positions[positionOffset];
            history[newestOffset + 1] = positions[positionOffset + 1];
            history[newestOffset + 2] = positions[positionOffset + 2];
        }
    }

    _updateTrailGeometry() {
        for (let body = 0; body < BODY_COUNT; body += 1) {
            const history = this.trailHistory[body];
            const attribute = this.trailVisuals[body].positionAttribute;
            const output = attribute.array;

            for (let point = 0; point < TRAIL_POINT_CAPACITY; point += 1) {
                const offset = point * AXIS_COUNT;

                output[offset] = history[offset] * this.positionWorldScale;
                output[offset + 1] = history[offset + 1] * this.positionWorldScale;
                output[offset + 2] = getVisualZ(history[offset + 2]);
            }

            attribute.needsUpdate = true;
            this.trailVisuals[body].geometry.computeBoundingSphere();
        }
    }

    _updateDynamicReflection() {
        if (!this.textMesh || !this.cubeCamera || !this.reflectionTarget) {
            return;
        }

        const mainBackground = this.scene.background;
        this.textMesh.visible = false;
        this.scene.background = this.reflectionBackground;

        for (const visual of this.bodyVisuals) {
            visual.halo.visible = false;
            visual.core.visible = false;
            visual.reflectionHalo.visible =
                visual.reflectionHalo.material.opacity > 0;
            visual.reflectionCore.visible =
                visual.reflectionCore.material.opacity > 0;
        }

        try {
            this.cubeCamera.update(this.renderer, this.scene);
        } finally {
            this.scene.background = mainBackground;
            this.textMesh.visible = true;

            for (const visual of this.bodyVisuals) {
                visual.halo.visible = true;
                visual.core.visible = true;
                visual.reflectionHalo.visible = false;
                visual.reflectionCore.visible = false;
            }
        }

        this.reflectionUpdates += 1;
        this.canvas.dataset.reflectionUpdates = String(this.reflectionUpdates);
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

const canvas = document.querySelector("[data-three-body]");

if (canvas) {
    try {
        const monument = new MirrorMonumentScene(canvas);

        monument.start().catch((error) => {
            console.error("Unable to start the mirror monument scene.", error);
            monument.destroy();
            document.body.classList.remove("scene-ready");
            document.body.classList.add("scene-failed");
            canvas.dataset.simulationState = "failed";
        });
    } catch (error) {
        console.error("WebGL mirror monument is unavailable.", error);
        document.body.classList.add("scene-failed");
        canvas.dataset.simulationState = "failed";
    }
}
