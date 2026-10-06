/** Force-directed layout with Barnes-Hut repulsion: O(n log n) per tick, so thousands of nodes stay smooth. */

export interface SimOptions {
  /** Repulsion between every pair of nodes (higher pushes harder). */
  charge: number;
  linkDistance: number;
  /** Pull towards the origin, keeps separate islands from drifting off. */
  gravity: number;
  /** Fraction of velocity lost per tick. */
  friction: number;
  alphaDecay: number;
  alphaMin: number;
  /** Barnes-Hut accuracy: bigger is faster and rougher. */
  theta: number;
}

export const DEFAULT_SIM: SimOptions = { charge: 90, linkDistance: 38, gravity: 0.035, friction: 0.42, alphaDecay: 0.0228, alphaMin: 0.002, theta: 0.9 };

export class ForceSimulation {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Pinned position while a node is being dragged (NaN = free). */
  readonly fx: Float64Array;
  readonly fy: Float64Array;
  alpha = 1;
  private readonly deg: Int32Array;
  private readonly bias: Float64Array;
  private readonly strength: Float64Array;
  private readonly tree = new QuadTree();

  constructor(
    positions: { x: number; y: number }[],
    readonly links: [number, number][],
    public opts: SimOptions = positions.length > 1500 ? { ...DEFAULT_SIM, theta: 1.3 } : DEFAULT_SIM,
  ) {
    const n = (this.n = positions.length);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.fx = new Float64Array(n).fill(NaN);
    this.fy = new Float64Array(n).fill(NaN);
    positions.forEach((p, i) => {
      this.x[i] = p.x;
      this.y[i] = p.y;
    });
    this.deg = new Int32Array(n);
    for (const [s, t] of links) (this.deg[s]++, this.deg[t]++);
    this.bias = new Float64Array(links.length);
    this.strength = new Float64Array(links.length);
    links.forEach(([s, t], i) => {
      this.bias[i] = this.deg[s] / (this.deg[s] + this.deg[t]);
      this.strength[i] = 1 / Math.min(this.deg[s], this.deg[t]);
    });
  }

  get settled(): boolean {
    return this.alpha < this.opts.alphaMin;
  }

  reheat(alpha = 0.3) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick() {
    const { n, x, y, vx, vy, fx, fy, opts } = this;
    this.alpha += (0 - this.alpha) * opts.alphaDecay;
    const alpha = this.alpha;

    // Springs along links, lighter node moves more.
    for (let i = 0; i < this.links.length; i++) {
      const [s, t] = this.links[i];
      let dx = x[t] + vx[t] - x[s] - vx[s];
      let dy = y[t] + vy[t] - y[s] - vy[s];
      let d = Math.hypot(dx, dy);
      if (d === 0) {
        dx = jiggle(i);
        dy = jiggle(i + 7);
        d = Math.hypot(dx, dy);
      }
      const k = ((d - opts.linkDistance) / d) * alpha * this.strength[i];
      dx *= k;
      dy *= k;
      const b = this.bias[i];
      vx[t] -= dx * b;
      vy[t] -= dy * b;
      vx[s] += dx * (1 - b);
      vy[s] += dy * (1 - b);
    }

    // Repulsion and gravity.
    this.tree.build(x, y, n);
    for (let i = 0; i < n; i++) {
      this.tree.repel(i, x[i], y[i], opts.theta, opts.charge * alpha, vx, vy);
      vx[i] -= x[i] * opts.gravity * alpha;
      vy[i] -= y[i] * opts.gravity * alpha;
    }

    const keep = 1 - opts.friction;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(fx[i])) {
        x[i] = fx[i];
        y[i] = fy[i];
        vx[i] = vy[i] = 0;
      } else {
        vx[i] *= keep;
        vy[i] *= keep;
        x[i] += vx[i];
        y[i] += vy[i];
      }
    }
  }
}

/** Small deterministic offset for nodes sitting on exactly the same spot. */
function jiggle(seed: number): number {
  return (Math.sin(seed * 12.9898) * 43758.5453 % 1) * 1e-3 || 1e-3;
}

const MAX_DEPTH = 48;

class QuadTree {
  // Cells live in parallel arrays and are reused between ticks to avoid garbage.
  private cx: number[] = []; // centre of mass
  private cy: number[] = [];
  private mass: number[] = [];
  private x0: number[] = []; // cell origin and side
  private y0: number[] = [];
  private size: number[] = [];
  private child: Int32Array = new Int32Array(4 * 1024);
  /** Body stored in a leaf, -1 when empty or internal. Bodies that collide share a leaf via `next`. */
  private body: number[] = [];
  private next: Int32Array = new Int32Array(0);
  private count = 0;
  private px!: Float64Array;
  private py!: Float64Array;
  private stack: number[] = [];

  private alloc(x0: number, y0: number, size: number): number {
    const id = this.count++;
    if (id * 4 + 4 > this.child.length) {
      const bigger = new Int32Array(this.child.length * 2);
      bigger.set(this.child);
      this.child = bigger;
    }
    this.child.fill(-1, id * 4, id * 4 + 4);
    this.x0[id] = x0;
    this.y0[id] = y0;
    this.size[id] = size;
    this.mass[id] = 0;
    this.cx[id] = 0;
    this.cy[id] = 0;
    this.body[id] = -1;
    return id;
  }

  build(x: Float64Array, y: Float64Array, n: number) {
    this.px = x;
    this.py = y;
    this.count = 0;
    if (this.next.length < n) this.next = new Int32Array(n);
    this.next.fill(-1, 0, n);
    if (!n) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.001;
    this.alloc(minX, minY, size);
    for (let i = 0; i < n; i++) this.insert(i);
  }

  private insert(i: number) {
    const x = this.px[i];
    const y = this.py[i];
    let cell = 0;
    for (let depth = 0; ; depth++) {
      // Update the running centre of mass on the way down.
      const m = this.mass[cell];
      this.cx[cell] = (this.cx[cell] * m + x) / (m + 1);
      this.cy[cell] = (this.cy[cell] * m + y) / (m + 1);
      this.mass[cell] = m + 1;

      const isLeaf = this.child[cell * 4] < 0 && this.child[cell * 4 + 1] < 0 && this.child[cell * 4 + 2] < 0 && this.child[cell * 4 + 3] < 0;
      if (isLeaf && this.body[cell] < 0) {
        this.body[cell] = i;
        return;
      }
      if (isLeaf) {
        const other = this.body[cell];
        // Coincident points (or too deep): chain them in the same leaf instead of splitting forever.
        if (depth >= MAX_DEPTH || (this.px[other] === x && this.py[other] === y)) {
          this.next[i] = this.next[other];
          this.next[other] = i;
          return;
        }
        // Push the resident body one level down, then continue inserting `i` from this cell.
        this.body[cell] = -1;
        const q = this.quadrant(cell, this.px[other], this.py[other]);
        const c = this.childCell(cell, q);
        this.body[c] = other;
        this.mass[c] = 1;
        this.cx[c] = this.px[other];
        this.cy[c] = this.py[other];
        // A chain of coincident bodies moves together.
        let chain = this.next[other];
        while (chain >= 0) {
          this.mass[c]++;
          chain = this.next[chain];
        }
      }
      cell = this.childCell(cell, this.quadrant(cell, x, y));
    }
  }

  private quadrant(cell: number, x: number, y: number): number {
    const half = this.size[cell] / 2;
    return (x >= this.x0[cell] + half ? 1 : 0) + (y >= this.y0[cell] + half ? 2 : 0);
  }

  private childCell(cell: number, q: number): number {
    let c = this.child[cell * 4 + q];
    if (c < 0) {
      const half = this.size[cell] / 2;
      c = this.alloc(this.x0[cell] + (q & 1 ? half : 0), this.y0[cell] + (q & 2 ? half : 0), half);
      this.child[cell * 4 + q] = c;
    }
    return c;
  }

  /** Adds the repulsion on body `i` (at x,y) from every other body to its velocity. */
  repel(i: number, x: number, y: number, theta: number, charge: number, vx: Float64Array, vy: Float64Array) {
    if (!this.count) return;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    const theta2 = theta * theta;
    while (stack.length) {
      const cell = stack.pop()!;
      const m = this.mass[cell];
      if (!m) continue;
      let dx = this.cx[cell] - x;
      let dy = this.cy[cell] - y;
      let d2 = dx * dx + dy * dy;
      const c = cell * 4;
      const isLeaf = this.child[c] < 0 && this.child[c + 1] < 0 && this.child[c + 2] < 0 && this.child[c + 3] < 0;
      const s = this.size[cell];
      if (isLeaf || (s * s) / d2 < theta2) {
        if (isLeaf && this.body[cell] >= 0) {
          // Treat each body of the leaf (usually one) individually, skipping `i` itself.
          let b = this.body[cell];
          while (b >= 0) {
            if (b !== i) {
              dx = this.px[b] - x;
              dy = this.py[b] - y;
              d2 = dx * dx + dy * dy;
              if (d2 === 0) {
                dx = jiggle(i + b);
                dy = jiggle(i * 3 + b);
                d2 = dx * dx + dy * dy;
              }
              if (d2 < 1) d2 = Math.sqrt(d2);
              const k = charge / d2;
              vx[i] -= dx * k;
              vy[i] -= dy * k;
            }
            b = this.next[b];
          }
        } else if (!isLeaf) {
          if (d2 < 1) d2 = Math.sqrt(d2) || 1;
          const k = (charge * m) / d2;
          vx[i] -= dx * k;
          vy[i] -= dy * k;
        }
        continue;
      }
      for (let q = 0; q < 4; q++) if (this.child[c + q] >= 0) stack.push(this.child[c + q]);
    }
  }
}
