import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const BG = 0x09090b; // the UI's background token — the city sits on the page, not in a box

// The 3D stage: renderer, camera, lights, ground, orbit controls, hover
// raycasting, and a render loop that fans out to per-frame subscribers.
// Lighting/ground setup adapted from grahambrooks/codecity (frontend/src/scene.js).
export class Scene {
  constructor(container) {
    this.container = container;
    this.frameCallbacks = [];
    this.hoverTargets = [];
    this.hovered = -1;
    this.onHover = null;      // (building, mouseEvent) => void
    this.onHoverIndex = null; // (instanceIndex) => void
    this.onSelect = null;     // (building | null) => void — a click, not a drag
    this.hitResolver = null;  // (intersection) => { building, index } | null
    this._resolved = null;    // what the pointer is over right now
    this._flight = null;      // an in-progress camera move

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-2, -2);

    this._init();
    this._lights();
    this._environment();
    this._ground();
    this._composer();
    this._events();
    this._animate();
  }

  /**
   * Image-based lighting. Without an environment, a PBR material has nothing
   * to reflect, so glazing renders as flat tinted paint no matter how low its
   * roughness is. A pre-filtered room probe gives every surface something to
   * pick up — which is what separates "material" from "coloured box".
   */
  _environment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // Low at night: enough for glazing to catch a sheen, not enough to
    // light the city like an overcast afternoon.
    this.scene.environmentIntensity = 0.22;
    pmrem.dispose();
  }

  /**
   * Post-processing. Ambient occlusion is the single biggest realism win here:
   * it darkens the creases where buildings meet the ground and where wings
   * meet each other, which is exactly the contact shading that makes massing
   * read as solid rather than as decals floating on a plane.
   */
  _composer() {
    const { clientWidth: w, clientHeight: h } = this.container;

    // The renderer's own `antialias: true` only applies to the default
    // framebuffer. As soon as rendering goes through a composer it lands in a
    // render target instead and antialiasing is silently lost — which is why
    // post-processing makes edges turn jagged. Asking for a multisampled
    // target puts MSAA back.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.width, size.height, {
      type: THREE.HalfFloatType,
      samples: 4,
    });

    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const gtao = new GTAOPass(this.scene, this.camera, w, h);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 1.0;
    // Radius is in world units — tuned to the width of a street so occlusion
    // gathers between buildings without smearing across whole blocks.
    // Sample counts are deliberately low: AO here is broad contact shading,
    // not fine detail, and the denoise pass hides the reduced sampling. Full
    // 16/16 sampling costs roughly 3x the frame time for no visible gain at
    // city scale.
    gtao.updateGtaoMaterial({
      radius: 1.6,
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.0,
      samples: 6,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 6 });
    this.gtao = gtao;
    this.composer.addPass(gtao);

    // OutputPass applies tone mapping and the sRGB conversion at the end.
    this.composer.addPass(new OutputPass());
  }

  /** Render through the composer. Use this instead of renderer.render(). */
  render() {
    this.composer.render();
  }

  /** Resize renderer, camera and composer together. */
  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    if (this.gtao) this.gtao.setSize(w, h);
    if (this.labels) this.labels.setSize(w, h);
  }

  _init() {
    this.scene = new THREE.Scene();
    // The city is drawn at night on the page's own background colour, so the
    // canvas has no visible edge — the UI floats over the city rather than
    // framing a picture of one. Fog fades the far ground into that same
    // colour instead of into a horizon line.
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.Fog(BG, 260, 900);

    const { clientWidth: w, clientHeight: h } = this.container;
    this.camera = new THREE.PerspectiveCamera(58, w / h, 0.1, 2000);
    this.camera.position.set(90, 90, 90);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Tone mapping keeps lit windows and accent roofs from clipping to white.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    // Folder names float over their districts. CSS2D keeps them as real DOM
    // text — crisp at any zoom and styled by the same stylesheet as the UI.
    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    Object.assign(this.labels.domElement.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none',
    });
    this.labels.domElement.className = 'label-layer';
    this.container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 800;

    this.cityGroup = new THREE.Group();
    this.scene.add(this.cityGroup);
  }

  _lights() {
    // Night lighting: a cool moon as the key so the massing still reads and
    // throws shadow, a violet rim from behind to separate towers from the
    // dark ground, and very little ambient — the windows do the rest.
    this.scene.add(new THREE.AmbientLight(0x8a90b8, 0.35));

    const key = new THREE.DirectionalLight(0xb4c2ff, 1.1);
    key.position.set(90, 170, 70);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 500;
    const s = 160;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.5;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xa78bfa, 0.55);
    rim.position.set(-80, 50, -90);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0x3a3f66, 0x050507, 0.45));
  }

  _ground() {
    // The base plane IS the road surface — districts get painted on top, and
    // the gaps the treemap leaves between them become the street grid.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // A faint survey grid, matching the dotted-grid floor in the design.
    const grid = new THREE.GridHelper(2400, 300, 0x1b1b22, 0x131318);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.75;
    this.scene.add(grid);
  }

  /** Replace the floating district labels. `items` = [{ text, x, z, y }]. */
  setLabels(items) {
    for (const o of this._labelObjects || []) this.cityGroup.remove(o);
    this._labelObjects = items.map((it) => {
      const el = document.createElement('div');
      el.className = 'district-label';
      const dot = document.createElement('i');
      dot.style.background = it.color;
      const name = document.createElement('span');
      name.textContent = it.text;
      el.append(dot, name);
      const obj = new CSS2DObject(el);
      obj.position.set(it.x, it.y ?? 0.4, it.z);
      this.cityGroup.add(obj);
      return obj;
    });
  }

  /**
   * Glide the camera to look at `target` from `distance` away, keeping the
   * current viewing direction unless an explicit `dir` is given. Eased over a
   * short flight so a jump across the city stays spatially legible.
   */
  flyTo(target, distance, dir = null, duration = 0.8) {
    const t = new THREE.Vector3(target.x, target.y || 0, target.z);
    const d = (dir ? new THREE.Vector3(dir.x, dir.y, dir.z)
      : this.camera.position.clone().sub(this.controls.target)).normalize();
    this._flight = {
      p0: this.camera.position.clone(), t0: this.controls.target.clone(),
      p1: t.clone().add(d.multiplyScalar(distance)), t1: t,
      k: 0, dur: duration,
    };
  }

  /** Dolly in (factor < 1) or out (factor > 1) around the current target. */
  zoom(factor) {
    const off = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(off.length() * factor,
      this.controls.minDistance, this.controls.maxDistance);
    this.flyTo(this.controls.target, len, off, 0.35);
  }

  _stepFlight(dt) {
    const f = this._flight;
    if (!f) return;
    f.k = Math.min(1, f.k + dt / f.dur);
    const e = f.k < 0.5 ? 4 * f.k ** 3 : 1 - (-2 * f.k + 2) ** 3 / 2; // easeInOutCubic
    this.camera.position.lerpVectors(f.p0, f.p1, e);
    this.controls.target.lerpVectors(f.t0, f.t1, e);
    if (f.k >= 1) this._flight = null;
  }

  _events() {
    window.addEventListener('resize', () => this._resize());
    // The container can start at 0×0 (e.g. before layout) and grow later —
    // keep the renderer matched to it however it changes.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._resize()).observe(this.container);
    }
    const el = this.renderer.domElement;
    el.addEventListener('mousemove', (e) => this._mouseMove(e));
    el.addEventListener('mouseleave', () => {
      this.mouse.set(-2, -2);
      if (this.onHover) this.onHover(null);
      if (this.onHoverIndex) this.onHoverIndex(-1);
    });

    // A click selects; a drag orbits. OrbitControls owns the drag, so only a
    // press that barely moved counts as a click.
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5 || !this.onSelect) return;
      this._mouseMove(e);
      this._raycast();
      this.onSelect(this._resolved ? this._resolved.building : null);
    });
    // Any manual orbit cancels an automated camera flight.
    this.controls.addEventListener('start', () => { this._flight = null; });
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return; // not laid out yet
    this.setSize(w, h);
  }

  _mouseMove(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this._mouseEvent = e;
  }

  _raycast() {
    if (!this.onHover || !this.hoverTargets.length) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.hoverTargets, false);

    // The city is a single InstancedMesh, so a hit carries an instanceId that
    // the resolver maps back to the building it represents.
    let resolved = null;
    if (hits.length && this.hitResolver) {
      for (const hit of hits) {
        resolved = this.hitResolver(hit);
        if (resolved) break;
      }
    }

    this._resolved = resolved;
    const key = resolved ? resolved.index : -1;
    if (key !== this.hovered) {
      this.hovered = key;
      if (this.onHoverIndex) this.onHoverIndex(key);
      // `index` is a building record, not a number, so test for presence.
      this.container.style.cursor = resolved ? 'pointer' : '';
    }

    this.onHover(resolved ? resolved.building : null, this._mouseEvent);
  }

  /** Register a callback run every frame with the delta seconds. Returns an unsubscribe fn. */
  onFrame(cb) {
    this.frameCallbacks.push(cb);
    return () => { this.frameCallbacks = this.frameCallbacks.filter((f) => f !== cb); };
  }

  setHoverTargets(meshes) { this.hoverTargets = meshes; }

  /**
   * Stand back far enough that the whole plan is legible at once, at the
   * raised three-quarter angle planning views use — high enough to read the
   * street grid, low enough to keep the extrusions three-dimensional.
   */
  frameCamera(radius, center = new THREE.Vector3(0, 0, 0)) {
    const dist = Math.max(radius * 1.75, 70);
    this.camera.position.set(
      center.x + dist * 0.62,
      dist * 0.78,
      center.z + dist * 0.62
    );
    this.controls.target.copy(center); // Before The camera always targets ground level (y = 0).After The camera targets the complete center position, including its height (center.y).
    this.controls.update();

  _animate() {
    this._clock = this._clock || new THREE.Clock();
    requestAnimationFrame(() => this._animate());
    const dt = this._clock.getDelta();
    for (const cb of this.frameCallbacks) cb(dt);
    this._stepFlight(dt);
    this.controls.update();
    // Another view is on screen: keep the city's clock running, skip the GPU work.
    if (this.paused) return;
    this._raycast();
    this.render();
    this.labels.render(this.scene, this.camera);
  }
}
