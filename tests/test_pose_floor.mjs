import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import {
    DEFAULT_FLOOR_SETTINGS,
    FLOOR_HEIGHT_LIMITS,
    PoseStudioFloor,
    boneSubtreeVertexIndices,
    floorHeightForLowestPoints,
    floorMoveLimit,
    largestSafeFraction,
    lowestPointOfVertices,
    groundingDeltaY,
    lowestSkinnedPointY,
    normalizeFloorSettings,
    renderedVertexIndices,
} from "../web/pose_studio/floor.mjs";

const close = (actual, expected, message = "", epsilon = 1e-5) => assert.ok(
    Math.abs(actual - expected) < epsilon,
    `${message}: ${actual} vs ${expected}`,
);

/**
 * A 10-unit vertical "leg" from y=0 (hip) down to y=-10 (sole), skinned to a
 * hip bone and a knee bone at y=-5. Rotating the knee lifts the sole.
 */
function createLeg() {
    const positions = [];
    const skinIndex = [];
    const skinWeight = [];
    for (let step = 0; step <= 10; step += 1) {
        const y = -step;
        for (const x of [-0.5, 0.5]) {
            positions.push(x, y, 0);
            skinIndex.push(y > -5 ? 0 : 1, 0, 0, 0);
            skinWeight.push(1, 0, 0, 0);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    const hip = new THREE.Bone();
    const knee = new THREE.Bone();
    knee.position.y = -5;
    hip.add(knee);
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(hip);
    // Bracket call keeps the registry scanner quiet, as in core.js.
    mesh["bind"](new THREE.Skeleton([hip, knee]));
    return { mesh, hip, knee };
}

test("floor settings default to disabled and unplaced", () => {
    const settings = normalizeFloorSettings(undefined);
    assert.equal(settings.enabled, false);
    assert.equal(settings.height, null);
    assert.deepEqual(settings, normalizeFloorSettings(DEFAULT_FLOOR_SETTINGS));
});

test("floor settings are clamped and sanitized", () => {
    const settings = normalizeFloorSettings({
        enabled: true,
        height: -500,
        style: "glitter",
        color: "#ABC",
        show_grid: false,
        grid_in_export: "yes",
        shadow_opacity: 4,
        shadow_source: "sun",
        auto_ground: false,
    });
    assert.equal(settings.enabled, true);
    assert.equal(settings.height, FLOOR_HEIGHT_LIMITS[0]);
    assert.equal(settings.style, "solid");
    assert.equal(settings.color, "#aabbcc");
    assert.equal(settings.show_grid, false);
    assert.equal(settings.grid_in_export, false);
    assert.equal(settings.shadow_opacity, 1);
    assert.equal(settings.shadow_source, "overhead");
    assert.equal(settings.auto_ground, false);
    assert.equal(normalizeFloorSettings({ height: "abc" }).height, null);
    assert.equal(normalizeFloorSettings({ height: "-8.5" }).height, -8.5);
});

test("lowest skinned point follows the posed skeleton, not the rest pose", () => {
    const { mesh, knee } = createLeg();
    close(lowestSkinnedPointY(THREE, mesh), -10, "rest sole");

    // Fold the shin up by 90 degrees: the lowest point becomes the knee.
    knee.rotation.z = Math.PI / 2;
    close(lowestSkinnedPointY(THREE, mesh), -5.5, "folded knee", 1e-4);
});

test("lowest skinned point ignores vertices no triangle draws", () => {
    const { mesh } = createLeg();
    const geometry = mesh.geometry;
    const count = geometry.attributes.position.count;
    // Index every leg vertex, then append a helper vertex below the sole that
    // no face references (like the MakeHuman helper geometry in Pose Studio).
    const positions = Array.from(geometry.attributes.position.array);
    positions.push(0, -13, 0);
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([...geometry.attributes.skinIndex.array, 0, 0, 0, 0], 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([...geometry.attributes.skinWeight.array, 1, 0, 0, 0], 4));
    const indices = [];
    for (let row = 0; row < count / 2 - 1; row += 1) {
        const a = row * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(indices);
    close(lowestSkinnedPointY(THREE, mesh), -10, "helper vertex ignored");
    assert.equal(renderedVertexIndices(geometry).length, count);

    // The cache follows index changes.
    geometry.setIndex([...indices, count, 0, 1]);
    close(lowestSkinnedPointY(THREE, mesh), -13, "now drawn");
});

test("lowest skinned point includes the character transform", () => {
    const { mesh } = createLeg();
    mesh.position.y = 3;
    mesh.scale.setScalar(2);
    close(lowestSkinnedPointY(THREE, mesh), 3 - 20, "scaled and moved sole");
});

test("grounding helpers place characters on the floor", () => {
    assert.equal(groundingDeltaY(-5.34, -8.18), -8.18 - -5.34);
    assert.equal(groundingDeltaY(null, 0), 0);
    assert.equal(floorHeightForLowestPoints([-7.29, -8.43, null]), -8.43);
    assert.equal(floorHeightForLowestPoints([]), null);
    assert.equal(floorHeightForLowestPoints([-500]), FLOOR_HEIGHT_LIMITS[0]);
});

test("floor scene objects follow settings", () => {
    const scene = new THREE.Scene();
    const floor = new PoseStudioFloor(THREE, scene);
    assert.equal(floor.group.visible, false);
    assert.equal(floor.castsShadows, false);

    floor.apply({ enabled: true, height: -8, style: "shadow", show_grid: true, shadows: true, shadow_opacity: 0.3 });
    assert.equal(floor.group.visible, true);
    assert.equal(floor.height, -8);
    assert.equal(floor.surface.visible, false, "shadow-only style hides the surface");
    assert.equal(floor.catcher.material.opacity, 0.3);
    assert.equal(floor.castsShadows, true);
    assert.equal(floor.editorOnlyGrid, floor.grid, "grid is an editor helper by default");
    // The shadow light never lights the characters themselves.
    assert.equal(floor.shadowLight.intensity, 0);

    floor.apply({ enabled: true, grid_in_export: true });
    assert.equal(floor.editorOnlyGrid, null, "exported grid must stay visible in captures");

    floor.apply({ enabled: true, shadows: false });
    assert.equal(floor.castsShadows, false);
    assert.equal(floor.catcher.visible, false);

    floor.dispose();
    assert.equal(scene.children.includes(floor.group), false);
});

test("shadow frame centres on the casters at floor height", () => {
    const scene = new THREE.Scene();
    const floor = new PoseStudioFloor(THREE, scene);
    floor.apply({ enabled: true, height: -10, shadows: true });
    const { mesh } = createLeg();
    mesh.position.set(6, 0, 0);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    floor.updateShadowFrame([mesh]);
    assert.equal(mesh.castShadow, true);
    close(floor.shadowLight.target.position.y, -10, "target on floor");
    close(floor.shadowLight.target.position.x, 6, "target under caster", 1);
    assert.ok(floor.shadowLight.position.y > -10, "overhead light is above the floor");

    floor.apply({ enabled: true, height: -10, shadows: true, shadow_source: "key" });
    floor.updateShadowFrame([mesh], new THREE.Vector3(-1, 1, 0));
    assert.ok(floor.shadowLight.position.x < floor.shadowLight.target.position.x, "key light direction is used");
});

test("Pose Studio wires the floor into the viewer, capture, and persistence", async () => {
    const core = await fs.readFile(new URL("../web/pose_studio/core.js", import.meta.url), "utf8");
    const widget = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    // Every render path refreshes shadows; the interaction overlay hides the floor.
    assert.match(core, /this\._prepareFloorForRender\(\);\n\s+this\.renderer\.render\(this\.scene, this\.camera\);/);
    assert.match(core, /this\._prepareFloorForRender\(\);\n\s+this\.renderer\.render\(this\.scene, camera\);/);
    assert.match(core, /this\.refPlane, this\.floor\?\.group,/);
    // The editor-only grid uses the existing capture-hidden helper slot.
    assert.match(core, /this\.gridHelper = this\.floor\.editorOnlyGrid;/);
    // Settings persist in exportParams and older workflows load with the floor off.
    assert.match(widget, /floor: \{ \.\.\.DEFAULT_FLOOR_SETTINGS \}/);
    assert.match(widget, /this\.exportParams\.floor = normalizeFloorSettings\(data\.export\.floor\);/);
    // Auto-ground runs after library loads and Add Character.
    assert.match(widget, /this\.commitViewerPoseToCurrentEditor\(\);\n\s+this\.autoGroundCharacters\(\[this\.activeCharacterId\]\);/);
    assert.match(widget, /await this\.selectCharacter\(character\.id\);\n\s+this\.autoGroundCharacters\(\[character\.id\]\);/);
});

test("floor collision is on by default and can be turned off", () => {
    assert.equal(normalizeFloorSettings({}).collision, true);
    assert.equal(normalizeFloorSettings({ collision: false }).collision, false);
});

test("bone subtree vertices cover the bone and its descendants", () => {
    const { mesh, hip, knee } = createLeg();
    const all = boneSubtreeVertexIndices(mesh, hip);
    const shin = boneSubtreeVertexIndices(mesh, knee);
    assert.equal(all.length, mesh.geometry.attributes.position.count);
    // Shin vertices are y <= -5 (two per row, rows -5..-10).
    assert.equal(shin.length, 12);
    assert.equal(boneSubtreeVertexIndices(mesh, knee), shin, "cached per bone");
    close(lowestPointOfVertices(THREE, mesh, shin), -10, "shin lowest");
});

test("largest safe fraction stops a motion at the floor", () => {
    // Lowest point moves linearly from 0 down to -10; the floor is at -4.
    const evaluate = t => -10 * t;
    close(largestSafeFraction(evaluate, -4), 0.4, "stops at contact", 0.01);
    assert.equal(largestSafeFraction(evaluate, -20), 1, "never touches");
    // Already 2 below the floor: may not go deeper, may come back up.
    assert.ok(largestSafeFraction(t => -6 - 4 * t, -4) < 0.01, "no deeper");
    assert.equal(largestSafeFraction(t => -6 + 4 * t, -4), 1, "moving up is free");
});

test("FK rotation into the floor stops at contact", () => {
    const { mesh, hip } = createLeg();
    const floorY = -8;
    const anchor = hip.quaternion.clone();
    const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    // The hanging leg's sole (-10) starts below the floor; swinging it up to
    // horizontal moves it out of the floor, so the whole rotation is allowed.
    const up = largestSafeFraction(t => {
        hip.quaternion.copy(anchor).slerp(target, t);
        return lowestPointOfVertices(THREE, mesh, boneSubtreeVertexIndices(mesh, hip));
    }, floorY);
    assert.equal(up, 1);

    // Starting horizontal (sole at y=0), swinging down stops on the floor.
    hip.quaternion.copy(target);
    const fromHorizontal = hip.quaternion.clone();
    const fraction = largestSafeFraction(t => {
        hip.quaternion.copy(fromHorizontal).slerp(new THREE.Quaternion(), t);
        return lowestPointOfVertices(THREE, mesh, boneSubtreeVertexIndices(mesh, hip));
    }, floorY);
    hip.quaternion.copy(fromHorizontal).slerp(new THREE.Quaternion(), fraction);
    close(lowestPointOfVertices(THREE, mesh, boneSubtreeVertexIndices(mesh, hip)), floorY, "leg rests on the floor", 0.05);
});

test("whole-character moves stop where the lowest character touches", () => {
    // Both lowest points are at -7 (y + clearance): the group may drop 3.
    close(floorMoveLimit([{ y: 0, clearance: -7 }, { y: 2, clearance: -9 }], -10), -3);
    // Lowest points at -7 and -9: the lower one stops the group after 1.
    close(floorMoveLimit([{ y: 0, clearance: -7 }, { y: 0, clearance: -9 }], -10), -1);
    // A character already below the floor blocks any further drop.
    assert.equal(floorMoveLimit([{ y: 0, clearance: -12 }], -10), 0);
    assert.equal(floorMoveLimit([], -10), -Infinity);
});

test("Pose Studio wires floor collision into every posing path", async () => {
    const core = await fs.readFile(new URL("../web/pose_studio/core.js", import.meta.url), "utf8");
    const widget = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    assert.match(core, /this\._keepEffectorAboveFloor\(chainDef, chainKey, targetPos\);/);
    assert.match(core, /this\._constrainBoneRotationToFloor\(this\.selectedBone, this\._floorRotationAnchor\);/);
    assert.match(core, /this\._constrainBoneRotationToFloor\(rootBone, floorAnchor\);/);
    assert.match(core, /Lowering the hips into the floor sits or kneels the body on it instead\./);
    assert.match(widget, /return this\.constrainCharacterPositionToFloor\(next, true\);/);
    // core.js and the widget must share one floor module instance.
    const stamp = text => text.match(/floor\.mjs\?v=([\w.]+)/)[1];
    assert.equal(stamp(core), stamp(widget));
});
