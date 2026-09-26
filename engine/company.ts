import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, describeError, type LLM } from "./llm";
import {
  agentSystemPrompt,
  CANDIDATE_SCHEMA,
  meetingTurnPrompt,
  minutesPrompt,
  minutesSchema,
  RECRUITER_SYSTEM,
  recruitPrompt,
  SECRETARY_SYSTEM,
  taskPrompt,
} from "./prompts";
import { MemoryStore, type Store } from "./store";
import type {
  ActionItem,
  Agent,
  CandidateProfile,
  CompanyEvent,
  CompanyState,
  HireInput,
  Meeting,
  Task,
  Utterance,
} from "./types";

const MAX_ACTIVITY = 200;

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
}

export interface StartMeetingInput {
  topic: string;
  agenda?: string;
  participantIds: string[];
  rounds?: number;
  /** Turn the minutes' action items into tasks automatically (default true). */
  createTasks?: boolean;
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function now() {
  return new Date().toISOString();
}

function emptyState(): CompanyState {
  return { name: "My AI Company", mission: "", defaultModel: DEFAULT_MODEL, agents: [], tasks: [], meetings: [], activity: [] };
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
 */
export class Company {
  private state: CompanyState = emptyState();
  private listeners = new Set<(e: CompanyEvent) => void>();
  private jobs = new Set<Promise<void>>();
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;

  private constructor(
    private llm: LLM,
    private store: Store,
  ) {}

  static async open(opts: { llm: LLM; store?: Store }): Promise<Company> {
    const company = new Company(opts.llm, opts.store ?? new MemoryStore());
    const saved = await company.store.load();
    if (saved) company.state = recoverInterrupted({ ...emptyState(), ...saved });
    company.dispatch();
    return company;
  }

  get provider() {
    return this.llm.name;
  }

  snapshot(): CompanyState {
    return structuredClone(this.state);
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
    const agent: Agent = {
      id: newId("agt"),
      name,
      role,
      persona: input.persona?.trim() || `${role} 역할을 맡은 성실하고 협업을 잘하는 팀원입니다.`,
      skills: (input.skills ?? []).map((s) => s.trim()).filter(Boolean),
      model: input.model || this.state.defaultModel,
      status: "idle",
      hiredAt: now(),
      stats: { tasksDone: 0, meetingsAttended: 0 },
    };
    this.state.agents.push(agent);
    this.emit({ type: "agent.updated", agent });
    this.log(`${agent.name}님이 ${agent.role}(으)로 입사했습니다.`);
    this.persist();
    return agent;
  }

  updateAgent(agentId: string, patch: Partial<Pick<Agent, "name" | "role" | "persona" | "skills" | "model">>): Agent {
    const agent = this.getAgent(agentId);
    if (patch.name?.trim()) agent.name = patch.name.trim();
    if (patch.role?.trim()) agent.role = patch.role.trim();
    if (patch.persona !== undefined) agent.persona = patch.persona.trim();
    if (patch.skills) agent.skills = patch.skills.map((s) => s.trim()).filter(Boolean);
    if (patch.model) agent.model = patch.model;
    this.emit({ type: "agent.updated", agent });
    this.persist();
    return agent;
  }

  fire(agentId: string) {
    const agent = this.getAgent(agentId);
    if (agent.status !== "idle") throw new EngineError(`${agent.name}님은 지금 일하는 중이라 내보낼 수 없습니다.`, 409);
    this.state.agents = this.state.agents.filter((a) => a.id !== agentId);
    for (const task of this.state.tasks) {
      if (task.assigneeId === agentId && task.status === "todo") {
        task.assigneeId = null;
        task.updatedAt = now();
        this.emit({ type: "task.updated", task });
      }
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
    const title = input.title?.trim();
    if (!title) throw new EngineError("업무 제목은 필수입니다.");
    if (input.assigneeId) this.getAgent(input.assigneeId);
    const task: Task = {
      id: newId("tsk"),
      title,
      description: input.description?.trim() ?? "",
      assigneeId: input.assigneeId || null,
      status: "todo",
      output: "",
      sourceMeetingId: input.sourceMeetingId,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.tasks.push(task);
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
    return task;
  }

  updateTask(taskId: string, patch: { title?: string; description?: string; assigneeId?: string | null }): Task {
    const task = this.getTask(taskId);
    if (task.status === "in_progress") throw new EngineError("진행 중인 업무는 수정할 수 없습니다.", 409);
    if (patch.title?.trim()) task.title = patch.title.trim();
    if (patch.description !== undefined) task.description = patch.description.trim();
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId) this.getAgent(patch.assigneeId);
      task.assigneeId = patch.assigneeId || null;
    }
    task.updatedAt = now();
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
    return task;
  }

  /** Put a finished or failed task back in the queue. */
  retryTask(taskId: string): Task {
    const task = this.getTask(taskId);
    if (task.status === "in_progress") throw new EngineError("이미 진행 중입니다.", 409);
    task.status = "todo";
    task.output = "";
    task.error = undefined;
    task.updatedAt = now();
    this.emit({ type: "task.updated", task });
    this.persist();
    this.dispatch();
    return task;
  }

  deleteTask(taskId: string) {
    const task = this.getTask(taskId);
    if (task.status === "in_progress") throw new EngineError("진행 중인 업무는 삭제할 수 없습니다.", 409);
    this.state.tasks = this.state.tasks.filter((t) => t.id !== taskId);
    this.emit({ type: "task.deleted", taskId });
    this.persist();
  }

  // --------------------------------------------------------------- meetings

  startMeeting(input: StartMeetingInput): Meeting {
    const topic = input.topic?.trim();
    if (!topic) throw new EngineError("회의 주제는 필수입니다.");
    const participantIds = [...new Set(input.participantIds ?? [])];
    if (participantIds.length < 2) throw new EngineError("회의에는 2명 이상 참석해야 합니다.");
    participantIds.forEach((id) => this.getAgent(id));
    const rounds = Math.min(Math.max(Math.round(input.rounds ?? 2), 1), 5);
    const meeting: Meeting = {
      id: newId("mtg"),
      topic,
      agenda: input.agenda?.trim() ?? "",
      participantIds,
      rounds,
      status: "scheduled",
      transcript: [],
      summary: "",
      decisions: [],
      actionItems: [],
      autoCreateTasks: input.createTasks !== false,
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

  /** Turn one action item of a finished meeting into a task (if not already). */
  promoteActionItem(meetingId: string, index: number): Task {
    const meeting = this.getMeeting(meetingId);
    const item = meeting.actionItems[index];
    if (!item) throw new EngineError("해당 액션 아이템이 없습니다.", 404);
    if (item.taskId && this.state.tasks.some((t) => t.id === item.taskId)) {
      return this.getTask(item.taskId);
    }
    return this.taskFromActionItem(meeting, item);
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
      const next = this.state.tasks.find((t) => t.status === "todo" && t.assigneeId === agent.id);
      if (next) this.track(this.runTask(next, agent));
    }
  }

  private track(job: Promise<void>) {
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
  }

  private async runTask(task: Task, agent: Agent) {
    // Synchronous part: claim the agent before dispatch() looks again.
    agent.status = "working";
    task.status = "in_progress";
    task.output = "";
    task.error = undefined;
    task.updatedAt = now();
    this.emit({ type: "agent.updated", agent });
    this.emit({ type: "task.updated", task });
    this.log(`${agent.name}님이 "${task.title}" 업무를 시작했습니다.`);

    const sourceMeeting = task.sourceMeetingId
      ? this.state.meetings.find((m) => m.id === task.sourceMeetingId)
      : undefined;
    try {
      const output = await this.llm.streamText(
        {
          model: agent.model,
          system: agentSystemPrompt(agent, this.state),
          prompt: taskPrompt(task, sourceMeeting),
          effort: "high",
          context: { kind: "task", agentName: agent.name, role: agent.role, title: task.title },
        },
        (text) => {
          task.output += text;
          this.emit({ type: "task.delta", taskId: task.id, text });
        },
      );
      task.output = output;
      task.status = "done";
      agent.stats.tasksDone += 1;
      this.log(`${agent.name}님이 "${task.title}" 업무를 완료했습니다.`);
    } catch (err) {
      task.status = "failed";
      task.error = describeError(err);
      this.log(`"${task.title}" 업무 실패: ${task.error}`, "error");
    } finally {
      task.updatedAt = now();
      agent.status = "idle";
      this.emit({ type: "task.updated", task });
      this.emit({ type: "agent.updated", agent });
      this.persist();
      this.dispatch();
    }
  }

  private async runMeeting(meeting: Meeting) {
    const participants = meeting.participantIds.map((id) => this.getAgent(id));
    meeting.status = "running";
    for (const agent of participants) {
      agent.status = "in_meeting";
      this.emit({ type: "agent.updated", agent });
    }
    this.emit({ type: "meeting.updated", meeting });
    this.log(`회의 "${meeting.topic}"이(가) 시작되었습니다.`);

    try {
      for (let round = 1; round <= meeting.rounds; round++) {
        for (const agent of participants) {
          const utterance: Utterance = { id: newId("utt"), agentId: agent.id, round, content: "", at: now() };
          // Build the prompt before adding the empty utterance for this turn.
          const prompt = meetingTurnPrompt(meeting, this.state, agent, round);
          meeting.transcript.push(utterance);
          this.emit({ type: "meeting.updated", meeting });
          utterance.content = await this.llm.streamText(
            {
              model: agent.model,
              system: agentSystemPrompt(agent, this.state),
              prompt,
              effort: "medium",
              context: {
                kind: "meeting",
                agentName: agent.name,
                role: agent.role,
                topic: meeting.topic,
                round,
                rounds: meeting.rounds,
              },
            },
            (text) => {
              utterance.content += text;
              this.emit({ type: "meeting.delta", meetingId: meeting.id, utteranceId: utterance.id, agentId: agent.id, round, text });
            },
          );
          utterance.endedAt = now();
          this.emit({ type: "meeting.updated", meeting });
        }
      }

      const minutes = await this.llm.generateJSON<{
        summary: string;
        decisions: string[];
        actionItems: { title: string; description: string; assigneeId: string }[];
      }>({
        model: this.state.defaultModel,
        system: SECRETARY_SYSTEM,
        prompt: minutesPrompt(meeting, this.state),
        schema: minutesSchema(meeting.participantIds),
        effort: "medium",
        context: {
          kind: "minutes",
          topic: meeting.topic,
          participants: participants.map((p) => ({ id: p.id, name: p.name, role: p.role })),
        },
      });
      meeting.summary = minutes.summary;
      meeting.decisions = minutes.decisions;
      meeting.actionItems = minutes.actionItems.map((a) => ({
        title: a.title,
        description: a.description,
        assigneeId: meeting.participantIds.includes(a.assigneeId) ? a.assigneeId : null,
      }));
      meeting.status = "done";
      for (const agent of participants) agent.stats.meetingsAttended += 1;
      this.log(`회의 "${meeting.topic}"이(가) 끝났습니다. 액션 아이템 ${meeting.actionItems.length}건.`);
    } catch (err) {
      meeting.status = "failed";
      meeting.error = describeError(err);
      this.log(`회의 "${meeting.topic}" 실패: ${meeting.error}`, "error");
    } finally {
      meeting.endedAt = now();
      for (const agent of participants) {
        agent.status = "idle";
        this.emit({ type: "agent.updated", agent });
      }
      if (meeting.status === "done" && meeting.autoCreateTasks) {
        for (const item of meeting.actionItems) this.taskFromActionItem(meeting, item, false);
      }
      this.emit({ type: "meeting.updated", meeting });
      this.persist();
      this.dispatch();
    }
  }

  private taskFromActionItem(meeting: Meeting, item: ActionItem, notify = true): Task {
    const assigneeId = item.assigneeId && this.state.agents.some((a) => a.id === item.assigneeId) ? item.assigneeId : null;
    const task = this.createTask({
      title: item.title,
      description: item.description,
      assigneeId,
      sourceMeetingId: meeting.id,
    });
    item.taskId = task.id;
    if (notify) this.emit({ type: "meeting.updated", meeting });
    return task;
  }

  // ---------------------------------------------------------------- helpers

  private getAgent(id: string): Agent {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new EngineError(`직원을 찾을 수 없습니다: ${id}`, 404);
    return agent;
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
    if (task.status === "in_progress") {
      task.status = "todo";
      task.output = "";
    }
  }
  for (const meeting of state.meetings) {
    if (meeting.status === "running") {
      meeting.status = "failed";
      meeting.error = "서버가 재시작되어 회의가 중단되었습니다.";
    }
  }
  return state;
}
