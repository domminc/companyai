import type { ReactNode } from "react";

/**
 * A small isometric street of office buildings with a sun, clouds and a few walkers, as inline SVG.
 * Faces are drawn flat and skewed onto the isometric axes, windows included, so a building is
 * a handful of numbers. Original artwork for this app.
 */

const C = Math.cos(Math.PI / 6); // 0.866
const S = 0.5;

interface Box {
  /** Top corner of the roof's rhombus. */
  x: number;
  y: number;
  /** Along the lower-right axis, the lower-left axis, and up. */
  w: number;
  d: number;
  h: number;
  /** Window grid pitch along each face. */
  win?: number;
}

const COLORS = {
  top: "#e3e9df",
  roofEdge: "#2f5d4a",
  left: "#f0e9cf",
  right: "#cfdccb",
  glassLeft: "#9fbdb4",
  glassRight: "#86a89f",
};

function windows(w: number, h: number, pitch: number, fill: string): ReactNode[] {
  const cols = Math.max(1, Math.floor((w - 4) / pitch));
  const rows = Math.max(1, Math.floor((h - 6) / pitch));
  const gx = (w - cols * pitch) / 2 + pitch * 0.18;
  const gy = 5;
  const out: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(<rect key={`${r}-${c}`} x={gx + c * pitch} y={gy + r * pitch} width={pitch * 0.62} height={pitch * 0.58} fill={fill} rx={0.8} />);
    }
  }
  return out;
}

function Building({ x, y, w, d, h, win = 9 }: Box) {
  // Roof rhombus: P0 top, P1 right, P2 bottom, P3 left.
  const p1 = { x: x + w * C, y: y + w * S };
  const p3 = { x: x - d * C, y: y + d * S };
  const p2 = { x: p1.x - d * C, y: p1.y + d * S };
  const rim = 2.4;
  return (
    <g>
      {/* ground shadow */}
      <polygon
        points={`${p3.x},${p3.y + h} ${p2.x},${p2.y + h} ${p1.x},${p1.y + h} ${p1.x + 14},${p1.y + h + 7} ${p2.x + 14},${p2.y + h + 7} ${p3.x + 14},${p3.y + h + 7}`}
        fill="#22342b"
        opacity="0.08"
      />
      <g transform={`matrix(${C} ${S} 0 1 ${p3.x} ${p3.y})`}>
        <rect width={w} height={h} fill={COLORS.left} />
        {windows(w, h, win, COLORS.glassLeft)}
      </g>
      <g transform={`matrix(${C} ${-S} 0 1 ${p2.x} ${p2.y})`}>
        <rect width={d} height={h} fill={COLORS.right} />
        {windows(d, h, win, COLORS.glassRight)}
      </g>
      <polygon points={`${x},${y} ${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`} fill={COLORS.roofEdge} />
      <polygon
        points={`${x},${y + rim} ${p1.x - rim * 1.2},${p1.y} ${p2.x},${p2.y - rim} ${p3.x + rim * 1.2},${p3.y}`}
        fill={COLORS.top}
      />
    </g>
  );
}

function Tree({ x, y, r = 11 }: { x: number; y: number; r?: number }) {
  return (
    <g>
      <ellipse cx={x} cy={y + 2} rx={r * 0.8} ry={r * 0.32} fill="#22342b" opacity="0.1" />
      <rect x={x - 1.2} y={y - r * 0.9} width={2.4} height={r * 0.9} fill="#8a6f4a" />
      <circle cx={x} cy={y - r * 1.4} r={r} fill="#7fae7c" />
      <circle cx={x - r * 0.35} cy={y - r * 1.75} r={r * 0.62} fill="#97c293" />
    </g>
  );
}

function Walker({ x, y, shirt }: { x: number; y: number; shirt: string }) {
  return (
    <g>
      <ellipse cx={x} cy={y + 1} rx={4} ry={1.6} fill="#22342b" opacity="0.18" />
      <rect x={x - 2.4} y={y - 9} width={4.8} height={9} rx={2} fill={shirt} />
      <circle cx={x} cy={y - 12.2} r={3.1} fill="#e8c9a6" />
      <rect x={x - 3.1} y={y - 15.4} width={6.2} height={2.6} rx={1.3} fill="#3a3a38" />
    </g>
  );
}

function Cloud({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill="#fffdf4" opacity="0.92">
      <ellipse cx="0" cy="6" rx="34" ry="9" />
      <circle cx="-12" cy="-1" r="12" />
      <circle cx="6" cy="-6" r="15" />
      <circle cx="22" cy="0" r="10" />
    </g>
  );
}

export function CityHero() {
  return (
    <svg viewBox="0 0 760 640" role="img" aria-label="나무와 사람이 있는 오피스 거리 일러스트" preserveAspectRatio="xMaxYMax meet">
      <defs>
        <radialGradient id="sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff3b8" />
          <stop offset="55%" stopColor="#fbe58f" />
          <stop offset="100%" stopColor="#fbe58f" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="560" cy="120" r="110" fill="url(#sun)" />
      <circle cx="560" cy="120" r="48" fill="#fdeaa0" />
      <Cloud x={150} y={150} s={1.15} />
      <Cloud x={430} y={70} s={0.8} />
      <Cloud x={690} y={230} s={0.7} />

      {/* ground plate and street */}
      <polygon points="40,520 420,330 760,500 760,640 380,640" fill="#e4e0cd" />
      <polygon points="40,520 380,640 380,652 40,532" fill="#cdc8b1" />
      <polygon points="130,545 430,398 760,560 760,624 470,624" fill="#b9c4bb" />
      <g stroke="#f4f1e3" strokeWidth="3" strokeDasharray="16 14" opacity="0.9">
        <line x1="190" y1="560" x2="720" y2="602" transform="rotate(-0.6 450 580)" />
      </g>
      <g fill="#f4f1e3" opacity="0.9">
        {[0, 1, 2, 3, 4].map((i) => (
          <polygon key={i} points={`${600 + i * 16},${536 + i * 8} ${608 + i * 16},${532 + i * 8} ${626 + i * 16},${541 + i * 8} ${618 + i * 16},${545 + i * 8}`} />
        ))}
      </g>

      {/* buildings, back to front */}
      <Building x={360} y={190} w={86} d={78} h={190} win={11} />
      <Building x={250} y={242} w={70} d={66} h={150} win={10} />
      <Building x={470} y={262} w={78} d={74} h={160} win={10} />
      <Building x={590} y={320} w={64} d={60} h={120} win={9} />
      <Building x={170} y={334} w={64} d={58} h={96} win={9} />

      {/* a small corner café */}
      <g>
        <polygon points="330,452 372,473 372,500 330,479" fill="#f0e9cf" />
        <polygon points="372,473 414,452 414,479 372,500" fill="#cfdccb" />
        <polygon points="330,452 372,431 414,452 372,473" fill="#2f5d4a" />
        <polygon points="330,447 372,468 414,447 372,426" fill="#c98f6b" />
      </g>

      <Tree x={150} y={540} />
      <Tree x={236} y={578} r={12} />
      <Tree x={532} y={470} r={10} />
      <Tree x={700} y={520} r={12} />
      <Tree x={80} y={505} r={9} />

      <Walker x={300} y={520} shirt="#2f5d4a" />
      <Walker x={322} y={531} shirt="#c98f6b" />
      <Walker x={470} y={520} shirt="#4d6f8c" />
      <Walker x={640} y={575} shirt="#8a5a6b" />
      <Walker x={560} y={585} shirt="#d3a73a" />
    </svg>
  );
}
