import { describe, expect, it } from "vitest";
import { NoteIndex } from "../index/note-index";
import { MemoryAdapter } from "../vault/memory-adapter";
import { parseQuery } from "./query";

describe("parseQuery", () => {
  it("splits words, quoted phrases, operators and negation", () => {
    expect(parseQuery('alpha "two words" -skip path:"my dir" tag:#x/y file:Note content:hi').terms).toEqual([
      { field: "any", value: "alpha", negated: false },
      { field: "any", value: "two words", negated: false },
      { field: "any", value: "skip", negated: true },
      { field: "path", value: "my dir", negated: false },
      { field: "tag", value: "x/y", negated: false },
      { field: "file", value: "note", negated: false },
      { field: "content", value: "hi", negated: false },
    ]);
  });
  it("treats #word as a tag filter and ignores empty input", () => {
    expect(parseQuery("#todo").terms).toEqual([{ field: "tag", value: "todo", negated: false }]);
    expect(parseQuery("   ").terms).toEqual([]);
    expect(parseQuery('""').terms).toEqual([]);
  });
});

async function build(files: Record<string, string>) {
  const vault = new MemoryAdapter("t", files);
  const index = new NoteIndex();
  await index.load(vault);
  return index;
}

describe("NoteIndex.searchContent", () => {
  it("requires every term, case-insensitively, and returns highlighted lines", async () => {
    const index = await build({
      "a.md": "Hello World\nsecond line about apples\n",
      "b.md": "hello only\n",
      "c.md": "APPLES and hello again",
    });
    const r = index.searchContent("hello apples");
    expect(r.map((x) => x.path).sort()).toEqual(["a.md", "c.md"]);
    const a = r.find((x) => x.path === "a.md")!;
    expect(a.matches.map((m) => m.line)).toEqual([0, 1]);
    const m = a.matches[1];
    expect(m.ranges.map(([s, e]) => m.text.slice(s, e))).toEqual(["apples"]);
  });

  it("matches exact phrases only when words are adjacent", async () => {
    const index = await build({ "a.md": "the quick brown fox", "b.md": "brown quick" });
    expect(index.searchContent('"quick brown"').map((x) => x.path)).toEqual(["a.md"]);
  });

  it("filters by path:, file:, tag: and negation", async () => {
    const index = await build({
      "work/plan.md": "ship it #project/alpha",
      "work/notes.md": "ship later",
      "home/plan.md": "ship dinner #chores",
    });
    expect(index.searchContent("ship path:work").map((x) => x.path).sort()).toEqual(["work/notes.md", "work/plan.md"]);
    expect(index.searchContent("ship file:plan").map((x) => x.path).sort()).toEqual(["home/plan.md", "work/plan.md"]);
    expect(index.searchContent("tag:project").map((x) => x.path)).toEqual(["work/plan.md"]);
    expect(index.searchContent("ship -later").map((x) => x.path).sort()).toEqual(["home/plan.md", "work/plan.md"]);
    expect(index.searchContent("ship -tag:chores path:plan").map((x) => x.path)).toEqual(["work/plan.md"]);
  });

  it("finds notes by file name and ranks them above body-only hits", async () => {
    const index = await build({ "Recipes.md": "pasta", "other.md": "I love recipes a lot, recipes recipes" });
    expect(index.searchContent("recipes").map((x) => x.path)).toEqual(["Recipes.md", "other.md"]);
    expect(index.searchContent("recipes")[0].matches).toEqual([]);
  });

  it("works with Korean text and shortens long lines around the hit", async () => {
    const long = "가".repeat(300) + " 검색어 " + "나".repeat(300);
    const index = await build({ "한글.md": long, "x.md": "아무것도 없음" });
    const [r] = index.searchContent("검색어");
    expect(r.path).toBe("한글.md");
    const m = r.matches[0];
    expect(m.text.length).toBeLessThan(250);
    expect(m.text.slice(...m.ranges[0])).toBe("검색어");
  });

  it("stays fast on thousands of notes", async () => {
    const files: Record<string, string> = {};
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    for (let i = 0; i < 5000; i++) {
      const body = Array.from({ length: 150 }, (_, j) => words[(i * 7 + j * 3) % words.length] + j).join(" ");
      files[`dir${i % 20}/note ${i}.md`] = `# Note ${i}\n${body}\n#tag${i % 10}`;
    }
    const index = await build(files);
    const t0 = performance.now();
    for (let n = 0; n < 5; n++) index.searchContent('alpha3 "beta4 gamma5" -zeta9 path:dir1');
    const perQuery = (performance.now() - t0) / 5;
    expect(perQuery).toBeLessThan(150);
  }, 30000);
});
