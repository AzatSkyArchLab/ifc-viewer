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

/**
 * Minimal three.js viewer for IFC geometry (light theme).
 * Takes neutral IfcMeshData[] from the core — independent of web-ifc.
 * Supports multi-selection and visibility control (isolate / hide / show all).
 */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private modelGroup = new THREE.Group();
  /** Ground grid — dropped to the model's underside after each load. */
  private grid!: THREE.GridHelper;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDownPos = new THREE.Vector2();
  /** Element picked at pointer-down (before any orbit); committed on a click. */
  private pendingPick: number | null = null;

  /** expressID → element meshes (an element may have several geometries). */
  private byExpressID = new Map<number, THREE.Mesh[]>();
  /** Current selection. */
  private selection = new Set<number>();
  /** Each mesh's own material — the base to restore under highlight / ghost. */
  private baseMaterial = new Map<THREE.Mesh, THREE.Material>();
  /** Last resolved visibility (from main), re-used when the selection changes. */
  private lastHidden = new Set<number>();
  private lastGhost = new Set<number>();
  /** A single shared highlight material for all selected meshes. */
  private highlightMaterial: THREE.MeshLambertMaterial;
  /** Shared translucent material for ghosted (locked context) models. */
  private ghostMaterial = new THREE.MeshLambertMaterial({
    color: 0xb0b4ba,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  /** Shared line material for IfcSpace top-face outlines. */
  private spaceEdgeMaterial = new THREE.LineBasicMaterial({ color: SPACE_EDGE_COLOR });

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

    this.highlightMaterial = new THREE.MeshLambertMaterial({
      color: HIGHLIGHT_COLOR,
      emissive: HIGHLIGHT_COLOR,
      emissiveIntensity: 0.3,
      side: THREE.DoubleSide,
    });

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

  /** Updates the perf overlay from the frame just rendered (draw-call bound
   *  large scenes show here as a high `calls` count that BatchedMesh collapses). */
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

  /** Drops the ground grid to the model's underside so it never cuts through. */
  private groundToModel(): void {
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const child of this.modelGroup.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) box.union(meshBox.copy(mesh.geometry.boundingBox));
    }
    this.grid.position.y = box.isEmpty() ? 0 : box.min.y;
  }

  /** Loads model geometry into the scene, clearing the previous one. */
  loadMeshes(meshes: IfcMeshData[]): void {
    this.clear();

    for (const data of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data.positions, 3),
      );
      geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      // Positions are already in (recentred) world IFC coordinates.

      // IfcSpace bodies are drawn translucent (and non-occluding) so rooms are
      // visible/clickable without hiding the walls behind them.
      const material = data.space
        ? new THREE.MeshLambertMaterial({
            color: SPACE_COLOR,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
          })
        : new THREE.MeshLambertMaterial({
            color: new THREE.Color(data.color.r, data.color.g, data.color.b),
            side: THREE.DoubleSide,
            transparent: data.color.a < 1,
            opacity: data.color.a,
          });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.key = data.key;
      mesh.userData.space = data.space;
      this.baseMaterial.set(mesh, material);
      if (data.space) {
        mesh.renderOrder = 1; // draw after solids
        // Outline the top face of each room so spaces are clearly separated.
        const top = topFaceEdges(geometry);
        if (top) {
          const line = new THREE.LineSegments(top, this.spaceEdgeMaterial);
          line.renderOrder = 2;
          mesh.add(line); // child → inherits the space's visibility
        }
      }
      this.modelGroup.add(mesh);

      const list = this.byExpressID.get(data.key) ?? [];
      list.push(mesh);
      this.byExpressID.set(data.key, list);
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
    const hex = color ?? HIGHLIGHT_COLOR.getHex();
    this.highlightMaterial.color.setHex(hex);
    this.highlightMaterial.emissive.setHex(hex);
    this.applyMaterials();
  }

  getSelection(): number[] {
    return [...this.selection];
  }

  // ── Visibility ───────────────────────────────────────────────────────────────

  /**
   * Applies a resolved visibility snapshot (computed centrally in main from the
   * VisState): `hidden` keys are not drawn, `ghost` keys are drawn translucent
   * and locked (non-pickable context), everything else is visible. The current
   * selection highlight is re-asserted on top. Does not move the camera.
   */
  render(hidden: Set<number>, ghost: Set<number>): void {
    this.lastHidden = hidden;
    this.lastGhost = ghost;
    this.applyMaterials();
  }

  /**
   * The single place that writes mesh.visible / mesh.material / userData.locked.
   * Re-derives each mesh from the last resolved snapshot plus the selection, so
   * it is idempotent and never leaves a stale swapped material behind.
   */
  private applyMaterials(): void {
    for (const [key, meshes] of this.byExpressID) {
      const isHidden = this.lastHidden.has(key);
      const isGhost = !isHidden && this.lastGhost.has(key);
      const isSel = !isHidden && !isGhost && this.selection.has(key);
      for (const mesh of meshes) {
        mesh.visible = !isHidden;
        mesh.userData.locked = isGhost;
        mesh.material = isGhost
          ? this.ghostMaterial
          : isSel
            ? this.highlightMaterial
            : this.baseMaterial.get(mesh)!;
      }
    }
    this.requestRender();
  }

  /** Fully clears the loaded model from the scene. */
  clear(): void {
    this.selection.clear();
    this.lastHidden.clear();
    this.lastGhost.clear();

    for (const child of this.modelGroup.children) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      // Dispose child outline lines (IfcSpace top-face edges).
      for (const c of m.children) (c as THREE.LineSegments).geometry?.dispose();
    }
    // Base materials are owned per mesh; the shared highlight / ghost materials
    // persist across loads and must not be disposed here.
    for (const mat of this.baseMaterial.values()) mat.dispose();
    this.baseMaterial.clear();
    this.modelGroup.clear();
    this.byExpressID.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownPos.set(event.clientX, event.clientY);
    // Pick now, before an orbit can rotate the camera: the click just commits
    // this hit, so a tiny drag between press and release never mis-selects or
    // misses (the old code ray-picked at click time, after the view had moved).
    this.pendingPick = this.pickAt(event.clientX, event.clientY, !event.altKey);
  };

  private handleClick = (event: MouseEvent): void => {
    // A click after a noticeable move = orbit/pan, not a selection.
    const moved = Math.hypot(
      event.clientX - this.pointerDownPos.x,
      event.clientY - this.pointerDownPos.y,
    );
    if (moved > DRAG_THRESHOLD) return;
    this.onSelect(this.pendingPick, event.shiftKey);
  };

  /**
   * Ray-picks the element under a screen position against the current camera.
   * Returns the composite element key, or null for empty space. Hidden and
   * ghosted (locked) meshes are skipped; when IfcSpace rooms are shown they are
   * preferred (they sit behind walls) unless `preferSpace` is false (Alt-click).
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

    const hits = this.raycaster.intersectObjects(this.modelGroup.children, false);
    const visible = hits.filter(
      (h) => h.object.visible && !h.object.userData.locked,
    );
    const space = preferSpace
      ? visible.find((h) => h.object.userData.space)
      : undefined;
    const hit = space ?? visible[0];
    return hit ? (hit.object.userData.key as number) : null;
  }

  /** Frames the camera on a specific set of elements (by scene key). Zooms in
   *  without touching scope/hidden, so it never resets an active isolation. */
  fitTo(keys: number[]): void {
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const key of keys) {
      for (const mesh of this.byExpressID.get(key) ?? []) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          box.union(meshBox.copy(mesh.geometry.boundingBox));
        }
      }
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
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

  /** Frames the camera on the currently visible meshes (respects scope). */
  private fitToVisible(): void {
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const child of this.modelGroup.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.visible) continue;
      // modelGroup and meshes carry no transform (coords baked into vertices),
      // so the geometry bounding box already is the world box.
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) box.union(meshBox.copy(mesh.geometry.boundingBox));
    }
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
