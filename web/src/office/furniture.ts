/**
 * The office as a miniature diorama: floor slab, cut-away walls, furniture. All built from
 * primitives with flat pastel materials.
 */
import * as THREE from "three";
import { DESK_D, DESK_W, type OfficeLayout, type Spot } from "./layout";

const C = {
  slab: "#6b5443",
  floor: "#e8dcc8",
  plank: "#dfd0b8",
  wall: "#f4f0e8",
  wallTrim: "#d9d1c3",
  window: "#bfe0f2",
  meetingCarpet: "#d5dde6",
  lounge: "#ecd6c6",
  bossRug: "#d9cfe8",
  deskTop: "#f7f3ec",
  deskLeg: "#8c8f96",
  wood: "#b68a5e",
  darkWood: "#6f4e37",
  chair: "#3b4252",
  screenOff: "#2b2f36",
  screenOn: "#8fd3ff",
  glass: "#bfe6f5",
  frame: "#9aa4ad",
  sofa: "#7d8fb3",
  pot: "#c9744a",
  leaf: "#5c9c5a",
  leafDark: "#467f48",
  whiteboard: "#fbfbfb",
};

const materials = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
    materials.set(key, m);
  }
  return m;
}

function box(w: number, h: number, d: number, material: THREE.Material, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function cyl(rTop: number, rBottom: number, h: number, material: THREE.Material, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function rug(w: number, d: number, color: string, x: number, z: number, y = 0.006) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

export function chair(spot: Spot, color = C.chair): THREE.Group {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.6 });
  g.add(box(0.46, 0.07, 0.44, m, 0, 0.42, 0));
  g.add(box(0.44, 0.46, 0.06, m, 0, 0.7, -0.22));
  g.add(cyl(0.03, 0.03, 0.36, mat(C.deskLeg), 0, 0.22, 0, 8));
  const base = cyl(0.22, 0.22, 0.03, mat(C.deskLeg), 0, 0.03, 0, 10);
  g.add(base);
  g.position.set(spot.x, 0, spot.z);
  g.rotation.y = spot.facing;
  return g;
}

export interface Workstation {
  group: THREE.Group;
  screen: THREE.Mesh;
}

export function workstation(x: number, z: number, seat: Spot): Workstation {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(box(DESK_W, 0.05, DESK_D, mat(C.deskTop), 0, 0.73, 0));
  for (const [lx, lz] of [
    [-DESK_W / 2 + 0.06, -DESK_D / 2 + 0.06],
    [DESK_W / 2 - 0.06, -DESK_D / 2 + 0.06],
    [-DESK_W / 2 + 0.06, DESK_D / 2 - 0.06],
    [DESK_W / 2 - 0.06, DESK_D / 2 - 0.06],
  ]) {
    g.add(box(0.05, 0.72, 0.05, mat(C.deskLeg), lx, 0.36, lz));
  }
  // Monitor at the back edge, facing the seat.
  g.add(box(0.08, 0.2, 0.08, mat(C.deskLeg), 0, 0.85, -0.22));
  const screen = box(0.62, 0.38, 0.04, mat(C.screenOff, { roughness: 0.4 }), 0, 1.1, -0.24);
  g.add(screen);
  g.add(box(0.45, 0.02, 0.15, mat("#dfe3e8"), 0, 0.765, 0.12));
  g.add(box(0.1, 0.12, 0.1, mat("#ffffff"), 0.6, 0.81, -0.1)); // mug
  const group = new THREE.Group();
  group.add(g);
  group.add(chair(seat));
  return { group, screen };
}

export function setScreen(screen: THREE.Mesh, on: boolean) {
  screen.material = on ? mat(C.screenOn, { emissive: new THREE.Color(C.screenOn), emissiveIntensity: 0.55, roughness: 0.3 }) : mat(C.screenOff, { roughness: 0.4 });
}

function plant(x: number, z: number, scale = 1) {
  const g = new THREE.Group();
  g.add(cyl(0.2, 0.16, 0.35, mat(C.pot), 0, 0.175, 0, 14));
  const leaves = [
    [0, 0.65, 0, 0.32, C.leaf],
    [0.14, 0.85, 0.05, 0.22, C.leafDark],
    [-0.12, 0.8, -0.06, 0.24, C.leaf],
    [0.02, 1.02, -0.02, 0.18, C.leafDark],
  ] as const;
  for (const [lx, ly, lz, r, color] of leaves) {
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat(color, { flatShading: true }));
    leaf.position.set(lx, ly, lz);
    leaf.castShadow = true;
    g.add(leaf);
  }
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  return g;
}

function sofa(s: { x: number; z: number; w: number; d: number; facing: number }) {
  const g = new THREE.Group();
  const m = mat(C.sofa);
  g.add(box(s.w, 0.28, s.d, m, 0, 0.24, 0));
  g.add(box(s.w, 0.45, 0.2, m, 0, 0.55, -s.d / 2 + 0.1));
  g.add(box(0.2, 0.42, s.d, m, -s.w / 2 + 0.1, 0.35, 0));
  g.add(box(0.2, 0.42, s.d, m, s.w / 2 - 0.1, 0.35, 0));
  for (const x of [-s.w / 4, s.w / 4]) g.add(box(s.w / 2 - 0.25, 0.1, s.d - 0.3, mat("#8fa0c2"), x, 0.43, 0.05));
  g.position.set(s.x, 0, s.z);
  g.rotation.y = s.facing;
  return g;
}

function windowStrip(len: number, horizontal: boolean) {
  const g = new THREE.Group();
  const panes = Math.max(1, Math.floor(len / 1.6));
  for (let i = 0; i < panes; i++) {
    const offset = -len / 2 + (i + 0.5) * (len / panes);
    const pane = box(horizontal ? len / panes - 0.3 : 0.02, 1.1, horizontal ? 0.02 : len / panes - 0.3, mat(C.window, { emissive: new THREE.Color(C.window), emissiveIntensity: 0.35, roughness: 0.2 }), 0, 1.55, 0, false);
    if (horizontal) pane.position.x = offset;
    else pane.position.z = offset;
    g.add(pane);
  }
  return g;
}

export interface OfficeModel {
  root: THREE.Group;
  workstations: Workstation[];
  meetingTable: THREE.Object3D;
  bossScreen: THREE.Mesh;
}

export function buildOffice(layout: OfficeLayout): OfficeModel {
  const root = new THREE.Group();
  const { width: W, depth: D } = layout;
  const x0 = -W / 2;
  const z0 = -D / 2;

  // Diorama slab + floor with plank stripes.
  root.add(box(W + 0.5, 0.4, D + 0.5, mat(C.slab), 0, -0.2, 0, false));
  root.add(rug(W, D, C.floor, 0, 0, 0.001));
  for (let x = x0 + 0.6; x < W / 2; x += 1.2) root.add(rug(0.02, D, C.plank, x, 0, 0.002));

  // Cut-away walls: back and both sides; the front stays open for the camera.
  const wallH = 2.7;
  const wallT = 0.15;
  root.add(box(W + 0.3, wallH, wallT, mat(C.wall), 0, wallH / 2, z0 - wallT / 2));
  root.add(box(wallT, wallH, D, mat(C.wall), x0 - wallT / 2, wallH / 2, 0));
  root.add(box(wallT, wallH, D, mat(C.wall), W / 2 + wallT / 2, wallH / 2, 0));
  root.add(box(W + 0.3, 0.12, 0.2, mat(C.wallTrim), 0, 0.06, z0 + 0.02));
  const backWindows = windowStrip(W - 2, true);
  backWindows.position.set(0.5, 0, z0 + 0.01);
  root.add(backWindows);
  const sideWindows = windowStrip(D - 3, false);
  sideWindows.position.set(W / 2 + 0.01 - 0.02, 0, 0.6);
  root.add(sideWindows);
  // Low front sill so the room reads as enclosed, with a gap at the entrance.
  const e = layout.entrance;
  const leftLen = e.x - 0.9 - x0;
  root.add(box(leftLen, 0.25, 0.1, mat(C.wallTrim), x0 + leftLen / 2, 0.125, D / 2));
  const rightLen = W / 2 - (e.x + 0.9);
  root.add(box(rightLen, 0.25, 0.1, mat(C.wallTrim), e.x + 0.9 + rightLen / 2, 0.125, D / 2));
  root.add(rug(1.6, 0.7, "#8a6f5a", e.x, D / 2 - 0.45));

  // Meeting room: carpet, glass walls, oval table, chairs, whiteboard.
  const { room, table, seats, doorX, doorWidth } = layout.meeting;
  root.add(rug(room.w, room.d, C.meetingCarpet, room.x, room.z));
  const glass = new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.28, roughness: 0.1, depthWrite: false });
  const glassH = 2.3;
  const frameM = mat(C.frame);
  const rightX = room.x + room.w / 2;
  const frontZ = room.z + room.d / 2;
  root.add(box(0.05, glassH, room.d, glass, rightX, glassH / 2, room.z, false));
  root.add(box(0.08, 0.08, room.d, frameM, rightX, glassH, room.z));
  const leftLenG = doorX - doorWidth / 2 - (room.x - room.w / 2);
  root.add(box(leftLenG, glassH, 0.05, glass, room.x - room.w / 2 + leftLenG / 2, glassH / 2, frontZ, false));
  const rightLenG = rightX - (doorX + doorWidth / 2);
  root.add(box(rightLenG, glassH, 0.05, glass, rightX - rightLenG / 2, glassH / 2, frontZ, false));
  root.add(box(room.w, 0.08, 0.08, frameM, room.x, glassH, frontZ));
  for (const x of [doorX - doorWidth / 2, doorX + doorWidth / 2]) root.add(box(0.08, glassH, 0.08, frameM, x, glassH / 2, frontZ));
  const tableGroup = new THREE.Group();
  const top = cyl(1, 1, 0.07, mat(C.wood, { roughness: 0.6 }), 0, 0.74, 0, 48);
  top.scale.set(table.rx, 1, table.rz);
  tableGroup.add(top);
  tableGroup.add(cyl(0.18, 0.3, 0.7, mat(C.darkWood), 0, 0.35, 0, 16));
  tableGroup.position.set(table.x, 0, table.z);
  root.add(tableGroup);
  for (const s of seats) root.add(chair(s, "#4b5563"));
  root.add(box(2.2, 1.1, 0.05, mat(C.whiteboard, { roughness: 0.3 }), room.x, 1.5, z0 + 0.04));
  root.add(box(2.3, 0.05, 0.1, frameM, room.x, 0.93, z0 + 0.07));

  // Desks.
  const workstations = layout.desks.map((d) => {
    const ws = workstation(d.x, d.z, d.seat);
    root.add(ws.group);
    return ws;
  });

  // 대표 desk: bigger, darker, with a rug and two monitors.
  const b = layout.boss;
  root.add(rug(3.4, 2.6, C.bossRug, b.desk.x, b.desk.z - 0.1));
  const bossGroup = new THREE.Group();
  bossGroup.position.set(b.desk.x, 0, b.desk.z);
  bossGroup.add(box(2.2, 0.08, 0.9, mat(C.darkWood, { roughness: 0.5 }), 0, 0.75, 0));
  bossGroup.add(box(2.1, 0.7, 0.08, mat(C.darkWood), 0, 0.37, 0.38));
  for (const x of [-1.02, 1.02]) bossGroup.add(box(0.08, 0.72, 0.84, mat(C.darkWood), x, 0.36, 0));
  const bossScreen = box(0.7, 0.4, 0.04, mat(C.screenOff), 0, 1.07, 0.18);
  bossScreen.rotation.y = Math.PI;
  bossGroup.add(bossScreen);
  bossGroup.add(box(0.08, 0.2, 0.08, mat(C.deskLeg), 0, 0.88, 0.2));
  bossGroup.add(box(0.5, 0.12, 0.05, mat("#d4af37", { metalness: 0.5, roughness: 0.3 }), 0.6, 0.85, 0.3));
  root.add(bossGroup);
  root.add(chair(b.seat, "#1f2937"));
  // Bookshelf behind the boss.
  const shelf = new THREE.Group();
  shelf.add(box(1.8, 2, 0.35, mat(C.wood), 0, 1, 0));
  const bookColors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#f39c12", "#16a085"];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 7; i++) {
      shelf.add(box(0.12, 0.42, 0.25, mat(bookColors[(i + row) % bookColors.length]), -0.72 + i * 0.22, 0.45 + row * 0.6, 0.06));
    }
  }
  shelf.position.set(b.desk.x + 1.8, 0, z0 + 0.2);
  root.add(shelf);

  // Lounge.
  const l = layout.lounge;
  root.add(rug(l.area.w, l.area.d, C.lounge, l.area.x, l.area.z));
  for (const s of l.sofas) root.add(sofa(s));
  const coffee = new THREE.Group();
  coffee.add(box(1.2, 0.06, 0.7, mat(C.wood), 0, 0.42, 0));
  coffee.add(box(1.0, 0.38, 0.5, mat(C.darkWood), 0, 0.2, 0));
  coffee.add(cyl(0.05, 0.04, 0.1, mat("#ffffff"), 0.2, 0.5, 0.1, 10));
  coffee.position.set(l.table.x, 0, l.table.z);
  root.add(coffee);
  // Water cooler at the lounge edge.
  const cooler = new THREE.Group();
  cooler.add(box(0.36, 0.9, 0.36, mat("#e5e7eb"), 0, 0.45, 0));
  cooler.add(cyl(0.16, 0.16, 0.4, new THREE.MeshStandardMaterial({ color: "#7dc4e8", transparent: true, opacity: 0.7 }), 0, 1.1, 0, 16));
  cooler.position.set(W / 2 - 0.4, 0, l.area.z - l.area.d / 2 + 0.4);
  root.add(cooler);

  for (const p of layout.plants) root.add(plant(p.x, p.z));

  return { root, workstations, meetingTable: tableGroup, bossScreen };
}

export function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
