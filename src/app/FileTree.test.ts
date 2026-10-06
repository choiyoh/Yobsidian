import { describe, expect, it } from "vitest";
import { canMoveInto } from "./FileTree";

describe("canMoveInto", () => {
  it("allows moving into another folder or the root", () => {
    expect(canMoveInto("a.md", "dir")).toBe(true);
    expect(canMoveInto("dir/a.md", "")).toBe(true);
    expect(canMoveInto("dir", "other")).toBe(true);
  });
  it("blocks no-op moves and moves into itself or its own subfolders", () => {
    expect(canMoveInto("a.md", "")).toBe(false);
    expect(canMoveInto("dir/a.md", "dir")).toBe(false);
    expect(canMoveInto("dir", "dir")).toBe(false);
    expect(canMoveInto("dir", "dir/sub")).toBe(false);
  });
  it("is not fooled by a shared name prefix", () => {
    expect(canMoveInto("dir", "dir2")).toBe(true);
  });
});
