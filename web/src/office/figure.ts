/**
 * What the scene moves around: a container with a selection ring and a click hitbox, holding a
 * swappable avatar (the built-in low-poly character until a GLB model finishes loading).
 */
import * as THREE from "three";
import type { CharacterPose } from "./character";

export interface Avatar {
  readonly root: THREE.Object3D;
  animate(dt: number, t: number, pose: CharacterPose): void;
  dispose(): void;
}

export class Figure {
  readonly root = new THREE.Group();
  /** Invisible, generous hit volume for clicking. */
  readonly hitbox: THREE.Mesh;
  private ring: THREE.Mesh;

  constructor(private avatar: Avatar) {
    this.root.add(avatar.root);
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

  setAvatar(next: Avatar) {
    this.root.remove(this.avatar.root);
    this.avatar.dispose();
    this.avatar = next;
    this.root.add(next.root);
  }

  setSelected(selected: boolean) {
    this.ring.visible = selected;
  }

  animate(dt: number, t: number, pose: CharacterPose) {
    this.avatar.animate(dt, t, pose);
  }

  dispose() {
    this.avatar.dispose();
    this.ring.geometry.dispose();
    this.hitbox.geometry.dispose();
  }
}
