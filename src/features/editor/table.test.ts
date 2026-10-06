import { describe, expect, it } from "vitest";
import { NoteIndex } from "@/core/index";
import { MemoryAdapter } from "@/core/vault";
import { parseAlign, parseInline, parseTable, splitRow } from "./table";

async function env() {
  const index = new NoteIndex();
  await index.load(new MemoryAdapter("t", { "Cur.md": "", "Other.md": "" }));
  return { index, path: "Cur.md" };
}

describe("table parsing", () => {
  it("splits rows with optional outer pipes", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    expect(splitRow("| a | |")).toEqual(["a", ""]);
  });
  it("honours escaped pipes and keeps wikilinks whole", () => {
    expect(splitRow("| a\\|b | c |")).toEqual(["a|b", "c"]);
    expect(splitRow("| [[N\\|x]] | [[N|y]] |")).toEqual(["[[N|x]]", "[[N|y]]"]);
  });
  it("reads alignment colons", () => {
    expect(parseAlign(splitRow("|:--|:-:|--:|---|"))).toEqual(["left", "center", "right", null]);
    expect(parseAlign(["a"])).toBeNull();
  });
  it("pads short rows and truncates long ones", async () => {
    const m = parseTable(["| a | b |", "|-|-|", "| 1 |", "| 1 | 2 | 3 |"], await env())!;
    expect(m.rows.map((r) => r.length)).toEqual([2, 2]);
  });
  it("parses inline formatting, wikilinks and tags", async () => {
    const e = await env();
    const nodes = parseInline("**b** `c` ~~s~~ [[Other|o]] [[Nope]] #tag [l](u)", e);
    const kinds = nodes.filter((n) => n.t !== "text").map((n) => n.t);
    expect(kinds).toEqual(["fmt", "code", "fmt", "wiki", "wiki", "tag", "link"]);
    const wikis = nodes.filter((n) => n.t === "wiki") as { label: string; unresolved: boolean }[];
    expect(wikis.map((w) => [w.label, w.unresolved])).toEqual([["o", false], ["Nope", true]]);
  });
});
