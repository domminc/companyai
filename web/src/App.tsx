import { lazy, Suspense, useEffect, useState } from "react";
import { type AuthInfo, type OnlineUser } from "./api";
import { FirstSetupScreen, LoginScreen, useAuth } from "./components/Accounts";
import { RuntimeProvider } from "./runtime";
import { HermesKanbanView } from "./components/HermesKanbanView";
import { MeetingsView } from "./components/MeetingsView";
import { ActivityDrawer, TopBar, useUnread } from "./components/Shell";
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
  if (auth.info.setupRequired) return <FirstSetupScreen onDone={auth.setInfo} />;
  if (auth.info.enabled && !auth.info.user) return <LoginScreen onLogin={auth.setInfo} />;
  // A new session (login turned on, someone else signed in) needs a fresh event stream.
  return (
    <RuntimeProvider key={`${auth.info.enabled}:${auth.info.user?.id ?? ""}`}>
      <Company auth={auth.info} onAuth={auth.setInfo} />
    </RuntimeProvider>
  );
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
  const [drawer, setDrawer] = useState(false);
  const unread = useUnread(state, drawer);
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

  const tabs = TABS.filter((t) => t.id !== "hermes" || state.gateways.length > 0).map((t) => ({ ...t, count: counts[t.id] }));

  return (
    <div className={`app tab-${tab} ${readOnly ? "readonly" : ""}`}>
      <TopBar
        state={state}
        provider={provider}
        models={models}
        connected={connected}
        canAdmin={canAdmin}
        auth={auth}
        online={online}
        onAuth={onAuth}
        tabs={tabs}
        tab={tab}
        onTab={setTab}
        unread={unread}
        onActivity={() => setDrawer(true)}
      />
      {readOnly && <div className="readonly-banner">보기 전용 계정입니다. 오피스를 둘러볼 수 있지만 바꿀 수는 없습니다.</div>}
      <div className="content">
        {/* Once opened, the office stays mounted so people keep their places across tabs. */}
        {officeOpened && (
          <div className="office-wrap" hidden={tab !== "office"}>
            <Suspense fallback={<div className="office-stage loading">3D 오피스를 불러오는 중…</div>}>
              <OfficeView state={state} models={models} onNavigate={setTab} active={tab === "office"} people={people} />
            </Suspense>
          </div>
        )}
        {tab !== "office" && (
          <main className="page">
            <div className="page-inner">
              {tab === "team" && <TeamView state={state} models={models} />}
              {tab === "tasks" && <TasksView state={state} />}
              {tab === "meetings" && <MeetingsView state={state} />}
              {tab === "hermes" && <HermesKanbanView state={state} />}
            </div>
          </main>
        )}
      </div>
      <ActivityDrawer state={state} open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
