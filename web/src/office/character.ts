/**
 * A low-poly miniature office worker built from primitives (no external assets).
 * Local space: standing on y = 0, facing +z.
 */
import * as THREE from "three";

export interface Look {
  shirt: string;
  pants: string;
  skin: string;
  hair: string;
  hairStyle: 0 | 1 | 2;
}

const SHIRTS = ["#5b7fd6", "#e07a5f", "#3d9970", "#f2b134", "#8e6cc9", "#e76f9a", "#2a9d8f", "#6c8ebf", "#c8553d", "#4f6d7a"];
const PANTS = ["#2f3542", "#3b4a6b", "#5a4a3f", "#444b55", "#253046"];
const SKINS = ["#f6d3b3", "#eec39a", "#d9a47a", "#c68a5e", "#f1c9a5"];
const HAIRS = ["#2b1d14", "#4a3020", "#1c1c1c", "#7a4e2d", "#c9a36b", "#5b3a29"];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function lookFor(id: string): Look {
  const h = hashString(id);
  return {
    shirt: SHIRTS[h % SHIRTS.length],
    pants: PANTS[(h >>> 4) % PANTS.length],
    skin: SKINS[(h >>> 8) % SKINS.length],
    hair: HAIRS[(h >>> 12) % HAIRS.length],
    hairStyle: ((h >>> 16) % 3) as Look["hairStyle"],
  };
}

export interface CharacterPose {
  moving: boolean;
  sitting: boolean;
  typing: boolean;
  talking: boolean;
  handRaised: boolean;
}

const HIP_Y = 0.5;
const SEAT_DROP = 0.06;

function mat(color: string, rough = 0.8) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function limb(radius: number, length: number, material: THREE.Material) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
  mesh.position.y = -(length / 2 + radius * 0.6);
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

export class Character {
  readonly root = new THREE.Group();
  /** Invisible, generous hit volume for clicking. */
  readonly hitbox: THREE.Mesh;
  private hips = new THREE.Group();
  private torso: THREE.Mesh;
  private head = new THREE.Group();
  private armL: THREE.Group;
  private armR: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private ring: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  private sitBlend = 0;

  constructor(look: Look, opts: { badge?: string } = {}) {
    const shirt = mat(look.shirt);
    const pants = mat(look.pants);
    const skin = mat(look.skin, 0.6);

    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    this.legL = limb(0.075, 0.3, pants);
    this.legR = limb(0.075, 0.3, pants);
    this.legL.position.x = -0.09;
    this.legR.position.x = 0.09;
    this.hips.add(this.legL, this.legR);

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.24, 6, 14), shirt);
    this.torso.position.y = 0.28;
    this.torso.scale.set(1, 1, 0.78);
    this.torso.castShadow = true;
    this.hips.add(this.torso);

    this.armL = limb(0.055, 0.26, shirt);
    this.armR = limb(0.055, 0.26, shirt);
    this.armL.position.set(-0.225, 0.44, 0);
    this.armR.position.set(0.225, 0.44, 0);
    for (const arm of [this.armL, this.armR]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), skin);
      hand.position.y = -0.4;
      arm.add(hand);
    }
    this.hips.add(this.armL, this.armR);

    // Big head: miniature proportions.
    this.head.position.y = 0.66;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), skin);
    skull.castShadow = true;
    this.head.add(skull);
    const hairMat = mat(look.hair, 0.9);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.212, 20, 12, 0, Math.PI * 2, 0, Math.PI * (look.hairStyle === 1 ? 0.62 : 0.5)), hairMat);
    hairCap.rotation.x = -0.25;
    this.head.add(hairCap);
    if (look.hairStyle === 2) {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), hairMat);
      bun.position.set(0, 0.16, -0.14);
      this.head.add(bun);
    }
    const eyeMat = mat("#1d1d1f", 0.3);
    for (const x of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), eyeMat);
      eye.position.set(x, 0.0, 0.185);
      this.head.add(eye);
    }
    if (opts.badge) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.015, 12), mat(opts.badge, 0.3));
      pin.rotation.x = Math.PI / 2;
      pin.position.set(0.08, 0.36, 0.14);
      this.hips.add(pin);
    }
    this.hips.add(this.head);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.38, 32),
      new THREE.MeshBasicMaterial({ color: "#4f46e5", transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    this.ring.visible = false;
    this.root.add(this.ring);

    this.hitbox = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.5, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.hitbox.position.y = 0.75;
    this.root.add(this.hitbox);
  }

  setSelected(selected: boolean) {
    this.ring.visible = selected;
  }

  /** Advance the animation. `t` is seconds since start. */
  animate(dt: number, t: number, pose: CharacterPose) {
    const k = 1 - Math.exp(-dt * 10); // smoothing factor
    this.sitBlend += ((pose.sitting && !pose.moving ? 1 : 0) - this.sitBlend) * k;
    const sit = this.sitBlend;
    const time = t + this.phase;

    // Legs: swing when walking, forward when seated.
    const swing = pose.moving ? Math.sin(time * 9) * 0.55 : 0;
    const legTarget = -Math.PI / 2 * sit;
    this.legL.rotation.x += (legTarget + swing - this.legL.rotation.x) * k;
    this.legR.rotation.x += (legTarget - swing - this.legR.rotation.x) * k;

    this.hips.position.y = HIP_Y - SEAT_DROP * sit + (pose.moving ? Math.abs(Math.sin(time * 9)) * 0.03 : Math.sin(time * 1.6) * 0.004);

    // Arms.
    let lx = pose.moving ? -swing * 0.8 : 0;
    let rx = pose.moving ? swing * 0.8 : 0;
    let lz = 0.06;
    let rz = -0.06;
    if (pose.typing && !pose.moving) {
      lx = -1.15 + Math.sin(time * 14) * 0.08;
      rx = -1.15 + Math.sin(time * 14 + 1.7) * 0.08;
      lz = -0.25;
      rz = 0.25;
    } else if (pose.talking && !pose.moving) {
      rx = -0.9 + Math.sin(time * 3.2) * 0.35;
      rz = -0.2 + Math.sin(time * 2.1) * 0.15;
    }
    if (pose.handRaised) {
      rx = -Math.PI * 0.94;
      rz = 0.1 + Math.sin(time * 5) * 0.08;
    }
    this.armL.rotation.x += (lx - this.armL.rotation.x) * k;
    this.armL.rotation.z += (lz - this.armL.rotation.z) * k;
    this.armR.rotation.x += (rx - this.armR.rotation.x) * k;
    this.armR.rotation.z += (rz - this.armR.rotation.z) * k;

    // Head: nod while talking, look down at the screen while typing.
    const nod = pose.talking ? Math.sin(time * 6) * 0.08 : pose.typing ? 0.18 : Math.sin(time * 0.7) * 0.03;
    this.head.rotation.x += (nod - this.head.rotation.x) * k;
    this.head.rotation.y = pose.talking ? Math.sin(time * 1.3) * 0.15 : 0;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      }
    });
  }
}
