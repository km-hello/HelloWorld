import assert from "node:assert/strict";
import test from "node:test";

import { ThreeBodySystem } from "../physics.js";

const FIXED_STEP = 1 / 120;

function allFinite(values) {
    return values.every((value) => Number.isFinite(value));
}

function weightedVectorSum(vectors, masses) {
    const result = [0, 0, 0];

    for (let body = 0; body < masses.length; body += 1) {
        const offset = body * 3;
        result[0] += vectors[offset] * masses[body];
        result[1] += vectors[offset + 1] * masses[body];
        result[2] += vectors[offset + 2] * masses[body];
    }

    return result;
}

function getNewtonianEnergy(system, gravityConstant) {
    let energy = 0;

    for (let first = 0; first < system.masses.length; first += 1) {
        const firstOffset = first * 3;
        const firstMass = system.masses[first];
        const speedSquared =
            system.velocities[firstOffset] ** 2
            + system.velocities[firstOffset + 1] ** 2
            + system.velocities[firstOffset + 2] ** 2;

        energy += 0.5 * firstMass * speedSquared;

        for (
            let second = first + 1;
            second < system.masses.length;
            second += 1
        ) {
            const secondOffset = second * 3;
            const separation = Math.hypot(
                system.positions[secondOffset] - system.positions[firstOffset],
                system.positions[secondOffset + 1]
                    - system.positions[firstOffset + 1],
                system.positions[secondOffset + 2]
                    - system.positions[firstOffset + 2],
            );

            energy -=
                gravityConstant
                * firstMass
                * system.masses[second]
                / separation;
        }
    }

    return energy;
}

test("initial state has no center-of-mass drift or net momentum", () => {
    const system = new ThreeBodySystem();
    const weightedPosition = weightedVectorSum(system.positions, system.masses);
    const weightedVelocity = weightedVectorSum(system.velocities, system.masses);

    for (const value of [...weightedPosition, ...weightedVelocity]) {
        assert.ok(Math.abs(value) < 1e-12, `expected ${value} to be approximately zero`);
    }
});

test("fixed-step simulation is deterministic", () => {
    const first = new ThreeBodySystem();
    const second = new ThreeBodySystem();

    for (let step = 0; step < 7_200; step += 1) {
        first.step(FIXED_STEP);
        second.step(FIXED_STEP);
    }

    assert.deepEqual(first.positions, second.positions);
    assert.deepEqual(first.velocities, second.velocities);
    assert.equal(first.resetCount, second.resetCount);
});

test("unconstrained figure-eight conserves energy, momentum, and center of mass", () => {
    const gravityConstant = 1;
    const system = new ThreeBodySystem({
        gravityConstant,
        softening: 0,
        coreRadius: 0,
        coreRepulsion: 0,
        boundaryStart: 100,
        boundaryFull: 101,
        restoreStiffness: 0,
        maxRestoreAcceleration: 0,
        maxAcceleration: 1_000_000,
        softSpeedLimit: 100,
        hardSpeedLimit: 100,
        binaryCaptureDistance: 0,
        binaryCaptureDuration: 1_000_000,
        failSafeRadius: 200,
    });

    system.setState([
        -0.97000436, 0.24308753, 0,
        0.97000436, -0.24308753, 0,
        0, 0, 0,
    ], [
        0.466203685, 0.43236573, 0,
        0.466203685, 0.43236573, 0,
        -0.93240737, -0.86473146, 0,
    ], true);

    const initialEnergy = getNewtonianEnergy(system, gravityConstant);
    let maximumRelativeEnergyDrift = 0;
    let maximumMomentum = 0;
    let maximumCenterOfMassOffset = 0;
    const figureEightPeriod = 6.3259;
    const steps = Math.round((figureEightPeriod * 10) / FIXED_STEP);

    for (let step = 0; step < steps; step += 1) {
        system.step(FIXED_STEP);

        const energy = getNewtonianEnergy(system, gravityConstant);
        const momentum = weightedVectorSum(system.velocities, system.masses);
        const weightedPosition = weightedVectorSum(system.positions, system.masses);
        const totalMass = system.masses.reduce((sum, mass) => sum + mass, 0);

        maximumRelativeEnergyDrift = Math.max(
            maximumRelativeEnergyDrift,
            Math.abs((energy - initialEnergy) / initialEnergy),
        );
        maximumMomentum = Math.max(maximumMomentum, Math.hypot(...momentum));
        maximumCenterOfMassOffset = Math.max(
            maximumCenterOfMassOffset,
            Math.hypot(...weightedPosition) / totalMass,
        );
    }

    assert.ok(
        maximumRelativeEnergyDrift < 1e-4,
        `unexpected relative energy drift: ${maximumRelativeEnergyDrift}`,
    );
    assert.ok(maximumMomentum < 1e-12, `unexpected momentum: ${maximumMomentum}`);
    assert.ok(
        maximumCenterOfMassOffset < 1e-12,
        `unexpected center-of-mass drift: ${maximumCenterOfMassOffset}`,
    );
    assert.equal(system.resetCount, 1);
    assert.equal(system.binaryInterventionCount, 0);
});

test("default trajectory reaches the outer activity region", () => {
    const system = new ThreeBodySystem();
    let maximumRadius = 0;

    for (let step = 0; step < 120 / FIXED_STEP; step += 1) {
        system.step(FIXED_STEP);

        for (let body = 0; body < 3; body += 1) {
            const offset = body * 3;
            maximumRadius = Math.max(
                maximumRadius,
                Math.hypot(
                    system.positions[offset],
                    system.positions[offset + 1],
                    system.positions[offset + 2],
                ),
            );
        }
    }

    assert.ok(maximumRadius > 2.4);
    assert.equal(system.resetCount, 1);
});

test("soft boundary is inactive in the core and pulls inward outside it", () => {
    const system = new ThreeBodySystem({ gravityConstant: 0 });
    const velocities = new Float64Array(9);

    system.setState([
        2.8, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ], velocities);
    assert.equal(system.accelerations[0], 0);

    system.setState([
        3.5, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ], velocities);
    assert.ok(system.accelerations[0] < 0);
    assert.equal(system.accelerations[1], 0);
    assert.equal(system.accelerations[2], 0);
});

test("offscreen urgency adds recovery only while a body moves outward", () => {
    const system = new ThreeBodySystem({ gravityConstant: 0 });
    const positions = [
        1.5, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ];
    const outwardVelocities = [
        1, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ];

    system.setState(positions, outwardVelocities);
    assert.equal(system.accelerations[0], 0);

    system.setRecoveryUrgency(0, 1);
    system.setState(positions, outwardVelocities);
    assert.ok(system.accelerations[0] < 0);

    const boundaryPositions = [
        3.5, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ];
    const inwardVelocities = [
        -1, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ];

    system.setRecoveryUrgency(0, 0);
    system.setState(boundaryPositions, inwardVelocities);
    const baseRecovery = system.accelerations[0];

    system.setRecoveryUrgency(0, 1);
    system.setState(boundaryPositions, inwardVelocities);
    assert.equal(system.accelerations[0], baseRecovery);
});

test("a body moving outward beyond the boundary returns within eight seconds", () => {
    const system = new ThreeBodySystem({ gravityConstant: 0 });
    system.setRecoveryUrgency(0, 1);
    system.setState([
        4.5, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ], [
        1.5, 0, 0,
        0, 0, 0,
        0, 0, 0,
    ]);

    let returned = false;

    for (let step = 0; step < 8 / FIXED_STEP; step += 1) {
        system.step(FIXED_STEP);

        if (system.positions[0] <= 2.2) {
            returned = true;
            break;
        }
    }

    assert.equal(returned, true);
});

test("an isolated binary completes several natural orbits before intervention", () => {
    const system = new ThreeBodySystem({
        boundaryStart: 100,
        boundaryFull: 101,
        failSafeRadius: 200,
        hardSpeedLimit: 20,
    });
    const separation = 0.5;
    const orbitalSpeed = Math.sqrt(
        system.config.gravityConstant / (2 * separation),
    );

    system.setState([
        -separation / 2, 0, 0,
        separation / 2, 0, 0,
        6, 0, 0,
    ], [
        0, -orbitalSpeed, 0,
        0, orbitalSpeed, 0,
        0, 0, 0,
    ]);

    let previousAngle = 0;
    let accumulatedAngle = 0;

    for (let step = 0; step < 6 / FIXED_STEP; step += 1) {
        system.step(FIXED_STEP);

        const deltaX = system.positions[3] - system.positions[0];
        const deltaY = system.positions[4] - system.positions[1];
        const angle = Math.atan2(deltaY, deltaX);
        let angleDelta = angle - previousAngle;

        if (angleDelta > Math.PI) {
            angleDelta -= Math.PI * 2;
        } else if (angleDelta < -Math.PI) {
            angleDelta += Math.PI * 2;
        }

        accumulatedAngle += angleDelta;
        previousAngle = angle;
    }

    const completedOrbits = Math.abs(accumulatedAngle) / (Math.PI * 2);
    const finalSeparation = Math.hypot(
        system.positions[3] - system.positions[0],
        system.positions[4] - system.positions[1],
        system.positions[5] - system.positions[2],
    );

    assert.ok(completedOrbits >= 3);
    assert.ok(finalSeparation < system.config.binaryCaptureDistance);
    assert.equal(system.binaryInterventionCount, 0);
    assert.equal(system.binaryControlStrength, 0);
});

test("persistent binary controller ramps smoothly without changing net momentum", () => {
    const system = new ThreeBodySystem({
        binaryCaptureDuration: 0.1,
        binaryControlRampUp: 0.8,
        binaryControlMinimumHold: 0.1,
        binaryControlMaximumHold: 0.3,
        binaryControlRampDown: 0.8,
        binaryControlCooldown: 10,
        hardSpeedLimit: 20,
    });
    const separation = 0.5;
    const orbitalSpeed = Math.sqrt(
        system.config.gravityConstant / (2 * separation),
    );

    system.setState([
        -separation / 2, 0, 0,
        separation / 2, 0, 0,
        0, 0, 2,
    ], [
        0, -orbitalSpeed, 0,
        0, orbitalSpeed, 0,
        0, 0, 0,
    ]);

    const momentumBefore = weightedVectorSum(system.velocities, system.masses);

    for (let step = 0; step < 30; step += 1) {
        system.step(FIXED_STEP);
    }

    const momentumAfter = weightedVectorSum(system.velocities, system.masses);
    assert.equal(system.binaryInterventionCount, 1);
    assert.ok(system.binaryControlStrength > 0);
    assert.ok(system.binaryControlStrength < 1);

    for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(Math.abs(momentumAfter[axis] - momentumBefore[axis]) < 1e-10);
    }
});

test("finite-size repulsive core prevents a persistent triple overlap", () => {
    const system = new ThreeBodySystem({
        gravityConstant: 0,
        binaryCaptureDuration: 100,
    });

    system.setState([
        -0.04, 0, 0,
        0.04, 0, 0,
        0, 0, 1,
    ], new Float64Array(9));

    const initialSeparation = system.positions[3] - system.positions[0];

    for (let step = 0; step < 120; step += 1) {
        system.step(FIXED_STEP);
    }

    const finalSeparation = Math.hypot(
        system.positions[3] - system.positions[0],
        system.positions[4] - system.positions[1],
        system.positions[5] - system.positions[2],
    );

    assert.ok(finalSeparation > initialSeparation);
    assert.ok(finalSeparation > system.config.coreRadius);
});

test("softening keeps very close encounters finite", () => {
    const system = new ThreeBodySystem();
    system.setState([
        -0.001, 0, 0,
        0.001, 0, 0,
        0, 1, 0.2,
    ], [
        0, 0.3, 0.1,
        0, -0.3, -0.1,
        0.1, 0, 0,
    ], true);

    for (let step = 0; step < 3_600; step += 1) {
        system.step(FIXED_STEP);
    }

    assert.equal(allFinite(system.positions), true);
    assert.equal(allFinite(system.velocities), true);
    assert.equal(allFinite(system.accelerations), true);
});

test("non-finite state triggers a deterministic safe reset", () => {
    const system = new ThreeBodySystem();
    const initialResetCount = system.resetCount;

    system.positions[0] = Number.POSITIVE_INFINITY;
    const remainedSafe = system.step(FIXED_STEP);

    assert.equal(remainedSafe, false);
    assert.equal(system.resetCount, initialResetCount + 1);
    assert.equal(allFinite(system.positions), true);
    assert.equal(allFinite(system.velocities), true);
});
