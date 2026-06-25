// Thin wrappers over the Rust attachment commands (attachments.rs) and the native
// dialog plugin. Keeps Tauri specifics out of the React components and the pure model.

import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { isImagePath, basename, type Attachment } from "./attachments";
import { log } from "../../logger";

let seq = 0;
/** Process-unique id for an attachment/text-block (not security-sensitive). */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

interface LoadedWire {
  path: string;
  name: string;
  data_url: string | null;
}

/** Read a dropped file into an Attachment (image → with dataUrl preview, else file tile). */
export async function loadAttachment(path: string): Promise<Attachment> {
  const res = await invoke<LoadedWire>("load_attachment", { path });
  return {
    id: nextId("att"),
    kind: res.data_url ? "image" : "file",
    path: res.path,
    name: res.name,
    dataUrl: res.data_url ?? undefined,
  };
}

/** Copy an image attachment's bitmap to the system clipboard. */
export async function copyImageToClipboard(path: string): Promise<void> {
  await invoke("copy_image_to_clipboard", { path });
}

/** Download one attachment: native Save dialog → copy the file to the chosen path.
 *  Resolves false if the user cancels the dialog. */
export async function downloadAttachment(att: Attachment): Promise<boolean> {
  const dest = await save({ defaultPath: att.name });
  if (!dest) return false;
  await invoke("copy_file_to", { src: att.path, dest });
  log.info("composer", "downloaded attachment", { name: att.name });
  return true;
}

/** Bulk download: pick a destination folder → copy all selected files into it.
 *  Resolves false if the user cancels the folder picker. */
export async function downloadAttachments(atts: Attachment[]): Promise<boolean> {
  if (atts.length === 0) return false;
  const dir = await open({ directory: true, multiple: false, title: "Choose a download folder" });
  if (!dir || typeof dir !== "string") return false;
  await invoke("copy_files_to_dir", { srcs: atts.map((a) => a.path), destDir: dir });
  log.info("composer", "bulk-downloaded attachments", { count: atts.length, dir });
  return true;
}

/** Adapt a captured screenshot (path + dataUrl) into the unified Attachment shape. */
export function screenshotAttachment(path: string, dataUrl: string): Attachment {
  return {
    id: nextId("shot"),
    kind: "image",
    path,
    name: isImagePath(path) ? basename(path) : "screenshot.png",
    dataUrl,
  };
}
