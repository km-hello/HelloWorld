const WORLD_VERTICAL_SPAN = 4;
const MIN_HORIZONTAL_POSITION_SPAN = 3.4;
const MIN_HORIZONTAL_GLOW_SPAN = 2;
const RECOVERY_URGENCY_DELAY = 6;
const RECOVERY_URGENCY_RAMP = 2;
const RECOVERY_PROGRESS_EPSILON = 0.01;

export const MAX_RECOVERY_STALL_DURATION = 12;
// The main camera's plane expressed in simulation-space Z units. Keeping this
// below the default blue body's closest approach lets that body genuinely pass
// the viewer instead of reaching a capped perspective and turning in place.
export const VISUAL_CAMERA_POSITION_Z = 1.2;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value) {
    const normalized = clamp(value, 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
}

export function getPositionScale(width, height) {
    return Math.min(
        height / WORLD_VERTICAL_SPAN,
        width / MIN_HORIZONTAL_POSITION_SPAN,
    );
}

export function getGlowScale(width, height) {
    return Math.min(
        height / WORLD_VERTICAL_SPAN,
        width / MIN_HORIZONTAL_GLOW_SPAN,
    );
}

/**
 * Map simulation-space depth to the Three.js camera's world-space depth.
 * This mapping stays linear through and beyond the camera plane, so neither a
 * near-object size cap nor a frozen maximum Z position is needed.
 */
export function getVisualZ(positionZ, cameraDistance) {
    return positionZ * cameraDistance / VISUAL_CAMERA_POSITION_Z;
}

/**
 * Return the perspective multiplier while a body is in front of the viewer.
 * At and beyond the camera plane the renderer clips the body naturally.
 */
export function getVisualPerspective(positionZ) {
    const forwardDistance = VISUAL_CAMERA_POSITION_Z - positionZ;

    return forwardDistance > 0
        ? VISUAL_CAMERA_POSITION_Z / forwardDistance
        : Number.POSITIVE_INFINITY;
}

/**
 * Fade a billboard before its center reaches the camera's near clipping plane.
 * Perspective remains uncapped; only opacity changes during the final approach.
 */
export function getNearCameraFade(
    positionZ,
    cameraDistance,
    nearDistance,
    fullOpacityDistance,
) {
    const forwardDistance = cameraDistance - getVisualZ(
        positionZ,
        cameraDistance,
    );

    return smoothstep(
        (forwardDistance - nearDistance)
        / (fullOpacityDistance - nearDistance),
    );
}

export function getOffscreenOverflow(
    projectedX,
    projectedY,
    coreRadius,
    width,
    height,
    margin,
) {
    return Math.max(
        0,
        -margin - (projectedX + coreRadius),
        projectedX - coreRadius - (width + margin),
        -margin - (projectedY + coreRadius),
        projectedY - coreRadius - (height + margin),
    );
}

/**
 * Update fixed-capacity viewport recovery state without allocating per frame.
 * The stall timer grows only while a body is not making visible return progress.
 */
export function updateRecoveryTracking(
    offscreenDurations,
    stallDurations,
    previousOverflows,
    body,
    overflow,
    deltaTime,
) {
    const safeDelta = Math.max(0, deltaTime);
    const previousOverflow = previousOverflows[body];

    if (overflow > 0) {
        offscreenDurations[body] += safeDelta;

        const isReturning =
            previousOverflow > 0
            && overflow < previousOverflow - RECOVERY_PROGRESS_EPSILON;

        if (isReturning) {
            stallDurations[body] = Math.max(
                0,
                stallDurations[body] - safeDelta * 2,
            );
        } else {
            stallDurations[body] += safeDelta;
        }
    } else {
        offscreenDurations[body] = Math.max(
            0,
            offscreenDurations[body] - safeDelta * 4,
        );
        stallDurations[body] = 0;
    }

    previousOverflows[body] = overflow;

    return smoothstep(
        (offscreenDurations[body] - RECOVERY_URGENCY_DELAY)
        / RECOVERY_URGENCY_RAMP,
    );
}
