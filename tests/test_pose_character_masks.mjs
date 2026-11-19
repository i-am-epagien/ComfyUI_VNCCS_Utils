import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const noop = () => {};

/** createScene() with a renderer that records what every capture render saw. */
function maskScene({ passive = 0 } = {}) {
    const scene = createScene();
    const { viewer, THREE } = scene;
    scene.renders = [];
    viewer.canvas.toDataURL = () => `data:image/png;base64,${scene.renders.length}`;
    viewer.passiveCharacters = new Map();
    for (let index = 0; index < passive; index += 1) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
        viewer.scene.add(mesh);
        viewer.passiveCharacters.set(`character-${index + 2}`, { mesh });
    }
    const meshes = () => [viewer.skinnedMesh, ...[...viewer.passiveCharacters.values()].map(entry => entry.mesh)];
    viewer.renderer = {
        render: (_scene, camera) => {
            if (camera === viewer.camera) return;
            scene.renders.push({
                background: viewer.scene.background?.getHexString?.() ?? null,
                materials: meshes().map(mesh => mesh.material),
                floorVisible: viewer.floor?.group.visible ?? null,
            });
        },
        getSize: target => target.set(512, 512),
        setSize: noop,
        getPixelRatio: () => 1,
        setPixelRatio: noop,
        shadowMap: { enabled: false },
    };
    return { ...scene, meshes };
}

const linkMaskOutput = (node, linked = true) => {
    node.outputs = [
        { name: "images", links: [] },
        { name: "lighting_prompt", links: [] },
        { name: "character_masks", links: linked ? [7] : [] },
    ];
};

test("mask packs put three characters per image and keep the rest black", () => {
    const { viewer, renders, meshes } = maskScene({ passive: 3 });
    const originals = meshes().map(mesh => mesh.material);
    const order = [null, "character-2", "character-3", "character-4"];
    const packs = viewer.captureCharacterMaskPacks(64, 64, 1, 0, 0, 0, 0, order);
    assert.equal(packs.length, 2);
    assert.equal(renders.length, 2);
    const [red, green, blue, black] = viewer._maskMaterials;
    assert.deepEqual(renders[0].materials, [red, green, blue, black], "pack 1: characters 1-3 in R, G, B");
    assert.deepEqual(renders[1].materials, [black, black, black, red], "pack 2: character 4 in R, the rest occlude in black");
    for (const render of renders) assert.equal(render.background, "000000");
    assert.deepEqual(meshes().map(mesh => mesh.material), originals, "materials are restored");
    for (const material of [red, green, blue, black]) assert.equal(material.toneMapped, false);
    assert.deepEqual([red, green, blue, black].map(material => material.color.getHexString()), ["ff0000", "00ff00", "0000ff", "000000"]);
});

test("mask passes hide the floor and skydome only while they render", () => {
    const { viewer, renders, THREE } = maskScene();
    viewer.floor = { group: new THREE.Group(), castsShadows: false, updateShadowFrame: noop };
    viewer.floor.group.visible = true;
    viewer.directionalSkydome = new THREE.Group();
    viewer.directionalSkydome.visible = true;
    viewer.captureCharacterMaskPacks(32, 32, 1, 0, 0, 0, 0, [null]);
    assert.equal(renders[0].floorVisible, false);
    assert.equal(viewer.floor.group.visible, true);
    assert.equal(viewer.directionalSkydome.visible, true);
    viewer.capture(32, 32, 1, [1, 2, 3]);
    assert.equal(renders[1].floorVisible, true, "ordinary captures keep the floor");
});

test("RUN renders masks only while the character_masks output is connected", () => {
    const scene = maskScene();
    const { w, node, renders } = scene;
    w.addTab();

    linkMaskOutput(node, false);
    renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(renders.length, 2, "one render per pose when masks are unused");
    assert.equal(w.characterMasksForCaptures(w.poseCaptures).length, 0, "nothing to upload");

    linkMaskOutput(node, true);
    renders.length = 0;
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.equal(renders.length, 4, "one image and one mask pack per pose");
    const entries = w.characterMasksForCaptures(w.poseCaptures);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
        assert.equal(entry.packs.length, 1);
        assert.deepEqual([...entry.characters.map(character => character.slot)], [0]);
        assert.equal("capture" in entry, false, "the capture itself is not uploaded twice");
    }
});

test("masks never travel with a capture they were not rendered for", () => {
    const { w, node } = maskScene();
    linkMaskOutput(node, true);
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    assert.ok(w.characterMasksForCaptures(w.poseCaptures)[0]);
    w.poseCaptures[0] = "data:image/png;base64,newer-preview";
    assert.equal(w.characterMasksForCaptures(w.poseCaptures).length, 0);
});

test("character mask order follows slots and marks the active character", () => {
    const { w, context } = maskScene();
    const second = context.createPoseStudioCharacter({ index: 2, mesh: w.meshParams });
    const third = context.createPoseStudioCharacter({ index: 1, mesh: w.meshParams });
    w.characters.push(second, third);
    w.activeCharacterId = third.id;
    const order = w.characterMaskOrder();
    // The widget runs in its own vm realm: compare plain copies.
    assert.deepEqual([...order.map(entry => entry.slot)], [0, 1, 2]);
    assert.deepEqual([...order.map(entry => entry.key)], [w.characters[0].id, null, second.id]);
});

test("execution sync uploads character masks with the captures", async () => {
    const widget = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    assert.match(widget, /character_masks: widget\.characterMasksForCaptures\?\.\(capturedImages\) \|\| \[\],/);
});
