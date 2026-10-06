import type { GraphData } from "@/core/index";

export interface GraphNode {
  id: number;
  path: string;
  name: string;
  tags: string[];
  /** Number of links in or out, counted over the whole vault so node sizes stay stable while filtering. */
  degree: number;
  /** Top-level folder, or "" for notes at the vault root. */
  folder: string;
}

export interface GraphModel {
  nodes: GraphNode[];
  /** Pairs of indexes into `nodes`. */
  edges: [number, number][];
  /** Neighbours (either direction) per node index. */
  adjacency: number[][];
  /** Identical for models with the same nodes and edges. */
  signature: string;
}

export interface GraphFilter {
  scope: "global" | "local";
  /** The note a local graph is centred on. */
  center: string | null;
  depth: number;
  /** Space-separated terms, all must match: `word` (name or path), `#tag` or `tag:x`, `path:x`. */
  query: string;
  showOrphans: boolean;
}

export type ColorMode = "none" | "tag" | "folder";

/** Notes within `depth` links of `center`, following links in both directions. */
function neighbourhood(adjacency: number[][], start: number, depth: number): Set<number> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: number[] = [];
    for (const n of frontier)
      for (const m of adjacency[n]) {
        if (seen.has(m)) continue;
        seen.add(m);
        next.push(m);
      }
    frontier = next;
  }
  return seen;
}

function matcher(query: string): ((n: GraphNode) => boolean) | null {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const tests = terms.map((term): ((n: GraphNode) => boolean) => {
    const tag = term.startsWith("#") ? term.slice(1) : term.startsWith("tag:") ? term.slice(4) : null;
    if (tag !== null) return (n) => n.tags.some((t) => { const l = t.toLowerCase(); return l === tag || l.startsWith(tag + "/"); });
    if (term.startsWith("path:")) {
      const p = term.slice(5);
      return (n) => n.path.toLowerCase().includes(p);
    }
    return (n) => n.name.toLowerCase().includes(term) || n.path.toLowerCase().includes(term);
  });
  return (n) => tests.every((t) => t(n));
}

export function buildGraph(data: GraphData, filter: GraphFilter): GraphModel {
  const all = new Map<string, number>();
  data.nodes.forEach((n, i) => all.set(n.path, i));
  const degree = new Array<number>(data.nodes.length).fill(0);
  const adj: number[][] = data.nodes.map(() => []);
  const edges: [number, number][] = [];
  for (const e of data.edges) {
    const s = all.get(e.source);
    const t = all.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    edges.push([s, t]);
    degree[s]++;
    degree[t]++;
    adj[s].push(t);
    adj[t].push(s);
  }

  let keep: Set<number> | null = null;
  const centerIdx = filter.center ? all.get(filter.center) : undefined;
  if (filter.scope === "local") keep = centerIdx === undefined ? new Set() : neighbourhood(adj, centerIdx, Math.max(1, filter.depth));

  const match = matcher(filter.query);
  const picked: number[] = [];
  for (let i = 0; i < data.nodes.length; i++) {
    if (keep && !keep.has(i)) continue;
    const isCenter = filter.scope === "local" && i === centerIdx;
    if (!isCenter) {
      if (!filter.showOrphans && degree[i] === 0) continue;
      if (match && !match(toNode(data.nodes[i], i, degree[i]))) continue;
    }
    picked.push(i);
  }

  const remap = new Map<number, number>();
  const nodes = picked.map((old, id) => {
    remap.set(old, id);
    return toNode(data.nodes[old], id, degree[old]);
  });
  const outEdges: [number, number][] = [];
  const adjacency: number[][] = nodes.map(() => []);
  for (const [s, t] of edges) {
    const a = remap.get(s);
    const b = remap.get(t);
    if (a === undefined || b === undefined) continue;
    outEdges.push([a, b]);
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  const signature = nodes.map((n) => n.path).join("\n") + "\n--\n" + outEdges.map(([a, b]) => `${a},${b}`).join(";") + "\n--\n" + nodes.map((n) => `${n.degree}${n.tags.join(",")}`).join("|");
  return { nodes, edges: outEdges, adjacency, signature };
}

function toNode(n: GraphData["nodes"][number], id: number, degree: number): GraphNode {
  const slash = n.path.indexOf("/");
  return { id, path: n.path, name: n.name, tags: n.tags, degree, folder: slash < 0 ? "" : n.path.slice(0, slash) };
}

/** The group a node belongs to for colouring; `null` means the default colour. */
export function groupOf(node: GraphNode, mode: ColorMode): string | null {
  if (mode === "tag") return node.tags.length ? node.tags[0].split("/")[0] : null;
  if (mode === "folder") return node.folder || null;
  return null;
}

/** A stable colour per group name, readable on light and dark backgrounds. */
export function groupColor(group: string): string {
  let h = 2166136261;
  for (let i = 0; i < group.length; i++) h = Math.imul(h ^ group.charCodeAt(i), 16777619);
  h ^= h >>> 16; // mix the bits so names that differ in one character still get distant hues
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return `hsl(${(h >>> 0) % 360} 62% 58%)`;
}

export function nodeRadius(degree: number): number {
  return Math.min(16, 3.5 + Math.sqrt(degree) * 1.9);
}
