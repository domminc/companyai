/**
 * Animated people from Kenney's "Mini Characters" pack (CC0, www.kenney.nl), served from
 * /models/kenney. Clips used: idle, walk, sit, emote-yes. Typing, talking while seated and raising
 * a hand are layered on top by posing the arm and head bones after the mixer runs.
 */
import * as THREE from "three";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { type CharacterPose, hashString } from "./character";
import type { Avatar } from "./figure";

export const KENNEY_MODELS = [
  "character-female-a",
  "character-male-a",
  "character-female-b",
  "character-male-b",
  "character-female-c",
  "character-male-c",
  "character-female-d",
  "character-male-d",
  "character-female-e",
  "character-male-e",
  "character-female-f",
  "character-male-f",
] as const;

/** The pack is modelled ~0.67 units tall; this makes people ~1.35m like the rest of the office. */
const SCALE = 2;
const FADE = 0.25;
/** The pack's `sit` clip sits on the floor; lift seated people onto the chair. */
const SEAT_LIFT = 0.36;

// Arm bones rest pointing sideways (T-pose). Z raises/lowers them, Y swings them forward.
const euler = new THREE.Euler();
function aim(bone: THREE.Object3D | undefined, x: number, y: number, z: number) {
  if (bone) bone.quaternion.setFromEuler(euler.set(x, y, z));
}

export function modelFor(id: string): string {
  return KENNEY_MODELS[hashString(id) % KENNEY_MODELS.length];
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function loadModel(name: string): Promise<GLTF> {
  let p = cache.get(name);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}models/kenney/${name}.glb`);
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return p;
}

type Clip = "idle" | "walk" | "sit" | "emote-yes";

export class KenneyAvatar implements Avatar {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current?: Clip;
  private armL?: THREE.Object3D;
  private armR?: THREE.Object3D;
  private head?: THREE.Object3D;
  private phase = Math.random() * 10;
  private lift = 0;

  constructor(gltf: GLTF) {
    this.root = clone(gltf.scene);
    this.root.scale.setScalar(SCALE);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        // Skinned meshes are culled by their bind-pose bounds; walking can leave those bounds.
        o.frustumCulled = false;
      }
    });
    this.armL = this.root.getObjectByName("arm-left");
    this.armR = this.root.getObjectByName("arm-right");
    this.head = this.root.getObjectByName("head");
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.play("idle", 0);
    this.mixer.update(this.phase); // don't have everyone breathe in sync
  }

  private play(name: Clip, fade = FADE) {
    if (name === this.current) return;
    const next = this.actions.get(name) ?? this.actions.get("idle");
    if (!next) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    this.current = name;
  }

  animate(dt: number, t: number, pose: CharacterPose) {
    const clip: Clip = pose.moving ? "walk" : pose.sitting ? "sit" : pose.talking ? "emote-yes" : "idle";
    this.play(clip);
    this.mixer.update(dt);

    const seated = clip === "sit";
    this.lift += ((seated ? SEAT_LIFT : 0) - this.lift) * (1 - Math.exp(-dt * 12));
    this.root.position.y = this.lift;

    const time = t + this.phase;
    if (!pose.moving) {
      if (pose.typing) {
        // Reach forward to the keyboard, hands tapping out of step.
        aim(this.armR, 0, 1.25, 0.35 + Math.sin(time * 14) * 0.1);
        aim(this.armL, 0, -1.25, -0.35 - Math.sin(time * 14 + 1.7) * 0.1);
      }
      if (pose.talking && seated) {
        if (this.head) this.head.rotation.x = Math.sin(time * 6) * 0.1;
        aim(this.armR, 0, 0.9 + Math.sin(time * 2.1) * 0.2, 0.1 + Math.sin(time * 3.2) * 0.25);
      }
    }
    // Tilted out and forward so the raised hand shows beside the (big) head.
    if (pose.handRaised) aim(this.armR, 0, -0.5, -1.1 + Math.sin(time * 5) * 0.08);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    // Geometry and textures are shared with the cached GLTF, so nothing else to free.
  }
}
