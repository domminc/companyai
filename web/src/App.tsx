import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { type AuthInfo, api, type CompanyState, type ModelOption, type OnlineUser } from "./api";
import { AccountArea, LoginScreen, useAuth } from "./components/Accounts";
import { timeAgo } from "./components/common";
import { GatewaysDialog } from "./components/GatewaysDialog";
import { HermesKanbanView } from "./components/HermesKanbanView";
import { MeetingsView } from "./components/MeetingsView";
import { TasksView } from "./components/TasksView";
import { TeamView } from "./components/TeamView";
import { useCompany } from "./store";

// three.js is large; load the 3D office only when its tab opens.
const OfficeView = lazy(() => import("./components/OfficeView").then((m) => ({ default: m.OfficeView })));

type Tab = "office" | "team" | "tasks" | "meetings" | "hermes";

const TABS: { id: Tab; label: string }[] = [
  { id: "office", label: "오피스" },
  { id: "team", label: "직원" },
  { id: "tasks", label: "업무" },
  { id: "meetings", label: "회의" },
  { id: "hermes", label: "Hermes 칸반" },
];

export function App() {
  const auth = useAuth();
  if (!auth.info) {
    return <div className="loading">{auth.error ? "엔진에 연결하는 중… (npm run dev 로 서버를 켜 주세요)" : "불러오는 중…"}</div>;
  }
  if (auth.info.enabled && !auth.info.user) return <LoginScreen onLogin={auth.setInfo} />;
  // A new session (login turned on, someone else signed in) needs a fresh event stream.
  return <Company key={`${auth.info.enabled}:${auth.info.user?.id ?? ""}`} auth={auth.info} onAuth={auth.setInfo} />;
}

/** 대표's name tag and the teammates who walk around the 3D office. */
function officePeople(auth: AuthInfo, online: OnlineUser[]) {
  const me = auth.user;
  if (!auth.enabled || !me) return { boss: "대표 (나)", visitors: [] };
  return {
    boss: me.role === "owner" ? `${me.displayName} (나)` : "대표",
    visitors: online.filter((u) => u.role !== "owner").map((u) => ({ id: u.id, name: u.id === me.id ? `${u.displayName} (나)` : u.displayName })),
  };
}

function Company({ auth, onAuth }: { auth: AuthInfo; onAuth: (info: AuthInfo) => void }) {
  const { state, provider, models, connected, online } = useCompany();
  const [tab, setTab] = useState<Tab>(() => {
    const fromHash = location.hash.slice(1) as Tab;
    return TABS.some((t) => t.id === fromHash) ? fromHash : "office";
  });

  const [officeOpened, setOfficeOpened] = useState(tab === "office");
  useEffect(() => {
    history.replaceState(null, "", `#${tab}`);
    if (tab === "office") setOfficeOpened(true);
  }, [tab]);

  if (!state) {
    return <div className="loading">{connected ? "불러오는 중…" : "엔진에 연결하는 중… (npm run dev 로 서버를 켜 주세요)"}</div>;
  }

  const readOnly = auth.user?.role === "viewer";
  const canAdmin = !auth.enabled || auth.user?.role === "owner";
  const people = officePeople(auth, online);

  const counts: Record<Tab, number> = {
    office: 0,
    team: state.agents.length,
    tasks: state.tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length,
    meetings: state.meetings.filter((m) => m.status === "scheduled" || m.status === "running").length,
    hermes: state.agents.filter((a) => a.external).length,
  };

  return (
    <div className={`app ${readOnly ? "readonly" : ""}`}>
      <CompanyHeader state={state} provider={provider} models={models} connected={connected} canAdmin={canAdmin}>
        <AccountArea auth={auth} online={online} onAuth={onAuth} />
      </CompanyHeader>
      {readOnly && <div className="readonly-banner">보기 전용 계정입니다. 오피스를 둘러볼 수 있지만 바꿀 수는 없습니다.</div>}
      <nav className="tabs">
        {TABS.filter((t) => t.id !== "hermes" || state.gateways.length > 0).map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {counts[t.id] > 0 && <span className="count">{counts[t.id]}</span>}
          </button>
        ))}
      </nav>
      <div className="layout">
        <main>
          {/* Once opened, the office stays mounted so people keep their places across tabs. */}
          {officeOpened && (
            <div hidden={tab !== "office"}>
              <Suspense fallback={<div className="office-stage loading">3D 오피스를 불러오는 중…</div>}>
                <OfficeView state={state} models={models} onNavigate={setTab} active={tab === "office"} people={people} />
              </Suspense>
            </div>
          )}
          {tab === "team" && <TeamView state={state} models={models} />}
          {tab === "tasks" && <TasksView state={state} />}
          {tab === "meetings" && <MeetingsView state={state} />}
          {tab === "hermes" && <HermesKanbanView state={state} />}
        </main>
        <ActivityFeed state={state} />
      </div>
    </div>
  );
}

function CompanyHeader({
  state,
  provider,
  models,
  connected,
  canAdmin,
  children,
}: {
  state: CompanyState;
  provider: string;
  models: ModelOption[];
  connected: boolean;
  /** Company settings and Hermes connections belong to the owner once login is on. */
  canAdmin: boolean;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [gateways, setGateways] = useState(false);
  const [name, setName] = useState(state.name);
  const [mission, setMission] = useState(state.mission);

  const save = async () => {
    await api.updateCompany({ name, mission });
    setEditing(false);
  };

  return (
    <header className="company-header">
      <div className="company-id">
        <span className="logo">🏢</span>
        {editing ? (
          <form
            className="company-edit"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="회사 이름" autoFocus />
            <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="미션 (직원들의 모든 판단 기준이 됩니다)" />
            <button className="btn primary small">저장</button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
              취소
            </button>
          </form>
        ) : (
          <button
            className="company-title"
            disabled={!canAdmin}
            onClick={() => {
              setName(state.name);
              setMission(state.mission);
              setEditing(true);
            }}
            title="회사 정보 수정"
          >
            <h1>{state.name}</h1>
            <p className="muted">{state.mission || (canAdmin ? "미션을 설정하세요 ✎" : "")}</p>
          </button>
        )}
      </div>
      <div className="header-meta">
        <button className="btn small" onClick={() => setGateways(true)} disabled={!canAdmin}>
          Hermes 연결{state.gateways.length > 0 && <span className="count">{state.gateways.length}</span>}
        </button>
        <label className="row tight small">
          기본 모델
          <select value={state.defaultModel} disabled={!canAdmin} onChange={(e) => api.updateCompany({ defaultModel: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className={`provider ${provider}`} title={provider === "mock" ? "ANTHROPIC_API_KEY를 설정하고 서버를 재시작하면 실제 Claude가 일합니다." : undefined}>
          {provider === "mock" ? "Claude: 데모 모드" : "Claude 연결됨"}
        </span>
        <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "실시간 연결됨" : "연결 끊김"} />
        {children}
      </div>
      {gateways && <GatewaysDialog state={state} onClose={() => setGateways(false)} />}
    </header>
  );
}

function ActivityFeed({ state }: { state: CompanyState }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <aside className="activity">
      <h3>활동</h3>
      {state.activity.length === 0 && <p className="muted small">아직 활동이 없습니다.</p>}
      <ul>
        {[...state.activity].reverse().slice(0, 60).map((e) => (
          <li key={e.id} className={e.level === "error" ? "error-text" : ""}>
            <span>
              {e.message}
              {e.by && <span className="muted"> · {e.by}</span>}
            </span>
            <time className="muted">{timeAgo(e.at)}</time>
          </li>
        ))}
      </ul>
    </aside>
  );
}
