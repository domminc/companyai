import { useEffect, useRef, useState } from "react";
import { api, type Agent, type CompanyState, type Meeting, type MeetingEntry, type TaskReview, USER_SPEAKER } from "../api";
import { ReviewPicker } from "./TasksView";
import { Avatar, ErrorText, Markdown, Modal, StatusBadge, timeAgo, useAction } from "./common";

const USER_NAME = "대표";

const END_REASON: Record<string, string> = {
  all_passed: "모두 PASS해서 종료",
  turn_limit: "발언 횟수 소진으로 종료",
  no_candidates: "발언할 사람이 없어 종료",
  ended_by_user: "대표가 종료",
};

export function MeetingsView({ state }: { state: CompanyState }) {
  const [creating, setCreating] = useState(false);
  const meetings = [...state.meetings].reverse();
  const [selected, setSelected] = useState<string | null>(null);
  const current = meetings.find((m) => m.id === selected) ?? meetings[0];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>회의</h2>
          <p className="muted">
            진행자가 회의를 열고, 이후엔 손을 든 사람 중 가장 오래 말하지 않은 사람이 발언합니다. @이름으로 지명할 수 있고, 대표님도 끼어들 수 있어요.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={state.agents.length < 2}>
          + 회의 소집
        </button>
      </div>

      {meetings.length === 0 ? (
        <div className="empty">
          <p>아직 열린 회의가 없습니다.</p>
          <p className="muted">{state.agents.length < 2 ? "회의를 하려면 직원이 2명 이상 필요합니다." : "주제를 정해 회의를 소집해 보세요."}</p>
        </div>
      ) : (
        <div className="meetings-layout">
          <ul className="meeting-list">
            {meetings.map((m) => (
              <li key={m.id}>
                <button className={`meeting-item ${m.id === current?.id ? "active" : ""}`} onClick={() => setSelected(m.id)}>
                  <div className="row between">
                    <strong>{m.topic}</strong>
                    <StatusBadge status={m.status} />
                  </div>
                  <div className="row tight">
                    {m.participantIds.map((id) => (
                      <Avatar key={id} agent={state.agents.find((a) => a.id === id)} size={20} />
                    ))}
                    <span className="muted small">{timeAgo(m.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {current && <MeetingRoom key={current.id} meeting={current} state={state} />}
        </div>
      )}

      {creating && (
        <NewMeetingDialog
          state={state}
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setSelected(m.id);
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}

function phaseText(meeting: Meeting, nameOf: (id: string) => string) {
  if (meeting.status === "scheduled") return "참석자를 기다리는 중";
  if (meeting.status !== "running") return meeting.endReason ? END_REASON[meeting.endReason] : "";
  if (meeting.endRequested && meeting.phase !== "summarizing") return "현재 발언이 끝나면 종료합니다";
  switch (meeting.phase) {
    case "polling":
      return "✋ 발언하고 싶은 사람을 확인하는 중…";
    case "speaking":
      return `🎙 ${nameOf(meeting.currentSpeakerId ?? "")} 발언 중`;
    case "summarizing":
      return "📝 회의록 정리 중…";
    default:
      return "진행 중";
  }
}

function MeetingRoom({ meeting, state }: { meeting: Meeting; state: CompanyState }) {
  const action = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const agentOf = (id: string) => state.agents.find((a) => a.id === id);
  const nameOf = (id: string) => (id === USER_SPEAKER ? USER_NAME : (agentOf(id)?.name ?? "퇴사자"));
  const last = meeting.transcript.at(-1);
  const lastLength = last?.kind === "speech" ? last.content.length : 0;
  const running = meeting.status === "running";

  useEffect(() => {
    if (running) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [running, meeting.transcript.length, lastLength]);

  const turnsUsed = (id: string) => meeting.transcript.filter((e) => e.kind === "speech" && e.speakerId === id).length;
  const waitingFor = meeting.participantIds.map(agentOf).filter((a) => a && a.status !== "idle");
  const canInteract = running && !meeting.endRequested && meeting.phase !== "summarizing";

  return (
    <div className="meeting-room card">
      <header className="meeting-room-head">
        <div>
          <h3>{meeting.topic}</h3>
          {meeting.agenda && <p className="muted pre">{meeting.agenda}</p>}
        </div>
        <div className="row">
          <span className={`phase ${running ? "live" : ""}`}>{phaseText(meeting, nameOf)}</span>
          <StatusBadge status={meeting.status} />
        </div>
      </header>

      <div className="floor-strip">
        {meeting.participantIds.map((id, i) => {
          const a = agentOf(id);
          const used = turnsUsed(id);
          const queued = meeting.floorQueue.some((q) => q.agentId === id);
          const speaking = meeting.phase === "speaking" && meeting.currentSpeakerId === id;
          return (
            <div key={id} className={`seat ${speaking ? "speaking" : ""}`}>
              <Avatar agent={a} size={30} />
              <div className="seat-info">
                <strong>
                  {a?.name ?? "퇴사자"}
                  {i === 0 && <span className="tag">진행</span>}
                  {a?.runtime.kind === "hermes" && <span className="tag hermes">Hermes</span>}
                </strong>
                <span className="muted small">
                  발언 {used}/{meeting.maxTurnsPerAgent}
                  {queued && " · 발언 대기"}
                </span>
              </div>
              {canInteract && a && (
                <button
                  className="btn small ghost"
                  title="다음 발언권을 줍니다 (횟수 제한 무시)"
                  disabled={action.busy || speaking}
                  onClick={() => action.run(() => api.grantFloor(meeting.id, id))}
                >
                  발언권
                </button>
              )}
            </div>
          );
        })}
      </div>

      {meeting.status === "scheduled" && (
        <div className="notice">
          <p>참석자를 기다리는 중: {waitingFor.map((a) => a!.name).join(", ") || "곧 시작합니다"}</p>
          <button className="btn ghost small" onClick={() => action.run(() => api.cancelMeeting(meeting.id))}>
            회의 취소
          </button>
        </div>
      )}
      {meeting.error && <p className="error-text">{meeting.error}</p>}

      <div className="transcript">
        {meeting.transcript.map((entry) => (
          <Entry key={entry.id} entry={entry} meeting={meeting} agentOf={agentOf} nameOf={nameOf} />
        ))}
        <div ref={bottom} />
      </div>

      {canInteract && (
        <div className="row between join-row">
          <span className="muted small">{meeting.userJoined ? "🪑 대표님이 회의실에 있습니다" : "대표님은 자리에서 회의를 보고 있습니다"}</span>
          <button className="btn small" disabled={action.busy} onClick={() => action.run(() => api.joinMeeting(meeting.id, !meeting.userJoined))}>
            {meeting.userJoined ? "자리로 돌아가기" : "회의실 들어가기"}
          </button>
        </div>
      )}
      {canInteract && <Composer meeting={meeting} participants={meeting.participantIds.map(agentOf).filter((a): a is Agent => !!a)} />}

      {meeting.status === "done" && <Minutes meeting={meeting} state={state} />}
      <ErrorText error={action.error} />
    </div>
  );
}

const VIA_LABEL: Record<string, string> = {
  opening: "진행",
  mention: "지명받음",
  user_grant: "대표가 발언권 줌",
};

function Entry({
  entry,
  meeting,
  agentOf,
  nameOf,
}: {
  entry: MeetingEntry;
  meeting: Meeting;
  agentOf: (id: string) => Agent | undefined;
  nameOf: (id: string) => string;
}) {
  if (entry.kind === "notice") return <p className="entry-notice">{entry.text}</p>;

  if (entry.kind === "poll") {
    return (
      <div className="entry-poll">
        {entry.raises.length > 0 && (
          <span>
            ✋{" "}
            {entry.raises.map((r, i) => (
              <span key={r.agentId} title={r.reason}>
                {i > 0 && ", "}
                <strong>{nameOf(r.agentId)}</strong>
                {r.reason && <span className="muted"> ({r.reason})</span>}
              </span>
            ))}
          </span>
        )}
        {entry.passes.length > 0 && <span className="muted">PASS: {entry.passes.map(nameOf).join(", ")}</span>}
        {entry.failures.length > 0 && (
          <span className="error-text" title={entry.failures.map((f) => `${nameOf(f.agentId)}: ${f.reason}`).join("\n")}>
            ⚠ 응답 없음: {entry.failures.map((f) => nameOf(f.agentId)).join(", ")}
          </span>
        )}
      </div>
    );
  }

  const isUser = entry.speakerId === USER_SPEAKER;
  const agent = agentOf(entry.speakerId);
  const streaming = meeting.status === "running" && !entry.endedAt;
  const via = entry.via === "hand" ? (entry.reason ? `✋ ${entry.reason}` : "✋") : VIA_LABEL[entry.via];
  return (
    <div className={`utterance ${isUser ? "mine" : ""}`}>
      {isUser ? <span className="avatar me">{USER_NAME.slice(0, 1)}</span> : <Avatar agent={agent} size={32} />}
      <div className="bubble">
        <div className="bubble-head">
          <strong>{nameOf(entry.speakerId)}</strong> {!isUser && <span className="muted small">{agent?.role}</span>}
          {via && <span className="via">{via}</span>}
        </div>
        <div className="pre">
          {entry.content || (streaming ? "생각하는 중…" : "")}
          {streaming && <span className="cursor" />}
        </div>
      </div>
    </div>
  );
}

function Composer({ meeting, participants }: { meeting: Meeting; participants: Agent[] }) {
  const [text, setText] = useState("");
  const say = useAction();
  const end = useAction();
  const input = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    if (!text.trim()) return;
    say.run(async () => {
      await api.sayInMeeting(meeting.id, text);
      setText("");
    });
  };
  const mention = (name: string) => {
    setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${name} `);
    input.current?.focus();
  };

  return (
    <div className="composer">
      <div className="row tight">
        <span className="muted small">지명:</span>
        {participants.map((p) => (
          <button key={p.id} className="chip mention-chip" onClick={() => mention(p.name)}>
            @{p.name}
          </button>
        ))}
      </div>
      <div className="composer-row">
        <textarea
          ref={input}
          rows={2}
          value={text}
          placeholder="대표로서 한마디 하기 — @이름으로 다음 발언자를 지명할 수 있어요 (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <button className="btn primary" disabled={say.busy || !text.trim()} onClick={send}>
            발언
          </button>
          <button
            className="btn danger ghost small"
            disabled={end.busy}
            onClick={() => confirm("현재 발언이 끝나면 회의를 마치고 회의록을 작성할까요?") && end.run(() => api.endMeeting(meeting.id))}
          >
            회의 종료
          </button>
        </div>
      </div>
      <ErrorText error={say.error ?? end.error} />
    </div>
  );
}

function Minutes({ meeting, state }: { meeting: Meeting; state: CompanyState }) {
  return (
    <div className="minutes">
      <h4>회의록</h4>
      <Markdown text={meeting.summary} />
      {meeting.decisions.length > 0 && (
        <>
          <h4>결정 사항</h4>
          <ul>
            {meeting.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      )}
      {meeting.outcome === "draft" ? <OutcomeDraft meeting={meeting} state={state} /> : <OutcomeList meeting={meeting} state={state} />}
    </div>
  );
}

function OutcomeList({ meeting, state }: { meeting: Meeting; state: CompanyState }) {
  const action = useAction();
  const items = meeting.actionItems.filter((i) => meeting.outcome !== "registered" || i.include);
  return (
    <>
      <h4>액션 아이템 {meeting.outcome === "registered" && <span className="muted small">· 업무로 등록됨</span>}</h4>
      {items.length === 0 && <p className="muted">없음</p>}
      <ul className="action-items">
        {meeting.actionItems.map((item, i) => {
          if (meeting.outcome === "registered" && !item.include) return null;
          const task = state.tasks.find((t) => t.id === item.taskId);
          const owner = state.agents.find((a) => a.id === item.assigneeId);
          return (
            <li key={i} className="action-item">
              <div>
                <strong>
                  {i + 1}. {item.title}
                </strong>
                <p className="muted small">{item.description}</p>
                {item.acceptance && <p className="small">완료 조건: {item.acceptance}</p>}
                {item.after.length > 0 && <p className="muted small">선행: {item.after.map((j) => `#${j + 1}`).join(", ")}</p>}
              </div>
              <div className="row tight">
                {owner && <Avatar agent={owner} size={22} />}
                {task ? (
                  <StatusBadge status={task.status} />
                ) : (
                  meeting.outcome !== "registered" && (
                    <button className="btn small" disabled={action.busy} onClick={() => action.run(() => api.promoteActionItem(meeting.id, i))}>
                      업무로 만들기
                    </button>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorText error={action.error} />
    </>
  );
}

/** The meeting's proposed follow-ups, for 대표 to edit and register (DeskRPG-style draft review). */
function OutcomeDraft({ meeting, state }: { meeting: Meeting; state: CompanyState }) {
  const [items, setItems] = useState(() =>
    meeting.actionItems.map((i) => ({ title: i.title, description: i.description, acceptance: i.acceptance, assigneeId: i.assigneeId, include: i.include })),
  );
  const [review, setReview] = useState<TaskReview>({ mode: "human" });
  const action = useAction();
  const edit = (i: number, patch: Partial<(typeof items)[number]>) => setItems((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const kept = items.filter((i) => i.include && i.title.trim()).length;

  return (
    <div className="outcome-draft">
      <div className="row between">
        <h4>액션 아이템 초안</h4>
        <span className="muted small">검토하고 고친 뒤 등록하면 업무가 됩니다. 선행 항목이 끝나야 다음 항목이 시작됩니다.</span>
      </div>
      <ol className="draft-items">
        {meeting.actionItems.map((original, i) => {
          const item = items[i];
          const droppedDeps = original.after.filter((j) => !items[j]?.include);
          return (
            <li key={i} className={`draft-item ${item.include ? "" : "off"}`}>
              <div className="row tight">
                <input type="checkbox" className="check" checked={item.include} onChange={(e) => edit(i, { include: e.target.checked })} aria-label="등록에 포함" />
                <span className="muted small">#{i + 1}</span>
                <input className="grow" value={item.title} onChange={(e) => edit(i, { title: e.target.value })} disabled={!item.include} />
                <select value={item.assigneeId ?? ""} onChange={(e) => edit(i, { assigneeId: e.target.value || null })} disabled={!item.include}>
                  <option value="">미배정</option>
                  {state.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              {item.include && (
                <div className="draft-detail">
                  <textarea rows={2} value={item.description} onChange={(e) => edit(i, { description: e.target.value })} />
                  <input value={item.acceptance} placeholder="완료 조건" onChange={(e) => edit(i, { acceptance: e.target.value })} />
                  {original.after.length > 0 && (
                    <p className="muted small">
                      선행: {original.after.map((j) => `#${j + 1}`).join(", ")}
                      {droppedDeps.length > 0 && " (빠진 선행 항목은 무시됩니다)"}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <ReviewPicker state={state} value={review} onChange={setReview} />
      <ErrorText error={action.error} />
      <div className="row end">
        <button className="btn primary" disabled={action.busy || kept === 0} onClick={() => action.run(() => api.registerOutcome(meeting.id, { items, review }))}>
          업무 {kept}건 등록
        </button>
      </div>
    </div>
  );
}

function NewMeetingDialog({
  state,
  onClose,
  onCreated,
}: {
  state: CompanyState;
  onClose: () => void;
  onCreated: (m: Meeting) => void;
}) {
  const [topic, setTopic] = useState("");
  const [agenda, setAgenda] = useState("");
  // Selection order matters: the first participant chairs.
  const [participants, setParticipants] = useState<string[]>(state.agents.map((a) => a.id));
  const [turns, setTurns] = useState(3);
  const [createTasks, setCreateTasks] = useState(false);
  const create = useAction();

  const toggle = (id: string) => setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const makeChair = (id: string) => setParticipants((p) => [id, ...p.filter((x) => x !== id)]);

  return (
    <Modal title="회의 소집" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.run(async () => {
            const m = await api.startMeeting({ topic, agenda, participantIds: participants, maxTurnsPerAgent: turns, createTasks });
            onCreated(m);
          });
        }}
      >
        <label>
          주제
          <input required autoFocus value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="예: 3분기 제품 로드맵" />
        </label>
        <label>
          안건 (선택)
          <textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="논의할 질문이나 배경" />
        </label>
        <fieldset>
          <legend>참석자 ({participants.length}명) · 첫 번째 사람이 진행합니다</legend>
          <div className="participant-picker">
            {state.agents.map((a) => {
              const on = participants.includes(a.id);
              const chair = participants[0] === a.id;
              return (
                <label key={a.id} className={`pick ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.id)} />
                  <Avatar agent={a} size={24} />
                  <span className="pick-name">
                    {a.name}
                    <span className="muted small"> {a.role}</span>
                  </span>
                  {on &&
                    (chair ? (
                      <span className="tag">진행</span>
                    ) : (
                      <button type="button" className="link-btn small" onClick={(e) => (e.preventDefault(), makeChair(a.id))}>
                        진행 맡기기
                      </button>
                    ))}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid-2">
          <label>
            1인당 발언 횟수
            <select value={turns} onChange={(e) => setTurns(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}회 (최대 {n * participants.length}턴)
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} />
            초안 검토 없이 끝나자마자 업무로 배정
          </label>
        </div>
        <ErrorText error={create.error} />
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={create.busy || participants.length < 2}>
            회의 시작
          </button>
        </div>
      </form>
    </Modal>
  );
}
