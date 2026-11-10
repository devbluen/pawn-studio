// three.js viewer for GTA models (objects and animated peds). Data comes from src/gta/dff.ts.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

export class Viewer {
    constructor(container) {
        this.container = container;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1b1f24);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(3, 5, 4);
        this.scene.add(sun);
        this.grid = new THREE.GridHelper(20, 20, 0x3d444d, 0x2d333b);
        this.scene.add(this.grid);
        // GTA is Z-up; three.js is Y-up
        this.world = new THREE.Group();
        this.world.rotation.x = -Math.PI / 2;
        this.scene.add(this.world);
        this.clock = new THREE.Clock();
        this.mixer = null;
        this.action = null;
        this.speed = 1;
        this.wireframe = false;
        this.onFrame = null;
        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();
        const loop = () => {
            this.raf = requestAnimationFrame(loop);
            const dt = this.clock.getDelta();
            if (this.mixer) this.mixer.update(dt * this.speed);
            if (this.onFrame && this.action) this.onFrame(this.action.time, this.action.getClip().duration);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    resize() {
        const w = this.container.clientWidth || 300;
        const h = this.container.clientHeight || 300;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    clear() {
        if (this.mixer) this.mixer.stopAllAction();
        this.mixer = null;
        this.action = null;
        for (const c of [...this.world.children]) {
            this.world.remove(c);
            c.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
                for (const m of mats) {
                    if (m.map) m.map.dispose();
                    m.dispose();
                }
            });
        }
    }

    _textures(data) {
        const loader = new THREE.TextureLoader();
        const cache = {};
        return (name) => {
            if (!name) return null;
            const k = name.toLowerCase();
            if (!(k in cache)) {
                const uri = data.textures[k];
                if (!uri) cache[k] = null;
                else {
                    const tex = loader.load(uri);
                    tex.flipY = false;
                    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.magFilter = THREE.LinearFilter;
                    cache[k] = tex;
                }
            }
            return cache[k];
        };
    }

    _materials(data) {
        const tex = this._textures(data);
        return data.model.materials.map((m) => {
            const map = tex(m.texture);
            return new THREE.MeshLambertMaterial({
                color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
                map,
                side: THREE.DoubleSide,
                transparent: m.color[3] < 0.99,
                opacity: m.color[3],
                alphaTest: map ? 0.35 : 0,
                wireframe: this.wireframe,
            });
        });
    }

    _geometry(mesh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
        if (mesh.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2));
        if (mesh.normals) g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
        const index = [];
        let start = 0;
        for (const grp of mesh.groups) {
            for (const i of grp.indices) index.push(i);
            g.addGroup(start, grp.indices.length, grp.material);
            start += grp.indices.length;
        }
        g.setIndex(index);
        if (!mesh.normals) g.computeVertexNormals();
        return g;
    }

    _frames(model) {
        const nodes = model.frames.map((f) => {
            const o = f.boneId !== undefined && model.hanim ? new THREE.Bone() : new THREE.Object3D();
            const m = new THREE.Matrix4().fromArray(f.matrix);
            m.decompose(o.position, o.quaternion, o.scale);
            o.name = f.boneId !== undefined ? `b${f.boneId}` : f.name;
            o.userData.frameName = f.name;
            return o;
        });
        const root = new THREE.Group();
        model.frames.forEach((f, i) => (f.parent >= 0 && nodes[f.parent] ? nodes[f.parent] : root).add(nodes[i]));
        return { root, nodes };
    }

    /** Static object: frames + meshes, camera framed on the bounding sphere. */
    showModel(data) {
        this.clear();
        const { root, nodes } = this._frames(data.model);
        const mats = this._materials(data);
        for (const mesh of data.model.meshes) {
            const g = this._geometry(mesh);
            const used = mesh.groups.map((x) => mats[x.material] ?? new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }));
            // groups index into `used`
            mesh.groups.forEach((_, i) => (g.groups[i].materialIndex = i));
            const obj = new THREE.Mesh(g, used);
            (nodes[mesh.frame] ?? root).add(obj);
        }
        this.world.add(root);
        this.frame(root);
    }

    /** Animated ped: skinned mesh + IFP animation. */
    showAnimated(data, anim, opts) {
        this.clear();
        const model = data.model;
        const { root, nodes } = this._frames(model);
        this.world.add(root);
        root.updateMatrixWorld(true);
        const byBoneId = new Map();
        model.frames.forEach((f, i) => f.boneId !== undefined && byBoneId.set(f.boneId, nodes[i]));
        const mats = this._materials(data);
        for (const mesh of model.meshes) {
            const g = this._geometry(mesh);
            mesh.groups.forEach((_, i) => (g.groups[i].materialIndex = i));
            const used = mesh.groups.map((x) => mats[x.material] ?? new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }));
            if (mesh.skin && model.hanim) {
                g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skin.indices, 4));
                g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(mesh.skin.weights, 4));
                const bones = model.hanim.map((n) => byBoneId.get(n.id) ?? new THREE.Bone());
                // RW inverse-bind matrices already map clump space → bone space (bone × inverse = the
                // atomic's frame), so the mesh hangs from the clump root, not from its frame; three.js
                // multiplies by the bind matrix, which is cancelled here.
                const sm = new THREE.SkinnedMesh(g, used);
                root.add(sm);
                sm.updateMatrixWorld(true);
                const undoBind = sm.matrixWorld.clone().invert();
                const inverses = mesh.skin.inverseBind.map((m) => new THREE.Matrix4().fromArray(m).multiply(undoBind));
                sm.bind(new THREE.Skeleton(bones, inverses), sm.matrixWorld);
            } else {
                (nodes[mesh.frame] ?? root).add(new THREE.Mesh(g, used));
            }
        }
        if (anim) {
            this.play(anim, byBoneId, opts);
            this.mixer.update(0); // frame the animated pose, not the (lying) rest pose
        }
        this.frame(root, true);
    }

    play(anim, byBoneId, opts) {
        const tracks = [];
        for (const b of anim.bones) {
            let bone = byBoneId.get(b.boneId);
            if (!bone) this.world.traverse((o) => { if (!bone && o.userData.frameName?.toLowerCase() === b.name.toLowerCase()) bone = o; });
            if (!bone || !b.frames.length) continue;
            const times = b.frames.map((f) => f.time);
            const q = [];
            let prev = null;
            for (const f of b.frames) {
                let [x, y, z, w] = f.rot;
                // keep quaternions in the same hemisphere for smooth interpolation
                if (prev && prev[0] * x + prev[1] * y + prev[2] * z + prev[3] * w < 0) [x, y, z, w] = [-x, -y, -z, -w];
                prev = [x, y, z, w];
                q.push(x, y, z, w);
            }
            // includes the root: the model's rest pose lies on its side, the animation's root rotation stands it up
            tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, q));
            if (b.frames[0].pos) {
                const p = [];
                const rest = bone.position;
                const isRoot = b.boneId === 0;
                for (const f of b.frames) {
                    if (isRoot && opts.inPlace) p.push(rest.x, rest.y, f.pos[2]);
                    else p.push(...f.pos);
                }
                tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, p));
            }
        }
        const clip = new THREE.AnimationClip(anim.name, -1, tracks);
        this.mixer = new THREE.AnimationMixer(this.world);
        this.action = this.mixer.clipAction(clip);
        this.action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        this.action.clampWhenFinished = true;
        this.action.play();
        this.speed = opts.speed ?? 1;
    }

    setPaused(p) {
        if (this.action) this.action.paused = p;
    }

    setWireframe(on) {
        this.wireframe = on;
        this.world.traverse((o) => {
            const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
            for (const m of mats) m.wireframe = on;
        });
    }

    frame(obj, ped = false) {
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj, true);
        if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = Math.max(sphere.radius, 0.3);
        const c = sphere.center;
        this.grid.position.set(c.x, box.min.y, c.z);
        this.grid.scale.setScalar(Math.max(0.05, r * 0.2));
        const dist = r / Math.sin((this.camera.fov * Math.PI) / 360) * (ped ? 1.2 : 1.05);
        // peds face GTA +Y, which is three.js -Z after the Z-up rotation: look at them from the front
        if (ped) this.camera.position.set(c.x + dist * 0.45, c.y + dist * 0.2, c.z - dist * 0.85);
        else this.camera.position.set(c.x + dist * 0.6, c.y + dist * 0.35, c.z + dist * 0.75);
        this.camera.near = Math.max(0.01, r / 100);
        this.camera.far = r * 100 + 100;
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(c);
        this.controls.update();
        this.home = { pos: this.camera.position.clone(), target: c.clone() };
    }

    resetView() {
        if (!this.home) return;
        this.camera.position.copy(this.home.pos);
        this.controls.target.copy(this.home.target);
        this.controls.update();
    }
}
