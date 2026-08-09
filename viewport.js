const WORLD_VERTICAL_SPAN = 4;
const MIN_HORIZONTAL_POSITION_SPAN = 3.4;
const MIN_HORIZONTAL_GLOW_SPAN = 2;
const RECOVERY_URGENCY_DELAY = 6;
const RECOVERY_URGENCY_RAMP = 2;
const RECOVERY_PROGRESS_EPSILON = 0.01;

export const MAX_RECOVERY_STALL_DURATION = 12;

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
