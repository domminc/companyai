/** Grid A* over the office floor. Pure (no three.js). */
import type { Obstacle, OfficeLayout, Vec2 } from "./layout";

export const CELL = 0.25;
/** Half a body width: keeps walkers from brushing furniture. */
const CLEARANCE = 0.22;

export class WalkGrid {
  readonly cols: number;
  readonly rows: number;
  private blocked: Uint8Array;
  private x0: number;
  private z0: number;

  constructor(readonly layout: OfficeLayout) {
    this.x0 = -layout.width / 2;
    this.z0 = -layout.depth / 2;
    this.cols = Math.ceil(layout.width / CELL);
    this.rows = Math.ceil(layout.depth / CELL);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const p = this.center(c, r);
        const nearWall =
          p.x < this.x0 + CLEARANCE || p.x > -this.x0 - CLEARANCE || p.z < this.z0 + CLEARANCE || p.z > -this.z0 - CLEARANCE;
        if (nearWall || layout.obstacles.some((o) => inside(o, p, CLEARANCE))) this.blocked[r * this.cols + c] = 1;
      }
    }
  }

  center(c: number, r: number): Vec2 {
    return { x: this.x0 + (c + 0.5) * CELL, z: this.z0 + (r + 0.5) * CELL };
  }

  cellOf(p: Vec2): [number, number] {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor((p.x - this.x0) / CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor((p.z - this.z0) / CELL)));
    return [c, r];
  }

  isBlocked(c: number, r: number): boolean {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return true;
    return this.blocked[r * this.cols + c] === 1;
  }

  walkable(p: Vec2): boolean {
    const [c, r] = this.cellOf(p);
    return !this.isBlocked(c, r);
  }

  /** Nearest walkable cell to `p` (seats hug furniture, so their own cell may be blocked). */
  private nearestFree(p: Vec2): [number, number] | null {
    const [c0, r0] = this.cellOf(p);
    for (let radius = 0; radius < 12; radius++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (this.isBlocked(c, r)) continue;
          const q = this.center(c, r);
          const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [c, r];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Straight segment clear of obstacles? Sampled every 5cm. */
  lineClear(a: Vec2, b: Vec2): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / 0.05));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.walkable({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
    }
    return true;
  }

  /**
   * Waypoints from `from` to `to` (both included), smoothed by line of sight.
   * Seats next to furniture are reached by walking to the nearest free cell, then stepping in.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] {
    const start = this.nearestFree(from);
    const goal = this.nearestFree(to);
    if (!start || !goal) return [from, to];
    const cells = this.astar(start, goal);
    if (!cells) return [from, to];
    const points = [from, ...cells.map(([c, r]) => this.center(c, r)), to];
    return smooth(points, (a, b) => this.lineClear(a, b));
  }

  private astar(start: [number, number], goal: [number, number]): [number, number][] | null {
    const idx = (c: number, r: number) => r * this.cols + c;
    const g = new Float32Array(this.cols * this.rows).fill(Infinity);
    const came = new Int32Array(this.cols * this.rows).fill(-1);
    const closed = new Uint8Array(this.cols * this.rows);
    const h = (c: number, r: number) => {
      const dx = Math.abs(c - goal[0]);
      const dz = Math.abs(r - goal[1]);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    const open = new MinHeap();
    g[idx(...start)] = 0;
    open.push(idx(...start), h(...start));

    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const c = cur % this.cols;
      const r = Math.floor(cur / this.cols);
      if (c === goal[0] && r === goal[1]) {
        const out: [number, number][] = [];
        for (let i = cur; i !== -1; i = came[i]) out.push([i % this.cols, Math.floor(i / this.cols)]);
        return out.reverse();
      }
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (this.isBlocked(nc, nr)) continue;
          // No cutting corners past furniture.
          if (dc && dr && (this.isBlocked(c + dc, r) || this.isBlocked(c, r + dr))) continue;
          const ni = idx(nc, nr);
          const cost = g[cur] + (dc && dr ? Math.SQRT2 : 1);
          if (cost < g[ni]) {
            g[ni] = cost;
            came[ni] = cur;
            open.push(ni, cost + h(nc, nr));
          }
        }
      }
    }
    return null;
  }
}

function inside(o: Obstacle, p: Vec2, pad: number): boolean {
  if (o.kind === "rect") return Math.abs(p.x - o.x) <= o.w / 2 + pad && Math.abs(p.z - o.z) <= o.d / 2 + pad;
  const dx = (p.x - o.x) / (o.rx + pad);
  const dz = (p.z - o.z) / (o.rz + pad);
  return dx * dx + dz * dz <= 1;
}

/** Drop waypoints that can be skipped with a clear straight line. First and last are kept. */
export function smooth(points: Vec2[], clear: (a: Vec2, b: Vec2) => boolean): Vec2[] {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = anchor + 1;
    for (let j = points.length - 1; j > anchor + 1; j--) {
      if (clear(points[anchor], points[j])) {
        next = j;
        break;
      }
    }
    out.push(points[next]);
    anchor = next;
  }
  return out;
}

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, p: number) {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
