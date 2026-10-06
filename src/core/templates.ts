import { formatDate } from "./dates";
import { CONFIG_DIR, isMarkdown, isWithin, joinPath, stem } from "./vault";
import type { VaultAdapter } from "./vault";

export interface TemplateConfig {
  folder: string;
  dateFormat: string;
  timeFormat: string;
}

export interface DailyConfig {
  folder: string;
  format: string;
  /** Template note path or name (with or without `.md`); empty for a blank daily note. */
  template: string;
}

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = { folder: "Templates", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };
export const DEFAULT_DAILY_CONFIG: DailyConfig = { folder: "", format: "YYYY-MM-DD", template: "" };

/** Values the user set in this app's settings; blank fields fall back to the vault's Obsidian config. */
export interface ConfigOverrides {
  templateFolder?: string;
  dailyFolder?: string;
  dailyFormat?: string;
  dailyTemplate?: string;
}

async function readJson(vault: VaultAdapter, name: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await vault.readText(`${CONFIG_DIR}/${name}`));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const clean = (folder: string) => folder.replace(/^\/+|\/+$/g, "");

/** `.obsidian/templates.json` (read only) under the app's own overrides. */
export async function readTemplateConfig(vault: VaultAdapter, overrides: ConfigOverrides = {}): Promise<TemplateConfig> {
  const o = await readJson(vault, "templates.json");
  return {
    folder: clean(str(overrides.templateFolder) ?? str(o.folder) ?? DEFAULT_TEMPLATE_CONFIG.folder),
    dateFormat: str(o.dateFormat) ?? DEFAULT_TEMPLATE_CONFIG.dateFormat,
    timeFormat: str(o.timeFormat) ?? DEFAULT_TEMPLATE_CONFIG.timeFormat,
  };
}

/** `.obsidian/daily-notes.json` (read only) under the app's own overrides. */
export async function readDailyConfig(vault: VaultAdapter, overrides: ConfigOverrides = {}): Promise<DailyConfig> {
  const o = await readJson(vault, "daily-notes.json");
  return {
    folder: clean(str(overrides.dailyFolder) ?? str(o.folder) ?? DEFAULT_DAILY_CONFIG.folder),
    format: str(overrides.dailyFormat) ?? str(o.format) ?? DEFAULT_DAILY_CONFIG.format,
    template: str(overrides.dailyTemplate) ?? str(o.template) ?? DEFAULT_DAILY_CONFIG.template,
  };
}

/**
 * Fill in a template the way Obsidian's core Templates plugin does:
 * `{{title}}`, `{{date}}`, `{{time}}`, and `{{date:FORMAT}}` / `{{time:FORMAT}}`.
 */
export function applyTemplate(template: string, ctx: { title: string; now: Date; dateFormat?: string; timeFormat?: string }): string {
  const dateFormat = ctx.dateFormat ?? DEFAULT_TEMPLATE_CONFIG.dateFormat;
  const timeFormat = ctx.timeFormat ?? DEFAULT_TEMPLATE_CONFIG.timeFormat;
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*?))?\s*\}\}/gi, (_, name: string, rawFormat?: string) => {
    const format = rawFormat?.trim() || undefined;
    switch (name.toLowerCase()) {
      case "title":
        return ctx.title;
      case "date":
        return formatDate(ctx.now, format ?? dateFormat);
      default:
        return formatDate(ctx.now, format ?? timeFormat);
    }
  });
}

/** Notes inside the template folder, sorted by name. */
export function listTemplates(notePaths: string[], folder: string): string[] {
  return notePaths.filter((p) => isMarkdown(p) && isWithin(p, folder) && p !== folder).sort((a, b) => stem(a).localeCompare(stem(b)));
}

/** Path of the daily note for `now`; the format may contain `/` for sub-folders. */
export function dailyNotePath(now: Date, config: DailyConfig): string {
  const name = formatDate(now, config.format).replace(/\.md$/i, "");
  return joinPath(config.folder, name) + ".md";
}
