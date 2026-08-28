import {
    Color,
    CubeCamera,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    MeshPhysicalMaterial,
    WebGLCubeRenderTarget,
} from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";

const TEXT_CONTENT = "HELLO WORLD !";
const TEXT_DEPTH = 0.3;
const MONUMENT_PITCH = -0.11;
const MONUMENT_YAW = -0.14;
const DESKTOP_REFLECTION_SIZE = 64;
const CONSTRAINED_REFLECTION_SIZE = 64;
const DESKTOP_REFLECTION_STRIDE = 2;
const CONSTRAINED_REFLECTION_STRIDE = 3;

export class MirrorMonument {
    constructor(scene, renderer) {
        this.scene = scene;
        this.renderer = renderer;
        this.reflectionBackground = new Color(0x000000);
        this.materials = [];
        this.geometry = null;
        this.mesh = null;
        this.localWidth = 1;
        this.reflectionTarget = null;
        this.cubeCamera = null;
        this.reflectionSize = 0;
        this.reflectionStride = DESKTOP_REFLECTION_STRIDE;
        this.reflectionFrame = 0;
        this.cssWidth = 0;
        this.pixelsPerWorldUnit = 1;
        this.isConstrained = false;
        this.disposed = false;
    }

    get reflectionProbePosition() {
        return this.cubeCamera?.position ?? null;
    }

    resize(cssWidth, pixelsPerWorldUnit, isConstrained) {
        this.cssWidth = cssWidth;
        this.pixelsPerWorldUnit = pixelsPerWorldUnit;
        this.isConstrained = isConstrained;
        this.reflectionStride = isConstrained
            ? CONSTRAINED_REFLECTION_STRIDE
            : DESKTOP_REFLECTION_STRIDE;

        this._resizeMesh();

        if (this.mesh) {
            this._ensureReflectionTarget();
        }
    }

    async create() {
        const fontUrl = new URL(
            "../assets/helvetiker_bold.typeface.json",
            import.meta.url,
        );
        const font = await new FontLoader().loadAsync(fontUrl.href);

        if (this.disposed) {
            return false;
        }

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
            geometry.dispose();
            throw new Error("Unable to measure the monument text geometry.");
        }

        const centerX = (bounds.min.x + bounds.max.x) / 2;
        const centerY = (bounds.min.y + bounds.max.y) / 2;
        const centerZ = (bounds.min.z + bounds.max.z) / 2;

        geometry.translate(-centerX, -centerY, -centerZ);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        this.localWidth = bounds.max.x - bounds.min.x;
        this.geometry = geometry;

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

        this.materials = [frontMaterial, sideMaterial];
        this.mesh = new Mesh(geometry, this.materials);
        this.mesh.position.z = 0;
        this.mesh.rotation.set(MONUMENT_PITCH, MONUMENT_YAW, 0);
        this.scene.add(this.mesh);
        this._resizeMesh();
        this._ensureReflectionTarget();
        return true;
    }

    updateReflection(bodyVisuals, force = false) {
        if (!force) {
            this.reflectionFrame += 1;

            if (this.reflectionFrame % this.reflectionStride !== 0) {
                return;
            }
        }

        if (
            !bodyVisuals
            || !this.mesh
            || !this.cubeCamera
            || !this.reflectionTarget
        ) {
            return;
        }

        const mainBackground = this.scene.background;
        this.mesh.visible = false;
        this.scene.background = this.reflectionBackground;
        bodyVisuals.setReflectionMode(true);

        try {
            this.cubeCamera.update(this.renderer, this.scene);
        } finally {
            this.scene.background = mainBackground;
            this.mesh.visible = true;
            bodyVisuals.setReflectionMode(false);
        }
    }

    dispose() {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        const dfgLut = this.materials
            .map((material) => (
                this.renderer.properties.get(material).uniforms?.dfgLUT?.value
            ))
            .find((texture) => texture?.isDataTexture);

        this.geometry?.dispose();
        this.reflectionTarget?.dispose();
        for (const material of this.materials) {
            material.dispose();
        }

        // MeshPhysicalMaterial uses Three.js's module-level DFG lookup
        // texture. WebGLRenderer.dispose() does not unregister the renderer's
        // listener from that shared texture, so dispose it before the renderer.
        dfgLut?.dispose();

        this.materials.length = 0;
        this.geometry = null;
        this.mesh = null;
        this.reflectionTarget = null;
        this.cubeCamera = null;
        this.reflectionSize = 0;
    }

    _resizeMesh() {
        if (!this.mesh || this.localWidth <= 0 || this.cssWidth <= 0) {
            return;
        }

        const widthRatio = this.cssWidth < 600 ? 0.9 : 0.67;
        const desiredPixelWidth = Math.min(this.cssWidth * widthRatio, 1120);
        const desiredWorldWidth = desiredPixelWidth / this.pixelsPerWorldUnit;
        const scale = desiredWorldWidth / this.localWidth;

        this.mesh.scale.setScalar(scale);
    }

    _ensureReflectionTarget() {
        const desiredSize = this.isConstrained
            ? CONSTRAINED_REFLECTION_SIZE
            : DESKTOP_REFLECTION_SIZE;

        if (this.reflectionTarget && desiredSize === this.reflectionSize) {
            for (const material of this.materials) {
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

        for (const material of this.materials) {
            material.envMap = target.texture;
            material.needsUpdate = true;
        }

        previousTarget?.dispose();
    }
}
