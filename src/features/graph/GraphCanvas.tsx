import { useEffect, useRef } from "react";
import { ForceSimulation } from "./simulation";
import { DEFAULT_STYLE, groupColor, groupOf, nodeRadius, type ColorMode, type GraphModel, type GraphStyle } from "./model";

interface Props {
  model: GraphModel;
  /** The open note; drawn with a ring. */
  activePath: string | null;
  colorMode: ColorMode;
  /** Changing this re-fits the view to the graph (new scope, centre note or filter). */
  fitKey: string;
  /** Keeps node positions between rebuilds of the same vault so the layout does not jump. */
  positions: React.MutableRefObject<Map<string, { x: number; y: number }>>;
  /** Draw every label regardless of zoom (the small local graph). */
  alwaysLabels?: boolean;
  style?: GraphStyle;
  onOpen(path: string, keepGraph: boolean): void;
}

interface Theme {
  text: string;
  muted: string;
  accent: string;
  bg: string;
  edge: string;
  dark: boolean;
}

interface View {
  k: number;
  x: number;
  y: number;
}

const FIT_TICKS = 90;

function readTheme(el: HTMLElement): Theme {
  const css = getComputedStyle(el);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const muted = get("--text-muted", "#888");
  const bg = get("--bg", "#fff");
  // Dark when the page background is dark, whichever way the theme was chosen.
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  const dark = m ? parseInt(m[1].slice(0, 2), 16) * 0.3 + parseInt(m[1].slice(2, 4), 16) * 0.59 + parseInt(m[1].slice(4, 6), 16) * 0.11 < 128 : false;
  return { text: get("--text", "#222"), muted, accent: get("--accent", "#7c5cdb"), bg, edge: get("--text", "#222"), dark };
}

/** Canvas graph with zoom, pan, node dragging, hover highlighting and click to open. */
export function GraphCanvas({ model, activePath, colorMode, fitKey, positions, alwaysLabels, style = DEFAULT_STYLE, onOpen }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Everything the draw loop needs lives in one mutable bag so frames never wait for React.
  const live = useRef({
    model,
    sim: null as ForceSimulation | null,
    view: { k: 1, x: 0, y: 0 } as View,
    hover: -1,
    /** Node whose neighbourhood is (or was just) highlighted, and how strongly (0-1), eased per frame. */
    focus: -1,
    fade: 0,
    style,
    active: -1,
    colorMode,
    alwaysLabels: !!alwaysLabels,
    width: 0,
    height: 0,
    dpr: 1,
    theme: null as Theme | null,
    raf: 0,
    ticks: 0,
    autoFit: true,
    onOpen,
    schedule: () => {},
    fit: () => {},
  });
  live.current.onOpen = onOpen;
  live.current.colorMode = colorMode;
  live.current.alwaysLabels = !!alwaysLabels;
live.current.style = style;

  // ---------------------------------------------------------- one-time setup
  useEffect(() => {
    const L = live.current;
    const cv = canvas.current!;
    const box = wrap.current!;
    const ctx = cv.getContext("2d")!;
    L.theme = readTheme(box);

    const schedule = () => {
      if (!L.raf) L.raf = requestAnimationFrame(frame);
    };
    L.schedule = schedule;

    const resize = () => {
      const r = box.getBoundingClientRect();
      L.width = Math.max(1, r.width);
      L.height = Math.max(1, r.height);
      L.dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(L.width * L.dpr);
      cv.height = Math.round(L.height * L.dpr);
      if (L.autoFit) fit();
      schedule();
    };

    const fit = () => {
      const sim = L.sim;
      if (!sim || !sim.n) return;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i < sim.n; i++) {
        x0 = Math.min(x0, sim.x[i]);
        x1 = Math.max(x1, sim.x[i]);
        y0 = Math.min(y0, sim.y[i]);
        y1 = Math.max(y1, sim.y[i]);
      }
      const pad = 40;
      const k = Math.min(2, Math.max(0.05, Math.min((L.width - pad * 2) / Math.max(x1 - x0, 1), (L.height - pad * 2) / Math.max(y1 - y0, 1))));
      L.view = { k, x: L.width / 2 - ((x0 + x1) / 2) * k, y: L.height / 2 - ((y0 + y1) / 2) * k };
    };
    L.fit = fit;

    const ro = new ResizeObserver(resize);
    ro.observe(box);
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => ((L.theme = readTheme(box)), schedule());
    dark.addEventListener("change", onScheme);
    window.addEventListener("yobsidian:theme", onScheme);

    // -------------------------------------------------------------- drawing
    function frame() {
      L.raf = 0;
      const sim = L.sim;
      if (sim && !sim.settled) {
        const t0 = performance.now();
        let n = 0;
        do {
          sim.tick();
          L.ticks++;
          n++;
        } while (n < 4 && performance.now() - t0 < 5 && !sim.settled);
        if (L.autoFit && L.ticks <= FIT_TICKS) fit();
      }
      const target = L.hover >= 0 ? 1 : 0;
      if (L.hover >= 0) L.focus = L.hover;
      if (L.fade !== target) {
        L.fade += (target - L.fade) * 0.3;
        if (Math.abs(target - L.fade) < 0.02) L.fade = target;
        if (L.fade === 0) L.focus = -1;
      }
      draw();
      if ((sim && !sim.settled) || L.fade !== target) schedule();
    }

    function draw() {
      const sim = L.sim;
      const theme = L.theme!;
      const { width, height, dpr, view, model: m } = L;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!sim || !sim.n) return;
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

      const st = L.style;
      const hover = L.focus;
      const fade = L.fade;
      const focus = hover >= 0 && hover < sim.n && fade > 0 ? new Set([hover, ...m.adjacency[hover]]) : null;
      const dim = 1 - fade * 0.88; // alpha of everything outside the hovered neighbourhood
      const radius = (i: number) => nodeRadius(m.nodes[i].degree) * st.nodeSize;
      const mode = L.colorMode;
      const colors = new Map<string, string>();
      // Ungrouped nodes get a soft neutral, like Obsidian's grey dots.
      const neutral = theme.dark ? "#9a9aa6" : "#8b8b96";
      const colorOf = (i: number) => {
        const g = groupOf(m.nodes[i], mode);
        if (g === null) return neutral;
        let c = colors.get(g);
        if (!c) colors.set(g, (c = groupColor(g)));
        return c;
      };

      // Edges: thin and faint in one path, the hovered node's links on top in the accent colour.
      const base = (m.edges.length > 4000 ? 0.1 : 0.2) * (theme.dark ? 1 : 1.1);
      ctx.lineCap = "round";
      ctx.lineWidth = (st.linkWidth * 0.9) / view.k;
      ctx.strokeStyle = theme.edge;
      ctx.globalAlpha = base * (1 - fade * 0.7);
      ctx.beginPath();
      for (const [s, t] of m.edges) {
        if (focus && (s === hover || t === hover)) continue;
        ctx.moveTo(sim.x[s], sim.y[s]);
        ctx.lineTo(sim.x[t], sim.y[t]);
      }
      ctx.stroke();
      if (focus) {
        ctx.globalAlpha = 0.85 * fade;
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = (st.linkWidth * 1.3) / view.k;
        ctx.beginPath();
        for (const [s, t] of m.edges) {
          if (s !== hover && t !== hover) continue;
          ctx.moveTo(sim.x[s], sim.y[s]);
          ctx.lineTo(sim.x[t], sim.y[t]);
        }
        ctx.stroke();
      }
      if (st.arrows && m.edges.length <= 3000) {
        ctx.fillStyle = theme.edge;
        ctx.globalAlpha = Math.min(0.5, base * 2) * (1 - fade * 0.6);
        const head = 5 / Math.sqrt(view.k) + 2;
        ctx.beginPath();
        for (const [s, t] of m.edges) {
          const dx = sim.x[t] - sim.x[s];
          const dy = sim.y[t] - sim.y[s];
          const d = Math.hypot(dx, dy);
          if (d < radius(t) + head) continue;
          const ux = dx / d;
          const uy = dy / d;
          const tipX = sim.x[t] - ux * (radius(t) + 1);
          const tipY = sim.y[t] - uy * (radius(t) + 1);
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * head + uy * head * 0.45, tipY - uy * head - ux * head * 0.45);
          ctx.lineTo(tipX - ux * head - uy * head * 0.45, tipY - uy * head + ux * head * 0.45);
          ctx.closePath();
        }
        ctx.fill();
      }

      // Nodes, skipping those off screen.
      const vx0 = -view.x / view.k,
        vy0 = -view.y / view.k,
        vx1 = (width - view.x) / view.k,
        vy1 = (height - view.y) / view.k;
      const visible: number[] = [];
      for (let i = 0; i < sim.n; i++) {
        const r = radius(i);
        if (sim.x[i] + r < vx0 || sim.x[i] - r > vx1 || sim.y[i] + r < vy0 || sim.y[i] - r > vy1) continue;
        visible.push(i);
        ctx.globalAlpha = focus && !focus.has(i) ? dim : 1;
        ctx.fillStyle = i === L.active || i === hover ? theme.accent : colorOf(i);
        ctx.beginPath();
        ctx.arc(sim.x[i], sim.y[i], r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (L.active >= 0 && L.active < sim.n) {
        // The open note glows softly instead of wearing a hard ring.
        const i = L.active;
        const r = radius(i);
        const glow = r + 9;
        const g = ctx.createRadialGradient(sim.x[i], sim.y[i], r * 0.6, sim.x[i], sim.y[i], glow);
        g.addColorStop(0, theme.accent + "99");
        g.addColorStop(1, theme.accent + "00");
        ctx.globalAlpha = focus && !focus.has(i) ? dim : 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sim.x[i], sim.y[i], glow, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.accent;
        ctx.beginPath();
        ctx.arc(sim.x[i], sim.y[i], r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Labels fade in with zoom; bigger nodes appear first. A thin background-coloured outline keeps them readable over links.
      const fontPx = 12;
      ctx.font = `${fontPx / view.k}px ${getComputedStyle(cv).fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 / view.k;
      for (const i of visible) {
        const r = radius(i);
        let a = L.alwaysLabels ? 1 : Math.min(1, Math.max(0, (view.k * (0.6 + r * 0.1) - st.labelZoom) / 0.6));
        if (i === hover || i === L.active) a = 1;
        if (focus) a = focus.has(i) ? Math.max(a, 0.5 + 0.4 * fade) : a * dim;
        if (a < 0.05) continue;
        ctx.globalAlpha = a * 0.85;
        ctx.strokeStyle = theme.bg;
        ctx.strokeText(m.nodes[i].name, sim.x[i], sim.y[i] + r + 3 / view.k);
        ctx.globalAlpha = a;
        ctx.fillStyle = i === hover || i === L.active ? theme.text : theme.muted;
        ctx.fillText(m.nodes[i].name, sim.x[i], sim.y[i] + r + 3 / view.k);
      }
      ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------- interaction
    const toWorld = (sx: number, sy: number) => ({ x: (sx - L.view.x) / L.view.k, y: (sy - L.view.y) / L.view.k });
    const local = (e: { clientX: number; clientY: number }) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pick = (sx: number, sy: number): number => {
      const sim = L.sim;
      if (!sim) return -1;
      const w = toWorld(sx, sy);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < sim.n; i++) {
        const dx = sim.x[i] - w.x;
        const dy = sim.y[i] - w.y;
        const d = dx * dx + dy * dy;
        const r = nodeRadius(L.model.nodes[i].degree) * L.style.nodeSize + 3 / L.view.k;
        if (d <= r * r && d < bestD) (best = i, (bestD = d));
      }
      return best;
    };

    const zoomAt = (sx: number, sy: number, factor: number) => {
      const k = Math.min(8, Math.max(0.03, L.view.k * factor));
      const f = k / L.view.k;
      L.view = { k, x: sx - (sx - L.view.x) * f, y: sy - (sy - L.view.y) * f };
      L.autoFit = false;
      schedule();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(p.x, p.y, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });

    type Drag = { kind: "pan" | "node"; id: number; startX: number; startY: number; moved: boolean; viewX: number; viewY: number };
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: Drag | null = null;
    let pinch: { dist: number } | null = null;

    const onDown = (e: PointerEvent) => {
      const p = local(e);
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        if (drag?.kind === "node") releaseNode(drag.id);
        drag = null;
        return;
      }
      const id = pick(p.x, p.y);
      drag = { kind: id >= 0 ? "node" : "pan", id, startX: p.x, startY: p.y, moved: false, viewX: L.view.x, viewY: L.view.y };
    };
    const releaseNode = (id: number) => {
      const sim = L.sim;
      if (!sim || id < 0) return;
      sim.fx[id] = NaN;
      sim.fy[id] = NaN;
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinch.dist);
        pinch.dist = dist;
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) {
          drag.moved = true;
          if (drag.kind === "node") L.sim?.reheat(0.3);
        }
        if (drag.moved) {
          L.autoFit = false;
          if (drag.kind === "pan") L.view = { ...L.view, x: drag.viewX + p.x - drag.startX, y: drag.viewY + p.y - drag.startY };
          else if (L.sim) {
            const w = toWorld(p.x, p.y);
            L.sim.fx[drag.id] = w.x;
            L.sim.fy[drag.id] = w.y;
          }
          schedule();
        }
        return;
      }
      const h = pick(p.x, p.y);
      if (h !== L.hover) {
        L.hover = h;
        cv.style.cursor = h >= 0 ? "pointer" : "grab";
        schedule();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === "node") {
        releaseNode(d.id);
        if (!d.moved && L.model.nodes[d.id]) L.onOpen(L.model.nodes[d.id].path, e.ctrlKey || e.metaKey);
      }
      schedule();
    };
    const onLeave = () => {
      if (drag || L.hover < 0) return;
      L.hover = -1;
      schedule();
    };
    cv.style.cursor = "grab";
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave", onLeave);

    resize();
    return () => {
      cancelAnimationFrame(L.raf);
      L.raf = 0;
      // Remember where everything is for the next graph that shows the same notes.
      const sim = L.sim;
      if (sim) L.model.nodes.forEach((n, i) => positions.current.set(n.path, { x: sim.x[i], y: sim.y[i] }));
      ro.disconnect();
      dark.removeEventListener("change", onScheme);
      window.removeEventListener("yobsidian:theme", onScheme);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onUp);
      cv.removeEventListener("pointerleave", onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------ rebuild when the graph changes
  useEffect(() => {
    const L = live.current;
    const prev = L.sim;
    if (prev) L.model.nodes.forEach((n, i) => positions.current.set(n.path, { x: prev.x[i], y: prev.y[i] }));
    L.model = model;
    L.hover = -1;
    L.sim = new ForceSimulation(initialPositions(model, positions.current), model.edges);
    L.sim.opts = simOpts(L.sim, L.style);
    // A graph that only changed slightly (a note was edited) settles gently instead of exploding.
    const reused = model.nodes.filter((n) => positions.current.has(n.path)).length;
    L.sim.alpha = reused > model.nodes.length * 0.8 ? 0.25 : 1;
    L.ticks = 0;
    L.schedule();
  }, [model, positions]);

  useEffect(() => {
    const L = live.current;
    L.autoFit = true;
    L.ticks = 0;
    L.sim?.reheat(0.6);
    L.fit();
    L.schedule();
  }, [fitKey]);

  useEffect(() => {
    const L = live.current;
    L.active = activePath ? model.nodes.findIndex((n) => n.path === activePath) : -1;
    L.schedule();
  }, [activePath, model]);

  useEffect(() => {
    live.current.schedule();
  }, [colorMode, alwaysLabels]);

  // Physics knobs: apply to the running layout and let it ease into the new shape.
  const { linkDistance, repel, center } = style;
  useEffect(() => {
    const L = live.current;
    if (!L.sim) return;
    const next = simOpts(L.sim, L.style);
    const changed = next.linkDistance !== L.sim.opts.linkDistance || next.charge !== L.sim.opts.charge || next.gravity !== L.sim.opts.gravity;
    L.sim.opts = next;
    if (changed) L.sim.reheat(0.4);
    L.schedule();
  }, [linkDistance, repel, center]);

  useEffect(() => {
    live.current.schedule();
  }, [style]);

  return (
    <div ref={wrap} className="graph-canvas-wrap">
      <canvas ref={canvas} className="graph-canvas" />
    </div>
  );
}

/** Reuse saved positions; place new nodes next to a placed neighbour, otherwise on a spiral. */
function initialPositions(model: GraphModel, saved: Map<string, { x: number; y: number }>): { x: number; y: number }[] {
  const out: ({ x: number; y: number } | null)[] = model.nodes.map((n) => {
    const p = saved.get(n.path);
    return p ? { x: p.x, y: p.y } : null;
  });
  const golden = Math.PI * (3 - Math.sqrt(5));
  let spiral = 0;
  return out.map((p, i) => {
    if (p) return p;
    const placed = model.adjacency[i].map((j) => out[j]).filter((q): q is { x: number; y: number } => !!q);
    if (placed.length) {
      const a = placed.reduce((s, q) => ({ x: s.x + q.x / placed.length, y: s.y + q.y / placed.length }), { x: 0, y: 0 });
      const angle = i * golden;
      return { x: a.x + Math.cos(angle) * 20, y: a.y + Math.sin(angle) * 20 };
    }
    spiral++;
    const r = 12 * Math.sqrt(spiral);
    return { x: Math.cos(spiral * golden) * r, y: Math.sin(spiral * golden) * r };
  });
}

function simOpts(sim: ForceSimulation, style: GraphStyle) {
  return { ...sim.opts, linkDistance: style.linkDistance, charge: style.repel, gravity: style.center };
}
