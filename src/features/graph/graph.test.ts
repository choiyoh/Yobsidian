import { describe, expect, it } from "vitest";
import type { GraphData } from "@/core/index";
import { buildGraph, groupColor, groupOf, nodeRadius, type GraphFilter } from "./model";
import { ForceSimulation } from "./simulation";

const data: GraphData = {
  nodes: [
    { path: "A.md", name: "A", tags: ["plan"] },
    { path: "B.md", name: "B", tags: ["plan/x"] },
    { path: "dir/C.md", name: "C", tags: [] },
    { path: "dir/D.md", name: "D", tags: ["idea"] },
    { path: "E.md", name: "E", tags: [] },
    { path: "Lonely.md", name: "Lonely", tags: [] },
  ],
  edges: [
    { source: "A.md", target: "B.md" },
    { source: "B.md", target: "dir/C.md" },
    { source: "dir/C.md", target: "dir/D.md" },
    { source: "dir/D.md", target: "E.md" },
  ],
};
const base: GraphFilter = { scope: "global", center: null, depth: 1, query: "", showOrphans: true };
const names = (f: Partial<GraphFilter>) => buildGraph(data, { ...base, ...f }).nodes.map((n) => n.name);

describe("buildGraph", () => {
  it("keeps everything in the global graph and counts links in both directions", () => {
    const g = buildGraph(data, base);
    expect(g.nodes).toHaveLength(6);
    expect(g.edges).toHaveLength(4);
    expect(g.nodes.find((n) => n.name === "B")!.degree).toBe(2);
    expect(g.nodes.find((n) => n.name === "Lonely")!.degree).toBe(0);
    expect(g.nodes.find((n) => n.name === "C")!.folder).toBe("dir");
  });

  it("limits a local graph by depth, following links both ways", () => {
    expect(names({ scope: "local", center: "B.md", depth: 1 }).sort()).toEqual(["A", "B", "C"]);
    expect(names({ scope: "local", center: "B.md", depth: 2 }).sort()).toEqual(["A", "B", "C", "D"]);
    expect(names({ scope: "local", center: "Lonely.md", depth: 3 })).toEqual(["Lonely"]);
    expect(names({ scope: "local", center: null })).toEqual([]);
  });

  it("filters by name, tag (with children) and path, dropping edges to hidden notes", () => {
    expect(names({ query: "lone" })).toEqual(["Lonely"]);
    expect(names({ query: "#plan" })).toEqual(["A", "B"]);
    expect(names({ query: "tag:idea" })).toEqual(["D"]);
    expect(names({ query: "path:dir/" })).toEqual(["C", "D"]);
    expect(names({ query: "#plan b" })).toEqual(["B"]);
    const g = buildGraph(data, { ...base, query: "path:dir/" });
    expect(g.edges).toEqual([[0, 1]]);
  });

  it("hides orphans on request but keeps the centre of a local graph", () => {
    expect(names({ showOrphans: false })).not.toContain("Lonely");
    expect(names({ scope: "local", center: "Lonely.md", showOrphans: false })).toEqual(["Lonely"]);
  });

  it("gives equal signatures to equal graphs", () => {
    expect(buildGraph(data, base).signature).toBe(buildGraph({ ...data }, base).signature);
    expect(buildGraph(data, base).signature).not.toBe(buildGraph(data, { ...base, query: "a" }).signature);
  });
});

describe("colours and sizes", () => {
  it("groups by first tag root or top-level folder", () => {
    const g = buildGraph(data, base);
    expect(groupOf(g.nodes[1], "tag")).toBe("plan");
    expect(groupOf(g.nodes[2], "folder")).toBe("dir");
    expect(groupOf(g.nodes[4], "folder")).toBeNull();
    expect(groupOf(g.nodes[0], "none")).toBeNull();
    expect(groupColor("plan")).toBe(groupColor("plan"));
  });

  it("grows nodes with their link count, up to a cap", () => {
    expect(nodeRadius(10)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(100000)).toBe(16);
  });
});

describe("ForceSimulation", () => {
  it("pulls linked nodes towards the link distance and pushes others apart", () => {
    const sim = new ForceSimulation([{ x: -200, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 1 }], [[0, 1]]);
    for (let i = 0; i < 300; i++) sim.tick();
    const d = Math.hypot(sim.x[0] - sim.x[1], sim.y[0] - sim.y[1]);
    expect(d).toBeLessThan(150);
    expect(d).toBeGreaterThan(20);
    expect(sim.settled).toBe(true);
  });

  it("keeps pinned nodes where they are", () => {
    const sim = new ForceSimulation([{ x: 0, y: 0 }, { x: 10, y: 0 }], [[0, 1]]);
    sim.fx[0] = 50;
    sim.fy[0] = 60;
    for (let i = 0; i < 20; i++) sim.tick();
    expect([sim.x[0], sim.y[0]]).toEqual([50, 60]);
  });

  it("copes with coincident nodes", () => {
    const sim = new ForceSimulation(Array.from({ length: 20 }, () => ({ x: 5, y: 5 })), []);
    for (let i = 0; i < 50; i++) sim.tick();
    for (let i = 0; i < sim.n; i++) expect(Number.isFinite(sim.x[i] + sim.y[i])).toBe(true);
    expect(new Set(Array.from(sim.x, (v) => v.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("stays fast on thousands of nodes", () => {
    const n = 4000;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pos = Array.from({ length: n }, () => ({ x: (rnd() - 0.5) * 800, y: (rnd() - 0.5) * 800 }));
    const links: [number, number][] = [];
    for (let i = 1; i < n; i++) links.push([i, Math.floor(rnd() * i)]);
    for (let i = 0; i < 2000; i++) links.push([Math.floor(rnd() * n), Math.floor(rnd() * n)].sort() as [number, number]);
    const sim = new ForceSimulation(pos, links.filter(([a, b]) => a !== b));
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) sim.tick();
    const perTick = (performance.now() - t0) / 30;
    for (let i = 0; i < n; i++) expect(Number.isFinite(sim.x[i] + sim.y[i])).toBe(true);
    // The budget is loose on purpose (CI runners vary); an O(n²) layout would take ~10x longer.
    expect(perTick).toBeLessThan(60);
    console.log(`4000 nodes, ${links.length} links: ${perTick.toFixed(1)} ms per tick`);
  });
});
