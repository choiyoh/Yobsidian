/** Ask the OS for a folder (desktop only). Resolves to its absolute path, or null if the user cancelled. */
export async function pickFolder(title = "볼트 폴더 선택"): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}
