import { useEffect, useRef, useState } from "react";
import { api, type CompanyState, type ModelOption } from "../api";
import { type CameraView, OfficeScene, webglAvailable } from "../office/scene";
import { Avatar, ErrorText, StatusBadge, useAction } from "./common";
import { AutomationsDialog } from "./AutomationsDialog";
import { ChatDialog } from "./ChatDialog";
import { RuntimeBadge } from "./TeamView";

type Tab = "office" | "team" | "tasks" | "meetings" | "hermes";

const TICKER_MS = 20_000;

export function OfficeView({
  state,
  models,
  onNavigate,
  active = true,
  people,
}: {
  state: CompanyState;
  models: ModelOption[];
  onNavigate: (tab: Tab) => void;
  /** False while another tab is showing: the scene keeps simulating but stops drawing. */
  active?: boolean;
  /** 대표's name tag and signed-in teammates, who show up as visitors. */
  people: { boss: string; visitors: { id: string; name: string }[] };
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<CameraView>("overview");

  useEffect(() => {
    if (!host.current) return;
    if (!webglAvailable()) {
      setError("이 브라우저에서 WebGL을 쓸 수 없어 3D 오피스를 표시할 수 없습니다.");
      return;
    }
    try {
      scene.current = new OfficeScene(host.current, {
        onSelectAgent: (id) => setSelected(id),
        onSelectMeeting: () => onNavigate("meetings"),
      });
    } catch (err) {
      setError(`3D 오피스를 시작하지 못했습니다: ${err instanceof Error ? err.message : err}`);
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
    // onNavigate is stable enough for this purpose; the scene is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scene.current?.update(state);
  }, [state]);

  useEffect(() => {
    scene.current?.select(selected);
  }, [selected]);

  const peopleKey = JSON.stringify(people);
  useEffect(() => {
    scene.current?.setPeople(people);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleKey]);

  useEffect(() => {
    scene.current?.setActive(active);
  }, [active]);

  const changeView = (v: CameraView) => {
    setView(v);
    scene.current?.setView(v);
  };

  // What just happened, floating over the office for a few seconds instead of a permanent column.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);
  const ticker = state.activity.filter((e) => clock - Date.parse(e.at) < TICKER_MS).slice(-3);

  const meeting = state.meetings.find((m) => m.status === "running");
  const working = state.agents.filter((a) => a.status === "working" || (a.status === "idle" && a.external)).length;
  const agent = state.agents.find((a) => a.id === selected);
  const [chatWith, setChatWith] = useState<string | null>(null);
  const [automating, setAutomating] = useState<string | null>(null);
  const reviewsForMe = state.tasks.filter((t) => t.status === "review" && t.review.mode === "human" && !t.reviewing).length;
  const speaker = meeting?.currentSpeakerId ? state.agents.find((a) => a.id === meeting.currentSpeakerId) : undefined;

  useEffect(() => {
    // Follow mode only makes sense while a meeting is on; fall back when it ends.
    if (!meeting && view === "follow") changeView("overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!meeting]);

  if (error) {
    return (
      <div className="empty">
        <p>{error}</p>
        <button className="btn" onClick={() => onNavigate("team")}>
          직원 화면으로
        </button>
      </div>
    );
  }

  return (
    <section className="office">
      <div className="office-stage" ref={host}>
        <div className="office-hud">
          <span className="hud-chip">👥 {state.agents.length}명</span>
          <span className="hud-chip work">💻 업무 중 {working}</span>
          {meeting ? (
            <button className="hud-chip meet" onClick={() => onNavigate("meetings")}>
              🗣 {meeting.topic}
              {speaker && meeting.phase === "speaking" && ` · ${speaker.name} 발언 중`}
              {meeting.phase === "polling" && " · 손들기"}
            </button>
          ) : (
            <span className="hud-chip">회의실 비어 있음</span>
          )}
          {meeting && (
            <button className="hud-chip needs-edit" onClick={() => api.joinMeeting(meeting.id, !meeting.userJoined)}>
              {meeting.userJoined ? "🪑 자리로 돌아가기" : "🚪 회의 참석"}
            </button>
          )}
          {reviewsForMe > 0 && (
            <button className="hud-chip attention" onClick={() => onNavigate("tasks")}>
              📝 검토 요청 {reviewsForMe}건
            </button>
          )}
        </div>
        <div className="office-views">
          <button className={view === "overview" ? "active" : ""} onClick={() => changeView("overview")}>
            전체
          </button>
          <button className={view === "meeting" ? "active" : ""} onClick={() => changeView("meeting")}>
            회의실
          </button>
          <button className={view === "follow" ? "active" : ""} disabled={!meeting} onClick={() => changeView("follow")} title="회의 중 발언자를 따라갑니다">
            발언자 따라가기
          </button>
        </div>
        {state.agents.length === 0 && (
          <div className="office-empty">
            <p>사무실이 비어 있습니다.</p>
            <button className="btn primary" onClick={() => onNavigate("team")}>
              첫 직원 채용하기
            </button>
          </div>
        )}
        {ticker.length > 0 && (
          <ul className="ticker" aria-live="polite">
            {ticker.map((e) => (
              <li key={e.id} className={e.level === "error" ? "error" : ""}>
                {e.message}
              </li>
            ))}
          </ul>
        )}
        <p className="office-hint">드래그로 회전 · 우클릭 드래그로 이동 · 휠로 확대 · 직원을 클릭하면 상세</p>
        {agent && (
          <AgentPanel
            key={agent.id}
            agentId={agent.id}
            state={state}
            models={models}
            onClose={() => setSelected(null)}
            onNavigate={onNavigate}
            onChat={() => setChatWith(agent.id)}
            onAutomations={() => setAutomating(agent.id)}
          />
        )}
        {chatWith && <ChatDialog agentId={chatWith} state={state} onClose={() => setChatWith(null)} />}
        {automating && <AutomationsDialog agentId={automating} state={state} onClose={() => setAutomating(null)} />}
      </div>
    </section>
  );
}

function AgentPanel({
  agentId,
  state,
  models,
  onClose,
  onNavigate,
  onChat,
  onAutomations,
}: {
  agentId: string;
  state: CompanyState;
  models: ModelOption[];
  onClose: () => void;
  onNavigate: (tab: Tab) => void;
  onChat: () => void;
  onAutomations: () => void;
}) {
  const agent = state.agents.find((a) => a.id === agentId)!;
  const [title, setTitle] = useState("");
  const create = useAction();
  const current = state.tasks.find((t) => t.assigneeId === agent.id && t.status === "in_progress");
  const queued = state.tasks.filter((t) => t.assigneeId === agent.id && t.status === "todo");
  const meeting = state.meetings.find((m) => m.status === "running" && m.participantIds.includes(agent.id));

  return (
    <aside className="office-panel card" onPointerDown={(e) => e.stopPropagation()}>
      <header className="row between">
        <div className="row">
          <Avatar agent={agent} size={40} />
          <div>
            <strong>{agent.name}</strong>
            <div className="muted small">{agent.role}</div>
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ×
        </button>
      </header>
      <div className="row tight">
        <StatusBadge status={agent.status} />
        <RuntimeBadge agent={agent} state={state} models={models} />
      </div>
      {current && (
        <div className="panel-block">
          <span className="muted small">지금 하는 일</span>
          <strong>{current.title}</strong>
          {current.activeTool && <span className="tool-chip">🔧 {current.activeTool}</span>}
          <p className="task-preview">{current.output.slice(-160) || "생각하는 중…"}</p>
        </div>
      )}
      {agent.external && (
        <button className="panel-block linkish" onClick={() => onNavigate("hermes")} disabled={agent.external.kind !== "kanban"}>
          <span className="muted small">{agent.external.kind === "kanban" ? "Hermes 칸반에서 하는 일" : "자동화 실행 중"}</span>
          <strong>
            {agent.external.kind === "kanban" ? "📋" : "⏰"} {agent.external.title}
          </strong>
        </button>
      )}
      {meeting && (
        <button className="btn small" onClick={() => onNavigate("meetings")}>
          🗣 회의 "{meeting.topic}" 보기
        </button>
      )}
      {queued.length > 0 && <p className="muted small">대기 중인 업무 {queued.length}건</p>}
      <form
        className="stack tight-stack needs-edit"
        onSubmit={(e) => {
          e.preventDefault();
          create.run(async () => {
            await api.createTask({ title, assigneeId: agent.id, review: { mode: "human" } });
            setTitle("");
          });
        }}
      >
        <label>
          업무 지시
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${agent.name}님에게 맡길 일`} />
        </label>
        <ErrorText error={create.error} />
        <div className="row between">
          <div className="row tight">
            <button type="button" className="btn ghost small" onClick={() => onNavigate("team")}>
              프로필
            </button>
            <button type="button" className="btn small" onClick={onChat}>
              💬 대화
            </button>
            {agent.runtime.kind === "hermes" && (
              <button type="button" className="btn small" onClick={onAutomations}>
                ⏰ 자동화
              </button>
            )}
          </div>
          <button className="btn primary small" disabled={!title.trim() || create.busy}>
            지시하기
          </button>
        </div>
      </form>
    </aside>
  );
}
