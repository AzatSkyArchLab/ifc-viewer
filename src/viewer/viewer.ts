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
const DRAG_THRESHOLD = 5;

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

  /** expressID → element meshes (an element may have several geometries). */
  private byExpressID = new Map<number, THREE.Mesh[]>();
  /** Current selection. */
  private selection = new Set<number>();
  /** Active storey scope (null = whole model); elements outside it are hidden. */
  private scope: Set<number> | null = null;
  /** Manually hidden elements within the current scope (for "show all"). */
  private hidden = new Set<number>();
  /** Hidden by layer toggle (per IFC type) — persists across show-all. */
  private typeHidden = new Set<number>();
  /** Meshes whose material was swapped for the highlight + their originals. */
  private highlighted: { mesh: THREE.Mesh; material: THREE.Material }[] = [];
  /** A single shared highlight material for all selected meshes. */
  private highlightMaterial: THREE.MeshLambertMaterial;
  /** Shared line material for IfcSpace top-face outlines. */
  private spaceEdgeMaterial = new THREE.LineBasicMaterial({ color: SPACE_EDGE_COLOR });

  /** On-demand rendering: only draw a frame when the scene actually changed. */
  private needsRender = true;
  /** Pixel ratio at rest (crisp) vs. while the camera moves (fast); see animate. */
  private readonly highRatio: number;
  private readonly lowRatio = 1;
  private ratioIsLow = false;

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

    this.animate();
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
    this.applyHighlight();
  }

  getSelection(): number[] {
    return [...this.selection];
  }

  // ── Visibility ───────────────────────────────────────────────────────────────

  /**
   * Restrict the scene to a set of elements (e.g. one storey); null = whole
   * model. Clears manual hides and re-fits the camera to what is now visible.
   */
  setScope(ids: number[] | null): void {
    this.scope = ids ? new Set(ids) : null;
    this.hidden.clear();
    this.applyVisibility();
    this.fitToVisible();
  }

  /** True when the element is within the current scope. */
  private inScope(id: number): boolean {
    return this.scope === null || this.scope.has(id);
  }

  /** Show only the selection (within the scope), hide the rest. */
  isolateSelected(): void {
    if (this.selection.size === 0) return;
    this.hidden.clear();
    for (const id of this.byExpressID.keys()) {
      if (this.inScope(id) && !this.selection.has(id)) this.hidden.add(id);
    }
    this.applyVisibility();
  }

  /** Hide the selection. */
  hideSelected(): void {
    if (this.selection.size === 0) return;
    for (const id of this.selection) this.hidden.add(id);
    this.applyVisibility();
  }

  /** Restore visibility of every element within the current scope. Layer
   * (per-type) hiding persists — it is managed separately via setTypeHidden. */
  showAll(): void {
    this.hidden.clear();
    this.applyVisibility();
  }

  /** Force a set of elements visible — clears manual and layer hides for just
   *  those keys, so highlighting a flagged element (e.g. a layer-hidden IfcSpace)
   *  actually reveals it in 3D. Other elements of the same type stay hidden. */
  reveal(keys: number[]): void {
    for (const k of keys) {
      this.hidden.delete(k);
      this.typeHidden.delete(k);
    }
    this.applyVisibility();
  }

  /** Hides or shows a set of elements by IFC type (layer toggle). */
  setTypeHidden(keys: number[], hidden: boolean): void {
    for (const k of keys) {
      if (hidden) this.typeHidden.add(k);
      else this.typeHidden.delete(k);
    }
    this.applyVisibility();
  }

  /** Applies scope + manual hides + layer hides to every mesh. */
  private applyVisibility(): void {
    for (const [id, meshes] of this.byExpressID) {
      const visible =
        this.inScope(id) && !this.hidden.has(id) && !this.typeHidden.has(id);
      for (const m of meshes) m.visible = visible;
    }
    this.requestRender();
  }

  getHiddenIds(): number[] {
    return [...this.hidden];
  }

  hasHidden(): boolean {
    return this.hidden.size > 0;
  }

  /** Fully clears the loaded model from the scene. */
  clear(): void {
    // Restore original materials first, so dispose does not touch the shared
    // highlight material and does not miss the originals of selected meshes.
    for (const { mesh, material } of this.highlighted) mesh.material = material;
    this.highlighted = [];
    this.selection.clear();
    this.hidden.clear();
    this.typeHidden.clear();
    this.scope = null;

    for (const child of this.modelGroup.children) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
      // Dispose child outline lines (IfcSpace top-face edges).
      for (const c of m.children) (c as THREE.LineSegments).geometry?.dispose();
    }
    this.modelGroup.clear();
    this.byExpressID.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownPos.set(event.clientX, event.clientY);
  };

  private handleClick = (event: MouseEvent): void => {
    // A click after a noticeable move = orbit/pan, not a selection.
    const moved = Math.hypot(
      event.clientX - this.pointerDownPos.x,
      event.clientY - this.pointerDownPos.y,
    );
    if (moved > DRAG_THRESHOLD) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(this.modelGroup.children, false);
    const visible = hits.filter((h) => h.object.visible); // do not pick hidden
    // When the IfcSpace layer is on, rooms sit behind slabs/walls; prefer the
    // nearest visible space so each room stays clickable. Alt+click picks the
    // solid element under the cursor instead.
    const space = event.altKey
      ? undefined
      : visible.find((h) => h.object.userData.space);
    const hit = space ?? visible[0];
    const id = hit ? (hit.object.userData.key as number) : null;
    this.onSelect(id, event.shiftKey);
  };

  private applyHighlight(): void {
    for (const { mesh, material } of this.highlighted) mesh.material = material;
    this.highlighted = [];
    for (const id of this.selection) {
      const meshes = this.byExpressID.get(id);
      if (!meshes) continue;
      for (const mesh of meshes) {
        this.highlighted.push({ mesh, material: mesh.material as THREE.Material });
        mesh.material = this.highlightMaterial;
      }
    }
    this.requestRender();
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
