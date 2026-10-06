/** App preferences. Stored per device in localStorage; the vault's `.obsidian` folder is only ever read. */
export interface Settings {
  theme: "system" | "light" | "dark";
  /** Editor font size in px. */
  fontSize: number;
  /** Where pasted/dropped files go; blank follows the vault's Obsidian setting. */
  attachmentFolder: string;
  templateFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  fontSize: 16,
  attachmentFolder: "",
  templateFolder: "",
  dailyFolder: "",
  dailyFormat: "",
  dailyTemplate: "",
};

const KEY = "yobsidian.settings";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS };
    if (raw.theme === "light" || raw.theme === "dark" || raw.theme === "system") s.theme = raw.theme;
    if (typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 32) s.fontSize = raw.fontSize;
    for (const k of ["attachmentFolder", "templateFolder", "dailyFolder", "dailyFormat", "dailyTemplate"] as const) {
      if (typeof raw[k] === "string") s[k] = raw[k];
    }
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable: the setting lasts until the page closes
  }
}

/** Push theme and font size onto the page. */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  window.dispatchEvent(new Event("yobsidian:theme"));
}
