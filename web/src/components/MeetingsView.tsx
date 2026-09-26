import { useEffect, useRef, useState } from "react";
import { api, type CompanyState, type Meeting } from "../api";
import { Avatar, ErrorText, Markdown, Modal, StatusBadge, timeAgo, useAction } from "./common";

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
          <p className="muted">참석자가 모두 한가해지면 회의가 시작되고, 끝나면 액션 아이템이 업무로 배정됩니다.</p>
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
          {current && <MeetingRoom meeting={current} state={state} />}
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

function MeetingRoom({ meeting, state }: { meeting: Meeting; state: CompanyState }) {
  const action = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const agentOf = (id: string) => state.agents.find((a) => a.id === id);
  const lastLength = meeting.transcript.at(-1)?.content.length ?? 0;

  useEffect(() => {
    if (meeting.status === "running") bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [meeting.status, meeting.transcript.length, lastLength]);

  const currentRound = meeting.transcript.at(-1)?.round ?? 0;
  const waitingFor = meeting.participantIds.map(agentOf).filter((a) => a && a.status !== "idle");

  return (
    <div className="meeting-room card">
      <header className="meeting-room-head">
        <div>
          <h3>{meeting.topic}</h3>
          {meeting.agenda && <p className="muted pre">{meeting.agenda}</p>}
        </div>
        <div className="row">
          {meeting.status === "running" && (
            <span className="muted">
              라운드 {currentRound}/{meeting.rounds}
            </span>
          )}
          <StatusBadge status={meeting.status} />
        </div>
      </header>

      <div className="row tight participants">
        {meeting.participantIds.map((id) => {
          const a = agentOf(id);
          return (
            <span key={id} className="chip row tight">
              <Avatar agent={a} size={18} /> {a?.name ?? "퇴사자"}
            </span>
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
        {meeting.transcript.map((u, i) => {
          const a = agentOf(u.agentId);
          const newRound = i === 0 || meeting.transcript[i - 1].round !== u.round;
          const speaking = meeting.status === "running" && !u.endedAt;
          return (
            <div key={u.id}>
              {newRound && <div className="round-divider">라운드 {u.round}</div>}
              <div className="utterance">
                <Avatar agent={a} size={32} />
                <div className="bubble">
                  <div className="bubble-head">
                    <strong>{a?.name ?? "퇴사자"}</strong> <span className="muted small">{a?.role}</span>
                  </div>
                  <div className="pre">
                    {u.content || (speaking ? "생각하는 중…" : "")}
                    {speaking && <span className="cursor" />}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {meeting.status === "running" &&
          meeting.transcript.length === meeting.participantIds.length * meeting.rounds &&
          meeting.transcript.every((u) => u.endedAt) && (
          <p className="muted center">서기가 회의록을 정리하는 중…</p>
        )}
        <div ref={bottom} />
      </div>

      {meeting.status === "done" && (
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
          <h4>액션 아이템</h4>
          {meeting.actionItems.length === 0 && <p className="muted">없음</p>}
          <ul className="action-items">
            {meeting.actionItems.map((item, i) => {
              const task = state.tasks.find((t) => t.id === item.taskId);
              const owner = agentOf(item.assigneeId ?? "");
              return (
                <li key={i} className="action-item">
                  <div>
                    <strong>{item.title}</strong>
                    <p className="muted small">{item.description}</p>
                  </div>
                  <div className="row tight">
                    {owner && <Avatar agent={owner} size={22} />}
                    {task ? (
                      <StatusBadge status={task.status} />
                    ) : (
                      <button className="btn small" disabled={action.busy} onClick={() => action.run(() => api.promoteActionItem(meeting.id, i))}>
                        업무로 만들기
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ErrorText error={action.error} />
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
  const [participants, setParticipants] = useState<string[]>(state.agents.map((a) => a.id));
  const [rounds, setRounds] = useState(2);
  const [createTasks, setCreateTasks] = useState(true);
  const create = useAction();

  const toggle = (id: string) =>
    setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal title="회의 소집" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.run(async () => {
            const m = await api.startMeeting({ topic, agenda, participantIds: participants, rounds, createTasks });
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
          <legend>참석자 ({participants.length}명)</legend>
          <div className="participant-picker">
            {state.agents.map((a) => (
              <label key={a.id} className={`pick ${participants.includes(a.id) ? "on" : ""}`}>
                <input type="checkbox" checked={participants.includes(a.id)} onChange={() => toggle(a.id)} />
                <Avatar agent={a} size={24} />
                <span>
                  {a.name}
                  <span className="muted small"> {a.role}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid-2">
          <label>
            발언 라운드
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}라운드 (총 {n * participants.length}회 발언)
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} />
            끝나면 액션 아이템을 업무로 자동 배정
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
