import { unzipSync, strFromU8 } from "fflate";

/** One document inside a TRM container (a drawing PDF, an encrypted blob, ...). */
export interface TrmDoc {
  title: string;
  filename: string;
  /** Lower-case extension without the dot, e.g. "pdf", "enc". */
  ext: string;
  bytes: Uint8Array;
}

/** A parsed vitro TRM container (nested containers are flattened into one). */
export interface TrmContainer {
  project: string;
  documents: TrmDoc[];
}

const xml = new DOMParser();

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Reads TRM documents from an unzipped file map rooted at `dir` (the folder that
 * holds `info.xml`). Each `<Document Id="…">` maps to a blob named by that Id.
 */
function readManifest(
  files: Record<string, Uint8Array>,
  infoPath: string,
  out: TrmDoc[],
): string {
  const dir = infoPath.slice(0, infoPath.lastIndexOf("/") + 1);
  const doc = xml.parseFromString(strFromU8(files[infoPath]), "application/xml");
  const project =
    doc
      .querySelector('Project > Attributes > Attribute[Name="ProjectName"]')
      ?.getAttribute("Value") ?? "TRM";

  for (const d of doc.querySelectorAll("Document")) {
    const id = d.getAttribute("Id");
    if (!id) continue;
    const bytes = files[dir + id];
    if (!bytes) continue;
    const filename =
      d.getAttribute("FileName")?.split("/").pop() ??
      d.querySelector('Attribute[Name="Title"]')?.getAttribute("Value") ??
      id;
    const title =
      d.querySelector('Attribute[Name="Title"]')?.getAttribute("Value") ??
      filename;
    out.push({ title, filename, ext: extOf(filename), bytes });
  }
  return project;
}

/**
 * Parses a vitro TRM (`_trm.zip`) or a wrapper zip containing several TRMs.
 * Recurses one level into nested `.zip` entries so an example container that
 * bundles multiple `_trm.zip` is flattened into a single document list.
 */
export function parseTrm(data: Uint8Array): TrmContainer {
  const documents: TrmDoc[] = [];
  let project = "TRM";

  const walk = (bytes: Uint8Array): void => {
    const files = unzipSync(bytes);
    for (const path of Object.keys(files)) {
      if (path.endsWith("info.xml")) {
        const p = readManifest(files, path, documents);
        if (project === "TRM") project = p;
      } else if (path.toLowerCase().endsWith(".zip")) {
        try {
          walk(files[path]);
        } catch {
          /* not a readable nested zip — skip */
        }
      }
    }
  };

  walk(data);
  return { project, documents };
}
