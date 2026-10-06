import { describe, expect, it } from "vitest";
import { formatDate } from "./dates";
import { applyTemplate, dailyNotePath, listTemplates, readDailyConfig, readTemplateConfig } from "./templates";
import { MemoryAdapter } from "./vault/memory-adapter";

const now = new Date(2026, 9, 6, 15, 4, 9); // Tue 2026-10-06 15:04:09

describe("formatDate", () => {
  it("handles Moment-style tokens and escapes", () => {
    expect(formatDate(now, "YYYY-MM-DD")).toBe("2026-10-06");
    expect(formatDate(now, "YY/M/D HH:mm:ss")).toBe("26/10/6 15:04:09");
    expect(formatDate(now, "YYYY년 M월 D일 dddd")).toBe("2026년 10월 6일 화요일");
    expect(formatDate(now, "[Week] ddd h:mm A")).toBe("Week 화 3:04 오후");
  });
});

describe("applyTemplate", () => {
  it("replaces title, date and time placeholders", () => {
    const out = applyTemplate("# {{title}}\n{{date}} {{time}}\n{{date:YYYY/MM}} {{ time : HH }} {{unknown}}", { title: "메모", now });
    expect(out).toBe("# 메모\n2026-10-06 15:04\n2026/10 15 {{unknown}}");
  });
  it("uses the configured default formats", () => {
    expect(applyTemplate("{{date}} {{time}}", { title: "t", now, dateFormat: "MM.DD", timeFormat: "h:mm" })).toBe("10.06 3:04");
  });
});

describe("daily note config", () => {
  it("falls back to defaults, then Obsidian's files, then app overrides", async () => {
    const empty = new MemoryAdapter("v", {});
    expect(await readDailyConfig(empty)).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
    expect((await readTemplateConfig(empty)).folder).toBe("Templates");

    const vault = new MemoryAdapter("v", {
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal/", format: "YYYY/MM/DD", template: "Templates/Daily" }),
      ".obsidian/templates.json": JSON.stringify({ folder: "Tpl", dateFormat: "YYYY.MM.DD" }),
    });
    expect(await readDailyConfig(vault)).toEqual({ folder: "Journal", format: "YYYY/MM/DD", template: "Templates/Daily" });
    expect(await readTemplateConfig(vault)).toMatchObject({ folder: "Tpl", dateFormat: "YYYY.MM.DD", timeFormat: "HH:mm" });
    expect((await readDailyConfig(vault, { dailyFolder: "Diary" })).folder).toBe("Diary");
  });
  it("builds the daily note path", () => {
    expect(dailyNotePath(now, { folder: "Journal", format: "YYYY/MM/DD", template: "" })).toBe("Journal/2026/10/06.md");
    expect(dailyNotePath(now, { folder: "", format: "YYYY-MM-DD", template: "" })).toBe("2026-10-06.md");
  });
});

describe("listTemplates", () => {
  it("lists notes in the folder only", () => {
    expect(listTemplates(["Templates/B.md", "Templates/A.md", "Other/C.md", "Templates/img.png", "Templates2/D.md"], "Templates")).toEqual([
      "Templates/A.md",
      "Templates/B.md",
    ]);
  });
});
