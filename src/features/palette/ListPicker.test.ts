import { describe, expect, it } from "vitest";
import { filterItems, fuzzyScore } from "./ListPicker";

describe("fuzzy filtering", () => {
  const items = [
    { id: "a", label: "그래프 보기 전환" },
    { id: "b", label: "새 노트" },
    { id: "c", label: "오늘의 일일 노트 열기" },
    { id: "d", label: "Toggle graph view" },
  ];
  it("keeps everything for an empty query in the original order", () => {
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("ranks prefix, then substring, then scattered matches, and drops non-matches", () => {
    expect(filterItems(items, "노트").map((i) => i.id)).toEqual(["b", "c"]);
    expect(filterItems(items, "tgv").map((i) => i.id)).toEqual(["d"]);
    expect(fuzzyScore("abc", "zzz")).toBe(0);
  });
});
