import { detectPlatform } from "@/core/platform";
import { joinPath, supportsFolderPicker, pickWebFolder, type VaultAdapter } from "@/core/vault";
import { pickFolder } from "./pick-folder";
import type { LocalVault } from "./vault-config";

/**
 * Open a folder from this computer as the vault.
 * Desktop uses the native dialog, Chromium browsers the File System Access API.
 * Returns null when cancelled, or `"unsupported"` for browsers that can only import files.
 */
export async function chooseLocalFolder(): Promise<LocalVault | null | "unsupported"> {
  if (detectPlatform() === "desktop") {
    const path = await pickFolder();
    return path ? { kind: "fs", path } : null;
  }
  if (!supportsFolderPicker()) return "unsupported";
  const key = await pickWebFolder();
  return key ? { kind: "fs", path: key } : null;
}

/** Show a file chooser (the fallback where folders can't be opened in place, and for single files). */
export function chooseFiles(opts: { folder?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts.folder) input.setAttribute("webkitdirectory", "");
    else input.accept = ".md,.markdown,.txt,image/*,application/pdf";
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Copy chosen files into the vault, keeping the folder structure of a chosen folder under `into`. Returns the vault paths written. */
export async function importFiles(vault: VaultAdapter, files: File[], into = ""): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const first = joinPath(into, rel);
    const dot = first.lastIndexOf(".");
    const hasExt = dot > first.lastIndexOf("/");
    const base = hasExt ? first.slice(0, dot) : first;
    const ext = hasExt ? first.slice(dot) : "";
    let path = first;
    for (let n = 2; await vault.stat(path); n++) path = `${base} ${n}${ext}`;
    await vault.writeBinary(path, new Uint8Array(await file.arrayBuffer()));
    written.push(path);
  }
  return written;
}
