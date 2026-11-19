/**
 * Pose Studio floor: a world-space ground plane with an optional grid and
 * contact shadows, plus the skinned-mesh measurements used to put characters
 * on it.
 *
 * Pose Studio frames a capture by moving and scaling the characters in front
 * of a fixed capture camera, so the floor is a fixed plane in that stage and
 * grounding a character means changing its stored Y offset.
 *
 * Three.js is passed in by the caller so Node tests can use the vendored
 * module without a DOM.
 */

export const FLOOR_HEIGHT_LIMITS = Object.freeze([-80, 40]);
export const FLOOR_STYLES = Object.freeze(["solid", "shadow"]);
export const FLOOR_SHADOW_SOURCES = Object.freeze(["overhead", "key"]);
export const FLOOR_GRID_SPACING = 5;
// Past the capture camera's 500-unit far plane, so no floor edge shows below the horizon.
const FLOOR_SIZE = 1000;
const GRID_SIZE = 200;
const SHADOW_MAP_SIZE = 2048;

export const DEFAULT_FLOOR_SETTINGS = Object.freeze({
    enabled: false,
    // null = not placed yet; enabling the floor fits it to the lowest character.
    height: null,
    style: "solid",
    color: "#5c5c68",
    show_grid: true,
    grid_in_export: false,
    shadows: true,
    shadow_opacity: 0.45,
    shadow_source: "overhead",
    auto_ground: true,
    // Keep limbs and characters from being dragged through the floor.
    collision: true,
});

const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function normalizeFloorColor(value, fallback = DEFAULT_FLOOR_SETTINGS.color) {
    const text = String(value ?? "").trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
        return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
    }
    return fallback;
}

export function clampFloorHeight(value) {
    return clamp(finite(value, 0), FLOOR_HEIGHT_LIMITS[0], FLOOR_HEIGHT_LIMITS[1]);
}

export function normalizeFloorSettings(source) {
    const data = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    const height = data.height === null || data.height === undefined || data.height === ""
        ? null
        : Number.isFinite(Number(data.height)) ? clampFloorHeight(data.height) : null;
    return {
        enabled: data.enabled === true,
        height,
        style: FLOOR_STYLES.includes(data.style) ? data.style : DEFAULT_FLOOR_SETTINGS.style,
        color: normalizeFloorColor(data.color),
        show_grid: data.show_grid !== false,
        grid_in_export: data.grid_in_export === true,
        shadows: data.shadows !== false,
        shadow_opacity: clamp(finite(data.shadow_opacity, DEFAULT_FLOOR_SETTINGS.shadow_opacity), 0, 1),
        shadow_source: FLOOR_SHADOW_SOURCES.includes(data.shadow_source)
            ? data.shadow_source
            : DEFAULT_FLOOR_SETTINGS.shadow_source,
        auto_ground: data.auto_ground !== false,
        collision: data.collision !== false,
    };
}

const renderedVertexCache = new WeakMap();

/**
 * Indices of the vertices that rendered triangles use. The Pose Studio body
 * keeps MakeHuman helper vertices (about a quarter of the mesh) that no face
 * references; some sit below the soles and must not decide ground contact.
 */
export function renderedVertexIndices(geometry) {
    const position = geometry?.attributes?.position;
    if (!position) return null;
    const index = geometry.index;
    const start = Math.max(0, geometry.drawRange?.start ?? 0);
    const rangeCount = geometry.drawRange?.count;
    const key = `${index ? index.version : "none"}:${index?.count ?? position.count}:${start}:${rangeCount}`;
    const cached = renderedVertexCache.get(geometry);
    if (cached?.key === key) return cached.vertices;

    let vertices;
    if (!index) {
        const end = Math.min(position.count, Number.isFinite(rangeCount) ? start + rangeCount : position.count);
        vertices = Uint32Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
    } else {
        const end = Math.min(index.count, Number.isFinite(rangeCount) ? start + rangeCount : index.count);
        const used = new Uint8Array(position.count);
        let total = 0;
        for (let item = start; item < end; item += 1) {
            const vertex = index.getX(item);
            if (!used[vertex]) {
                used[vertex] = 1;
                total += 1;
            }
        }
        vertices = new Uint32Array(total);
        for (let vertex = 0, next = 0; vertex < used.length; vertex += 1) {
            if (used[vertex]) vertices[next++] = vertex;
        }
    }
    renderedVertexCache.set(geometry, { key, vertices });
    return vertices;
}

/**
 * Lowest world-space Y of a skinned mesh in its current pose, over the
 * vertices that are actually drawn. Skins each vertex (~14k drawn vertices,
 * a few milliseconds) so it follows the current pose.
 */
export function lowestSkinnedPointY(THREE, mesh) {
    return lowestPointOfVertices(THREE, mesh, renderedVertexIndices(mesh?.geometry));
}

const subtreeVertexCache = new WeakMap();

/**
 * Drawn vertices whose strongest skin weight belongs to `bone` or one of its
 * descendants: the part of the body that moves when that bone moves.
 */
export function boneSubtreeVertexIndices(mesh, bone) {
    const geometry = mesh?.geometry;
    const bones = mesh?.skeleton?.bones;
    const skinIndex = geometry?.attributes?.skinIndex;
    const skinWeight = geometry?.attributes?.skinWeight;
    if (!bone || !bones || !skinIndex || !skinWeight) return null;
    const rendered = renderedVertexIndices(geometry);
    let perGeometry = subtreeVertexCache.get(geometry);
    if (!perGeometry || perGeometry.rendered !== rendered || perGeometry.bones !== bones) {
        perGeometry = { rendered, bones, subtrees: new Map() };
        subtreeVertexCache.set(geometry, perGeometry);
    }
    const cached = perGeometry.subtrees.get(bone);
    if (cached) return cached;

    const inSubtree = new Uint8Array(bones.length);
    bone.traverse(child => {
        const index = bones.indexOf(child);
        if (index >= 0) inSubtree[index] = 1;
    });
    const selected = [];
    for (const vertex of rendered) {
        let strongest = 0;
        for (let slot = 1; slot < 4; slot += 1) {
            if (skinWeight.getComponent(vertex, slot) > skinWeight.getComponent(vertex, strongest)) strongest = slot;
        }
        if (inSubtree[skinIndex.getComponent(vertex, strongest)]) selected.push(vertex);
    }
    const result = Uint32Array.from(selected);
    perGeometry.subtrees.set(bone, result);
    return result;
}

/** Lowest world-space Y over the given vertex indices of a skinned mesh. */
export function lowestPointOfVertices(THREE, mesh, vertices) {
    const position = mesh?.geometry?.attributes?.position;
    if (!position || !vertices?.length) return null;
    mesh.updateMatrixWorld(true);
    mesh.skeleton?.update?.();
    const vertex = new THREE.Vector3();
    let lowest = Infinity;
    for (const index of vertices) {
        if (typeof mesh.getVertexPosition === "function") mesh.getVertexPosition(index, vertex);
        else vertex.fromBufferAttribute(position, index);
        vertex.applyMatrix4(mesh.matrixWorld);
        if (vertex.y < lowest) lowest = vertex.y;
    }
    return Number.isFinite(lowest) ? lowest : null;
}

/**
 * Largest fraction t in [0, 1] of a motion that keeps `evaluate(t)` (the
 * lowest point after applying fraction t) at or above `limit`.
 * `evaluate(0)` is the last accepted state. If it is already below the limit
 * (a pose that started in the floor), the motion may not go any deeper.
 */
export function largestSafeFraction(evaluate, limit, { steps = 8, epsilon = 1e-3 } = {}) {
    // Common case first: the full motion stays above the floor.
    const end = evaluate(1);
    if (!Number.isFinite(end) || end >= limit - epsilon) return 1;
    const start = evaluate(0);
    if (!Number.isFinite(start)) return 1;
    const bound = Math.min(limit, start) - epsilon;
    if (end >= bound) return 1;
    let low = 0;
    let high = 1;
    for (let step = 0; step < steps; step += 1) {
        const middle = (low + high) / 2;
        if (evaluate(middle) >= bound) low = middle;
        else high = middle;
    }
    return low;
}

/**
 * Most negative vertical move allowed for a group of characters that move
 * together. Each entry is `{ y, clearance }`, where clearance is the lowest
 * point minus the character's Y (unchanged by translation). A character that
 * already intersects the floor may not move further down.
 */
export function floorMoveLimit(entries = [], floorY) {
    let limit = -Infinity;
    for (const entry of entries) {
        const y = Number(entry?.y);
        const clearance = Number(entry?.clearance);
        if (!Number.isFinite(y) || !Number.isFinite(clearance)) continue;
        limit = Math.max(limit, Math.min(0, Number(floorY) - clearance - y));
    }
    return limit;
}

/** Y offset to add to a character so its lowest point rests on the floor. */
export function groundingDeltaY(lowestY, floorY) {
    if (!Number.isFinite(Number(lowestY)) || !Number.isFinite(Number(floorY))) return 0;
    return Number(floorY) - Number(lowestY);
}

/** Floor height that touches the lowest of several characters. */
export function floorHeightForLowestPoints(lowestPoints = []) {
    const values = lowestPoints.map(Number).filter(Number.isFinite);
    return values.length ? clampFloorHeight(Math.min(...values)) : null;
}

/**
 * Scene objects for the floor. Shadows come from a dedicated zero-intensity
 * light that only the ShadowMaterial catcher reads, so enabling the floor
 * never changes how the characters themselves are lit or the lighting prompt.
 */
export class PoseStudioFloor {
    constructor(THREE, scene) {
        this.THREE = THREE;
        this.scene = scene;
        this.settings = normalizeFloorSettings(DEFAULT_FLOOR_SETTINGS);

        this.group = new THREE.Group();
        this.group.name = "VNCCS Pose Studio Floor";

        const plane = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
        plane.rotateX(-Math.PI / 2);
        // FrontSide: the floor disappears when the camera goes below it.
        this.surface = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({
            color: DEFAULT_FLOOR_SETTINGS.color,
            side: THREE.FrontSide,
        }));
        this.surface.name = "VNCCS Floor Surface";
        this.surface.renderOrder = -2;

        this.catcher = new THREE.Mesh(plane.clone(), new THREE.ShadowMaterial({
            opacity: DEFAULT_FLOOR_SETTINGS.shadow_opacity,
            side: THREE.FrontSide,
            depthWrite: false,
        }));
        this.catcher.name = "VNCCS Floor Shadows";
        this.catcher.receiveShadow = true;
        this.catcher.position.y = 0.01;
        this.catcher.renderOrder = -1;

        this.grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE / FLOOR_GRID_SPACING, 0x8a8a96, 0x6a6a76);
        this.grid.name = "VNCCS Floor Grid";
        this.grid.position.y = 0.02;
        for (const material of [this.grid.material].flat()) {
            material.transparent = true;
            material.opacity = 0.55;
            material.depthWrite = false;
        }

        this.shadowLight = new THREE.DirectionalLight(0xffffff, 0);
        this.shadowLight.name = "VNCCS Floor Shadow Light";
        this.shadowLight.castShadow = true;
        this.shadowLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        this.shadowLight.shadow.bias = -0.0005;
        this.shadowLight.shadow.normalBias = 0.02;
        this.shadowLight.shadow.radius = 3;

        this.group.add(this.surface, this.catcher, this.grid);
        scene.add(this.group, this.shadowLight, this.shadowLight.target);
        this.group.visible = false;
        this.shadowLight.visible = false;
    }

    get height() {
        return this.group.position.y;
    }

    apply(settings) {
        this.settings = normalizeFloorSettings(settings);
        const value = this.settings;
        this.group.visible = value.enabled;
        this.group.position.y = value.height ?? 0;
        this.surface.visible = value.style === "solid";
        this.surface.material.color.set(value.color);
        this.catcher.visible = value.shadows;
        this.catcher.material.opacity = value.shadow_opacity;
        this.grid.visible = value.show_grid;
        this.shadowLight.visible = value.enabled && value.shadows;
        this.shadowLight.castShadow = value.enabled && value.shadows;
    }

    /** True when the renderer needs shadow maps for this frame. */
    get castsShadows() {
        return this.group.visible && this.shadowLight.castShadow;
    }

    /** The grid is an editor helper unless the user exports it. */
    get editorOnlyGrid() {
        return this.grid.visible && !this.settings.grid_in_export ? this.grid : null;
    }

    /**
     * Fit the shadow camera around the casters and aim it from overhead or
     * from the key (first directional) light.
     */
    updateShadowFrame(casters = [], keyLightPosition = null) {
        if (!this.castsShadows) return;
        const THREE = this.THREE;
        const bounds = new THREE.Box3();
        const sphere = new THREE.Sphere();
        for (const mesh of casters) {
            if (!mesh?.visible || !mesh.geometry) continue;
            mesh.castShadow = true;
            if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
            sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
            bounds.expandByPoint(sphere.center.clone().addScalar(sphere.radius));
            bounds.expandByPoint(sphere.center.clone().subScalar(sphere.radius));
        }
        if (bounds.isEmpty()) return;
        const center = bounds.getCenter(new THREE.Vector3());
        center.y = this.height;
        const radius = Math.max(4, bounds.getSize(new THREE.Vector3()).length() * 0.75);

        const direction = this.settings.shadow_source === "key" && keyLightPosition
            ? new THREE.Vector3().copy(keyLightPosition)
            : new THREE.Vector3(0.15, 1, 0.25);
        if (direction.lengthSq() < 1e-6 || direction.y <= 0.05) direction.set(0.15, 1, 0.25);
        direction.normalize();

        const distance = radius * 3;
        this.shadowLight.position.copy(center).addScaledVector(direction, distance);
        this.shadowLight.target.position.copy(center);
        this.shadowLight.target.updateMatrixWorld();
        const camera = this.shadowLight.shadow.camera;
        camera.left = -radius;
        camera.right = radius;
        camera.top = radius;
        camera.bottom = -radius;
        camera.near = 0.5;
        camera.far = distance + radius * 2;
        camera.updateProjectionMatrix();
    }

    dispose() {
        this.scene?.remove(this.group, this.shadowLight, this.shadowLight.target);
        this.surface.geometry.dispose();
        this.surface.material.dispose();
        this.catcher.geometry.dispose();
        this.catcher.material.dispose();
        this.grid.geometry.dispose();
        [this.grid.material].flat().forEach(material => material.dispose());
        this.shadowLight.shadow?.map?.dispose?.();
        this.shadowLight.dispose?.();
    }
}
