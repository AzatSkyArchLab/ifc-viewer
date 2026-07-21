import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { IfcMeshData } from "../core/types.ts";

/**
 * Element selection callback fired by a click in the scene.
 * expressID === null — click on empty space; additive === true — Shift was held.
 */
export type SelectHandler = (expressID: number | null, additive: boolean) => void;

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

/** Where an element's geometry lives inside the batches (one entry per geometry). */
interface InstRef {
  batch: "solid" | "trans";
  /** instanceId (=== geometryId, added in lockstep with the ghost twin). */
  id: number;
  /** geometryId, for per-geometry bounds (getBoundingBoxAt). */
  geoId: number;
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
    });
    this.highRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.highRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f5f7);
    this.scene.add(this.modelGroup);
    this.modelGroup.add(this.markerGroup);

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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xbfc3c9, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(50, 80, 30);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  }

  private addGround(): void {
    this.grid = new THREE.GridHelper(100, 100, 0xc0c4cc, 0xe2e5ea);
    (this.grid.material as THREE.Material).opacity = 0.6;
    (this.grid.material as THREE.Material).transparent = true;
    this.scene.add(this.grid);
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
        }
      }
      // Outlines follow the space's visibility (stay shown while ghosted).
      const lines = this.spaceOutlines.get(key);
      if (lines) for (const l of lines) l.visible = !isHidden;
    }
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

    this.solids = this.transparent = this.ghostSolid = this.ghostTrans = null;
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
    this.renderer.render(this.scene, this.camera);
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
