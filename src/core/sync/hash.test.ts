import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { md5Hex } from "./hash";

describe("md5Hex", () => {
  it("matches known vectors", () => {
    const enc = new TextEncoder();
    expect(md5Hex(new Uint8Array())).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(enc.encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("agrees with node's md5 for many lengths, including block boundaries", () => {
    for (const len of [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = new Uint8Array(len).map((_, i) => (i * 31 + len) & 255);
      expect(md5Hex(data), `length ${len}`).toBe(createHash("md5").update(data).digest("hex"));
    }
    const korean = new TextEncoder().encode("안녕하세요 [[노트]]\n".repeat(50));
    expect(md5Hex(korean)).toBe(createHash("md5").update(korean).digest("hex"));
  });
});
