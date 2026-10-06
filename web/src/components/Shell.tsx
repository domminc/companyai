import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRuntime } from "../runtime";
import { type AuthInfo, api, type CompanyState, type ModelOption, type OnlineUser } from "../api";
import { AccountArea } from "./Accounts";
import { BrandMark } from "./BrandMark";
import { AutostartDialog } from "./AutostartDialog";
import { ClaudeKeyDialog } from "./ClaudeKeyDialog";
import { ErrorText, Modal, timeAgo, useAction } from "./common";
import { GatewaysDialog } from "./GatewaysDialog";

type MenuDialog = "company" | "claude" | "gateways" | "autostart";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count: number;
}

export function TopBar<T extends string>({
  state,
  provider,
  models,
  connected,
  canAdmin,
  auth,
  online,
  onAuth,
  tabs,
  tab,
  onTab,
  unread,
  onActivity,
}: {
  state: CompanyState;
  provider: string;
  models: ModelOption[];
  connected: boolean;
  /** Company settings and Hermes connections belong to the owner once login is on. */
  canAdmin: boolean;
  auth: AuthInfo;
  online: OnlineUser[];
  onAuth: (info: AuthInfo) => void;
  tabs: TabDef<T>[];
  tab: T;
  onTab: (tab: T) => void;
  unread: number;
  onActivity: () => void;
}) {
  const [dialog, setDialog] = useState<MenuDialog | null>(null);
  return (
    <header className="topbar">
      <button className="brand" onClick={() => canAdmin && setDialog("company")} disabled={!canAdmin} title={canAdmin ? "회사 정보 수정" : undefined}>
        <BrandMark />
        <span className="brand-text">
          <strong>{state.name}</strong>
          <span className="muted">{state.mission || (canAdmin ? "미션을 정해 주세요" : "")}</span>
        </span>
      </button>

      <nav className="pills" aria-label="화면">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => onTab(t.id)}>
            {t.label}
            {t.count > 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button
          className={`provider ${provider}`}
          onClick={() => setDialog("claude")}
          title={provider === "mock" ? "Anthropic API 키를 넣으면 실제 Claude가 일합니다" : "Claude 연결 정보"}
        >
          {provider === "mock" ? "데모 모드 · 키 넣기" : "Claude 연결됨"}
        </button>
        <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "실시간 연결됨" : "연결 끊김"} />
        <button className="icon-pill" onClick={onActivity} title="활동 기록" aria-label="활동 기록">
          🔔{unread > 0 && <span className="badge">{unread > 9 ? "9+" : unread}</span>}
        </button>
        <SettingsMenu
          state={state}
          provider={provider}
          models={models}
          canAdmin={canAdmin}
          onOpen={(d) => setDialog(d)}
        />
        <AccountArea auth={auth} online={online} onAuth={onAuth} />
      </div>

      {dialog === "company" && <CompanyDialog state={state} onClose={() => setDialog(null)} />}
      {dialog === "gateways" && <GatewaysDialog state={state} onClose={() => setDialog(null)} />}
      {dialog === "claude" && <ClaudeKeyDialog canEdit={canAdmin} onClose={() => setDialog(null)} />}
      {dialog === "autostart" && <AutostartDialog onClose={() => setDialog(null)} />}
    </header>
  );
}

function SettingsMenu({
  state,
  provider,
  models,
  canAdmin,
  onOpen,
}: {
  state: CompanyState;
  provider: string;
  models: ModelOption[];
  canAdmin: boolean;
  onOpen: (dialog: MenuDialog) => void;
}) {
  const [open, setOpen] = useState(false);
  const { features } = useRuntime();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (d: MenuDialog) => {
    setOpen(false);
    onOpen(d);
  };
  return (
    <div className="menu-wrap" ref={box}>
      <button className="icon-pill" onClick={() => setOpen(!open)} aria-expanded={open} title="설정" aria-label="설정">
        ⚙
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" disabled={!canAdmin} onClick={() => pick("company")}>
            🏢 회사 정보
          </button>
          <button role="menuitem" onClick={() => pick("claude")}>
            ✨ Claude 연결 (API 키)
            <span className="muted small">{provider === "mock" ? "데모 모드" : "연결됨"}</span>
          </button>
          <button role="menuitem" disabled={!canAdmin} onClick={() => pick("gateways")}>
            🔌 Hermes 연결
            {state.gateways.length > 0 && <span className="count">{state.gateways.length}</span>}
          </button>
          {features.autostart && (
            <button role="menuitem" disabled={!canAdmin} onClick={() => pick("autostart")}>
              🖥 컴퓨터 켜면 자동 시작
            </button>
          )}
          <label className="menu-field">
            새 직원 기본 모델
            <select value={state.defaultModel} disabled={!canAdmin} onChange={(e) => api.updateCompany({ defaultModel: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function CompanyDialog({ state, onClose }: { state: CompanyState; onClose: () => void }) {
  const [name, setName] = useState(state.name);
  const [mission, setMission] = useState(state.mission);
  const save = useAction();
  return (
    <Modal title="회사 정보" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            await api.updateCompany({ name, mission });
            onClose();
          });
        }}
      >
        <label>
          회사 이름
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label>
          미션
          <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="직원들의 모든 판단 기준이 됩니다" />
        </label>
        <ErrorText error={save.error} />
        <div className="row end">
          <button className="btn primary" disabled={save.busy}>
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Counts activity that arrived since the drawer was last open. */
export function useUnread(state: CompanyState | null, open: boolean) {
  const [seen, setSeen] = useState(() => Date.now());
  useEffect(() => {
    if (open) setSeen(Date.now());
  }, [open, state?.activity.length]);
  if (!state || open) return 0;
  return state.activity.filter((a) => Date.parse(a.at) > seen).length;
}

export function ActivityDrawer({ state, open, onClose }: { state: CompanyState; open: boolean; onClose: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", esc);
    };
  }, [open, onClose]);
  if (!open) return null;
  const entries: ReactNode[] = [...state.activity]
    .reverse()
    .slice(0, 80)
    .map((e) => (
      <li key={e.id} className={e.level === "error" ? "error-text" : ""}>
        <span>
          {e.message}
          {e.by && <span className="muted"> · {e.by}</span>}
        </span>
        <time className="muted">{timeAgo(e.at)}</time>
      </li>
    ));
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="활동 기록">
        <header className="row between">
          <h3>활동</h3>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>
        {entries.length === 0 && <p className="muted small">아직 활동이 없습니다.</p>}
        <ul>{entries}</ul>
      </aside>
    </>
  );
}
