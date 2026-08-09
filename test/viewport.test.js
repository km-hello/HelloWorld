import assert from "node:assert/strict";
import test from "node:test";

import { ThreeBodySystem } from "../physics.js";
import {
    getGlowScale,
    getOffscreenOverflow,
    getPositionScale,
    MAX_RECOVERY_STALL_DURATION,
    updateRecoveryTracking,
} from "../viewport.js";

const FIXED_STEP = 1 / 120;
const FRAME_STEP = 1 / 60;
const CAMERA_DISTANCE = 6;
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

function getRecoveryPerspective(positionZ) {
    const visualDepth = positionZ * RECOVERY_DEPTH_GAIN;
    const safeDepth = Math.min(visualDepth, CAMERA_DISTANCE - 0.5);

    return clamp(
        CAMERA_DISTANCE / (CAMERA_DISTANCE - safeDepth),
        MIN_RECOVERY_PERSPECTIVE,
        MAX_RECOVERY_PERSPECTIVE,
    );
}

test("portrait layouts constrain position scale without shrinking the glow equally", () => {
    assert.equal(getPositionScale(1280, 720), 180);
    assert.equal(getGlowScale(1280, 720), 180);
    assert.ok(Math.abs(getPositionScale(390, 844) - 390 / 3.4) < 1e-12);
    assert.equal(getGlowScale(390, 844), 195);
    assert.ok(getGlowScale(390, 844) > getPositionScale(390, 844));
});

test("offscreen fallback tracks stalled recovery instead of total return time", () => {
    const offscreenDurations = new Float64Array(1);
    const stallDurations = new Float64Array(1);
    const previousOverflows = new Float64Array(1);

    for (let frame = 0; frame < 8 / FRAME_STEP; frame += 1) {
        updateRecoveryTracking(
            offscreenDurations,
            stallDurations,
            previousOverflows,
            0,
            200 - frame * 0.1,
            FRAME_STEP,
        );
    }

    assert.ok(offscreenDurations[0] > 7.9);
    assert.equal(stallDurations[0], 0);

    for (let frame = 0; frame < 12.1 / FRAME_STEP; frame += 1) {
        updateRecoveryTracking(
            offscreenDurations,
            stallDurations,
            previousOverflows,
            0,
            152,
            FRAME_STEP,
        );
    }

    assert.ok(stallDurations[0] >= MAX_RECOVERY_STALL_DURATION);
});

test("narrow-screen recovery remains stable during a twenty-minute run", () => {
    const width = 390;
    const height = 844;
    const margin = Math.min(width, height) * 0.15;
    const positionScale = getPositionScale(width, height);
    const glowScale = getGlowScale(width, height);
    const offscreenDurations = new Float64Array(3);
    const stallDurations = new Float64Array(3);
    const previousOverflows = new Float64Array(3);
    const system = new ThreeBodySystem();
    let maximumSpeed = 0;
    let hardLimitFrames = 0;
    let maximumStallDuration = 0;

    for (let frame = 0; frame < 20 * 60 / FRAME_STEP; frame += 1) {
        system.step(FIXED_STEP);
        system.step(FIXED_STEP);

        for (let body = 0; body < 3; body += 1) {
            const offset = body * 3;
            const perspective = getRecoveryPerspective(system.positions[offset + 2]);
            const depthIntensity = smoothstep(
                (perspective - MIN_RECOVERY_PERSPECTIVE)
                / (MAX_RECOVERY_PERSPECTIVE - MIN_RECOVERY_PERSPECTIVE),
            );
            const projectedX = width / 2
                + system.positions[offset] * positionScale * perspective;
            const projectedY = height / 2
                - system.positions[offset + 1] * positionScale * perspective;
            const recoveryRadius = clamp(
                glowScale
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
                width,
                height,
                margin,
            );
            const urgency = updateRecoveryTracking(
                offscreenDurations,
                stallDurations,
                previousOverflows,
                body,
                overflow,
                FRAME_STEP,
            );
            const speed = Math.hypot(
                system.velocities[offset],
                system.velocities[offset + 1],
                system.velocities[offset + 2],
            );

            system.setRecoveryUrgency(body, urgency);
            maximumSpeed = Math.max(maximumSpeed, speed);
            maximumStallDuration = Math.max(
                maximumStallDuration,
                stallDurations[body],
            );

            if (speed >= system.config.hardSpeedLimit * 0.99) {
                hardLimitFrames += 1;
            }
        }
    }

    assert.ok(maximumSpeed < 4.5, `unexpected maximum speed: ${maximumSpeed}`);
    assert.equal(hardLimitFrames, 0);
    assert.ok(
        maximumStallDuration < MAX_RECOVERY_STALL_DURATION,
        `unexpected recovery stall: ${maximumStallDuration}`,
    );
    assert.equal(system.resetCount, 1);
});
