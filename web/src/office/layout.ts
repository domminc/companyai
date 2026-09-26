/**
 * Office floor plan in metres. Pure data (no three.js), so it can be unit tested.
 *
 * Coordinates: x to the right, z towards the viewer, y up. The floor is centred on the origin;
 * the back wall is at z = -depth/2 and the entrance is in the front wall at z = +depth/2.
 *
 *   ┌───────────────┬──────────────────────────┬────────────┐
 *   │ meeting room  │  desks (one per agent)   │  대표 desk  │
 *   │  (glass)      │                          ├────────────┤
 *   │               │                          │   lounge   │
 *   └───── door ────┴────────── entrance ──────┴────────────┘
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** Where someone stands or sits, and which way they face (radians, 0 = facing +z). */
export interface Spot extends Vec2 {
  facing: number;
}

export type Obstacle =
  | { kind: "rect"; x: number; z: number; w: number; d: number }
  | { kind: "ellipse"; x: number; z: number; rx: number; rz: number };

export interface Desk {
  /** Centre of the desk top. */
  x: number;
  z: number;
  seat: Spot;
}

export interface OfficeLayout {
  width: number;
  depth: number;
  entrance: Spot;
  desks: Desk[];
  boss: { desk: Vec2; seat: Spot; reportSpot: Spot };
  meeting: {
    room: { x: number; z: number; w: number; d: number };
    table: { x: number; z: number; rx: number; rz: number };
    seats: Spot[];
    /** Opening in the room's front wall. */
    doorX: number;
    doorWidth: number;
  };
  lounge: { area: { x: number; z: number; w: number; d: number }; spots: Spot[]; sofas: { x: number; z: number; w: number; d: number; facing: number }[]; table: Vec2 };
  plants: Vec2[];
  obstacles: Obstacle[];
}

export const DESK_W = 1.6;
export const DESK_D = 0.8;
const DESK_PITCH_X = 2.4;
const DESK_PITCH_Z = 2.8;
const MEETING_W = 7;
const SIDE_W = 6.2;
const GAP = 1.2;
/** Facing the back wall (-z). */
export const FACING_BACK = Math.PI;
/** Facing the viewer (+z). */
export const FACING_FRONT = 0;

export function facingTowards(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Builds a floor plan with room for `agentCount` employees (at least 6 desks and 6 meeting seats,
 * so a small team still gets a lived-in office).
 */
export function buildLayout(agentCount: number): OfficeLayout {
  const deskCount = Math.max(6, agentCount);
  const cols = deskCount <= 6 ? 3 : deskCount <= 12 ? 4 : 5;
  const rows = Math.ceil(deskCount / cols);
  const seatCount = Math.min(Math.max(6, agentCount), 16);

  const workW = cols * DESK_PITCH_X;
  const width = MEETING_W + GAP + workW + GAP + SIDE_W;
  const meetingD = 5.5 + Math.ceil(seatCount / 2) * 0.35;
  const depth = Math.max(10, rows * DESK_PITCH_Z + 3.5, meetingD + 3);
  const x0 = -width / 2;
  const z0 = -depth / 2;
  const obstacles: Obstacle[] = [];

  // Desks, filled row by row from the back wall.
  const workX0 = x0 + MEETING_W + GAP;
  const desks: Desk[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = workX0 + DESK_PITCH_X * (col + 0.5);
    const z = z0 + 1.6 + row * DESK_PITCH_Z;
    desks.push({ x, z, seat: { x, z: z + 0.75, facing: FACING_BACK } });
    obstacles.push({ kind: "rect", x, z, w: DESK_W, d: DESK_D });
  }

  // Meeting room with an oval table; the door is at the right end of its front wall.
  const room = { x: x0 + MEETING_W / 2, z: z0 + meetingD / 2, w: MEETING_W, d: meetingD };
  const table = { x: room.x - 0.3, z: room.z - 0.2, rx: 1.3 + seatCount * 0.08, rz: 0.75 + seatCount * 0.04 };
  obstacles.push({ kind: "ellipse", ...table });
  const seats: Spot[] = [];
  for (let i = 0; i < seatCount; i++) {
    // Seat 0 (the chair) sits at the far end of the table; the rest go round.
    const angle = Math.PI + (i / seatCount) * Math.PI * 2;
    const x = table.x + Math.cos(angle) * (table.rx + 0.65);
    const z = table.z + Math.sin(angle) * (table.rz + 0.65);
    seats.push({ x, z, facing: facingTowards({ x, z }, table) });
  }
  const doorWidth = 1.4;
  const doorX = x0 + MEETING_W - 1.2;
  const wall = 0.12;
  // Right glass wall and the front wall split around the door.
  obstacles.push({ kind: "rect", x: x0 + MEETING_W, z: room.z, w: wall, d: meetingD });
  const leftLen = doorX - doorWidth / 2 - x0;
  obstacles.push({ kind: "rect", x: x0 + leftLen / 2, z: z0 + meetingD, w: leftLen, d: wall });
  const rightStart = doorX + doorWidth / 2;
  obstacles.push({ kind: "rect", x: (rightStart + x0 + MEETING_W) / 2, z: z0 + meetingD, w: x0 + MEETING_W - rightStart, d: wall });

  // 대표 desk in the back right corner, facing the office.
  const sideX = x0 + width - SIDE_W / 2;
  const bossDesk = { x: sideX, z: z0 + 2.1 };
  obstacles.push({ kind: "rect", ...bossDesk, w: 2.2, d: 0.9 });
  const boss = {
    desk: bossDesk,
    seat: { x: bossDesk.x, z: bossDesk.z - 0.8, facing: FACING_FRONT },
    reportSpot: { x: bossDesk.x - 0.4, z: bossDesk.z + 1.25, facing: FACING_BACK },
  };

  // Lounge below it: two sofas around a coffee table.
  const loungeZ0 = z0 + 4.2;
  const loungeD = depth / 2 - 1.6 - loungeZ0;
  const area = { x: sideX, z: loungeZ0 + loungeD / 2, w: SIDE_W - 0.6, d: loungeD };
  const loungeTable = { x: sideX, z: area.z };
  obstacles.push({ kind: "rect", ...loungeTable, w: 1.2, d: 0.7 });
  const sofas = [
    { x: sideX, z: loungeTable.z - 1.35, w: 2.2, d: 0.8, facing: FACING_FRONT },
    { x: sideX, z: loungeTable.z + 1.35, w: 2.2, d: 0.8, facing: FACING_BACK },
  ];
  for (const s of sofas) obstacles.push({ kind: "rect", x: s.x, z: s.z, w: s.w, d: s.d });
  const spots: Spot[] = [
    { x: sideX - 1.7, z: loungeTable.z - 0.2, facing: Math.PI / 2 },
    { x: sideX + 1.7, z: loungeTable.z + 0.2, facing: -Math.PI / 2 },
    { x: sideX - 0.5, z: loungeTable.z - 0.75, facing: FACING_FRONT },
    { x: sideX + 0.5, z: loungeTable.z + 0.75, facing: FACING_BACK },
  ];

  const plants: Vec2[] = [
    { x: x0 + 0.5, z: z0 + 0.5 },
    { x: x0 + width - 0.5, z: depth / 2 - 0.5 },
    { x: workX0 - 0.4, z: depth / 2 - 0.6 },
    { x: x0 + width - SIDE_W - 0.3, z: z0 + 0.5 },
  ];
  for (const p of plants) obstacles.push({ kind: "rect", ...p, w: 0.5, d: 0.5 });

  const entrance: Spot = { x: workX0 + workW / 2, z: depth / 2 - 0.3, facing: FACING_BACK };

  return {
    width,
    depth,
    entrance,
    desks,
    boss,
    meeting: { room, table, seats, doorX, doorWidth },
    lounge: { area, spots, sofas, table: loungeTable },
    plants,
    obstacles,
  };
}
