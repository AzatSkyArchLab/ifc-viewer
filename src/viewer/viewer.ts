import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { IfcMeshData, SectionConfig } from "../core/types.ts";

/**
 * Element selection callback fired by a click in the scene.
 * expressID === null — click on empty space; additive === true — Shift was held.
 */
export type SelectHandler = (expressID: number | null, additive: boolean) => void;

/** A point/vector in scene space, as handed to applyViewpoint. */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** BCF camera pose in SCENE space (the host maps IFC world → scene first). */
export interface BcfSceneCamera {
  position: Vec3;
  direction: Vec3; // view direction (unit)
  up: Vec3; // up vector (unit)
  fovDeg: number | null; // perspective: vertical field of view, degrees
}

/** BCF clipping plane in SCENE space. `normal` is the BCF direction (the side
 *  it points at is hidden); `point` is a point on the plane. */
export interface BcfSceneClip {
  normal: Vec3;
  point: Vec3;
}

const HIGHLIGHT_COLOR = new THREE.Color(0xff8800);
/** Translucent colour for IfcSpace room volumes. */
const SPACE_COLOR = new THREE.Color(0x33aaff);
/** Colour for IfcSpace top-face outline edges. */
const SPACE_EDGE_COLOR = new THREE.Color(0x0a4fa0);
/** Threshold in pixels: a click that moved more than this is treated as orbit. */
const DRAG_THRESHOLD = 6;
/** Collision dot size — sprite units, constant on screen (~28 px at 800 px tall). */
const MARKER_SIZE = 0.035;
/** How much the sprite grows to fit the ring around an unchanged dot. */
const RING_FACTOR = 1.5;
/** Height of a collision number plate, in the same sprite units. */
const LABEL_SIZE = 0.028;

// ── Section capping ────────────────────────────────────────────────────────────
/** Muted mid-grey poché — the filled cut cross-section. */
const SECTION_FILL_COLOR = 0x8a8f98;
/** Dark near-black — the thick outline around the cut. */
const SECTION_OUTLINE_COLOR = 0x15181c;
/** Cut-outline half-thickness, in device pixels (screen-space edge kernel). */
const SECTION_OUTLINE_PX = 1.4;
/** Light orange for the translucent cut-plane indicator + its projection arrows. */
const SECTION_PLANE_COLOR = 0xff9d3c;

// ── Screen-space element edges (the "drawing" look) ──────────────────────────────
/** Layer carrying the opaque solids for the edge normal-prepass, in isolation. */
const EDGE_LAYER = 3;
/** Dark graphite for the element contour lines. */
const EDGE_COLOR = 0x2b2f36;
/** Normal dot below this between neighbours marks a crease edge. */
const EDGE_NORMAL_THRESHOLD = 0.7;
/** Relative linear-depth jump between neighbours marking a silhouette edge. */
const EDGE_DEPTH_THRESHOLD = 0.02;
/** Extra camera layer carrying only the opaque solids, for the stencil pass. */
const STENCIL_LAYER = 1;
/** Camera layer carrying only the cap quads, so they render in isolation. */
const CAP_LAYER = 2;

/** Shared empties that replace a mesh's source buffers once the batches own a
 *  copy — lets loadMeshes free the input model as it uploads it. */
const EMPTY_POS = new Float32Array(0);
const EMPTY_IDX = new Uint32Array(0);

/** Where an element's geometry lives inside the batches (one entry per geometry). */
interface InstRef {
  batch: "solid" | "trans";
  /** instanceId (=== geometryId, added in lockstep with the ghost twin). */
  id: number;
  /** geometryId, for per-geometry bounds (getBoundingBoxAt). */
  geoId: number;
}

/**
 * One section plane's capping resources. `backMat`/`frontMat` are swapped onto
 * the solid BatchedMesh to write the stencil (clip = this plane only); `mesh` is
 * the quad drawn on the plane, filled where the stencil marks solid interior
 * (`fillMat`) or as a white silhouette into the mask target (`maskMat`).
 */
interface CapPlane {
  backMat: THREE.MeshBasicMaterial;
  frontMat: THREE.MeshBasicMaterial;
  fillMat: THREE.MeshBasicMaterial;
  maskMat: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
}

/**
 * Minimal three.js viewer for IFC geometry (light theme).
 * Takes neutral IfcMeshData[] from the core — independent of web-ifc.
 *
 * All element geometry lives in a few THREE.BatchedMesh objects (one opaque, one
 * transparent, plus a gray "ghost" twin of each) instead of one Mesh per element,
 * so the whole model draws in a handful of calls regardless of element count.
 * Per-element visibility/colour is driven by setVisibleAt / setColorAt; picking
 * uses the batch raycast (batchId → element key). Supports multi-selection and
 * visibility control (isolate / hide / show all / floor focus).
 */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private modelGroup = new THREE.Group();
  /** Collision markers (red spheres at contact points); cleared on reload. */
  private markerGroup = new THREE.Group();
  /** Per-key colour overrides — the two sides of a collision. */
  private keyColors = new Map<number, THREE.Color>();
  /** Ground grid — dropped to the model's underside after each load. */
  private grid!: THREE.GridHelper;
  /** The sun that casts the contact shadow, and the ground plane that catches it. */
  private sun!: THREE.DirectionalLight;
  private shadowCatcher!: THREE.Mesh;
  /** Fill lights, kept in fields so setLighting can rebalance them. */
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  /** Contact shadow off until enabled from the menu. */
  private shadowsOn = false;
  /** Sun direction (unit, model→sun), driven by setSunDirection; default SE, high. */
  private sunDir = dirFromAzAlt(135, 55);

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDownPos = new THREE.Vector2();
  /** Element picked at pointer-down (before any orbit); committed on a click. */
  private pendingPick: number | null = null;
  /** Pair number of the marker pressed, when the press landed on one. */
  private pendingMarker: number | null = null;
  private onMarker: (pair: number) => void = () => {};
  /** Marker sprites by pair number, so one can be ringed on demand. */
  private markerByPair = new Map<number, THREE.Sprite>();
  /** Shared materials of the current marker set: plain dot and ringed dot. */
  private markerDot: THREE.SpriteMaterial | null = null;
  private markerRing: THREE.SpriteMaterial | null = null;
  private activeMarker: number | null = null;

  // ── Batched geometry ─────────────────────────────────────────────────────────
  /** Opaque solids / translucent (IfcSpace + a<1) / their gray ghost twins. */
  private solids: THREE.BatchedMesh | null = null;
  private transparent: THREE.BatchedMesh | null = null;
  private ghostSolid: THREE.BatchedMesh | null = null;
  private ghostTrans: THREE.BatchedMesh | null = null;
  /** Element key → its instances across the batches. */
  private byKey = new Map<number, InstRef[]>();
  /** Per-key IfcSpace top-face outlines (kept as individual LineSegments). */
  private spaceOutlines = new Map<number, THREE.LineSegments[]>();
  /** instanceId → element key, per batch. */
  private solidKey: number[] = [];
  private transKey: number[] = [];
  /** 1 iff the transparent instance is a real IfcSpace (0 for a<1 glass). */
  private transSpace = new Uint8Array(0);
  /** instanceId → base colour, per batch (Vector4 carries alpha for transparent). */
  private solidBase: THREE.Color[] = [];
  private transBase: THREE.Vector4[] = [];
  /** Guards against redundant setColorAt (which would re-upload the colour texture). */
  private solidColorCache = new Int32Array(0); // packed 0xRRGGBB, -1 = unset
  private transColorCache = new Float32Array(0); // 4 per instance

  /** Current selection. */
  private selection = new Set<number>();
  /** Last resolved visibility (from main), re-used when the selection changes. */
  private lastHidden = new Set<number>();
  private lastGhost = new Set<number>();
  /** Current highlight colour (set per selection; applied via setColorAt). */
  private highlightColor = new THREE.Color(HIGHLIGHT_COLOR);

  /** Shared batch materials — colour comes from per-instance setColorAt. */
  private solidMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  private transMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, // white so the per-instance RGBA is not double-multiplied
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private ghostMat = new THREE.MeshBasicMaterial({
    color: 0xb0b4ba,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  /** Shared line material for IfcSpace top-face outlines. */
  private spaceEdgeMaterial = new THREE.LineBasicMaterial({ color: SPACE_EDGE_COLOR });

  /** Scratch objects reused on the hot paths. */
  private _box = new THREE.Box3();
  private _meshBox = new THREE.Box3();
  private _scratchVec4 = new THREE.Vector4();

  /**
   * Whole-model bounds (scene space, Y-up), cached so a section-slider drag does
   * not recompute the batch bounding box on every change. Invalidated on clear.
   */
  private _bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  private _boundsDirty = true;

  // ── Section capping (stencil fill + screen-space outline) ────────────────────
  /** Per-plane cap resources; empty when no section is on. */
  private caps: CapPlane[] = [];
  /** Holds the cap quads (on CAP_LAYER, so the normal render skips them). */
  private capGroup = new THREE.Group();
  /** True once caps are built for the active planes and there is solid geometry. */
  private capsOn = false;

  /** The translucent cut-plane indicators + their corner projection arrows. Not
   *  clipped (own materials) and not raycast — a pure visual guide. */
  private sectionWidgets = new THREE.Group();
  private sectionPlaneMat = new THREE.MeshBasicMaterial({
    color: SECTION_PLANE_COLOR,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private sectionEdgeMat = new THREE.LineBasicMaterial({
    color: SECTION_PLANE_COLOR,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  private sectionArrowMat = new THREE.MeshBasicMaterial({
    color: SECTION_PLANE_COLOR,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  /** Draw the thick cut outline (screen-space edge of the fill silhouette). */
  private outlineOn = true;
  /** Off-screen silhouette of the caps, edge-detected for the outline. */
  private maskRT: THREE.WebGLRenderTarget | null = null;
  private outlineScene: THREE.Scene | null = null;
  private outlineMat: THREE.ShaderMaterial | null = null;
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private _bufSize = new THREE.Vector2();

  /** Screen-space element edges: a dark contour on silhouettes and creases, for
   *  a drawing-like read. Off by default — enabled from the Отображение menu. */
  private edgesOn = false;
  private edgeRT: THREE.WebGLRenderTarget | null = null;
  private edgeNormalMat = new THREE.MeshNormalMaterial();
  private edgeMat: THREE.ShaderMaterial | null = null;
  private edgeScene: THREE.Scene | null = null;

  /** On-demand rendering: only draw a frame when the scene actually changed. */
  private needsRender = true;
  /** Pixel ratio at rest (crisp) vs. while the camera moves (fast); see animate. */
  private readonly highRatio: number;
  private readonly lowRatio = 1;
  private ratioIsLow = false;

  /** Perf overlay (FPS / draw calls / triangles); toggle with ` or ?stats. */
  private statsEl: HTMLDivElement | null = null;
  private statsLastT = 0;
  private statsFps = 0;

  private onSelect: SelectHandler = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      // Section capping fills the cut cross-section with a stencil pass.
      stencil: true,
    });
    this.highRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.highRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // Section planes are per-material (material.clippingPlanes), so local
    // clipping has to be enabled once for the whole renderer.
    this.renderer.localClippingEnabled = true;
    // Soft contact shadow. The model + light are static, so the map is rebuilt
    // on demand (load / section change), not per frame; see updateShadow.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f5f7);
    this.scene.add(this.modelGroup);
    this.modelGroup.add(this.markerGroup);
    // Cap quads live directly under the scene on their own layer, so the model
    // group's clear/visibility logic never touches them.
    this.scene.add(this.capGroup);
    this.scene.add(this.sectionWidgets);

    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.01,
      10000,
    );
    this.camera.position.set(10, 10, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", this.requestRender);

    this.addLights();
    this.addGround();

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("click", this.handleClick);
    window.addEventListener("resize", this.handleResize);

    this.setupStats();
    this.animate();
  }

  /** Hidden perf overlay; `?stats` shows it on load, the ` key toggles it. */
  private setupStats(): void {
    const el = document.createElement("div");
    el.className = "viewer-stats";
    el.style.display = new URLSearchParams(location.search).has("stats")
      ? "block"
      : "none";
    this.container.appendChild(el);
    this.statsEl = el;
    window.addEventListener("keydown", (e) => {
      if (e.key === "`" || e.key === "ё") {
        el.style.display = el.style.display === "none" ? "block" : "none";
        this.requestRender();
      }
    });
  }

  /** Updates the perf overlay from the frame just rendered. */
  private updateStats(): void {
    const el = this.statsEl;
    if (!el || el.style.display === "none") return;
    const now = performance.now();
    if (this.statsLastT) {
      const dt = now - this.statsLastT;
      if (dt < 250) {
        // skip the idle gap when movement resumes
        const fps = 1000 / Math.max(dt, 0.001);
        this.statsFps = this.statsFps ? this.statsFps * 0.9 + fps * 0.1 : fps;
      }
    }
    this.statsLastT = now;
    const r = this.renderer.info.render;
    const tris =
      r.triangles >= 1e6
        ? `${(r.triangles / 1e6).toFixed(1)}M`
        : `${(r.triangles / 1e3).toFixed(0)}k`;
    el.textContent = `${this.statsFps.toFixed(0)} fps · ${r.calls} calls · ${tris} tris`;
  }

  setSelectHandler(handler: SelectHandler): void {
    this.onSelect = handler;
  }

  private addLights(): void {
    // Default is the "flat" set: bright fill + a faint sun, so the model reads
    // evenly with no strong cast on the material. setLighting(true) swaps to a
    // directional set (strong sun, dimmed fill) for sculpted light and shadow.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xbfc3c9, 0.85);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.45);
    const dir = new THREE.DirectionalLight(0xffffff, 0.15);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.bias = -0.0005;
    dir.shadow.normalBias = 0.6; // pushes samples off the surface — kills acne on big flat slabs
    this.sun = dir;
    this.scene.add(this.hemi, dir, dir.target, this.ambient);
  }

  private addGround(): void {
    this.grid = new THREE.GridHelper(100, 100, 0xc0c4cc, 0xe2e5ea);
    (this.grid.material as THREE.Material).opacity = 0.6;
    (this.grid.material as THREE.Material).transparent = true;
    this.scene.add(this.grid);

    // Invisible plane that shows only the shadow (ShadowMaterial), sat at the
    // model's foot and sized in updateShadow. Not raycast.
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.16, transparent: true, depthWrite: false }),
    );
    this.shadowCatcher.rotation.x = -Math.PI / 2; // lie flat, facing up
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.visible = false;
    this.shadowCatcher.raycast = () => {};
    this.scene.add(this.shadowCatcher);
  }

  /** Whole-model bounds from the batches (all instances active at load). */
  private modelBounds(target: THREE.Box3): THREE.Box3 {
    target.makeEmpty();
    if (this.solids) {
      this.solids.computeBoundingBox();
      if (this.solids.boundingBox) target.union(this.solids.boundingBox);
    }
    if (this.transparent) {
      this.transparent.computeBoundingBox();
      if (this.transparent.boundingBox) target.union(this.transparent.boundingBox);
    }
    return target;
  }

  /** Drops the ground grid to the model's underside so it never cuts through. */
  private groundToModel(): void {
    const box = this.modelBounds(this._box);
    this.grid.position.y = box.isEmpty() ? 0 : box.min.y;
    this.updateShadow();
  }

  /**
   * Aims the sun at the model and sizes its shadow frustum + the catcher plane
   * to the model bounds, then rebuilds the (static) shadow map once. Switched off
   * while a section is active — its multi-pass cap render would fight the shadow
   * pass, and a cut model's shadow is misleading anyway.
   */
  private updateShadow(): void {
    const b = this.getModelBounds();
    // Shadow needs an explicit opt-in and no active section (its multi-pass cap
    // render would fight the shadow pass, and a cut model's shadow misleads).
    const on = !!b && !this.capsOn && this.shadowsOn;
    this.sun.castShadow = on;
    this.shadowCatcher.visible = on;
    if (!b) return;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const radius = Math.max(sx, sy, sz);

    // Aim the sun from `sunDir` at all times — it also drives the directional
    // lighting, which must follow the sun sliders even with the shadow off.
    const center = new THREE.Vector3(cx, cy, cz);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDir, radius * 2.5);

    // Catcher: flat plane a hair below the model foot (avoids z-fighting the slab).
    this.shadowCatcher.position.set(cx, b.min.y - radius * 0.001, cz);
    this.shadowCatcher.scale.set(sx * 2.5 + 1, sz * 2.5 + 1, 1);

    if (on) {
      const cam = this.sun.shadow.camera;
      cam.left = -radius * 1.2;
      cam.right = radius * 1.2;
      cam.top = radius * 1.2;
      cam.bottom = -radius * 1.2;
      cam.near = 0.1;
      cam.far = radius * 6;
      cam.updateProjectionMatrix();
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.requestRender();
  }

  // ── Display menu API (Отображение → Графика) ─────────────────────────────────

  /** Toggle the screen-space element contours (off by default). */
  setEdges(on: boolean): void {
    this.edgesOn = on;
    this.requestRender();
  }

  /** Flat even fill (off) vs a sculpted directional sun with dimmed fill (on). */
  setLighting(on: boolean): void {
    this.sun.intensity = on ? 1.15 : 0.15;
    this.hemi.intensity = on ? 0.45 : 0.85;
    this.ambient.intensity = on ? 0.25 : 0.45;
    this.requestRender();
  }

  /** Enable/disable the contact shadow (updateShadow gates on shadowsOn + capsOn). */
  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.updateShadow();
  }

  /** Move the sun by azimuth (0..360°) and altitude (0..90°); light + shadow follow. */
  setSunDirection(azimuthDeg: number, altitudeDeg: number): void {
    this.sunDir = dirFromAzAlt(azimuthDeg, altitudeDeg);
    this.updateShadow();
  }

  /**
   * Loads model geometry into the scene, clearing the previous one. Geometry is
   * partitioned into an opaque and a translucent BatchedMesh (plus gray ghost
   * twins built in lockstep), so the whole model draws in a few calls. Vertices
   * already bake world coordinates → every instance keeps the identity matrix.
   */
  loadMeshes(meshes: IfcMeshData[]): void {
    this.clear();

    // Pass 1 — pre-scan to size the batches.
    let solidCount = 0;
    let solidVerts = 0;
    let solidIdx = 0;
    let transCount = 0;
    let transVerts = 0;
    let transIdx = 0;
    for (const data of meshes) {
      const isTrans = data.space || data.color.a < 1;
      const verts = data.positions.length / 3;
      const idx = data.indices.length;
      if (isTrans) {
        transCount++;
        transVerts += verts;
        transIdx += idx;
      } else {
        solidCount++;
        solidVerts += verts;
        solidIdx += idx;
      }
    }

    // Construct only the batches we need (a model may be all-solid or all-space).
    if (solidCount > 0) {
      this.solids = new THREE.BatchedMesh(solidCount, solidVerts, solidIdx, this.solidMat);
      // Opaque: depth test resolves order, so skip BatchedMesh's per-frame
      // O(n log n) instance sort — it otherwise runs on every render(), and the
      // section path renders solids 6-8× per frame.
      this.solids.sortObjects = false;
      // Also drawn on its own layer for the edge normal-prepass.
      this.solids.layers.enable(EDGE_LAYER);
      this.solids.castShadow = true; // the opaque structure casts the contact shadow
      this.ghostSolid = new THREE.BatchedMesh(solidCount, solidVerts, solidIdx, this.ghostMat);
      this.modelGroup.add(this.solids, this.ghostSolid);
      this.solidKey = new Array(solidCount);
      this.solidBase = new Array(solidCount);
      this.solidColorCache = new Int32Array(solidCount).fill(-1);
    }
    if (transCount > 0) {
      this.transparent = new THREE.BatchedMesh(transCount, transVerts, transIdx, this.transMat);
      this.transparent.renderOrder = 1;
      this.ghostTrans = new THREE.BatchedMesh(transCount, transVerts, transIdx, this.ghostMat);
      this.ghostTrans.renderOrder = 1;
      this.modelGroup.add(this.transparent, this.ghostTrans);
      this.transKey = new Array(transCount);
      this.transBase = new Array(transCount);
      this.transSpace = new Uint8Array(transCount);
      this.transColorCache = new Float32Array(transCount * 4).fill(NaN);
    }

    // Pass 2 — fill the batches.
    for (const data of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

      const isTrans = data.space || data.color.a < 1;
      const refs = this.byKey.get(data.key) ?? [];

      if (!isTrans) {
        const geoId = this.solids!.addGeometry(geometry);
        const id = this.solids!.addInstance(geoId);
        const c = new THREE.Color(data.color.r, data.color.g, data.color.b);
        this.solids!.setColorAt(id, c);
        this.solidColorCache[id] = c.getHex();
        this.solidBase[id] = c;
        this.solidKey[id] = data.key;
        this.ghostSolid!.addInstance(this.ghostSolid!.addGeometry(ghostGeom(geometry)));
        this.ghostSolid!.setVisibleAt(id, false);
        refs.push({ batch: "solid", id, geoId });
      } else {
        const geoId = this.transparent!.addGeometry(geometry);
        const id = this.transparent!.addInstance(geoId);
        const v = data.space
          ? new THREE.Vector4(SPACE_COLOR.r, SPACE_COLOR.g, SPACE_COLOR.b, 0.28)
          : new THREE.Vector4(data.color.r, data.color.g, data.color.b, data.color.a);
        this.transparent!.setColorAt(id, v);
        const o = id * 4;
        this.transColorCache[o] = v.x;
        this.transColorCache[o + 1] = v.y;
        this.transColorCache[o + 2] = v.z;
        this.transColorCache[o + 3] = v.w;
        this.transBase[id] = v;
        this.transKey[id] = data.key;
        this.transSpace[id] = data.space ? 1 : 0;
        this.ghostTrans!.addInstance(this.ghostTrans!.addGeometry(ghostGeom(geometry)));
        this.ghostTrans!.setVisibleAt(id, false);
        refs.push({ batch: "trans", id, geoId });
        if (data.space) {
          // Outline the top face of each room so spaces are clearly separated.
          const top = topFaceEdges(geometry);
          if (top) {
            const line = new THREE.LineSegments(top, this.spaceEdgeMaterial);
            line.renderOrder = 2;
            this.modelGroup.add(line);
            const arr = this.spaceOutlines.get(data.key) ?? [];
            arr.push(line);
            this.spaceOutlines.set(data.key, arr);
          }
        }
      }
      this.byKey.set(data.key, refs);

      // The batches (and the ghost twins) now hold their own copy of this mesh,
      // so release the source typed arrays right away. Without this the input
      // model and the GPU batches both hold the whole geometry at once, and a
      // big file peaks near the tab's memory ceiling during the upload.
      data.positions = EMPTY_POS;
      data.normals = EMPTY_POS;
      data.indices = EMPTY_IDX;
    }

    this.groundToModel();
    this.fitToVisible();
  }

  // ── Selection ────────────────────────────────────────────────────────────────

  /**
   * Sets the selection (source of truth is main) and highlights it. An optional
   * colour (hex) tints the highlight — used to show check categories (red /
   * orange / blue); omitted resets to the default pick colour.
   */
  setSelection(ids: number[], color?: number): void {
    this.selection = new Set(ids);
    this.highlightColor.setHex(color ?? HIGHLIGHT_COLOR.getHex());
    this.applyMaterials();
  }

  getSelection(): number[] {
    return [...this.selection];
  }

  /**
   * Per-key colour overrides, on top of the selection highlight. Used to show a
   * cross-file collision: the element from one model in one colour, its
   * counterpart from the other model in another. Pass null to clear.
   */
  setKeyColors(colors: Map<number, number> | null): void {
    this.keyColors.clear();
    if (colors) {
      for (const [key, hex] of colors) {
        this.keyColors.set(key, new THREE.Color(hex));
      }
    }
    this.applyMaterials();
  }

  /**
   * Drops a marker at each world point — the place where two bodies actually
   * meet. Points arrive in the model's own coordinates and are shifted by the
   * same recentring offset the meshes got, so they land on the geometry.
   *
   * Each point may carry a `label` — its collision number, the same one the
   * Excel report prints in «№ точки». Written next to the dot, it turns the
   * markers from anonymous red spots into something a reviewer can name.
   */
  setMarkers(
    points: { x: number; y: number; z: number; pair?: number; label?: string }[],
    color = 0xff0000,
  ): void {
    this.disposeMarkers();
    if (points.length === 0) return;
    // A collision is a ~100 mm feature on a ~100 m site: a world-sized marker is
    // either invisible zoomed out or enormous up close. Sprites with size
    // attenuation off keep a constant pixel size, so the spot is always findable.
    this.markerDot = new THREE.SpriteMaterial({
      map: this.markerTexture(color),
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    this.markerRing = new THREE.SpriteMaterial({
      map: this.ringTexture(color),
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    for (const p of points) {
      const sprite = new THREE.Sprite(this.markerDot);
      sprite.position.set(p.x, p.y, p.z);
      sprite.scale.set(MARKER_SIZE, MARKER_SIZE, 1);
      sprite.renderOrder = 999;
      // The pair number rides along so a click can name the collision.
      sprite.userData.pair = p.pair;
      this.markerGroup.add(sprite);
      if (typeof p.pair === "number") this.markerByPair.set(p.pair, sprite);
      if (p.label) this.markerGroup.add(this.markerLabel(p, p.label));
    }
    this.requestRender();
  }

  /**
   * Debug overlay for IFC-54: a coloured dot per sampled point, labelled with
   * its offset above the relief. Green points sit at the covering's constant
   * height (follow relief), red ones deviate — so a wrong covering shows its
   * bad spots directly on the geometry. Reuses the marker layer, so any
   * collision markers are replaced.
   */
  setDebugPoints(
    points: { x: number; y: number; z: number; label: string; color: number }[],
  ): void {
    this.disposeMarkers();
    if (points.length === 0) return;
    const materials = new Map<number, THREE.SpriteMaterial>();
    for (const p of points) {
      let material = materials.get(p.color);
      if (!material) {
        material = new THREE.SpriteMaterial({
          map: this.markerTexture(p.color),
          sizeAttenuation: false,
          depthTest: false,
          transparent: true,
        });
        materials.set(p.color, material);
      }
      const sprite = new THREE.Sprite(material);
      sprite.position.set(p.x, p.y, p.z);
      sprite.scale.set(MARKER_SIZE * 0.6, MARKER_SIZE * 0.6, 1);
      sprite.renderOrder = 999;
      sprite.raycast = () => {};
      this.markerGroup.add(sprite);
      this.markerGroup.add(this.markerLabel(p, p.label));
    }
    this.requestRender();
  }

  /** Ringed marker for the collision currently open; null clears the ring. */
  setActiveMarker(pair: number | null): void {
    if (this.activeMarker != null) {
      const previous = this.markerByPair.get(this.activeMarker);
      if (previous && this.markerDot) {
        previous.material = this.markerDot;
        previous.scale.set(MARKER_SIZE, MARKER_SIZE, 1);
      }
    }
    this.activeMarker = pair;
    const sprite = pair == null ? undefined : this.markerByPair.get(pair);
    if (sprite && this.markerRing) {
      sprite.material = this.markerRing;
      // The ring canvas is 1.5× wider around the same dot, so the sprite grows
      // by the same factor — the dot keeps its size and only the ring appears.
      sprite.scale.set(MARKER_SIZE * RING_FACTOR, MARKER_SIZE * RING_FACTOR, 1);
    }
    this.requestRender();
  }

  /** Called with the pair number when a collision marker is clicked. */
  setMarkerHandler(fn: (pair: number) => void): void {
    this.onMarker = fn;
  }

  /** Round dot with a white rim, so it reads against both models' colours. */
  private markerTexture(color: number): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    return new THREE.CanvasTexture(canvas);
  }

  /** The same dot inside a ring — the marker whose collision is open. */
  private ringTexture(color: number): THREE.CanvasTexture {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const middle = size / 2;
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    // Dot drawn at exactly the size it has when not active (the canvas grew,
    // not the dot), so switching materials does not make the point jump.
    ctx.beginPath();
    ctx.arc(middle, middle, 26, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(middle, middle, 42, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(middle, middle, 42, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = hex;
    ctx.stroke();
    return new THREE.CanvasTexture(canvas);
  }

  /** Number plate placed just above-right of a marker. Never raycast. */
  private markerLabel(
    at: { x: number; y: number; z: number },
    text: string,
  ): THREE.Sprite {
    const height = 64;
    const font = "bold 40px system-ui, sans-serif";
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;
    const width = Math.ceil(measure.measureText(text).width) + 28;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(17, 24, 39, 0.82)";
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 14);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    // Text shrunk by a mipmap chain turns to mush; keep it a plain bilinear read.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    const scaleY = LABEL_SIZE;
    const scaleX = (scaleY * width) / height;
    sprite.position.set(at.x, at.y, at.z);
    sprite.scale.set(scaleX, scaleY, 1);
    // `center` is the anchor point that lands on the position, so moving it off
    // (0.5, 0.5) parks the whole plate above-right of the dot — clear of it at
    // every zoom level, because both sizes are screen-constant.
    const offsetX = MARKER_SIZE * 0.85 + scaleX / 2;
    const offsetY = MARKER_SIZE * 0.5 + scaleY / 2;
    sprite.center.set(0.5 - offsetX / scaleX, 0.5 - offsetY / scaleY);
    sprite.renderOrder = 1000;
    // A label must never answer a click: markers win over geometry, and a hit on
    // the plate would otherwise swallow the press without opening anything.
    sprite.raycast = () => {};
    return sprite;
  }

  clearMarkers(): void {
    this.disposeMarkers();
  }

  /**
   * Drops the marker set and frees its GPU memory. Every set builds its own
   * canvas textures (one per label), so clearing the group alone would leak
   * them on each re-run of a check.
   */
  private disposeMarkers(): void {
    const shared = new Set<THREE.Material>();
    for (const material of [this.markerDot, this.markerRing]) {
      if (!material) continue;
      shared.add(material);
      material.map?.dispose();
      material.dispose();
    }
    for (const child of this.markerGroup.children) {
      // Every dot reuses one of the two shared materials; each label owns its
      // own texture, and that is what would otherwise pile up run after run.
      const material = (child as THREE.Sprite).material;
      if (shared.has(material)) continue;
      material.map?.dispose();
      material.dispose();
    }
    this.markerGroup.clear();
    this.markerByPair.clear();
    this.markerDot = this.markerRing = null;
    this.activeMarker = null;
  }

  // ── Visibility ───────────────────────────────────────────────────────────────

  /**
   * Applies a resolved visibility snapshot (computed centrally in main from the
   * VisState): `hidden` keys are not drawn, `ghost` keys are drawn as gray,
   * non-pickable context, everything else is visible. The current selection
   * highlight is re-asserted on top. Does not move the camera.
   */
  render(hidden: Set<number>, ghost: Set<number>): void {
    this.lastHidden = hidden;
    this.lastGhost = ghost;
    this.applyMaterials();
  }

  /**
   * The single writer of per-instance visibility/colour. Re-derives every
   * instance from the last resolved snapshot plus the selection, so it is
   * idempotent (safe to re-run for undo/redo). Ghosted keys are shown only in
   * the ghost batches (which are never raycast → structurally non-pickable).
   */
  private applyMaterials(): void {
    let transShown = 0;
    let ghostSolidOn = 0;
    let ghostTransOn = 0;
    for (const [key, refs] of this.byKey) {
      const isHidden = this.lastHidden.has(key);
      const isGhost = !isHidden && this.lastGhost.has(key);
      const override = this.keyColors.get(key);
      const isSel =
        !isHidden && !isGhost && (this.selection.has(key) || override !== undefined);
      const tint = override ?? this.highlightColor;
      const shown = !isHidden && !isGhost;
      for (const ref of refs) {
        if (ref.batch === "solid") {
          this.solids!.setVisibleAt(ref.id, shown);
          this.ghostSolid!.setVisibleAt(ref.id, isGhost);
          this.setSolidColor(ref.id, isSel ? tint : this.solidBase[ref.id]);
          if (isGhost) ghostSolidOn++;
        } else {
          this.transparent!.setVisibleAt(ref.id, shown);
          this.ghostTrans!.setVisibleAt(ref.id, isGhost);
          if (isSel) {
            const base = this.transBase[ref.id];
            this._scratchVec4.set(tint.r, tint.g, tint.b, base.w);
            this.setTransColor(ref.id, this._scratchVec4);
          } else {
            this.setTransColor(ref.id, this.transBase[ref.id]);
          }
          if (shown) transShown++;
          if (isGhost) ghostTransOn++;
        }
      }
      // Outlines follow the space's visibility (stay shown while ghosted).
      const lines = this.spaceOutlines.get(key);
      if (lines) for (const l of lines) l.visible = !isHidden;
    }
    // Skip whole batches that draw nothing this frame — their per-instance
    // onBeforeRender loop (frustum test on every instance) otherwise runs even
    // at multiDrawCount 0. Typical model: ghost empty + IfcSpace layer-hidden.
    if (this.transparent) this.transparent.visible = transShown > 0;
    if (this.ghostSolid) this.ghostSolid.visible = ghostSolidOn > 0;
    if (this.ghostTrans) this.ghostTrans.visible = ghostTransOn > 0;
    this.requestRender();
  }

  /** Cache-guarded per-instance colour writes (setColorAt re-uploads otherwise). */
  private setSolidColor(id: number, c: THREE.Color): void {
    const hex = c.getHex();
    if (this.solidColorCache[id] === hex) return;
    this.solidColorCache[id] = hex;
    this.solids!.setColorAt(id, c);
  }

  private setTransColor(id: number, v: THREE.Vector4): void {
    const o = id * 4;
    const c = this.transColorCache;
    if (c[o] === v.x && c[o + 1] === v.y && c[o + 2] === v.z && c[o + 3] === v.w) {
      return;
    }
    c[o] = v.x;
    c[o + 1] = v.y;
    c[o + 2] = v.z;
    c[o + 3] = v.w;
    this.transparent!.setColorAt(id, v);
  }

  /** Fully clears the loaded model from the scene. */
  clear(): void {
    this.selection.clear();
    this.lastHidden.clear();
    this.lastGhost.clear();

    for (const b of [this.solids, this.transparent, this.ghostSolid, this.ghostTrans]) {
      b?.dispose(); // frees the batch's textures/geometry, NOT the shared material
    }
    for (const arr of this.spaceOutlines.values()) {
      for (const l of arr) l.geometry.dispose();
    }
    this.modelGroup.clear();
    // The marker layer lives on the model group, so re-attach it after the wipe.
    this.disposeMarkers();
    this.keyColors.clear();
    this.modelGroup.add(this.markerGroup);

    // Drop any active caps — their planes belong to the model being cleared.
    this.disposeCaps();
    this.capsOn = false;

    this.solids = this.transparent = this.ghostSolid = this.ghostTrans = null;
    this._boundsDirty = true; // next load re-derives the section-slider range
    this.spaceOutlines.clear();
    this.byKey.clear();
    this.solidKey = [];
    this.transKey = [];
    this.solidBase = [];
    this.transBase = [];
    this.transSpace = new Uint8Array(0);
    this.solidColorCache = new Int32Array(0);
    this.transColorCache = new Float32Array(0);
  }

  // ── Sections (cutting planes) ────────────────────────────────────────────────

  /**
   * Whole-model bounds in scene space (Y-up), or null when nothing is loaded.
   * The section panel ranges its sliders off this: Y for the plan-cut height,
   * the XZ half-extent for the vertical section's slide. Cached (invalidated on
   * clear) so a slider drag never recomputes the batch bounding box.
   */
  getModelBounds(): { min: THREE.Vector3; max: THREE.Vector3 } | null {
    if (this._boundsDirty) {
      const box = this.modelBounds(this._box);
      this._bounds = box.isEmpty()
        ? null
        : { min: box.min.clone(), max: box.max.clone() };
      this._boundsDirty = false;
    }
    return this._bounds
      ? { min: this._bounds.min.clone(), max: this._bounds.max.clone() }
      : null;
  }

  /**
   * (Re)builds the list of active section planes from the enabled sections and
   * assigns it to the three batch materials (solid / transparent / ghost), so the
   * cut applies to everything the viewer draws — including highlighted and
   * ghosted geometry, which reuse these same shared materials. Empty when neither
   * section is on.
   *
   * A THREE.Plane(normal, constant) keeps the +normal half-space: it discards a
   * fragment where normal·worldPos + constant < 0.
   *
   * HORIZONTAL — the scene is Y-up, so the plan cut is a Y-normal plane and
   * `z` is the cut height along scene-Y. Default keeps geometry BELOW the cut:
   * normal (0,−1,0), constant = z ⟹ distance = z − worldY ≥ 0 ⟺ worldY ≤ z.
   * Flip negates both normal and constant ⟹ keeps worldY ≥ z (above).
   *
   * VERTICAL — a plane containing the Y axis whose normal rotates in the ground
   * (XZ) plane: normal (cosθ, 0, sinθ), θ from angleDeg (0° → +X). The plane
   * passes through the model-centre XZ shifted by `offset` along that normal;
   * constant = −(normal·planePoint). Flip negates normal and constant.
   */
  setSections(cfg: SectionConfig): void {
    const planes: THREE.Plane[] = [];

    if (cfg.horizontal.on) {
      const s = cfg.horizontal.flip ? -1 : 1;
      planes.push(
        new THREE.Plane(new THREE.Vector3(0, -s, 0), s * cfg.horizontal.z),
      );
    }

    if (cfg.vertical.on) {
      const b = this.getModelBounds();
      const cx = b ? (b.min.x + b.max.x) / 2 : 0;
      const cz = b ? (b.min.z + b.max.z) / 2 : 0;
      const a = (cfg.vertical.angleDeg * Math.PI) / 180;
      const s = cfg.vertical.flip ? -1 : 1;
      const nx = Math.cos(a) * s;
      const nz = Math.sin(a) * s;
      // Plane through centre + offset·normal — exactly where the widget rectangle
      // sits (the normal already carries the flip), so the cut and the visible
      // plane move together in either flip state. (Earlier this had an extra ·s
      // that made the offset run opposite the widget once flipped.)
      const constant = -(nx * cx + nz * cz) - cfg.vertical.offset;
      planes.push(new THREE.Plane(new THREE.Vector3(nx, 0, nz), constant));
    }

    this.applyPlanes(planes);
    this.buildSectionWidgets(cfg);
  }

  /**
   * (Re)builds the translucent cut-plane indicators: for each active section a
   * light-orange rectangle a touch larger than the model, sitting at the cut,
   * with a projection arrow at each corner pointing the way the plan/section is
   * viewed (down for a plan, along the kept-side normal for a section). Purely a
   * visual guide — its own materials, so the section planes never clip it.
   */
  private buildSectionWidgets(cfg: SectionConfig): void {
    this.disposeSectionWidgets();
    const b = this.getModelBounds();
    if (!b) return;
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const pad = 1.08; // a touch larger than the building

    if (cfg.horizontal.on) {
      const center = new THREE.Vector3(cx, cfg.horizontal.z, cz);
      const u = new THREE.Vector3(1, 0, 0);
      const v = new THREE.Vector3(0, 0, 1);
      // Plan: viewed from above unless flipped to keep the upper part.
      const proj = new THREE.Vector3(0, cfg.horizontal.flip ? 1 : -1, 0);
      this.addPlaneWidget(center, u, v, (sx / 2) * pad, (sz / 2) * pad, proj, Math.max(sx, sz));
    }
    if (cfg.vertical.on) {
      const a = (cfg.vertical.angleDeg * Math.PI) / 180;
      const s = cfg.vertical.flip ? -1 : 1;
      const nx = Math.cos(a) * s;
      const nz = Math.sin(a) * s;
      const center = new THREE.Vector3(
        cx + nx * cfg.vertical.offset,
        cy,
        cz + nz * cfg.vertical.offset,
      );
      const u = new THREE.Vector3(0, 1, 0); // vertical
      const v = new THREE.Vector3(-nz, 0, nx); // in-plane horizontal (⟂ normal)
      // Width the building actually spans along the cut (its bbox shadow on v),
      // so the rectangle hugs the model instead of the full footprint diagonal.
      const halfW = (sx / 2) * Math.abs(nz) + (sz / 2) * Math.abs(nx);
      const proj = new THREE.Vector3(-nx, 0, -nz); // view toward the kept (+normal) side
      this.addPlaneWidget(center, u, v, (sy / 2) * pad, halfW * pad, proj, Math.max(sy, halfW * 2));
    }
    this.requestRender();
  }

  /** One cut-plane rectangle (fill + border) with a projection arrow at each of
   *  its four corners. `u`/`v` are the in-plane axes; the plane normal is u×v. */
  private addPlaneWidget(
    center: THREE.Vector3,
    u: THREE.Vector3,
    v: THREE.Vector3,
    halfU: number,
    halfV: number,
    proj: THREE.Vector3,
    modelSpan: number,
  ): void {
    const un = u.clone().normalize();
    const vn = v.clone().normalize();
    const normal = new THREE.Vector3().crossVectors(un, vn).normalize();
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(un, vn, normal),
    );

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(halfU * 2, halfV * 2),
      this.sectionPlaneMat,
    );
    fill.position.copy(center);
    fill.quaternion.copy(quat);
    fill.renderOrder = 4;
    fill.raycast = () => {};
    this.sectionWidgets.add(fill);

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(fill.geometry),
      this.sectionEdgeMat,
    );
    border.position.copy(center);
    border.quaternion.copy(quat);
    border.renderOrder = 5;
    border.raycast = () => {};
    this.sectionWidgets.add(border);

    const len = Math.max(modelSpan * 0.06, 0.5);
    for (const su of [halfU, -halfU]) {
      for (const sv of [halfV, -halfV]) {
        const corner = center
          .clone()
          .addScaledVector(un, su)
          .addScaledVector(vn, sv);
        this.sectionWidgets.add(this.makeArrow(corner, proj, len));
      }
    }
  }

  /** A small translucent arrow (shaft + head) at `origin` pointing along `dir`. */
  private makeArrow(origin: THREE.Vector3, dir: THREE.Vector3, len: number): THREE.Object3D {
    const g = new THREE.Group();
    const shaftLen = len * 0.7;
    const headLen = len * 0.3;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(len * 0.03, len * 0.03, shaftLen, 6),
      this.sectionArrowMat,
    );
    shaft.position.set(0, shaftLen / 2, 0);
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(len * 0.09, headLen, 10),
      this.sectionArrowMat,
    );
    head.position.set(0, shaftLen + headLen / 2, 0);
    g.add(shaft, head);
    // Cylinder/Cone point along +Y by default — aim them along dir.
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.position.copy(origin);
    g.renderOrder = 5;
    g.traverse((o) => (o.raycast = () => {}));
    return g;
  }

  /** Frees the current cut-plane widgets (geometry only; materials are shared). */
  private disposeSectionWidgets(): void {
    for (const child of this.sectionWidgets.children.slice()) {
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      this.sectionWidgets.remove(child);
    }
  }

  /**
   * Assigns a plane list to the three batch materials (solid / transparent /
   * ghost) and rebuilds the stencil caps for it, so the cut applies to
   * everything the viewer draws. Shared by the section panel (setSections) and
   * BCF viewpoint restore (applyViewpoint). Empty clears the cut.
   */
  private applyPlanes(planes: THREE.Plane[]): void {
    // The renderer recompiles the material shader when the plane count changes,
    // so no manual needsUpdate is required here.
    for (const mat of [this.solidMat, this.transMat, this.ghostMat]) {
      mat.clippingPlanes = planes;
    }
    // Rebuild the stencil caps for these planes (fills the cut cross-section).
    this.buildCaps(planes);
    this.updateShadow(); // caps on → shadow off (and back), per capsOn
    this.requestRender();
  }

  /**
   * Restores a BCF viewpoint: places the camera at the saved pose and applies
   * the saved section cuts. Both are given in SCENE space (the host maps IFC
   * world coordinates through the same swap + recentring the geometry used).
   *
   * `camera` null keeps the current view (a viewpoint may carry only cuts).
   * `clips` fully defines the section state for this viewpoint — an empty list
   * clears any cut, since restoring a viewpoint takes over what the model shows.
   */
  applyViewpoint(camera: BcfSceneCamera | null, clips: BcfSceneClip[]): void {
    if (camera) this.applyCamera(camera);
    this.applyPlanes(clips.map((c) => this.clipPlane(c)));
    // A viewpoint takes over the section state; drop the panel's plane widget so
    // a stale orange rectangle from a previous cut does not linger.
    this.disposeSectionWidgets();
  }

  /** Points the camera along a BCF pose (scene space), framing the model depth. */
  private applyCamera(cam: BcfSceneCamera): void {
    const pos = new THREE.Vector3(cam.position.x, cam.position.y, cam.position.z);
    const dir = new THREE.Vector3(cam.direction.x, cam.direction.y, cam.direction.z);
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, -1);
    dir.normalize();
    const up = new THREE.Vector3(cam.up.x, cam.up.y, cam.up.z);
    if (up.lengthSq() < 1e-12) up.set(0, 1, 0);

    const b = this.getModelBounds();
    const center = b
      ? new THREE.Vector3(
          (b.min.x + b.max.x) / 2,
          (b.min.y + b.max.y) / 2,
          (b.min.z + b.max.z) / 2,
        )
      : pos.clone().add(dir);
    const diag = b ? b.min.distanceTo(b.max) : 1;
    // Orbit pivot: as far down the view ray as the model centre, so later
    // orbiting turns around the model rather than a point on the lens.
    let dist = center.clone().sub(pos).dot(dir);
    if (!(dist > 1e-3)) dist = Math.max(diag, 1);

    this.camera.up.copy(up).normalize();
    this.camera.position.copy(pos);
    this.controls.target.copy(pos).addScaledVector(dir, dist);
    if (cam.fovDeg && cam.fovDeg > 1 && cam.fovDeg < 179) {
      this.camera.fov = cam.fovDeg;
    }
    this.camera.near = Math.max(diag / 1000, 0.01);
    this.camera.far = Math.max(diag * 100, dist * 4);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * A BCF clipping plane (scene space) as a THREE.Plane. BCF hides the geometry
   * on the +normal side; THREE keeps the +normal half-space, so the plane normal
   * is the opposite of the BCF direction.
   */
  private clipPlane(c: BcfSceneClip): THREE.Plane {
    const n = new THREE.Vector3(-c.normal.x, -c.normal.y, -c.normal.z);
    if (n.lengthSq() < 1e-12) n.set(0, -1, 0);
    n.normalize();
    const p = new THREE.Vector3(c.point.x, c.point.y, c.point.z);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
  }

  /**
   * (Re)builds the per-plane cap resources for the active section planes. Each
   * cap gets: two stencil-writing materials swapped onto the solid batch during
   * the render (clip = its own plane, back faces increment / front faces
   * decrement, so a net non-zero marks solid interior at the plane), a grey fill
   * quad (clip = the *other* planes, drawn where stencil ≠ 0), and a white twin
   * of that quad used to render the outline silhouette. Disposes the previous set
   * first; leaves capping off when there are no planes or no solid geometry.
   */
  private buildCaps(planes: THREE.Plane[]): void {
    this.disposeCaps();
    if (planes.length === 0 || !this.solids) {
      this.capsOn = false;
      return;
    }
    // The stencil pass renders only the solids — give them a private layer.
    this.solids.layers.enable(STENCIL_LAYER);

    const b = this.getModelBounds();
    const center = b
      ? new THREE.Vector3(
          (b.min.x + b.max.x) / 2,
          (b.min.y + b.max.y) / 2,
          (b.min.z + b.max.z) / 2,
        )
      : new THREE.Vector3();
    const diag = b ? b.min.distanceTo(b.max) : 1;
    const size = Math.max(diag * 2, 1); // quad big enough to cover the whole cut
    const zAxis = new THREE.Vector3(0, 0, 1);

    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      const others = planes.filter((_, j) => j !== i);

      const stencilBase: THREE.MeshBasicMaterialParameters = {
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        clippingPlanes: [plane],
      };
      const backMat = new THREE.MeshBasicMaterial({
        ...stencilBase,
        side: THREE.BackSide,
        stencilFail: THREE.IncrementWrapStencilOp,
        stencilZFail: THREE.IncrementWrapStencilOp,
        stencilZPass: THREE.IncrementWrapStencilOp,
      });
      const frontMat = new THREE.MeshBasicMaterial({
        ...stencilBase,
        side: THREE.FrontSide,
        stencilFail: THREE.DecrementWrapStencilOp,
        stencilZFail: THREE.DecrementWrapStencilOp,
        stencilZPass: THREE.DecrementWrapStencilOp,
      });
      // The cap fills only where the stencil is non-zero, then clears it (Replace
      // ref 0) so the next plane starts clean.
      const capBase: THREE.MeshBasicMaterialParameters = {
        side: THREE.DoubleSide,
        clippingPlanes: others,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      };
      const fillMat = new THREE.MeshBasicMaterial({
        ...capBase,
        color: SECTION_FILL_COLOR,
      });
      const maskMat = new THREE.MeshBasicMaterial({
        ...capBase,
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), fillMat);
      mesh.layers.set(CAP_LAYER);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.quaternion.setFromUnitVectors(zAxis, plane.normal.clone().normalize());
      // Sit the quad on the plane at the model-centre's projection onto it.
      mesh.position
        .copy(center)
        .addScaledVector(plane.normal, -plane.distanceToPoint(center));
      this.capGroup.add(mesh);

      this.caps.push({ backMat, frontMat, fillMat, maskMat, mesh });
    }
    this.capsOn = true;
  }

  /** Frees the current cap set (materials + quad geometry). */
  private disposeCaps(): void {
    for (const cap of this.caps) {
      this.capGroup.remove(cap.mesh);
      cap.mesh.geometry.dispose();
      cap.backMat.dispose();
      cap.frontMat.dispose();
      cap.fillMat.dispose();
      cap.maskMat.dispose();
    }
    this.caps = [];
  }

  // ── Section cap rendering (called from the render loop) ───────────────────────

  /**
   * Full frame when at least one cut cross-section is filled. First draws the
   * scene as usual (cap quads sit on CAP_LAYER, so this layer-0 pass skips them),
   * then stencil-fills each cap into the same buffer, then lays the thick outline
   * over the top. Restores the default render state so the plain path is
   * unaffected on the next frame.
   */
  private renderWithCaps(): void {
    const r = this.renderer;
    const cam = this.camera;
    const bg = this.scene.background;

    // Normal scene, with its background clear.
    cam.layers.set(0);
    r.autoClear = true;
    r.render(this.scene, cam);

    // A Color scene.background forces a full clear on every render() call, which
    // would wipe the frame (and the stencil) on each cap sub-pass — drop it while
    // capping and accumulate into the buffer instead.
    this.scene.background = null;
    r.autoClear = false;
    this.fillCaps(false);
    if (this.outlineOn) this.renderOutline();

    this.scene.background = bg;
    cam.layers.set(0);
    r.autoClear = true;
  }

  /**
   * Runs the stencil-cap sequence for every plane, into whatever buffer is bound.
   * Per plane: clear the stencil, write it from the solids (back then front,
   * material swapped in), then draw the plane's quad (grey fill, or the white
   * `mask` silhouette). The solid batch's material is restored before the quad,
   * so the normal render on the next frame is untouched.
   */
  private fillCaps(mask: boolean): void {
    const r = this.renderer;
    const cam = this.camera;
    const solids = this.solids;
    if (!solids) return;
    for (const cap of this.caps) {
      r.clearStencil();
      cam.layers.set(STENCIL_LAYER);
      solids.material = cap.backMat;
      r.render(this.scene, cam);
      solids.material = cap.frontMat;
      r.render(this.scene, cam);
      solids.material = this.solidMat;
      cam.layers.set(CAP_LAYER);
      cap.mesh.material = mask ? cap.maskMat : cap.fillMat;
      cap.mesh.visible = true;
      r.render(this.scene, cam);
      cap.mesh.visible = false;
    }
  }

  /**
   * Draws the thick cut outline: render the caps as a white silhouette into an
   * off-screen target, then composite a screen-space edge of that silhouette over
   * the frame. Screen-space keeps the line uniformly thick along the true section
   * contour, including prismatic walls where a geometric offset would produce no
   * edge.
   */
  private renderOutline(): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this._bufSize);
    this.ensureOutline();

    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.maskRT);
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    this.fillCaps(true);
    r.setRenderTarget(null);
    r.setClearColor(prevColor, prevAlpha);

    const mat = this.outlineMat!;
    mat.uniforms.uMask.value = this.maskRT!.texture;
    mat.uniforms.uTexel.value.set(1 / this._bufSize.x, 1 / this._bufSize.y);
    r.autoClear = false;
    r.render(this.outlineScene!, this.orthoCam);
  }

  /** Lazily builds (and resizes) the mask target and the full-screen edge quad. */
  private ensureOutline(): void {
    const w = Math.max(1, Math.floor(this._bufSize.x));
    const h = Math.max(1, Math.floor(this._bufSize.y));
    if (!this.maskRT) {
      this.maskRT = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: true,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
    } else if (this.maskRT.width !== w || this.maskRT.height !== h) {
      this.maskRT.setSize(w, h);
    }
    if (this.outlineScene) return;
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(SECTION_OUTLINE_COLOR) },
        uRadius: { value: SECTION_OUTLINE_PX },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uMask;
        uniform vec2 uTexel;
        uniform vec3 uColor;
        uniform float uRadius;
        varying vec2 vUv;
        void main() {
          float mn = 1.0, mx = 0.0;
          for (int i = -2; i <= 2; i++) {
            for (int j = -2; j <= 2; j++) {
              float s = texture2D(uMask, vUv + vec2(float(i), float(j)) * uTexel * uRadius).r;
              mn = min(mn, s); mx = max(mx, s);
            }
          }
          if (mx < 0.5 || mn > 0.5) discard; // kernel does not straddle the edge
          gl_FragColor = vec4(uColor, 1.0);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outlineMat);
    quad.frustumCulled = false;
    this.outlineScene = new THREE.Scene();
    this.outlineScene.add(quad);
  }

  /**
   * Draws dark element contours over the current frame. A prepass renders the
   * opaque solids' view-space normals (+ depth) off-screen, honouring the active
   * clipping planes; a full-screen pass then marks a pixel as an edge where a
   * neighbour is background (silhouette), the normal turns sharply (crease), or
   * the depth jumps (one solid in front of another), and composites the line on
   * top. Cost is O(pixels), so it holds up on large models. Ghost/space/ground
   * are off EDGE_LAYER and never contribute edges.
   */
  private renderEdges(): void {
    if (!this.edgesOn || !this.solids) return;
    const r = this.renderer;
    r.getDrawingBufferSize(this._bufSize);
    this.ensureEdges();

    // Prepass — solids only, as view normals, into edgeRT (+ its depth texture).
    this.edgeNormalMat.clippingPlanes = this.solidMat.clippingPlanes;
    const prevBg = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    this.scene.background = null;
    this.scene.overrideMaterial = this.edgeNormalMat;
    this.camera.layers.set(EDGE_LAYER);
    r.setRenderTarget(this.edgeRT);
    r.autoClear = true;
    r.setClearColor(0x000000, 0); // alpha 0 → background sentinel for silhouettes
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    this.scene.background = prevBg;
    this.scene.overrideMaterial = prevOverride;
    this.camera.layers.set(0);

    // Composite — detect edges from the normal+depth buffer and draw the line.
    const mat = this.edgeMat!;
    mat.uniforms.uNormal.value = this.edgeRT!.texture;
    mat.uniforms.uDepth.value = this.edgeRT!.depthTexture;
    mat.uniforms.uTexel.value.set(1 / this._bufSize.x, 1 / this._bufSize.y);
    mat.uniforms.uNear.value = this.camera.near;
    mat.uniforms.uFar.value = this.camera.far;
    r.autoClear = false;
    r.render(this.edgeScene!, this.orthoCam);
    r.autoClear = true;
  }

  /** Lazily builds (and resizes) the edge normal+depth target and its quad. */
  private ensureEdges(): void {
    const w = Math.max(1, Math.floor(this._bufSize.x));
    const h = Math.max(1, Math.floor(this._bufSize.y));
    if (!this.edgeRT) {
      this.edgeRT = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
      });
      this.edgeRT.depthTexture = new THREE.DepthTexture(w, h);
      this.edgeRT.depthTexture.type = THREE.UnsignedIntType;
    } else if (this.edgeRT.width !== w || this.edgeRT.height !== h) {
      this.edgeRT.setSize(w, h);
    }
    if (this.edgeScene) return;
    this.edgeMat = new THREE.ShaderMaterial({
      uniforms: {
        uNormal: { value: null },
        uDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(EDGE_COLOR) },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uNormalT: { value: EDGE_NORMAL_THRESHOLD },
        uDepthT: { value: EDGE_DEPTH_THRESHOLD },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uNormal;
        uniform sampler2D uDepth;
        uniform vec2 uTexel;
        uniform vec3 uColor;
        uniform float uNear, uFar, uNormalT, uDepthT;
        varying vec2 vUv;
        float linz(float d) {
          float z = d * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
        }
        void main() {
          vec4 c = texture2D(uNormal, vUv);
          if (c.a < 0.5) discard;                 // background pixel — no edge here
          vec3 nc = normalize(c.rgb * 2.0 - 1.0);
          float dc = linz(texture2D(uDepth, vUv).r);
          float edge = 0.0;
          vec2 offs[4];
          offs[0] = vec2(uTexel.x, 0.0);  offs[1] = vec2(-uTexel.x, 0.0);
          offs[2] = vec2(0.0, uTexel.y);  offs[3] = vec2(0.0, -uTexel.y);
          for (int i = 0; i < 4; i++) {
            vec2 uv = vUv + offs[i];
            vec4 s = texture2D(uNormal, uv);
            if (s.a < 0.5) { edge = 1.0; continue; }               // silhouette vs background
            vec3 ns = normalize(s.rgb * 2.0 - 1.0);
            if (dot(nc, ns) < uNormalT) edge = 1.0;                // crease
            float ds = linz(texture2D(uDepth, uv).r);
            if (abs(ds - dc) > uDepthT * dc) edge = 1.0;           // depth step
          }
          if (edge < 0.5) discard;
          gl_FragColor = vec4(uColor, 1.0);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edgeMat);
    quad.frustumCulled = false;
    this.edgeScene = new THREE.Scene();
    this.edgeScene.add(quad);
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownPos.set(event.clientX, event.clientY);
    // Pick now, before an orbit can rotate the camera: the click just commits
    // this hit, so a tiny drag between press and release never mis-selects or
    // misses (the old code ray-picked at click time, after the view had moved).
    // Markers win over geometry — they are the small thing being aimed at.
    this.pendingMarker = this.pickMarker(event.clientX, event.clientY);
    this.pendingPick =
      this.pendingMarker == null
        ? this.pickAt(event.clientX, event.clientY, !event.altKey)
        : null;
  };

  private handleClick = (event: MouseEvent): void => {
    // A click after a noticeable move = orbit/pan, not a selection.
    const moved = Math.hypot(
      event.clientX - this.pointerDownPos.x,
      event.clientY - this.pointerDownPos.y,
    );
    if (moved > DRAG_THRESHOLD) return;
    if (this.pendingMarker != null) {
      this.onMarker(this.pendingMarker);
      return;
    }
    this.onSelect(this.pendingPick, event.shiftKey);
  };

  /** Pair number of the collision marker under the cursor, or null. */
  private pickMarker(clientX: number, clientY: number): number | null {
    if (this.markerGroup.children.length === 0) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.markerGroup.children, false);
    // Number plates share the group with the dots; only a dot carries a pair.
    const hit = hits.find((h) => typeof h.object.userData.pair === "number");
    return hit ? (hit.object.userData.pair as number) : null;
  }

  /**
   * Ray-picks the element under a screen position against the current camera.
   * Returns the composite element key, or null for empty space. Only the two
   * real batches are tested — hidden instances are auto-excluded and ghost
   * batches are never raycast, so ghosted context is non-pickable. When IfcSpace
   * rooms are shown they are preferred (they sit behind walls) unless
   * `preferSpace` is false (Alt-click), which falls through to the solid behind.
   */
  private pickAt(
    clientX: number,
    clientY: number,
    preferSpace: boolean,
  ): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const batches = [this.solids, this.transparent].filter(
      Boolean,
    ) as THREE.BatchedMesh[];
    const hits = this.raycaster.intersectObjects(batches, false);
    if (hits.length === 0) return null;

    const keyOf = (h: THREE.Intersection): number =>
      h.object === this.solids
        ? this.solidKey[h.batchId as number]
        : this.transKey[h.batchId as number];
    const isSpaceHit = (h: THREE.Intersection): boolean =>
      h.object === this.transparent && this.transSpace[h.batchId as number] === 1;

    const space = preferSpace ? hits.find(isSpaceHit) : undefined;
    const hit = space ?? hits[0];
    return hit ? keyOf(hit) : null;
  }

  /** Frames the camera on a specific set of elements (by scene key). Zooms in
   *  without touching visibility, so it never resets an active isolation. */
  fitTo(keys: number[]): void {
    this._box.makeEmpty();
    for (const key of keys) {
      for (const ref of this.byKey.get(key) ?? []) {
        const b = ref.batch === "solid" ? this.solids : this.transparent;
        if (!b) continue;
        if (b.getBoundingBoxAt(ref.geoId, this._meshBox)) this._box.union(this._meshBox);
      }
    }
    if (this._box.isEmpty()) return;
    const size = this._box.getSize(new THREE.Vector3());
    const center = this._box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    this.controls.target.copy(center);
    const dist = maxDim * 1.8;
    this.camera.position.set(center.x + dist, center.y + dist * 0.8, center.z + dist);
    this.camera.near = Math.max(maxDim / 100, 0.01);
    this.camera.far = Math.max(this.camera.far, maxDim * 200);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Frames the camera on the whole model (called at load, all instances shown). */
  private fitToVisible(): void {
    const box = this.modelBounds(this._box);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    this.controls.target.copy(center);
    const dist = maxDim * 1.6;
    this.camera.position.set(
      center.x + dist,
      center.y + dist * 0.8,
      center.z + dist,
    );
    this.camera.near = maxDim / 1000;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  private handleResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.requestRender();
  };

  /** Flags that a frame is needed; the render loop is otherwise idle. */
  private requestRender = (): void => {
    this.needsRender = true;
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (!this.needsRender) return;
    this.needsRender = false;
    // update() applies damping and re-flags needsRender (via "change") while the
    // camera is still moving, so the loop keeps drawing until it settles.
    this.controls.update();
    this.applyRenderQuality(this.needsRender);
    if (this.capsOn && this.solids) this.renderWithCaps();
    else this.renderer.render(this.scene, this.camera);
    this.renderEdges(); // element contours over the base frame (both paths)
    this.updateStats();
  };

  /** Low pixel ratio while moving (fast), full ratio once settled (crisp). */
  private applyRenderQuality(moving: boolean): void {
    if (moving === this.ratioIsLow) return; // switch only on transitions
    this.ratioIsLow = moving;
    this.renderer.setPixelRatio(moving ? this.lowRatio : this.highRatio);
    this.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight,
      false,
    );
  }
}

/** Unit sun direction (model→sun) from azimuth (° around Y, 0° = +Z) and
 *  altitude (° above the ground). Scene is Y-up. */
function dirFromAzAlt(azimuthDeg: number, altitudeDeg: number): THREE.Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const al = (altitudeDeg * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(al) * Math.sin(az),
    Math.sin(al),
    Math.cos(al) * Math.cos(az),
  ).normalize();
}

/** A position+index-only copy for a ghost twin (no normals — unlit material). */
function ghostGeom(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", src.getAttribute("position"));
  g.setIndex(src.getIndex());
  return g;
}

/**
 * Returns the outline edges of a mesh's top face (scene is Y-up, so "top" is
 * max Y). Used to draw a crisp boundary around each IfcSpace room. Null when
 * the geometry has no top edges.
 */
function topFaceEdges(geometry: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const edges = new THREE.EdgesGeometry(geometry, 1);
  const pos = edges.getAttribute("position");
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));

  const eps = 0.05; // 5 cm tolerance for "on the top plane"
  const kept: number[] = [];
  for (let i = 0; i < pos.count; i += 2) {
    if (pos.getY(i) >= maxY - eps && pos.getY(i + 1) >= maxY - eps) {
      kept.push(
        pos.getX(i), pos.getY(i), pos.getZ(i),
        pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1),
      );
    }
  }
  edges.dispose();
  if (kept.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  return g;
}
