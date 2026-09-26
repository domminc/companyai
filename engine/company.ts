import { randomUUID } from "node:crypto";
import { type AgentBackend, ClaudeBackend, HermesBackend } from "./backends";
import { HermesClient } from "./hermes";
import { DEFAULT_MODEL, describeError, type LLM } from "./llm";
import {
  findMentions,
  inChunks,
  MEETING_PROTOCOL,
  parseHandRaise,
  pickSpeaker,
  pollPrompt,
  speakerName,
  speechPrompt,
  USER_DISPLAY_NAME,
} from "./meeting";
import {
  agentIdentity,
  CANDIDATE_SCHEMA,
  chatPrompt,
  parseVerdict,
  reviewPrompt,
  minutesPrompt,
  minutesSchema,
  RECRUITER_SYSTEM,
  recruitPrompt,
  SECRETARY_SYSTEM,
  taskPrompt,
  workplaceContext,
} from "./prompts";
import { MemoryStore, type Store } from "./store";
import {
  type ActionItem,
  type Agent,
  type CandidateProfile,
  type ChatMessage,
  type ChatThread,
  type CompanyEvent,
  type CompanyState,
  type FloorVia,
  type HermesGateway,
  type HireInput,
  type Meeting,
  type MeetingEndReason,
  type PollEntry,
  type SpeechEntry,
  type Task,
  type TaskReview,
  USER_SPEAKER,
} from "./types";

const MAX_ACTIVITY = 200;
/** Parallel polls per meeting step; Hermes rejects runs above its concurrency cap. */
const MAX_CONCURRENT_POLLS = 4;

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigneeId?: string | null;
  /** Completion criteria. */
  acceptance?: string;
  /** Who signs off the result (default: nobody). */
  review?: TaskReview;
  /** Tasks that must be done before this one starts. */
  dependsOn?: string[];
}

/** Edits the human makes to a meeting's draft action items before registering them. */
export interface ActionItemEdit {
  title?: string;
  description?: string;
  acceptance?: string;
  assigneeId?: string | null;
  include?: boolean;
}

export interface StartMeetingInput {
  topic: string;
  agenda?: string;
  /** The first participant chairs the meeting. */
  participantIds: string[];
  /** Speaking turns per agent (1-6, default 3). */
  maxTurnsPerAgent?: number;
  /** Turn the minutes' action items into tasks automatically (default true). */
  createTasks?: boolean;
}

export interface CompanyOptions {
  llm: LLM;
  store?: Store;
  /** Injected into Hermes clients (tests use a fake gateway). */
  hermesFetch?: typeof fetch;
}

interface Minutes {
  summary: string;
  decisions: string[];
  actionItems: { title: string; description: string; acceptance?: string; assigneeId: string; after?: number[] }[];
}

/** After this many rejected revisions an AI reviewer hands the task to 대표. */
const MAX_AI_REVISIONS = 2;
const MAX_CHAT_MESSAGES = 200;

const END_REASON_TEXT: Record<MeetingEndReason, string> = {
  all_passed: "모두 PASS해서 회의를 마칩니다.",
  turn_limit: "발언 횟수를 모두 써서 회의를 마칩니다.",
  no_candidates: "발언권이 남은 참석자가 없어 회의를 마칩니다.",
  ended_by_user: `${USER_DISPLAY_NAME}님이 회의를 종료했습니다.`,
};

function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function now() {
  return new Date().toISOString();
}

function emptyState(): CompanyState {
  return {
    name: "My AI Company",
    mission: "",
    defaultModel: DEFAULT_MODEL,
    gateways: [],
    agents: [],
    tasks: [],
    meetings: [],
    chats: [],
    activity: [],
  };
}

function publicAgent(agent: Agent): Agent {
  const copy = structuredClone(agent);
  if (copy.runtime.kind === "hermes") {
    copy.runtime.hasProfileKey = !!copy.runtime.profileKey;
    delete copy.runtime.profileKey;
  }
  return copy;
}

function publicGateway(gateway: HermesGateway): HermesGateway {
  const { apiKey, ...rest } = gateway;
  return { ...rest, hasApiKey: !!apiKey };
}

function parseLooseJSON<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/**
 * The company engine. Owns all state, runs agents' work in the background and
 * reports every change as a CompanyEvent.
 *
 * Scheduling rules (see `dispatch`):
 * - Each agent does one thing at a time: a task or a meeting.
 * - A scheduled meeting starts once all its participants are idle, and
 *   participants of a pending meeting don't pick up new tasks meanwhile.
 * - An idle agent automatically starts its oldest `todo` task.
 *
 * Each agent thinks through an AgentBackend: Claude directly, or a Hermes Agent profile.
 */
export class Company {
  private state: CompanyState = emptyState();
  private listeners = new Set<(e: CompanyEvent) => void>();
  private jobs = new Set<Promise<void>>();
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;
  /** Bumped whenever the human speaks in a meeting, so an all-PASS poll can be re-run. */
  private userMessageSeq = new Map<string, number>();

  private constructor(
    private llm: LLM,
    private store: Store,
    private hermesFetch?: typeof fetch,
  ) {}

  static async open(opts: CompanyOptions): Promise<Company> {
    const company = new Company(opts.llm, opts.store ?? new MemoryStore(), opts.hermesFetch);
    const saved = await company.store.load();
    if (saved) company.state = recoverInterrupted({ ...emptyState(), ...saved });
    company.dispatch();
    return company;
  }

  get provider() {
    return this.llm.name;
  }

  /** Current state with secrets (gateway and profile keys) removed. */
  snapshot(): CompanyState {
    const state = structuredClone(this.state);
    state.agents = this.state.agents.map(publicAgent);
    state.gateways = this.state.gateways.map(publicGateway);
    return state;
  }

  subscribe(listener: (e: CompanyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once pending saves are written (running work is not awaited). */
  async flush(): Promise<void> {
    await this.saving;
  }

  /** Resolves once no task or meeting is running and state has been saved. */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
    await this.saving;
  }

  // ---------------------------------------------------------------- company

  updateCompany(patch: { name?: string; mission?: string; defaultModel?: string }) {
    if (patch.name !== undefined) this.state.name = patch.name.trim() || this.state.name;
    if (patch.mission !== undefined) this.state.mission = patch.mission.trim();
    if (patch.defaultModel) this.state.defaultModel = patch.defaultModel;
    const { name, mission, defaultModel } = this.state;
    this.emit({ type: "company.updated", name, mission, defaultModel });
    this.persist();
  }

  // --------------------------------------------------------------- gateways

  /** Registers a Hermes API Server after checking it answers with these credentials. */
  async addGateway(input: { name?: string; url: string; apiKey?: string }): Promise<HermesGateway> {
    const url = input.url?.trim().replace(/\/+$/, "");
    if (!url || !/^https?:\/\//.test(url)) throw new EngineError("게이트웨이 주소는 http:// 또는 https:// 로 시작해야 합니다.");
    await this.probeHermes({ url, apiKey: input.apiKey?.trim() || undefined });
    const gateway: HermesGateway = {
      id: newId("gw"),
      name: input.name?.trim() || new URL(url).host,
      url,
      apiKey: input.apiKey?.trim() || undefined,
      createdAt: now(),
    };
    this.state.gateways.push(gateway);
    this.emitGateways();
    this.log(`Hermes 게이트웨이 "${gateway.name}"을(를) 연결했습니다.`);
    this.persist();
    return publicGateway(gateway);
  }

  async testGateway(gatewayId: string): Promise<{ ok: true; capabilities: Record<string, unknown> }> {
    const gateway = this.getGateway(gatewayId);
    return { ok: true, capabilities: await this.probeHermes(gateway) };
  }

  removeGateway(gatewayId: string) {
    const gateway = this.getGateway(gatewayId);
    const users = this.state.agents.filter((a) => a.runtime.kind === "hermes" && a.runtime.gatewayId === gatewayId);
    if (users.length) {
      throw new EngineError(`이 게이트웨이를 쓰는 직원이 있습니다: ${users.map((a) => a.name).join(", ")}`, 409);
    }
    this.state.gateways = this.state.gateways.filter((g) => g.id !== gatewayId);
    this.emitGateways();
    this.log(`Hermes 게이트웨이 "${gateway.name}" 연결을 해제했습니다.`);
    this.persist();
  }

  /** Checks that a Hermes profile answers before hiring it. */
  async verifyHermesProfile(input: { gatewayId: string; profile?: string; profileKey?: string }) {
    const gateway = this.getGateway(input.gatewayId);
    await this.probeHermes({ url: gateway.url, apiKey: input.profileKey?.trim() || gateway.apiKey }, input.profile);
  }

  private async probeHermes(target: { url: string; apiKey?: string }, profile?: string) {
    try {
      const client = new HermesClient({ baseUrl: target.url, token: target.apiKey, profile, fetchImpl: this.hermesFetch });
      return await client.capabilities();
    } catch (err) {
      throw new EngineError(`Hermes 연결 확인 실패: ${describeError(err)}`, 502);
    }
  }

  private emitGateways() {
    this.emit({ type: "gateways.updated", gateways: this.state.gateways.map(publicGateway) });
  }

  // ----------------------------------------------------------------- hiring

  /** Ask the LLM to propose a candidate for a job description. Does not hire. */
  async recruit(jobDescription: string): Promise<CandidateProfile> {
    if (!jobDescription.trim()) throw new EngineError("채용 공고 내용을 입력하세요.");
    try {
      return await this.llm.generateJSON<CandidateProfile>({
        model: this.state.defaultModel,
        system: RECRUITER_SYSTEM,
        prompt: recruitPrompt(jobDescription, this.state),
        schema: CANDIDATE_SCHEMA,
        effort: "medium",
        context: { kind: "recruit", jobDescription },
      });
    } catch (err) {
      throw new EngineError(`후보 추천 실패: ${describeError(err)}`, 502);
    }
  }

  hire(input: HireInput): Agent {
    const name = input.name?.trim();
    const role = input.role?.trim();
    if (!name || !role) throw new EngineError("이름과 직무는 필수입니다.");
    let runtime: Agent["runtime"];
    if (input.hermes) {
      this.getGateway(input.hermes.gatewayId);
      runtime = {
        kind: "hermes",
        gatewayId: input.hermes.gatewayId,
        profile: input.hermes.profile?.trim() || "default",
        profileKey: input.hermes.profileKey?.trim() || undefined,
      };
    } else {
      runtime = { kind: "claude", model: input.model || this.state.defaultModel };
    }
    const agent: Agent = {
      id: newId("agt"),
      name,
      role,
      persona: input.persona?.trim() || `${role} 역할을 맡은 성실하고 협업을 잘하는 팀원입니다.`,
      skills: (input.skills ?? []).map((s) => s.trim()).filter(Boolean),
      runtime,
      status: "idle",
      hiredAt: now(),
      stats: { tasksDone: 0, meetingsAttended: 0 },
    };
    this.state.agents.push(agent);
    this.emit({ type: "agent.updated", agent: publicAgent(agent) });
    const via = runtime.kind === "hermes" ? ` (Hermes 프로필 ${runtime.profile})` : "";
    this.log(`${agent.name}님이 ${agent.role}(으)로 입사했습니다${via}.`);
    this.persist();
    return publicAgent(agent);
  }

  updateAgent(
    agentId: string,
    patch: Partial<Pick<Agent, "name" | "role" | "persona" | "skills">> & {
      model?: string;
      hermes?: { profile?: string; profileKey?: string };
    },
  ): Agent {
    const agent = this.getAgent(agentId);
    if (patch.name?.trim()) agent.name = patch.name.trim();
    if (patch.role?.trim()) agent.role = patch.role.trim();
    if (patch.persona !== undefined) agent.persona = patch.persona.trim();
    if (patch.skills) agent.skills = patch.skills.map((s) => s.trim()).filter(Boolean);
    if (patch.model && agent.runtime.kind === "claude") agent.runtime.model = patch.model;
    if (patch.hermes && agent.runtime.kind === "hermes") {
      if (patch.hermes.profile?.trim()) agent.runtime.profile = patch.hermes.profile.trim();
      if (patch.hermes.profileKey !== undefined) agent.runtime.profileKey = patch.hermes.profileKey.trim() || undefined;
    }
    this.emit({ type: "agent.updated", agent: publicAgent(agent) });
    this.persist();
    return publicAgent(agent);
  }

  fire(agentId: string) {
    const agent = this.getAgent(agentId);
    if (agent.status !== "idle") throw new EngineError(`${agent.name}님은 지금 일하는 중이라 내보낼 수 없습니다.`, 409);
    this.state.agents = this.state.agents.filter((a) => a.id !== agentId);
    for (const task of this.state.tasks) {
      let changed = false;
      if (task.assigneeId === agentId && task.status === "todo") {
        task.assigneeId = null;
        changed = true;
      }
      if (task.review.mode === "agent" && task.review.reviewerId === agentId) {
        task.review = { mode: "human" };
        changed = true;
      }
      if (changed) {
        task.updatedAt = now();
        this.emit({ type: "task.updated", task });
      }
    }
    if (this.state.chats.some((c) => c.agentId === agentId)) {
      this.state.chats = this.state.chats.filter((c) => c.agentId !== agentId);
      this.emit({ type: "chat.cleared", agentId });
    }
    for (const meeting of this.state.meetings) {
      if (meeting.status !== "scheduled" || !meeting.participantIds.includes(agentId)) continue;
      meeting.participantIds = meeting.participantIds.filter((id) => id !== agentId);
      if (meeting.participantIds.length < 2) {
        meeting.status = "failed";
        meeting.error = "참석자가 부족해 회의가 취소되었습니다.";
      }
      this.emit({ type: "meeting.updated", meeting });
    }
    this.emit({ type: "agent.fired", agentId });
    this.log(`${agent.name}님이 퇴사했습니다.`);
    this.persist();
    this.dispatch();
  }

  // ------------------------------------------------------------------ tasks

  createTask(input: CreateTaskInput & { sourceMeetingId?: string }): Task {
    const task = this.addTask(input);
    this.persist();
    this.dispatch();
    return task;
  }

  /** Records a task without starting anything (callers dispatch). */
  private addTask(input: CreateTaskInput & { sourceMeetingId?: string }): Task {
    const title = input.title?.trim();
    if (!title) throw new EngineError("업무 제목은 필수입니다.");
    if (input.assigneeId) this.getAgent(input.assigneeId);
    const assigneeId = input.assigneeId || null;
    const task: Task = {
      id: newId("tsk"),
      title,
      description: input.description?.trim() ?? "",
      assigneeId,
      status: "todo",
      output: "",
      sourceMeetingId: input.sourceMeetingId,
      acceptance: input.acceptance?.trim() || undefined,
      dependsOn: [...new Set(input.dependsOn ?? [])].filter((id) => this.state.tasks.some((t) => t.id === id)),
      review: this.checkReview(input.review, assigneeId),
      revision: 0,
      reviews: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.tasks.push(task);
    this.emit({ type: "task.updated", task });
    return task;
  }

  private checkReview(review: TaskReview | undefined, assigneeId: string | null): TaskReview {
    if (!review || review.mode === "none") return { mode: "none" };
    if (review.mode === "human") return { mode: "human" };
    if (review.mode === "agent") {
      if (!review.reviewerId) throw new EngineError("검토할 동료를 고르세요.");
      this.getAgent(review.reviewerId);
      if (review.reviewerId === assigneeId) throw new EngineError("담당자가 자기 업무를 검토할 수는 없습니다.");
      return { mode: "agent", reviewerId: review.reviewerId };
    }
    throw new EngineError("알 수 없는 검토 방식입니다.");
  }

  updateTask(
    taskId: string,
    patch: { title?: string; description?: string; assigneeId?: string | null; acceptance?: string; review?: TaskReview },
  ): Task {
    const task = this.getTask(taskId);
    if (task.status === "in_progress" || task.reviewing) throw new EngineError("진행 중인 업무는 수정할 수 없습니다.", 409);
    if (patch.title?.trim()) task.title = patch.title.trim();
    if (patch.description !== undefined) task.description = patch.description.trim();
    if (patch.acceptance !== undefined) task.acceptance = patch.acceptance.trim() || undefined;
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId) this.getAgent(patch.assigneeId);
      task.assigneeId = patch.assigneeId || null;
    }
    if (patch.review !== undefined || patch.assigneeId !== undefined) {
      task.review = this.checkReview(patch.review ?? task.review, task.assigneeId);
    }
    task.updatedAt = now();
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
    return task;
  }

  /** Put a finished or failed task back in the queue, from scratch. */
  retryTask(taskId: string): Task {
    const task = this.getTask(taskId);
    if (task.status === "in_progress" || task.reviewing) throw new EngineError("이미 진행 중입니다.", 409);
    task.status = "todo";
    task.output = "";
    task.previousOutput = undefined;
    task.error = undefined;
    task.updatedAt = now();
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
    return task;
  }

  deleteTask(taskId: string) {
    const task = this.getTask(taskId);
    if (task.status === "in_progress" || task.reviewing) throw new EngineError("진행 중인 업무는 삭제할 수 없습니다.", 409);
    this.state.tasks = this.state.tasks.filter((t) => t.id !== taskId);
    for (const other of this.state.tasks) {
      if (!other.dependsOn.includes(taskId)) continue;
      other.dependsOn = other.dependsOn.filter((id) => id !== taskId);
      this.emit({ type: "task.updated", task: other });
    }
    this.emit({ type: "task.deleted", taskId });
    this.persist();
    this.dispatch();
  }

  /** 대표 signs off (or sends back) a task waiting in review. */
  reviewTask(taskId: string, input: { approve: boolean; comment?: string }): Task {
    const task = this.getTask(taskId);
    if (task.status !== "review") throw new EngineError("검토를 기다리는 업무가 아닙니다.", 409);
    if (task.reviewing) throw new EngineError("AI 동료가 검토하는 중입니다.", 409);
    const comment = input.comment?.trim() ?? "";
    if (!input.approve && !comment) throw new EngineError("무엇을 고쳐야 하는지 적어 주세요.");
    this.applyVerdict(task, USER_SPEAKER, input.approve ? "approved" : "changes", comment);
    return task;
  }

  private applyVerdict(task: Task, by: string, verdict: "approved" | "changes", comment: string) {
    const who = speakerName(by, this.state);
    task.reviews.push({ by, verdict, comment, revision: task.revision, at: now() });
    if (verdict === "approved") {
      task.status = "done";
      const assignee = this.state.agents.find((a) => a.id === task.assigneeId);
      if (assignee) {
        assignee.stats.tasksDone += 1;
        this.emit({ type: "agent.updated", agent: publicAgent(assignee) });
      }
      this.log(`${who}님이 "${task.title}"을(를) 승인했습니다.`);
    } else {
      task.previousOutput = task.output;
      task.output = "";
      task.revision += 1;
      task.status = "todo";
      this.log(`${who}님이 "${task.title}" 수정을 요청했습니다: ${comment}`);
    }
    task.updatedAt = now();
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
  }

  /** Hands a task in review over to 대표, e.g. when an AI reviewer can't settle it. */
  private escalate(task: Task, reason: string) {
    task.review = { mode: "human" };
    task.updatedAt = now();
    this.log(reason);
    this.emit({ type: "task.updated", task });
  }

  private depsDone(task: Task): boolean {
    return task.dependsOn.every((id) => {
      const dep = this.state.tasks.find((t) => t.id === id);
      return !dep || dep.status === "done";
    });
  }

  // ------------------------------------------------------------------- chat

  /** 대표 says something to one employee; the reply streams in as chat events. */
  chat(agentId: string, content: string): ChatThread {
    const agent = this.getAgent(agentId);
    const text = content?.trim();
    if (!text) throw new EngineError("메시지를 입력하세요.");
    let thread = this.state.chats.find((c) => c.agentId === agentId);
    if (!thread) {
      thread = { agentId, messages: [], replying: false };
      this.state.chats.push(thread);
    }
    if (thread.replying) throw new EngineError(`${agent.name}님이 아직 답하는 중입니다.`, 409);
    const history = thread.messages.filter((m) => !m.error).map(({ from, content }) => ({ from, content }));
    thread.messages.push({ id: newId("msg"), from: "user", content: text, at: now() });
    const reply: ChatMessage = { id: newId("msg"), from: "agent", content: "", at: now() };
    thread.messages.push(reply);
    if (thread.messages.length > MAX_CHAT_MESSAGES) thread.messages.splice(0, thread.messages.length - MAX_CHAT_MESSAGES);
    thread.replying = true;
    this.emit({ type: "chat.updated", thread });
    this.persist();
    this.track(this.runChat(agent, thread, reply, history, text));
    return thread;
  }

  clearChat(agentId: string) {
    const thread = this.state.chats.find((c) => c.agentId === agentId);
    if (!thread) return;
    if (thread.replying) throw new EngineError("답변이 끝난 뒤에 지울 수 있습니다.", 409);
    this.state.chats = this.state.chats.filter((c) => c !== thread);
    this.emit({ type: "chat.cleared", agentId });
    this.persist();
  }

  private async runChat(agent: Agent, thread: ChatThread, reply: ChatMessage, history: { from: "user" | "agent"; content: string }[], text: string) {
    try {
      reply.content = await this.backendFor(agent).run(
        {
          identity: agentIdentity(agent),
          instructions: workplaceContext(agent, this.state),
          prompt: chatPrompt(history, text, agent.name),
          effort: "medium",
          context: { kind: "chat", agentName: agent.name, role: agent.role, message: text },
        },
        {
          onDelta: (delta) => {
            reply.content += delta;
            this.emit({ type: "chat.delta", agentId: agent.id, messageId: reply.id, text: delta });
          },
        },
      );
    } catch (err) {
      reply.content = `(답하지 못했습니다: ${describeError(err)})`;
      reply.error = true;
    } finally {
      reply.endedAt = now();
      thread.replying = false;
      if (this.state.chats.includes(thread)) this.emit({ type: "chat.updated", thread });
      this.persist();
    }
  }

  // --------------------------------------------------------------- meetings

  startMeeting(input: StartMeetingInput): Meeting {
    const topic = input.topic?.trim();
    if (!topic) throw new EngineError("회의 주제는 필수입니다.");
    const participantIds = [...new Set(input.participantIds ?? [])];
    if (participantIds.length < 2) throw new EngineError("회의에는 2명 이상 참석해야 합니다.");
    participantIds.forEach((id) => this.getAgent(id));
    const maxTurnsPerAgent = Math.min(Math.max(Math.round(input.maxTurnsPerAgent ?? 3), 1), 6);
    const meeting: Meeting = {
      id: newId("mtg"),
      topic,
      agenda: input.agenda?.trim() ?? "",
      participantIds,
      maxTurnsPerAgent,
      maxTotalTurns: maxTurnsPerAgent * participantIds.length,
      status: "scheduled",
      transcript: [],
      floorQueue: [],
      summary: "",
      decisions: [],
      actionItems: [],
      autoCreateTasks: input.createTasks !== false,
      outcome: "none",
      createdAt: now(),
    };
    this.state.meetings.push(meeting);
    this.emit({ type: "meeting.updated", meeting });
    this.log(`회의 "${topic}"이(가) 소집되었습니다.`);
    this.persist();
    this.dispatch();
    return meeting;
  }

  cancelMeeting(meetingId: string): Meeting {
    const meeting = this.getMeeting(meetingId);
    if (meeting.status !== "scheduled") throw new EngineError("대기 중인 회의만 취소할 수 있습니다.", 409);
    meeting.status = "failed";
    meeting.error = "회의가 취소되었습니다.";
    this.emit({ type: "meeting.updated", meeting });
    this.persist();
    this.dispatch();
    return meeting;
  }

  /** The human speaks in a running meeting. `@Name` hands that participant the floor next. */
  postMeetingMessage(meetingId: string, content: string): Meeting {
    const meeting = this.getRunningMeeting(meetingId);
    const text = content?.trim();
    if (!text) throw new EngineError("발언 내용을 입력하세요.");
    const entry: SpeechEntry = { kind: "speech", id: newId("spc"), speakerId: USER_SPEAKER, content: text, via: "user", at: now(), endedAt: now() };
    meeting.transcript.push(entry);
    const participants = meeting.participantIds.map((id) => this.state.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
    for (const agentId of findMentions(text, participants)) this.queueFloor(meeting, agentId, "user");
    this.userMessageSeq.set(meeting.id, (this.userMessageSeq.get(meeting.id) ?? 0) + 1);
    meeting.userJoined = true;
    this.emit({ type: "meeting.updated", meeting });
    this.persist();
    return meeting;
  }

  /** The human gives a participant the floor next (skips the turn quota). */
  grantFloor(meetingId: string, agentId: string): Meeting {
    const meeting = this.getRunningMeeting(meetingId);
    if (!meeting.participantIds.includes(agentId)) throw new EngineError("회의 참석자가 아닙니다.", 404);
    this.queueFloor(meeting, agentId, "user");
    this.emit({ type: "meeting.updated", meeting });
    return meeting;
  }

  /** Ends a running meeting after the current speaker finishes, then writes the minutes. */
  endMeeting(meetingId: string): Meeting {
    const meeting = this.getMeeting(meetingId);
    if (meeting.status === "scheduled") return this.cancelMeeting(meetingId);
    if (meeting.status !== "running") throw new EngineError("진행 중인 회의가 아닙니다.", 409);
    meeting.endRequested = true;
    this.emit({ type: "meeting.updated", meeting });
    return meeting;
  }

  /** Turn one action item of a finished meeting into a task (if not already). */
  /** 대표 walks into (or out of) a running meeting. Speaking also joins. */
  joinMeeting(meetingId: string, joined = true): Meeting {
    const meeting = this.getMeeting(meetingId);
    if (meeting.status !== "running") throw new EngineError("진행 중인 회의가 아닙니다.", 409);
    meeting.userJoined = joined;
    this.emit({ type: "meeting.updated", meeting });
    this.persist();
    return meeting;
  }

  /**
   * Turns a meeting's draft action items into tasks, after 대표's edits. Items can be dropped
   * (`include: false`); `after` links become task dependencies among the kept items.
   */
  registerOutcome(meetingId: string, input: { items?: (ActionItemEdit | null)[]; review?: TaskReview } = {}): Task[] {
    const meeting = this.getMeeting(meetingId);
    if (meeting.outcome !== "draft") throw new EngineError("등록할 회의 결과 초안이 없습니다.", 409);
    input.items?.forEach((edit, i) => {
      const item = meeting.actionItems[i];
      if (!item || !edit) return;
      if (edit.title !== undefined) item.title = edit.title.trim();
      if (edit.description !== undefined) item.description = edit.description.trim();
      if (edit.acceptance !== undefined) item.acceptance = edit.acceptance.trim();
      if (edit.include !== undefined) item.include = edit.include;
      if (edit.assigneeId !== undefined) {
        if (edit.assigneeId) this.getAgent(edit.assigneeId);
        item.assigneeId = edit.assigneeId || null;
      }
    });
    if (input.review?.mode === "agent") this.checkReview(input.review, null);
    return this.registerItems(meeting, input.review);
  }

  private registerItems(meeting: Meeting, review?: TaskReview): Task[] {
    const created: (Task | undefined)[] = [];
    meeting.actionItems.forEach((item, i) => {
      if (!item.include || !item.title.trim()) return;
      const assigneeId = item.assigneeId && this.state.agents.some((a) => a.id === item.assigneeId) ? item.assigneeId : null;
      // Nobody reviews their own work: fall back to 대표 for that item.
      const itemReview: TaskReview | undefined =
        review?.mode === "agent" && review.reviewerId === assigneeId ? { mode: "human" } : review;
      const task = this.addTask({
        title: item.title,
        description: item.description,
        acceptance: item.acceptance,
        assigneeId,
        sourceMeetingId: meeting.id,
        review: itemReview,
        dependsOn: item.after.map((j) => created[j]?.id).filter((id): id is string => !!id),
      });
      item.taskId = task.id;
      created[i] = task;
    });
    meeting.outcome = "registered";
    const tasks = created.filter((t): t is Task => !!t);
    this.log(`회의 "${meeting.topic}"의 결과를 업무 ${tasks.length}건으로 등록했습니다.`);
    this.emit({ type: "meeting.updated", meeting });
    this.persist();
    this.dispatch();
    return tasks;
  }

  promoteActionItem(meetingId: string, index: number): Task {
    const meeting = this.getMeeting(meetingId);
    const item = meeting.actionItems[index];
    if (!item) throw new EngineError("해당 액션 아이템이 없습니다.", 404);
    if (item.taskId && this.state.tasks.some((t) => t.id === item.taskId)) {
      return this.getTask(item.taskId);
    }
    return this.taskFromActionItem(meeting, item);
  }

  private queueFloor(meeting: Meeting, agentId: string, by: "user" | "mention") {
    const existing = meeting.floorQueue.findIndex((q) => q.agentId === agentId);
    if (by === "user") {
      // The human's grants go ahead of mention grants and replace a queued mention.
      if (existing !== -1) meeting.floorQueue.splice(existing, 1);
      const firstMention = meeting.floorQueue.findIndex((q) => q.by === "mention");
      meeting.floorQueue.splice(firstMention === -1 ? meeting.floorQueue.length : firstMention, 0, { agentId, by });
    } else if (existing === -1) {
      meeting.floorQueue.push({ agentId, by });
    }
  }

  // -------------------------------------------------------------- scheduler

  private dispatch() {
    const idle = (id: string) => this.state.agents.find((a) => a.id === id)?.status === "idle";

    for (const meeting of this.state.meetings) {
      if (meeting.status === "scheduled" && meeting.participantIds.every(idle)) this.track(this.runMeeting(meeting));
    }

    const reserved = new Set(
      this.state.meetings.filter((m) => m.status === "scheduled").flatMap((m) => m.participantIds),
    );
    for (const agent of this.state.agents) {
      if (agent.status !== "idle" || reserved.has(agent.id)) continue;
      // Reviewing a colleague's finished work comes before starting new work.
      const review = this.state.tasks.find(
        (t) => t.status === "review" && t.review.mode === "agent" && t.review.reviewerId === agent.id && !t.reviewing,
      );
      if (review) {
        this.track(this.runReview(review, agent));
        continue;
      }
      const next = this.state.tasks.find((t) => t.status === "todo" && t.assigneeId === agent.id && this.depsDone(t));
      if (next) this.track(this.runTask(next, agent));
    }
  }

  private track(job: Promise<void>) {
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
  }

  private backendFor(agent: Agent): AgentBackend {
    if (agent.runtime.kind === "claude") return new ClaudeBackend(this.llm, agent.runtime.model);
    const gateway = this.getGateway(agent.runtime.gatewayId);
    return new HermesBackend(
      new HermesClient({
        baseUrl: gateway.url,
        token: agent.runtime.profileKey || gateway.apiKey,
        profile: agent.runtime.profile,
        fetchImpl: this.hermesFetch,
      }),
    );
  }

  private async runTask(task: Task, agent: Agent) {
    // Synchronous part: claim the agent before dispatch() looks again.
    agent.status = "working";
    task.status = "in_progress";
    task.output = "";
    task.error = undefined;
    task.updatedAt = now();
    this.emit({ type: "agent.updated", agent: publicAgent(agent) });
    this.emit({ type: "task.updated", task });
    this.log(`${agent.name}님이 "${task.title}" 업무를 시작했습니다.`);

    const sourceMeeting = task.sourceMeetingId
      ? this.state.meetings.find((m) => m.id === task.sourceMeetingId)
      : undefined;
    try {
      const output = await this.backendFor(agent).run(
        {
          identity: agentIdentity(agent),
          instructions: workplaceContext(agent, this.state),
          prompt: taskPrompt(task, sourceMeeting),
          effort: "high",
          context: { kind: "task", agentName: agent.name, role: agent.role, title: task.title },
        },
        {
          onDelta: (text) => {
            task.output += text;
            this.emit({ type: "task.delta", taskId: task.id, text });
          },
          onTool: (tool) => {
            task.activeTool = tool ?? undefined;
            this.emit({ type: "task.updated", task });
          },
        },
      );
      task.output = output;
      if (task.review.mode === "none") {
        task.status = "done";
        agent.stats.tasksDone += 1;
        this.log(`${agent.name}님이 "${task.title}" 업무를 완료했습니다.`);
      } else {
        task.status = "review";
        const reviewer = task.review.mode === "human" ? USER_DISPLAY_NAME : speakerName(task.review.reviewerId!, this.state);
        this.log(`${agent.name}님이 "${task.title}" 업무를 마치고 ${reviewer}님께 검토를 요청했습니다.`);
      }
    } catch (err) {
      task.status = "failed";
      task.error = describeError(err);
      this.log(`"${task.title}" 업무 실패: ${task.error}`, "error");
    } finally {
      task.activeTool = undefined;
      task.updatedAt = now();
      agent.status = "idle";
      this.emit({ type: "task.updated", task });
      this.emit({ type: "agent.updated", agent: publicAgent(agent) });
      this.persist();
      this.dispatch();
    }
  }

  /** An AI colleague reviews finished work and approves it or sends it back. */
  private async runReview(task: Task, reviewer: Agent) {
    reviewer.status = "working";
    task.reviewing = true;
    this.emit({ type: "agent.updated", agent: publicAgent(reviewer) });
    this.emit({ type: "task.updated", task });
    this.log(`${reviewer.name}님이 "${task.title}" 검토를 시작했습니다.`);
    const assignee = this.state.agents.find((a) => a.id === task.assigneeId);
    try {
      const answer = await this.backendFor(reviewer).run({
        identity: agentIdentity(reviewer),
        instructions: workplaceContext(reviewer, this.state),
        prompt: reviewPrompt(task, assignee?.name ?? "A colleague"),
        effort: "medium",
        context: { kind: "review", agentName: reviewer.name, title: task.title, revision: task.revision },
      });
      task.reviewing = false;
      const { verdict, comment } = parseVerdict(answer);
      if (verdict === "unclear") {
        this.escalate(task, `${reviewer.name}님의 검토 의견이 분명하지 않아 "${task.title}"을(를) ${USER_DISPLAY_NAME}님 검토로 넘깁니다.`);
      } else if (verdict === "changes" && task.revision >= MAX_AI_REVISIONS) {
        task.reviews.push({ by: reviewer.id, verdict, comment, revision: task.revision, at: now() });
        this.escalate(task, `"${task.title}"이(가) ${task.revision + 1}번째도 반려되어 ${USER_DISPLAY_NAME}님 검토로 넘깁니다.`);
      } else {
        this.applyVerdict(task, reviewer.id, verdict, comment);
      }
    } catch (err) {
      task.reviewing = false;
      this.escalate(task, `${reviewer.name}님이 "${task.title}"을(를) 검토하지 못해 ${USER_DISPLAY_NAME}님 검토로 넘깁니다: ${describeError(err)}`);
    } finally {
      reviewer.status = "idle";
      this.emit({ type: "agent.updated", agent: publicAgent(reviewer) });
      this.emit({ type: "task.updated", task });
      this.persist();
      this.dispatch();
    }
  }

  // ------------------------------------------------------ meeting run loop

  private async runMeeting(meeting: Meeting) {
    const participants = meeting.participantIds.map((id) => this.getAgent(id));
    meeting.status = "running";
    for (const agent of participants) {
      agent.status = "in_meeting";
      this.emit({ type: "agent.updated", agent: publicAgent(agent) });
    }
    this.emit({ type: "meeting.updated", meeting });
    this.log(`회의 "${meeting.topic}"이(가) 시작되었습니다.`);

    const turnsTaken = new Map<string, number>();
    const lastSpokeAt = new Map<string, number>();
    const remaining = (id: string) => meeting.maxTurnsPerAgent - (turnsTaken.get(id) ?? 0);
    let clock = 0;
    let totalTurns = 0;
    let endReason: MeetingEndReason | null = null;

    try {
      for (let opening = true; ; opening = false) {
        if (meeting.endRequested) endReason = "ended_by_user";
        else if (totalTurns >= meeting.maxTotalTurns) endReason = "turn_limit";
        if (endReason) break;

        let floor: { agentId: string; via: FloorVia; reason?: string } | null = null;
        if (opening) {
          floor = { agentId: participants[0].id, via: "opening" };
        } else {
          floor = this.takeGrant(meeting, remaining);
          if (!floor) {
            const candidates = participants.map((a) => a.id).filter((id) => remaining(id) > 0);
            if (!candidates.length) {
              endReason = "no_candidates";
              break;
            }
            const seqBefore = this.userMessageSeq.get(meeting.id) ?? 0;
            const poll = await this.pollParticipants(meeting, candidates, turnsTaken, remaining);
            if (poll.failures.length === candidates.length) {
              throw new Error(`참석자 모두에게 연결하지 못했습니다: ${poll.failures[0].reason}`);
            }
            if (meeting.endRequested || meeting.floorQueue.length) continue;
            if (!poll.raises.length) {
              // The human spoke while everyone was deciding: ask again with that in view.
              if ((this.userMessageSeq.get(meeting.id) ?? 0) !== seqBefore) continue;
              endReason = "all_passed";
              break;
            }
            const agentId = pickSpeaker(poll.raises.map((r) => r.agentId), lastSpokeAt, meeting.participantIds)!;
            floor = { agentId, via: "hand", reason: poll.raises.find((r) => r.agentId === agentId)?.reason };
          }
        }

        const speaker = participants.find((a) => a.id === floor.agentId)!;
        const content = await this.speak(meeting, speaker, floor.via, floor.reason, {
          turnNumber: totalTurns + 1,
          remainingAfter: Math.max(remaining(speaker.id) - 1, 0),
        });
        turnsTaken.set(speaker.id, (turnsTaken.get(speaker.id) ?? 0) + 1);
        lastSpokeAt.set(speaker.id, ++clock);
        totalTurns += 1;
        for (const agentId of findMentions(content, participants, speaker.id)) this.queueFloor(meeting, agentId, "mention");
      }

      meeting.endReason = endReason;
      this.notice(meeting, END_REASON_TEXT[endReason]);
      meeting.phase = "summarizing";
      meeting.currentSpeakerId = undefined;
      meeting.floorQueue = [];
      this.emit({ type: "meeting.updated", meeting });

      const spoken = meeting.transcript.some((e) => e.kind === "speech" && e.content.trim());
      if (spoken) {
        const minutes = await this.writeMinutes(meeting, participants);
        meeting.summary = minutes.summary;
        meeting.decisions = minutes.decisions ?? [];
        meeting.actionItems = (minutes.actionItems ?? []).map((a, i) => ({
          title: a.title,
          description: a.description,
          acceptance: a.acceptance ?? "",
          assigneeId: meeting.participantIds.includes(a.assigneeId) ? a.assigneeId : null,
          // Only earlier items may be prerequisites, so there can be no cycles.
          after: [...new Set(a.after ?? [])].filter((j) => Number.isInteger(j) && j >= 0 && j < i),
          include: true,
        }));
        meeting.outcome = meeting.actionItems.length ? "draft" : "none";
      } else {
        meeting.summary = "발언 없이 회의가 끝났습니다.";
      }
      meeting.status = "done";
      for (const agent of participants) if (turnsTaken.has(agent.id)) agent.stats.meetingsAttended += 1;
      this.log(`회의 "${meeting.topic}"이(가) 끝났습니다. 액션 아이템 ${meeting.actionItems.length}건.`);
    } catch (err) {
      meeting.status = "failed";
      meeting.error = describeError(err);
      this.log(`회의 "${meeting.topic}" 실패: ${meeting.error}`, "error");
    } finally {
      meeting.endedAt = now();
      meeting.phase = undefined;
      meeting.currentSpeakerId = undefined;
      meeting.floorQueue = [];
      this.userMessageSeq.delete(meeting.id);
      for (const agent of participants) {
        agent.status = "idle";
        this.emit({ type: "agent.updated", agent: publicAgent(agent) });
      }
      if (meeting.status === "done" && meeting.autoCreateTasks && meeting.outcome === "draft") {
        this.registerItems(meeting);
      }
      this.emit({ type: "meeting.updated", meeting });
      this.persist();
      this.dispatch();
    }
  }

  /** Next queued grant. The human's grants skip the quota; mention grants need turns left. */
  private takeGrant(meeting: Meeting, remaining: (id: string) => number) {
    while (meeting.floorQueue.length) {
      const next = meeting.floorQueue.shift()!;
      if (next.by === "user") return { agentId: next.agentId, via: "user_grant" as const };
      if (remaining(next.agentId) > 0) return { agentId: next.agentId, via: "mention" as const };
      this.notice(meeting, `${speakerName(next.agentId, this.state)}님은 발언 횟수를 다 써서 지명을 건너뜁니다.`);
    }
    return null;
  }

  private async pollParticipants(
    meeting: Meeting,
    candidateIds: string[],
    turnsTaken: Map<string, number>,
    remaining: (id: string) => number,
  ): Promise<PollEntry> {
    meeting.phase = "polling";
    meeting.currentSpeakerId = undefined;
    this.emit({ type: "meeting.updated", meeting });

    const results = await inChunks(candidateIds, MAX_CONCURRENT_POLLS, async (agentId) => {
      const agent = this.getAgent(agentId);
      const answer = await this.backendFor(agent).run({
        identity: agentIdentity(agent),
        instructions: `${workplaceContext(agent, this.state)}\n\n${MEETING_PROTOCOL}`,
        prompt: pollPrompt(meeting, this.state, remaining(agentId)),
        effort: "low",
        context: { kind: "poll", agentName: agent.name, turnsTaken: turnsTaken.get(agentId) ?? 0, remaining: remaining(agentId) },
      });
      return { agentId, ...parseHandRaise(answer) };
    });

    const poll: PollEntry = { kind: "poll", id: newId("pol"), at: now(), raises: [], passes: [], failures: [] };
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        poll.failures.push({ agentId: candidateIds[i], reason: describeError(result.reason) });
      } else if (result.value.wantsToSpeak) {
        poll.raises.push({ agentId: result.value.agentId, reason: result.value.reason });
      } else {
        poll.passes.push(result.value.agentId);
      }
    });
    meeting.transcript.push(poll);
    this.emit({ type: "meeting.updated", meeting });
    return poll;
  }

  /** One agent's turn. A failed turn is noted and counted, so the meeting moves on. */
  private async speak(
    meeting: Meeting,
    agent: Agent,
    via: FloorVia,
    reason: string | undefined,
    info: { turnNumber: number; remainingAfter: number },
  ): Promise<string> {
    const prompt = speechPrompt(meeting, this.state, agent, { ...info, via, reason });
    const entry: SpeechEntry = { kind: "speech", id: newId("spc"), speakerId: agent.id, content: "", via, reason, at: now() };
    meeting.transcript.push(entry);
    meeting.phase = "speaking";
    meeting.currentSpeakerId = agent.id;
    this.emit({ type: "meeting.updated", meeting });
    try {
      entry.content = await this.backendFor(agent).run(
        {
          identity: agentIdentity(agent),
          instructions: `${workplaceContext(agent, this.state)}\n\n${MEETING_PROTOCOL}`,
          prompt,
          effort: "medium",
          context: {
            kind: "meeting",
            agentName: agent.name,
            role: agent.role,
            topic: meeting.topic,
            opening: via === "opening",
            last: info.remainingAfter === 0,
            others: meeting.participantIds.filter((id) => id !== agent.id).map((id) => speakerName(id, this.state)),
          },
        },
        {
          onDelta: (text) => {
            entry.content += text;
            this.emit({ type: "meeting.delta", meetingId: meeting.id, entryId: entry.id, text });
          },
        },
      );
    } catch (err) {
      this.notice(meeting, `${agent.name}님의 발언이 실패했습니다: ${describeError(err)}`);
    }
    entry.endedAt = now();
    this.emit({ type: "meeting.updated", meeting });
    return entry.content;
  }

  private async writeMinutes(meeting: Meeting, participants: Agent[]): Promise<Minutes> {
    const prompt = minutesPrompt(meeting, this.state);
    const schema = minutesSchema(meeting.participantIds);
    // Without a Claude key, let a Hermes participant take the minutes rather than faking them.
    const hermesScribe = this.llm.name === "mock" ? participants.find((a) => a.runtime.kind === "hermes") : undefined;
    if (hermesScribe) {
      const answer = await this.backendFor(hermesScribe).run({
        identity: "",
        instructions: SECRETARY_SYSTEM,
        prompt: `${prompt}\n\nReply with only a JSON object matching this schema, no other text:\n${JSON.stringify(schema)}`,
        context: { kind: "task", agentName: hermesScribe.name, role: "secretary", title: "minutes" },
      });
      return parseLooseJSON<Minutes>(answer);
    }
    return this.llm.generateJSON<Minutes>({
      model: this.state.defaultModel,
      system: SECRETARY_SYSTEM,
      prompt,
      schema,
      effort: "medium",
      context: {
        kind: "minutes",
        topic: meeting.topic,
        participants: participants.map((p) => ({ id: p.id, name: p.name, role: p.role })),
      },
    });
  }

  private taskFromActionItem(meeting: Meeting, item: ActionItem, notify = true): Task {
    const assigneeId = item.assigneeId && this.state.agents.some((a) => a.id === item.assigneeId) ? item.assigneeId : null;
    const task = this.createTask({
      title: item.title,
      description: item.description,
      acceptance: item.acceptance,
      assigneeId,
      sourceMeetingId: meeting.id,
    });
    item.taskId = task.id;
    if (notify) this.emit({ type: "meeting.updated", meeting });
    return task;
  }

  // ---------------------------------------------------------------- helpers

  private notice(meeting: Meeting, text: string) {
    meeting.transcript.push({ kind: "notice", id: newId("ntc"), at: now(), text });
  }

  private getAgent(id: string): Agent {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new EngineError(`직원을 찾을 수 없습니다: ${id}`, 404);
    return agent;
  }

  private getGateway(id: string): HermesGateway {
    const gateway = this.state.gateways.find((g) => g.id === id);
    if (!gateway) throw new EngineError(`Hermes 게이트웨이를 찾을 수 없습니다: ${id}`, 404);
    return gateway;
  }

  private getTask(id: string): Task {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new EngineError(`업무를 찾을 수 없습니다: ${id}`, 404);
    return task;
  }

  private getMeeting(id: string): Meeting {
    const meeting = this.state.meetings.find((m) => m.id === id);
    if (!meeting) throw new EngineError(`회의를 찾을 수 없습니다: ${id}`, 404);
    return meeting;
  }

  private getRunningMeeting(id: string): Meeting {
    const meeting = this.getMeeting(id);
    if (meeting.status !== "running") throw new EngineError("진행 중인 회의가 아닙니다.", 409);
    if (meeting.endRequested || meeting.phase === "summarizing") throw new EngineError("회의가 마무리되는 중입니다.", 409);
    return meeting;
  }

  private log(message: string, level: "info" | "error" = "info") {
    const entry = { id: newId("act"), at: now(), level, message };
    this.state.activity.push(entry);
    if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    this.emit({ type: "activity", entry });
  }

  private emit(event: CompanyEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("listener failed", err);
      }
    }
  }

  /** Coalesce saves: at most one in flight and one queued. */
  private persist() {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving.then(async () => {
      this.saveQueued = false;
      try {
        await this.store.save(this.state);
      } catch (err) {
        console.error("failed to save company state", err);
      }
    });
  }
}

/** Work that was running when the process stopped cannot be resumed mid-stream. */
function recoverInterrupted(state: CompanyState): CompanyState {
  for (const agent of state.agents) agent.status = "idle";
  for (const task of state.tasks) {
    // Fill fields added after the data was saved.
    task.dependsOn ??= [];
    task.review ??= { mode: "none" };
    task.revision ??= 0;
    task.reviews ??= [];
    task.reviewing = false;
    task.activeTool = undefined;
    if (task.status === "in_progress") {
      task.status = "todo";
      task.output = "";
    }
  }
  for (const meeting of state.meetings) {
    meeting.floorQueue ??= [];
    for (const item of meeting.actionItems) {
      item.acceptance ??= "";
      item.after ??= [];
      item.include ??= true;
    }
    meeting.outcome ??= meeting.actionItems.some((i) => i.taskId) ? "registered" : meeting.actionItems.length ? "draft" : "none";
    meeting.phase = undefined;
    meeting.currentSpeakerId = undefined;
    if (meeting.status === "running") {
      meeting.status = "failed";
      meeting.error = "서버가 재시작되어 회의가 중단되었습니다.";
    }
  }
  state.chats ??= [];
  for (const thread of state.chats) {
    thread.replying = false;
    for (const m of thread.messages) {
      if (m.from === "agent" && !m.endedAt) {
        m.endedAt = m.at;
        m.error = true;
        m.content ||= "(서버가 재시작되어 답변이 중단되었습니다)";
      }
    }
  }
  return state;
}
