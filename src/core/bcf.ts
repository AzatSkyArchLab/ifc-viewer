import { unzipSync, strFromU8 } from "fflate";

/**
 * Parser for buildingSMART BCF archives (`.bcfzip` / `.bcf`, BCF 2.1, lenient
 * towards 3.0). A BCF is a zip with one folder per topic (named by its GUID)
 * holding `markup.bcf` (topic + comments + viewpoint refs), the referenced
 * `*.bcfv` viewpoints and `*.png` snapshots.
 *
 * Each viewpoint carries the full spatial anchor of the issue: the selected
 * components (IfcGuids), the camera pose (position / direction / up) and any
 * clipping planes. All of it is extracted so the host can restore the exact
 * view the author saw — camera, section cuts and highlighted elements. Raw IFC
 * world coordinates are kept as-is here; the host maps them into scene space.
 */

export interface BcfComment {
  author: string;
  date: string;
  text: string;
}

/** Camera of a viewpoint, in IFC world coordinates (metres, Z-up). */
export interface BcfCamera {
  perspective: boolean; // false → orthographic
  position: [number, number, number];
  direction: [number, number, number]; // view direction (unit)
  up: [number, number, number]; // up vector (unit)
  fov: number | null; // perspective: field of view, degrees
  viewToWorldScale: number | null; // orthographic: view-to-world scale
}

/** A clipping plane, in IFC world coordinates. Geometry on the +direction side
 *  of the plane is hidden (buildingSMART convention). */
export interface BcfClipPlane {
  location: [number, number, number];
  direction: [number, number, number]; // plane normal (unit)
}

export interface BcfViewpoint {
  guid: string;
  snapshot: string | null; // data: URL of the PNG, if present
  components: string[]; // IfcGuids selected by this viewpoint
  camera: BcfCamera | null;
  clippingPlanes: BcfClipPlane[];
}

export interface BcfTopic {
  guid: string;
  title: string;
  status: string;
  type: string;
  priority: string;
  author: string;
  date: string;
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
}

export interface BcfArchive {
  version: string;
  topics: BcfTopic[];
}

const XML = new DOMParser();

/** Text content of the first descendant `tag`, trimmed; "" if absent. */
function tagText(root: Element | Document, tag: string): string {
  return root.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
}

/** First descendant element named `tag`, or undefined. */
function child(root: Element | Document, tag: string): Element | undefined {
  return root.getElementsByTagName(tag)[0];
}

/** Reads an `<X>/<Y>/<Z>` triple off an element; null if any is not finite. */
function readXYZ(el: Element | undefined): [number, number, number] | null {
  if (!el) return null;
  const n = (t: string) => Number(el.getElementsByTagName(t)[0]?.textContent);
  const p: [number, number, number] = [n("X"), n("Y"), n("Z")];
  return p.every(Number.isFinite) ? p : null;
}

/** Encodes bytes as a `data:` URL without blowing the call stack on big PNGs. */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** IfcGuids a viewpoint selects (scoped to `<Selection>` when present). */
function parseComponents(doc: Document): string[] {
  const selection = doc.getElementsByTagName("Selection")[0];
  const scope = selection ?? doc; // some exports omit <Selection>
  return Array.from(scope.getElementsByTagName("Component"))
    .map((c) => c.getAttribute("IfcGuid"))
    .filter((g): g is string => !!g);
}

/** Camera pose of a viewpoint (perspective or orthographic), or null. */
function parseCamera(doc: Document): BcfCamera | null {
  const persp = child(doc, "PerspectiveCamera");
  const cam = persp ?? child(doc, "OrthogonalCamera");
  if (!cam) return null;
  const position = readXYZ(child(cam, "CameraViewPoint"));
  const direction = readXYZ(child(cam, "CameraDirection"));
  const up = readXYZ(child(cam, "CameraUpVector"));
  if (!position || !direction || !up) return null;
  const fov = Number(tagText(cam, "FieldOfView"));
  const vws = Number(tagText(cam, "ViewToWorldScale"));
  return {
    perspective: !!persp,
    position,
    direction,
    up,
    fov: Number.isFinite(fov) && fov > 0 ? fov : null,
    viewToWorldScale: Number.isFinite(vws) && vws > 0 ? vws : null,
  };
}

/** Clipping planes of a viewpoint (location + normal), IFC world coordinates. */
function parseClippingPlanes(doc: Document): BcfClipPlane[] {
  const out: BcfClipPlane[] = [];
  for (const cp of Array.from(doc.getElementsByTagName("ClippingPlane"))) {
    const location = readXYZ(child(cp, "Location"));
    const direction = readXYZ(child(cp, "Direction"));
    if (location && direction) out.push({ location, direction });
  }
  return out;
}

/** Parses a viewpoint `.bcfv` into its components, camera and clipping planes. */
function parseViewpointFile(
  bytes: Uint8Array,
): Pick<BcfViewpoint, "components" | "camera" | "clippingPlanes"> {
  const doc = XML.parseFromString(strFromU8(bytes), "application/xml");
  return {
    components: parseComponents(doc),
    camera: parseCamera(doc),
    clippingPlanes: parseClippingPlanes(doc),
  };
}

/** Reads one topic's `markup.bcf` (and its referenced files) into a BcfTopic. */
function parseMarkup(
  markupBytes: Uint8Array,
  dir: string,
  files: Record<string, Uint8Array>,
): BcfTopic | null {
  const doc = XML.parseFromString(strFromU8(markupBytes), "application/xml");
  const topicEl = doc.getElementsByTagName("Topic")[0];
  if (!topicEl) return null;

  const topic: BcfTopic = {
    guid: topicEl.getAttribute("Guid") ?? dir.replace(/\/$/, ""),
    title: tagText(topicEl, "Title") || "(без названия)",
    status: topicEl.getAttribute("TopicStatus") || tagText(topicEl, "TopicStatus"),
    type: topicEl.getAttribute("TopicType") || tagText(topicEl, "TopicType"),
    priority: tagText(topicEl, "Priority"),
    author: tagText(topicEl, "CreationAuthor"),
    date: tagText(topicEl, "CreationDate"),
    comments: [],
    viewpoints: [],
  };

  // Outer <Comment> elements carry an Author/Date or Guid; the inner <Comment>
  // holds only text — filter to the outer ones so both nestings (2.1 / 3.0) work.
  for (const c of Array.from(doc.getElementsByTagName("Comment"))) {
    const isOuter =
      c.getElementsByTagName("Author").length > 0 ||
      c.getElementsByTagName("Date").length > 0 ||
      c.hasAttribute("Guid");
    if (!isOuter) continue;
    topic.comments.push({
      author: tagText(c, "Author"),
      date: tagText(c, "Date"),
      text: c.getElementsByTagName("Comment")[0]?.textContent?.trim() ?? "",
    });
  }

  for (const vp of Array.from(doc.getElementsByTagName("Viewpoints"))) {
    const vpName = tagText(vp, "Viewpoint");
    const snapName = tagText(vp, "Snapshot");
    const snapBytes = snapName ? files[dir + snapName] : undefined;
    const vpBytes = vpName ? files[dir + vpName] : undefined;
    const parsed = vpBytes
      ? parseViewpointFile(vpBytes)
      : { components: [], camera: null, clippingPlanes: [] };
    topic.viewpoints.push({
      guid: vp.getAttribute("Guid") ?? "",
      snapshot: snapBytes ? toDataUrl(snapBytes, "image/png") : null,
      ...parsed,
    });
  }

  return topic;
}

/** Parses a BCF archive into its topics. Throws on a non-zip / empty archive. */
export function parseBcf(data: Uint8Array): BcfArchive {
  const files = unzipSync(data);

  let version = "";
  const versionFile = files["bcf.version"];
  if (versionFile) {
    const doc = XML.parseFromString(strFromU8(versionFile), "application/xml");
    version = doc.documentElement?.getAttribute("VersionId") ?? "";
  }

  const topics: BcfTopic[] = [];
  for (const path of Object.keys(files)) {
    if (!/(^|\/)markup\.bcf$/i.test(path)) continue;
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const topic = parseMarkup(files[path], dir, files);
    if (topic) topics.push(topic);
  }

  if (topics.length === 0) {
    throw new Error("В архиве нет тем BCF (markup.bcf не найден)");
  }
  return { version, topics };
}
