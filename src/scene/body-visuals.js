import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Color,
    DynamicDrawUsage,
    LinearFilter,
    Line,
    LineBasicMaterial,
    Object3D,
    PointLight,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
} from "three";

import {
    getNearCameraFade,
    getVisualPerspective,
    getVisualZ,
} from "./viewport.js";

const BODY_COUNT = 3;
const AXIS_COUNT = 3;
const CAMERA_NEAR_DISTANCE = 0.05;
const CAMERA_FADE_FULL_OPACITY_DISTANCE = 0.45;
const FAR_STYLE_PERSPECTIVE = 0.44;
const FULL_STYLE_PERSPECTIVE = 2.18;
const TRAIL_POINT_CAPACITY = 40;
const TRAIL_SAMPLE_INTERVAL = 1 / 30;
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

function getDepthIntensity(perspective) {
    return smoothstep(
        (perspective - FAR_STYLE_PERSPECTIVE)
        / (FULL_STYLE_PERSPECTIVE - FAR_STYLE_PERSPECTIVE),
    );
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

export class BodyVisuals {
    constructor(scene, cameraDistance) {
        this.scene = scene;
        this.cameraDistance = cameraDistance;
        this.visuals = [];
        this.trails = [];
        this.trailHistory = [];
        this.textures = [];
        this.positionWorldScale = 1;
        this.glowWorldDiameter = 1;
        this.trailSampleAccumulator = 0;

        this._create();
    }

    resize(positionWorldScale, glowWorldDiameter) {
        this.positionWorldScale = positionWorldScale;
        this.glowWorldDiameter = glowWorldDiameter;
        this._updateTrailGeometry();
    }

    updateBodies(positions, reflectionProbePosition) {
        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const positionZ = positions[offset + 2];
            const perspective = getVisualPerspective(positionZ);
            const depthIntensity = getDepthIntensity(perspective);
            const cameraFade = getNearCameraFade(
                positionZ,
                this.cameraDistance,
                CAMERA_NEAR_DISTANCE,
                CAMERA_FADE_FULL_OPACITY_DISTANCE,
            );
            const diameter =
                this.glowWorldDiameter * (0.58 + 0.82 * depthIntensity);
            const visual = this.visuals[body];
            const haloOpacity =
                FAR_HALO_OPACITY + (0.95 - FAR_HALO_OPACITY) * depthIntensity;
            const coreOpacity =
                FAR_CORE_OPACITY + (1 - FAR_CORE_OPACITY) * depthIntensity;

            visual.group.position.set(
                positions[offset] * this.positionWorldScale,
                positions[offset + 1] * this.positionWorldScale,
                getVisualZ(positionZ, this.cameraDistance),
            );
            visual.halo.scale.set(diameter, diameter, 1);
            visual.halo.material.opacity = haloOpacity * cameraFade;
            const coreDiameter = diameter * (0.27 + 0.12 * depthIntensity);
            visual.core.scale.set(coreDiameter, coreDiameter, 1);
            visual.core.material.opacity = coreOpacity * cameraFade;
            visual.mainVisible = cameraFade > 0;
            visual.halo.visible = visual.mainVisible;
            visual.core.visible = visual.mainVisible;

            const reflectionDistance = reflectionProbePosition
                ? visual.group.position.distanceTo(reflectionProbePosition)
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
                haloOpacity
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
                coreOpacity
                * REFLECTION_CORE_OPACITY_SCALE
                * reflectionNearFade;
            visual.pointLight.intensity = BODY_STYLES[body].lightIntensity;
        }
    }

    updateTrails(frameDelta, positions) {
        if (frameDelta > 0) {
            this.trailSampleAccumulator += frameDelta;

            while (this.trailSampleAccumulator >= TRAIL_SAMPLE_INTERVAL) {
                this._recordTrailPoint(positions);
                this.trailSampleAccumulator -= TRAIL_SAMPLE_INTERVAL;
            }
        }

        this._updateTrailGeometry();
    }

    resetTrails(positions) {
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

    resetTrailSampling() {
        this.trailSampleAccumulator = 0;
    }

    setReflectionMode(enabled) {
        for (const visual of this.visuals) {
            visual.halo.visible = enabled ? false : visual.mainVisible;
            visual.core.visible = enabled ? false : visual.mainVisible;
            visual.reflectionHalo.visible = enabled
                && visual.reflectionHalo.material.opacity > 0;
            visual.reflectionCore.visible = enabled
                && visual.reflectionCore.material.opacity > 0;
        }
    }

    dispose() {
        const spriteGeometry = this.visuals[0]?.halo.geometry;

        for (const texture of this.textures) {
            texture.dispose();
        }
        for (const visual of this.visuals) {
            visual.core.material.dispose();
            visual.halo.material.dispose();
            visual.reflectionCore.material.dispose();
            visual.reflectionHalo.material.dispose();
        }
        for (const trail of this.trails) {
            trail.geometry.dispose();
            trail.material.dispose();
        }

        // Three.js shares one module-level geometry across every Sprite. Its
        // renderer-specific dispose listener otherwise keeps a destroyed
        // WebGLRenderer and canvas reachable after renderer.dispose().
        spriteGeometry?.dispose();

        this.visuals.length = 0;
        this.trails.length = 0;
        this.trailHistory.length = 0;
        this.textures.length = 0;
    }

    _create() {
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
            this.visuals.push({
                group,
                core,
                halo,
                reflectionCore,
                reflectionHalo,
                pointLight,
                mainVisible: true,
            });
            this.textures.push(haloTexture, coreTexture);

            const trailPositions = new Float32Array(
                TRAIL_POINT_CAPACITY * AXIS_COUNT,
            );
            const trailColors = new Float32Array(
                TRAIL_POINT_CAPACITY * AXIS_COUNT,
            );
            const trailGeometry = new BufferGeometry();
            const positionAttribute = new BufferAttribute(
                trailPositions,
                AXIS_COUNT,
            );
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
            this.trails.push({
                geometry: trailGeometry,
                material: trailMaterial,
                positionAttribute,
            });
            this.trailHistory.push(
                new Float64Array(TRAIL_POINT_CAPACITY * AXIS_COUNT),
            );
        }
    }

    _recordTrailPoint(positions) {
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
            const attribute = this.trails[body].positionAttribute;
            const output = attribute.array;

            for (let point = 0; point < TRAIL_POINT_CAPACITY; point += 1) {
                const offset = point * AXIS_COUNT;

                output[offset] = history[offset] * this.positionWorldScale;
                output[offset + 1] =
                    history[offset + 1] * this.positionWorldScale;
                output[offset + 2] = getVisualZ(
                    history[offset + 2],
                    this.cameraDistance,
                );
            }

            attribute.needsUpdate = true;
        }
    }
}
