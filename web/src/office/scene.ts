/**
 * The live 3D office. Feed it company state with `update()`; it walks employees to where the
 * engine says they should be (desk, meeting room, 대표 desk) and shows what they are doing.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Agent, CompanyState } from "../../../engine/types";
import { Character, type CharacterPose, lookFor } from "./character";
import { buildOffice, disposeTree, type OfficeModel, setScreen } from "./furniture";
import { buildLayout, type OfficeLayout, type Spot, type Vec2 } from "./layout";
import { WalkGrid } from "./pathfinding";
import { deskAssignments, type Errand, type Goal, type Overlay, planGoals, planOverlays } from "./plan";

export type CameraView = "overview" | "meeting" | "follow";

export interface SceneCallbacks {
  onSelectAgent: (agentId: string | null) => void;
  onSelectMeeting: () => void;
}

const WALK_SPEED = 1.5;
const REPORT_STAY_MS = 5000;
const REPORT_TIMEOUT_MS = 30000;
const HERMES_BADGE = "#f59e0b";

interface Actor {
  id: string;
  character: Character;
  pos: Vec2;
  heading: number;
  path: Vec2[];
  goal?: Goal;
  arrivedAt?: number;
  leaving?: boolean;
  label: CSS2DObject;
  nameEl: HTMLDivElement;
  bubble: CSS2DObject;
  bubbleEl: HTMLDivElement;
  bubbleKey?: string;
  overlay: Overlay;
}

function angleLerp(from: number, to: number, k: number) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}

function makeLabel(className: string): [CSS2DObject, HTMLDivElement] {
  const el = document.createElement("div");
  el.className = className;
  const obj = new CSS2DObject(el);
  return [obj, el];
}

export class OfficeScene {
  private renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  private controls: OrbitControls;
  private layout!: OfficeLayout;
  private layoutKey = "";
  private grid!: WalkGrid;
  private model?: OfficeModel;
  private actors = new Map<string, Actor>();
  private boss: Actor;
  private errands = new Map<string, Errand>();
  private state?: CompanyState;
  private taskStatus = new Map<string, string>();
  private initialized = false;
  private selected: string | null = null;
  private view: CameraView = "overview";
  private tween: { target: THREE.Vector3; distance: number } | null = null;
  private raf = 0;
  private clock = new THREE.Clock();
  private nextBreakCheck = 0;
  private resize: ResizeObserver;
  private pointerDown: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(
    private container: HTMLElement,
    private callbacks: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.labels.domElement.className = "office-labels";
    container.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color("#e9eef2");
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#b9a891", 1.25));
    const sun = new THREE.DirectionalLight("#fff6e8", 1.9);
    sun.position.set(8, 16, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.2;
    this.controls.minAzimuthAngle = -0.7;
    this.controls.maxAzimuthAngle = 0.7;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("start", () => {
      this.tween = null;
      this.userMovedCamera = true;
      if (this.view === "follow") this.view = "overview";
    });

    this.boss = this.createActor("__boss__", "대표 (나)", { shirt: "#2d3142", pants: "#1f2230", skin: "#f1c9a5", hair: "#1c1c1c", hairStyle: 0 });
    this.boss.nameEl.classList.add("boss");

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(container);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.onResize();
    this.loop();
  }

  private sun: THREE.DirectionalLight;

  // -------------------------------------------------------------- public API

  update(state: CompanyState) {
    this.state = state;
    this.ensureLayout(state.agents.length);
    const now = performance.now();

    // A task that just finished sends its owner over to report.
    for (const task of state.tasks) {
      const before = this.taskStatus.get(task.id);
      if (this.initialized && before === "in_progress" && task.status === "done" && task.assigneeId) {
        this.errands.set(task.assigneeId, { kind: "report", title: task.title, since: now });
      }
      this.taskStatus.set(task.id, task.status);
    }

    const present = new Set(state.agents.map((a) => a.id));
    for (const agent of state.agents) {
      if (!this.actors.has(agent.id)) this.spawn(agent);
      const actor = this.actors.get(agent.id)!;
      actor.nameEl.innerHTML = this.nameTag(agent);
    }
    for (const [id, actor] of this.actors) {
      if (!present.has(id) && !actor.leaving) {
        actor.leaving = true;
        this.errands.delete(id);
        actor.goal = { key: "leave", spot: this.layout.entrance, pose: "stand", activity: "idle" };
        actor.path = this.grid.findPath(actor.pos, this.layout.entrance);
        actor.arrivedAt = undefined;
      }
    }
    this.initialized = true;
    this.replan();
  }

  setView(view: CameraView) {
    this.view = view;
    const table = this.layout.meeting.table;
    this.userMovedCamera = false;
    if (view === "overview") this.tween = this.overviewShot();
    else this.tween = { target: new THREE.Vector3(table.x, 0.6, table.z), distance: Math.max(9, this.layout.meeting.room.w * 1.35) };
  }

  select(agentId: string | null) {
    this.selected = agentId;
    for (const a of this.actors.values()) a.character.setSelected(a.id === agentId);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    for (const a of [...this.actors.values(), this.boss]) this.removeActor(a);
    if (this.model) disposeTree(this.model.root);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  // -------------------------------------------------------------- internals

  private ensureLayout(agentCount: number) {
    const layout = buildLayout(agentCount);
    const key = `${layout.desks.length}:${layout.meeting.seats.length}`;
    if (key === this.layoutKey) return;
    const first = !this.layoutKey;
    this.layoutKey = key;
    this.layout = layout;
    this.grid = new WalkGrid(layout);
    if (this.model) {
      this.scene.remove(this.model.root);
      disposeTree(this.model.root);
    }
    this.model = buildOffice(layout);
    this.scene.add(this.model.root);

    const shadowSpan = Math.max(layout.width, layout.depth) / 2 + 2;
    const cam = this.sun.shadow.camera;
    cam.left = -shadowSpan;
    cam.right = shadowSpan;
    cam.top = shadowSpan;
    cam.bottom = -shadowSpan;
    cam.far = 60;
    cam.updateProjectionMatrix();

    this.placeStatic(this.boss, layout.boss.seat);
    for (const a of this.actors.values()) a.goal = undefined; // re-plan onto the new floor
    if (first) {
      const shot = this.overviewShot();
      this.controls.target.copy(shot.target);
      this.camera.position.copy(shot.target).add(new THREE.Vector3(0, Math.sin(0.95), Math.cos(0.95)).multiplyScalar(shot.distance));
      this.controls.maxDistance = shot.distance * 1.6;
      this.controls.minDistance = 4;
      this.controls.update();
    } else {
      this.controls.maxDistance = this.overviewShot().distance * 1.6;
    }
  }

  /** Frames the whole floor for the current aspect ratio (phones need to back off further). */
  private overviewShot() {
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    // On a phone, frame the middle of the floor at a readable size; the rest is a pan away.
    const widthShare = this.camera.aspect < 0.8 ? 0.33 : 0.54;
    const fitWidth = (this.layout.width * widthShare) / Math.tan(hHalf);
    const fitDepth = (this.layout.depth * 0.62) / Math.tan(vHalf);
    return { target: new THREE.Vector3(0, 0, -0.4), distance: Math.max(fitWidth, fitDepth) };
  }

  private createActor(id: string, name: string, look = lookFor(id), badge?: string): Actor {
    const character = new Character(look, { badge });
    character.hitbox.userData.actorId = id;
    const [label, nameEl] = makeLabel("office-name");
    nameEl.textContent = name;
    label.position.set(0, 1.5, 0);
    character.root.add(label);
    const [bubble, bubbleEl] = makeLabel("office-bubble");
    bubble.position.set(0, 1.78, 0);
    bubble.visible = false;
    character.root.add(bubble);
    this.scene.add(character.root);
    return {
      id,
      character,
      pos: { x: 0, z: 0 },
      heading: 0,
      path: [],
      label,
      nameEl,
      bubble,
      bubbleEl,
      overlay: { handRaised: false, talking: false, typing: false },
    };
  }

  private spawn(agent: Agent) {
    const actor = this.createActor(agent.id, agent.name, lookFor(agent.id), agent.runtime.kind === "hermes" ? HERMES_BADGE : undefined);
    actor.character.setSelected(agent.id === this.selected);
    this.actors.set(agent.id, actor);
    if (!this.initialized) {
      // Already at work when the page loads: start at the desk.
      const desk = this.layout.desks[(deskAssignments(this.state!.agents).get(agent.id) ?? 0) % this.layout.desks.length];
      this.placeStatic(actor, desk.seat);
    } else {
      // New hire: walks in through the entrance.
      this.placeStatic(actor, this.layout.entrance);
      actor.arrivedAt = undefined;
    }
  }

  private placeStatic(actor: Actor, spot: Spot) {
    actor.pos = { x: spot.x, z: spot.z };
    actor.heading = spot.facing;
    actor.character.root.position.set(spot.x, 0, spot.z);
    actor.character.root.rotation.y = spot.facing;
    actor.arrivedAt = performance.now();
  }

  private nameTag(agent: Agent) {
    const dot = agent.status === "working" ? "work" : agent.status === "in_meeting" ? "meet" : "idle";
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const hermes = agent.runtime.kind === "hermes" ? `<span class="h">H</span>` : "";
    return `<span class="dot ${dot}"></span>${esc(agent.name)}${hermes}`;
  }

  private replan() {
    if (!this.state) return;
    const goals = planGoals(this.state, this.layout, this.errands);
    const overlays = planOverlays(this.state, this.errands);
    for (const [id, actor] of this.actors) {
      if (actor.leaving) continue;
      const goal = goals.get(id);
      if (goal && goal.key !== actor.goal?.key) {
        actor.goal = goal;
        actor.path = this.grid.findPath(actor.pos, goal.spot).slice(1);
        actor.arrivedAt = undefined;
      } else if (goal) {
        actor.goal = goal; // same place, maybe a new activity
      }
      actor.overlay = overlays.agents.get(id) ?? actor.overlay;
      this.setBubble(actor, actor.overlay.bubble);
    }
    // People reporting side by side: stack their bubbles so they don't cover each other.
    let reporting = 0;
    for (const actor of this.actors.values()) {
      const stacked = actor.goal?.activity === "report" ? reporting++ : 0;
      actor.bubbleEl.style.translate = `0 ${-stacked * 38}px`;
    }
    this.setBubble(this.boss, overlays.boss ? { text: overlays.boss, tone: "speech" } : undefined);

    // Screens glow at desks whose owner is working.
    const desks = deskAssignments(this.state.agents);
    const working = new Set(this.state.agents.filter((a) => a.status === "working").map((a) => desks.get(a.id)));
    this.model?.workstations.forEach((ws, i) => setScreen(ws.screen, working.has(i)));
    if (this.model) setScreen(this.model.bossScreen, true);
  }

  private setBubble(actor: Actor, bubble: Overlay["bubble"]) {
    const key = bubble ? `${bubble.tone}|${bubble.text}` : "";
    if (key === actor.bubbleKey) return;
    actor.bubbleKey = key;
    actor.bubble.visible = !!bubble;
    actor.bubbleEl.className = `office-bubble ${bubble ? `tone-${bubble.tone}` : ""}`;
    actor.bubbleEl.textContent = bubble?.text ?? "";
  }

  private tickErrands(now: number) {
    let changed = false;
    for (const [id, errand] of this.errands) {
      const actor = this.actors.get(id);
      if (!actor) {
        this.errands.delete(id);
        changed = true;
        continue;
      }
      const done =
        errand.kind === "report"
          ? (actor.goal?.activity === "report" && actor.arrivedAt && now - actor.arrivedAt > REPORT_STAY_MS) || now - errand.since > REPORT_TIMEOUT_MS
          : now > errand.until;
      if (done) {
        this.errands.delete(id);
        changed = true;
      }
    }
    // Now and then an idle employee wanders off to the lounge for a bit.
    if (now > this.nextBreakCheck && this.state) {
      this.nextBreakCheck = now + 4000;
      const onBreak = [...this.errands.values()].filter((e) => e.kind === "break").length;
      const idle = this.state.agents.filter((a) => a.status === "idle" && !this.errands.has(a.id) && this.actors.get(a.id)?.arrivedAt);
      if (idle.length && onBreak < this.layout.lounge.spots.length - 1 && Math.random() < 0.25) {
        const agent = idle[Math.floor(Math.random() * idle.length)];
        const used = new Set([...this.errands.values()].flatMap((e) => (e.kind === "break" ? [e.spot] : [])));
        const free = this.layout.lounge.spots.map((_, i) => i).filter((i) => !used.has(i));
        this.errands.set(agent.id, { kind: "break", spot: free[Math.floor(Math.random() * free.length)], until: now + 14000 + Math.random() * 10000 });
        changed = true;
      }
    }
    if (changed) this.replan();
  }

  private stepActor(actor: Actor, dt: number, t: number, now: number) {
    const moving = actor.path.length > 0;
    if (moving) {
      let remaining = WALK_SPEED * dt;
      while (remaining > 0 && actor.path.length) {
        const next = actor.path[0];
        const dx = next.x - actor.pos.x;
        const dz = next.z - actor.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-4) {
          actor.path.shift();
          continue;
        }
        actor.heading = angleLerp(actor.heading, Math.atan2(dx, dz), 1 - Math.exp(-dt * 12));
        const step = Math.min(dist, remaining);
        actor.pos.x += (dx / dist) * step;
        actor.pos.z += (dz / dist) * step;
        remaining -= step;
        if (step === dist) actor.path.shift();
      }
      if (!actor.path.length) actor.arrivedAt = now;
    } else if (actor.goal) {
      actor.heading = angleLerp(actor.heading, actor.goal.spot.facing, 1 - Math.exp(-dt * 8));
    }
    actor.character.root.position.set(actor.pos.x, 0, actor.pos.z);
    actor.character.root.rotation.y = actor.heading;

    const arrived = !moving && actor.path.length === 0;
    const pose: CharacterPose = {
      moving,
      sitting: arrived && actor.goal?.pose === "sit",
      typing: arrived && actor.overlay.typing,
      talking: arrived && actor.overlay.talking,
      handRaised: actor.overlay.handRaised,
    };
    actor.character.animate(dt, t, pose);
  }

  private removeActor(actor: Actor) {
    actor.label.element.remove();
    actor.bubble.element.remove();
    this.scene.remove(actor.character.root);
    actor.character.dispose();
  }

  private followTarget(): THREE.Vector3 | null {
    const meeting = this.state?.meetings.find((m) => m.status === "running");
    if (!meeting) return null;
    const speaker = meeting.currentSpeakerId && this.actors.get(meeting.currentSpeakerId);
    if (speaker && meeting.phase === "speaking") return new THREE.Vector3(speaker.pos.x, 0.8, speaker.pos.z);
    const table = this.layout.meeting.table;
    return new THREE.Vector3(table.x, 0.6, table.z);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const now = performance.now();

    this.tickErrands(now);
    for (const [id, actor] of this.actors) {
      this.stepActor(actor, dt, t, now);
      if (actor.leaving && actor.path.length === 0) {
        this.removeActor(actor);
        this.actors.delete(id);
      }
    }
    this.boss.character.animate(dt, t, { moving: false, sitting: true, typing: !this.boss.bubble.visible, talking: this.boss.bubble.visible, handRaised: false });

    if (this.view === "follow") {
      const target = this.followTarget();
      if (target) this.tween = { target, distance: 8 };
    }
    if (this.tween) {
      const k = 1 - Math.exp(-dt * 3);
      this.controls.target.lerp(this.tween.target, k);
      const offset = this.camera.position.clone().sub(this.controls.target);
      const len = offset.length();
      offset.setLength(len + (this.tween.distance - len) * k);
      this.camera.position.copy(this.controls.target).add(offset);
      if (this.view !== "follow" && this.controls.target.distanceTo(this.tween.target) < 0.01 && Math.abs(len - this.tween.distance) < 0.05) {
        this.tween = null;
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  private onResize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    if (this.layout) {
      const shot = this.overviewShot();
      this.controls.maxDistance = shot.distance * 1.6;
      // Keep the whole office in frame when the window changes, unless the user took over the camera.
      if (this.view === "overview" && !this.userMovedCamera) this.tween = shot;
    }
  }

  private userMovedCamera = false;

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag, not a click
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hitboxes = [...this.actors.values()].filter((a) => !a.leaving).map((a) => a.character.hitbox);
    const hit = this.raycaster.intersectObjects(hitboxes, false)[0];
    if (hit) {
      this.callbacks.onSelectAgent(hit.object.userData.actorId as string);
      return;
    }
    if (this.model && this.raycaster.intersectObject(this.model.meetingTable, true).length) {
      this.callbacks.onSelectMeeting();
      return;
    }
    this.callbacks.onSelectAgent(null);
  };
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
