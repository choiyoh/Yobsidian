import { describe, expect, it } from "vitest";
import { merge3 } from "./merge3";

const base = "# 제목\n\n첫째 줄\n둘째 줄\n셋째 줄\n\n끝\n";

describe("merge3", () => {
  it("combines edits to different parts of the note", () => {
    const local = base.replace("첫째 줄", "첫째 줄 (로컬)");
    const remote = base.replace("끝", "끝\n추가한 문단\n");
    expect(merge3(base, local, remote)).toBe("# 제목\n\n첫째 줄 (로컬)\n둘째 줄\n셋째 줄\n\n끝\n추가한 문단\n\n");
  });

  it("takes the other side when one side is unchanged", () => {
    expect(merge3(base, base, "x\n")).toBe("x\n");
    expect(merge3(base, "y\n", base)).toBe("y\n");
  });

  it("accepts identical edits on both sides", () => {
    const both = base.replace("둘째 줄", "둘째");
    expect(merge3(base, both, both)).toBe(both);
  });

  it("gives up when both sides changed the same line", () => {
    const local = base.replace("둘째 줄", "로컬이 고침");
    const remote = base.replace("둘째 줄", "원격이 고침");
    expect(merge3(base, local, remote)).toBeNull();
  });

  it("gives up on edits to adjacent lines, like git does", () => {
    const local = base.replace("첫째 줄", "A");
    const remote = base.replace("둘째 줄", "B");
    expect(merge3(base, local, remote)).toBeNull();
  });

  it("handles insertions at both ends and deletions", () => {
    const local = "머리말\n" + base;
    const remote = base.replace("셋째 줄\n", "");
    expect(merge3(base, local, remote)).toBe("머리말\n# 제목\n\n첫째 줄\n둘째 줄\n\n끝\n");
  });

  it("works from an empty base (both sides created the note)", () => {
    expect(merge3("", "a\n", "b\n")).toBeNull();
    expect(merge3("", "a\n", "")).toBe("a\n");
  });

  it("refuses very large texts instead of hanging", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join("");
    const local = big.replace("line 5\n", "x\n").replace("line 2900\n", "y\n");
    const remote = Array.from({ length: 3000 }, (_, i) => `row ${i}\n`).join("");
    expect(merge3(big, local, remote)).toBeNull();
  });
});
