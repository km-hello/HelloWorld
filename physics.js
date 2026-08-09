const BODY_COUNT = 3;
const AXIS_COUNT = 3;
const STATE_SIZE = BODY_COUNT * AXIS_COUNT;
const PAIR_FIRST = [0, 0, 1];
const PAIR_SECOND = [1, 2, 2];
const PAIR_THIRD = [2, 1, 0];

const DEFAULT_POSITIONS = [
    -0.9, -0.25, 0.35,
    0.75, -0.35, -0.25,
    0.15, 0.6, -0.1,
];

const DEFAULT_VELOCITIES = [
    0.3, 0.576, -0.216,
    -0.48, 0.216, 0.264,
    0.18, -0.792, -0.048,
];

const DEFAULT_MASSES = [1, 1, 1];

export const DEFAULT_PHYSICS_CONFIG = Object.freeze({
    gravityConstant: 0.9,
    softening: 0.12,
    coreRadius: 0.32,
    coreRepulsion: 35,
    boundaryStart: 2.9,
    boundaryFull: 4.7,
    restoreStiffness: 1.5,
    maxRestoreAcceleration: 4.5,
    boundaryDamping: 0,
    maxAcceleration: 18,
    softSpeedLimit: 3.2,
    hardSpeedLimit: 6,
    speedDamping: 0,
    binaryCaptureDistance: 0.7,
    binaryIsolationDistance: 1.8,
    binaryCaptureDuration: 8,
    binaryBindingEnergyMargin: 0.15,
    binaryInternalGravityScale: 0.65,
    binaryExternalGravityScale: 1.5,
    binaryControlRampUp: 4,
    binaryControlMinimumHold: 3,
    binaryControlMaximumHold: 10,
    binaryControlRampDown: 3,
    binaryReengageDistance: 1.35,
    binaryOpenDistance: 1.6,
    binaryControlCooldown: 8,
    failSafeRadius: 20,
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value) {
    const normalized = clamp(value, 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
}

function assertStateVector(value, name) {
    if (!value || value.length !== STATE_SIZE) {
        throw new TypeError(`${name} must contain exactly ${STATE_SIZE} numbers.`);
    }
}

/**
 * Deterministic, allocation-free three-body simulation in normalized units.
 * Positions and velocities are exposed as stable typed-array views for rendering.
 */
export class ThreeBodySystem {
    constructor(options = {}) {
        const {
            initialPositions = DEFAULT_POSITIONS,
            initialVelocities = DEFAULT_VELOCITIES,
            masses = DEFAULT_MASSES,
            ...physicsOverrides
        } = options;

        assertStateVector(initialPositions, "initialPositions");
        assertStateVector(initialVelocities, "initialVelocities");

        if (!masses || masses.length !== BODY_COUNT) {
            throw new TypeError(`masses must contain exactly ${BODY_COUNT} numbers.`);
        }

        this.config = Object.freeze({
            ...DEFAULT_PHYSICS_CONFIG,
            ...physicsOverrides,
        });

        this.positions = new Float64Array(STATE_SIZE);
        this.velocities = new Float64Array(STATE_SIZE);
        this.accelerations = new Float64Array(STATE_SIZE);
        this.masses = Float64Array.from(masses);

        this._nextAccelerations = new Float64Array(STATE_SIZE);
        this._initialPositions = Float64Array.from(initialPositions);
        this._initialVelocities = Float64Array.from(initialVelocities);
        this._recoveryUrgencies = new Float64Array(BODY_COUNT);

        this.elapsedTime = 0;
        this.resetCount = 0;
        this.binaryInterventionCount = 0;
        this.binaryControlStrength = 0;
        this._binaryCandidatePair = -1;
        this._binaryCandidateTime = 0;
        this._binaryControlPair = -1;
        this._binaryControlPhase = 0;
        this._binaryControlPhaseTime = 0;
        this._binaryControlCooldown = 0;

        this._validateConfiguration();
        this.reset();
    }

    _validateConfiguration() {
        let totalMass = 0;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const mass = this.masses[body];

            if (!Number.isFinite(mass) || mass <= 0) {
                throw new RangeError("Every body mass must be a positive finite number.");
            }

            totalMass += mass;
        }

        const configValues = Object.values(this.config);
        if (configValues.some((value) => !Number.isFinite(value) || value < 0)) {
            throw new RangeError("Physics configuration values must be finite and non-negative.");
        }

        if (totalMass <= 0 || this.config.boundaryFull <= this.config.boundaryStart) {
            throw new RangeError("The physics configuration defines an invalid simulation volume.");
        }

        if (
            this.config.binaryInternalGravityScale > 1
            || this.config.binaryExternalGravityScale < 1
            || this.config.binaryControlMaximumHold < this.config.binaryControlMinimumHold
        ) {
            throw new RangeError("The binary interaction controller configuration is invalid.");
        }
    }

    reset() {
        this.positions.set(this._initialPositions);
        this.velocities.set(this._initialVelocities);
        this._recoveryUrgencies.fill(0);
        this.elapsedTime = 0;
        this._binaryCandidatePair = -1;
        this._binaryCandidateTime = 0;
        this._binaryControlPair = -1;
        this._binaryControlPhase = 0;
        this._binaryControlPhaseTime = 0;
        this._binaryControlCooldown = 0;
        this.binaryControlStrength = 0;

        this._removeCenterOfMassDrift();
        this._computeAccelerations(this.accelerations);
        this.resetCount += 1;
    }

    /**
     * Replace the current state. This is useful for deterministic tests and future
     * debugging tools; normal animation only needs reset() and step().
     */
    setState(positions, velocities, recenter = false) {
        assertStateVector(positions, "positions");
        assertStateVector(velocities, "velocities");

        this.positions.set(positions);
        this.velocities.set(velocities);
        this._binaryCandidatePair = -1;
        this._binaryCandidateTime = 0;
        this._binaryControlPair = -1;
        this._binaryControlPhase = 0;
        this._binaryControlPhaseTime = 0;
        this._binaryControlCooldown = 0;
        this.binaryControlStrength = 0;

        if (recenter) {
            this._removeCenterOfMassDrift();
        }

        this._computeAccelerations(this.accelerations);
    }

    setRecoveryUrgency(bodyIndex, urgency) {
        if (bodyIndex < 0 || bodyIndex >= BODY_COUNT) {
            return;
        }

        this._recoveryUrgencies[bodyIndex] = clamp(urgency, 0, 1);
    }

    step(deltaTime) {
        if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
            return true;
        }

        const halfDeltaSquared = 0.5 * deltaTime * deltaTime;

        for (let index = 0; index < STATE_SIZE; index += 1) {
            this.positions[index] +=
                this.velocities[index] * deltaTime
                + this.accelerations[index] * halfDeltaSquared;
        }

        this._computeAccelerations(this._nextAccelerations);

        for (let index = 0; index < STATE_SIZE; index += 1) {
            this.velocities[index] +=
                0.5
                * (this.accelerations[index] + this._nextAccelerations[index])
                * deltaTime;
            this.accelerations[index] = this._nextAccelerations[index];
        }

        this._applySpeedSafety(deltaTime);
        this._updateBinaryController(deltaTime);
        this.elapsedTime += deltaTime;

        if (!this._stateIsSafe()) {
            this.reset();
            return false;
        }

        return true;
    }

    _removeCenterOfMassDrift() {
        let totalMass = 0;
        let centerX = 0;
        let centerY = 0;
        let centerZ = 0;
        let momentumX = 0;
        let momentumY = 0;
        let momentumZ = 0;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const mass = this.masses[body];
            totalMass += mass;
            centerX += this.positions[offset] * mass;
            centerY += this.positions[offset + 1] * mass;
            centerZ += this.positions[offset + 2] * mass;
            momentumX += this.velocities[offset] * mass;
            momentumY += this.velocities[offset + 1] * mass;
            momentumZ += this.velocities[offset + 2] * mass;
        }

        centerX /= totalMass;
        centerY /= totalMass;
        centerZ /= totalMass;
        momentumX /= totalMass;
        momentumY /= totalMass;
        momentumZ /= totalMass;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            this.positions[offset] -= centerX;
            this.positions[offset + 1] -= centerY;
            this.positions[offset + 2] -= centerZ;
            this.velocities[offset] -= momentumX;
            this.velocities[offset + 1] -= momentumY;
            this.velocities[offset + 2] -= momentumZ;
        }
    }

    _computeAccelerations(output) {
        output.fill(0);

        const {
            gravityConstant,
            softening,
            coreRadius,
            coreRepulsion,
            boundaryStart,
            boundaryFull,
            restoreStiffness,
            maxRestoreAcceleration,
            boundaryDamping,
            maxAcceleration,
        } = this.config;
        const softenedDistanceSquared = softening * softening;

        for (let first = 0; first < BODY_COUNT - 1; first += 1) {
            const firstOffset = first * AXIS_COUNT;

            for (let second = first + 1; second < BODY_COUNT; second += 1) {
                const secondOffset = second * AXIS_COUNT;
                const deltaX = this.positions[secondOffset] - this.positions[firstOffset];
                const deltaY = this.positions[secondOffset + 1] - this.positions[firstOffset + 1];
                const deltaZ = this.positions[secondOffset + 2] - this.positions[firstOffset + 2];
                const rawDistanceSquared =
                    deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
                const rawDistance = Math.sqrt(rawDistanceSquared);
                const distanceSquared =
                    rawDistanceSquared + softenedDistanceSquared;
                const inverseDistance = 1 / Math.sqrt(distanceSquared);
                const interactionScale = this._getPairGravityScale(first, second);
                const gravityScale =
                    gravityConstant
                    * interactionScale
                    * inverseDistance
                    * inverseDistance
                    * inverseDistance;
                let repulsionScale = 0;

                if (rawDistance > Number.EPSILON && rawDistance < coreRadius) {
                    const corePenetration = (coreRadius - rawDistance) / coreRadius;
                    const repulsionAcceleration =
                        coreRepulsion * smoothstep(corePenetration);
                    repulsionScale = repulsionAcceleration / rawDistance;
                }

                const firstScale =
                    (gravityScale - repulsionScale) * this.masses[second];
                const secondScale =
                    (gravityScale - repulsionScale) * this.masses[first];

                output[firstOffset] += deltaX * firstScale;
                output[firstOffset + 1] += deltaY * firstScale;
                output[firstOffset + 2] += deltaZ * firstScale;
                output[secondOffset] -= deltaX * secondScale;
                output[secondOffset + 1] -= deltaY * secondScale;
                output[secondOffset + 2] -= deltaZ * secondScale;
            }
        }

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const positionX = this.positions[offset];
            const positionY = this.positions[offset + 1];
            const positionZ = this.positions[offset + 2];
            const radius = Math.hypot(positionX, positionY, positionZ);
            const urgency = this._recoveryUrgencies[body];
            const effectiveStart = boundaryStart * (1 - 0.65 * urgency);
            const effectiveFull = Math.max(
                effectiveStart + 0.01,
                boundaryFull * (1 - 0.35 * urgency),
            );

            if (radius > effectiveStart && radius > 0) {
                const boundaryProgress = smoothstep(
                    (radius - effectiveStart) / (effectiveFull - effectiveStart),
                );
                const recoveryMultiplier = 1 + urgency;
                const recoveryAcceleration = Math.min(
                    maxRestoreAcceleration * recoveryMultiplier,
                    restoreStiffness
                        * (radius - effectiveStart)
                        * boundaryProgress
                        * recoveryMultiplier,
                );
                const inverseRadius = 1 / radius;
                const directionX = positionX * inverseRadius;
                const directionY = positionY * inverseRadius;
                const directionZ = positionZ * inverseRadius;
                const radialVelocity =
                    this.velocities[offset] * directionX
                    + this.velocities[offset + 1] * directionY
                    + this.velocities[offset + 2] * directionZ;
                const outwardDamping = radialVelocity > 0
                    ? boundaryDamping * boundaryProgress * radialVelocity * recoveryMultiplier
                    : 0;
                const totalRecovery = recoveryAcceleration + outwardDamping;

                output[offset] -= directionX * totalRecovery;
                output[offset + 1] -= directionY * totalRecovery;
                output[offset + 2] -= directionZ * totalRecovery;
            }

            const acceleration = Math.hypot(
                output[offset],
                output[offset + 1],
                output[offset + 2],
            );

            if (acceleration > maxAcceleration && acceleration > 0) {
                const safetyScale = maxAcceleration / acceleration;
                output[offset] *= safetyScale;
                output[offset + 1] *= safetyScale;
                output[offset + 2] *= safetyScale;
            }
        }
    }

    _getPairGravityScale(first, second) {
        if (this._binaryControlPair < 0 || this.binaryControlStrength <= 0) {
            return 1;
        }

        const controlledFirst = PAIR_FIRST[this._binaryControlPair];
        const controlledSecond = PAIR_SECOND[this._binaryControlPair];
        const isInternalPair =
            (first === controlledFirst && second === controlledSecond)
            || (first === controlledSecond && second === controlledFirst);
        const targetScale = isInternalPair
            ? this.config.binaryInternalGravityScale
            : this.config.binaryExternalGravityScale;

        return 1 + (targetScale - 1) * this.binaryControlStrength;
    }

    _applySpeedSafety(deltaTime) {
        const {
            softSpeedLimit,
            hardSpeedLimit,
            speedDamping,
        } = this.config;

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const speed = Math.hypot(
                this.velocities[offset],
                this.velocities[offset + 1],
                this.velocities[offset + 2],
            );

            if (speedDamping > 0 && speed > softSpeedLimit) {
                const drag = Math.exp(-(speed - softSpeedLimit) * speedDamping * deltaTime);
                this.velocities[offset] *= drag;
                this.velocities[offset + 1] *= drag;
                this.velocities[offset + 2] *= drag;
            }

            const dampedSpeed = Math.hypot(
                this.velocities[offset],
                this.velocities[offset + 1],
                this.velocities[offset + 2],
            );

            if (dampedSpeed > hardSpeedLimit && dampedSpeed > 0) {
                const limitScale = hardSpeedLimit / dampedSpeed;
                this.velocities[offset] *= limitScale;
                this.velocities[offset + 1] *= limitScale;
                this.velocities[offset + 2] *= limitScale;
            }
        }
    }

    _updateBinaryController(deltaTime) {
        this._binaryControlCooldown = Math.max(
            0,
            this._binaryControlCooldown - deltaTime,
        );

        if (this._binaryControlPhase !== 0) {
            this._advanceBinaryController(deltaTime);
            return;
        }

        if (this._binaryControlCooldown > 0) {
            this._binaryCandidatePair = -1;
            this._binaryCandidateTime = 0;
            return;
        }

        const detectedPair = this._detectBoundPair();

        if (detectedPair === this._binaryCandidatePair) {
            if (detectedPair >= 0) {
                this._binaryCandidateTime += deltaTime;
            }
        } else {
            this._binaryCandidatePair = detectedPair;
            this._binaryCandidateTime = detectedPair >= 0 ? deltaTime : 0;
        }

        if (
            detectedPair >= 0
            && this._binaryCandidateTime >= this.config.binaryCaptureDuration
        ) {
            this._binaryControlPair = detectedPair;
            this._binaryControlPhase = 1;
            this._binaryControlPhaseTime = 0;
            this.binaryControlStrength = 0;
            this.binaryInterventionCount += 1;
            this._binaryCandidatePair = -1;
            this._binaryCandidateTime = 0;
        }
    }

    _detectBoundPair() {
        const {
            gravityConstant,
            softening,
            binaryCaptureDistance,
            binaryIsolationDistance,
            binaryBindingEnergyMargin,
        } = this.config;
        let detectedPair = -1;
        let closestSeparation = Number.POSITIVE_INFINITY;

        for (let pair = 0; pair < BODY_COUNT; pair += 1) {
            const first = PAIR_FIRST[pair];
            const second = PAIR_SECOND[pair];
            const third = PAIR_THIRD[pair];
            const firstOffset = first * AXIS_COUNT;
            const secondOffset = second * AXIS_COUNT;
            const thirdOffset = third * AXIS_COUNT;
            const deltaX = this.positions[secondOffset] - this.positions[firstOffset];
            const deltaY = this.positions[secondOffset + 1] - this.positions[firstOffset + 1];
            const deltaZ = this.positions[secondOffset + 2] - this.positions[firstOffset + 2];
            const separation = Math.hypot(deltaX, deltaY, deltaZ);

            if (separation >= binaryCaptureDistance || separation >= closestSeparation) {
                continue;
            }

            const firstMass = this.masses[first];
            const secondMass = this.masses[second];
            const pairMass = firstMass + secondMass;
            const centerX =
                (this.positions[firstOffset] * firstMass
                    + this.positions[secondOffset] * secondMass)
                / pairMass;
            const centerY =
                (this.positions[firstOffset + 1] * firstMass
                    + this.positions[secondOffset + 1] * secondMass)
                / pairMass;
            const centerZ =
                (this.positions[firstOffset + 2] * firstMass
                    + this.positions[secondOffset + 2] * secondMass)
                / pairMass;
            const thirdDistance = Math.hypot(
                this.positions[thirdOffset] - centerX,
                this.positions[thirdOffset + 1] - centerY,
                this.positions[thirdOffset + 2] - centerZ,
            );

            if (thirdDistance <= binaryIsolationDistance) {
                continue;
            }

            const relativeVelocityX =
                this.velocities[secondOffset] - this.velocities[firstOffset];
            const relativeVelocityY =
                this.velocities[secondOffset + 1] - this.velocities[firstOffset + 1];
            const relativeVelocityZ =
                this.velocities[secondOffset + 2] - this.velocities[firstOffset + 2];
            const relativeSpeedSquared =
                relativeVelocityX * relativeVelocityX
                + relativeVelocityY * relativeVelocityY
                + relativeVelocityZ * relativeVelocityZ;
            const softenedSeparation = Math.sqrt(
                separation * separation + softening * softening,
            );
            const specificBindingEnergy =
                0.5 * relativeSpeedSquared
                - gravityConstant * pairMass / softenedSeparation;

            if (specificBindingEnergy < -binaryBindingEnergyMargin) {
                detectedPair = pair;
                closestSeparation = separation;
            }
        }

        return detectedPair;
    }

    _advanceBinaryController(deltaTime) {
        this._binaryControlPhaseTime += deltaTime;

        if (this._binaryControlPhase === 1) {
            const duration = Math.max(
                this.config.binaryControlRampUp,
                Number.EPSILON,
            );
            this.binaryControlStrength = smoothstep(
                this._binaryControlPhaseTime / duration,
            );

            if (this._binaryControlPhaseTime >= duration) {
                this._binaryControlPhase = 2;
                this._binaryControlPhaseTime = 0;
                this.binaryControlStrength = 1;
            }
            return;
        }

        if (this._binaryControlPhase === 2) {
            this.binaryControlStrength = 1;

            const minimumHoldReached =
                this._binaryControlPhaseTime >= this.config.binaryControlMinimumHold;
            const maximumHoldReached =
                this._binaryControlPhaseTime >= this.config.binaryControlMaximumHold;

            if (
                maximumHoldReached
                || (minimumHoldReached && this._binarySystemHasReengaged())
            ) {
                this._binaryControlPhase = 3;
                this._binaryControlPhaseTime = 0;
            }
            return;
        }

        const duration = Math.max(
            this.config.binaryControlRampDown,
            Number.EPSILON,
        );
        this.binaryControlStrength = 1 - smoothstep(
            this._binaryControlPhaseTime / duration,
        );

        if (this._binaryControlPhaseTime >= duration) {
            this.binaryControlStrength = 0;
            this._binaryControlPair = -1;
            this._binaryControlPhase = 0;
            this._binaryControlPhaseTime = 0;
            this._binaryControlCooldown = this.config.binaryControlCooldown;
        }
    }

    _binarySystemHasReengaged() {
        const pair = this._binaryControlPair;

        if (pair < 0) {
            return true;
        }

        const first = PAIR_FIRST[pair];
        const second = PAIR_SECOND[pair];
        const third = PAIR_THIRD[pair];
        const firstOffset = first * AXIS_COUNT;
        const secondOffset = second * AXIS_COUNT;
        const thirdOffset = third * AXIS_COUNT;
        const deltaX = this.positions[secondOffset] - this.positions[firstOffset];
        const deltaY = this.positions[secondOffset + 1] - this.positions[firstOffset + 1];
        const deltaZ = this.positions[secondOffset + 2] - this.positions[firstOffset + 2];
        const separation = Math.hypot(deltaX, deltaY, deltaZ);
        const firstMass = this.masses[first];
        const secondMass = this.masses[second];
        const pairMass = firstMass + secondMass;
        const centerX =
            (this.positions[firstOffset] * firstMass
                + this.positions[secondOffset] * secondMass)
            / pairMass;
        const centerY =
            (this.positions[firstOffset + 1] * firstMass
                + this.positions[secondOffset + 1] * secondMass)
            / pairMass;
        const centerZ =
            (this.positions[firstOffset + 2] * firstMass
                + this.positions[secondOffset + 2] * secondMass)
            / pairMass;
        const thirdDistance = Math.hypot(
            this.positions[thirdOffset] - centerX,
            this.positions[thirdOffset + 1] - centerY,
            this.positions[thirdOffset + 2] - centerZ,
        );

        return (
            separation >= this.config.binaryOpenDistance
            || thirdDistance <= this.config.binaryReengageDistance
        );
    }

    _stateIsSafe() {
        const maximumRadiusSquared = this.config.failSafeRadius * this.config.failSafeRadius;

        for (let index = 0; index < STATE_SIZE; index += 1) {
            if (
                !Number.isFinite(this.positions[index])
                || !Number.isFinite(this.velocities[index])
                || !Number.isFinite(this.accelerations[index])
            ) {
                return false;
            }
        }

        for (let body = 0; body < BODY_COUNT; body += 1) {
            const offset = body * AXIS_COUNT;
            const radiusSquared =
                this.positions[offset] * this.positions[offset]
                + this.positions[offset + 1] * this.positions[offset + 1]
                + this.positions[offset + 2] * this.positions[offset + 2];

            if (radiusSquared > maximumRadiusSquared) {
                return false;
            }
        }

        return true;
    }
}

export const THREE_BODY_CONSTANTS = Object.freeze({
    bodyCount: BODY_COUNT,
    axisCount: AXIS_COUNT,
    stateSize: STATE_SIZE,
});
