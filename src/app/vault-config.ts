import { SAMPLE_FILES } from "@/core/vault/sample-vault";
import { FsAdapter, IdbAdapter, type VaultAdapter } from "@/core/vault";

/** Where the notes live on this device. */
export type LocalVault = { kind: "idb"; name: string } | { kind: "fs"; path: string };

/** The Google Drive folder a local vault is kept in sync with. */
export interface DriveLink {
  folderId: string;
  folderName: string;
}

interface Stored {
  local: LocalVault;
  /** Drive links by local vault id (`idb:<name>` / `fs:<path>`), so each vault remembers its own. */
  links: Record<string, DriveLink>;
  /** Recently opened folder vaults (desktop), newest first. */
  recent: string[];
}

const KEY = "yobsidian.vault";
const DEFAULT_LOCAL: LocalVault = { kind: "idb", name: "default" };

export function vaultIdOf(local: LocalVault): string {
  return local.kind === "fs" ? `fs:${local.path}` : `idb:${local.name}`;
}

export function loadVaultConfig(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    const local = raw?.local;
    const valid = local && ((local.kind === "idb" && typeof local.name === "string") || (local.kind === "fs" && typeof local.path === "string"));
    return { local: valid ? local : DEFAULT_LOCAL, links: raw?.links ?? {}, recent: raw?.recent ?? [] };
  } catch {
    return { local: DEFAULT_LOCAL, links: {}, recent: [] };
  }
}

export function saveVaultConfig(config: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // not persisted: the choice lasts until the page is closed
  }
}

export function openLocalVault(local: LocalVault): Promise<VaultAdapter> {
  return local.kind === "fs" ? FsAdapter.open(local.path) : IdbAdapter.open(local.name, local.name === "default" ? SAMPLE_FILES : {});
}

/** Switch the local vault (the page reloads to open it). A folder vault is remembered in the recent list. */
export function switchLocalVault(local: LocalVault) {
  const config = loadVaultConfig();
  const recent = local.kind === "fs" ? [local.path, ...config.recent.filter((p) => p !== local.path)].slice(0, 5) : config.recent;
  saveVaultConfig({ ...config, local, recent });
}

export function setDriveLink(vaultId: string, link: DriveLink | null) {
  const config = loadVaultConfig();
  const links = { ...config.links };
  if (link) links[vaultId] = link;
  else delete links[vaultId];
  saveVaultConfig({ ...config, links });
}
