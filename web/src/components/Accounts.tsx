import { useCallback, useEffect, useState } from "react";
import { api, type AuthInfo, LOGGED_OUT_EVENT, type OnlineUser, type Role, type User } from "../api";
import { ErrorText, Modal, useAction } from "./common";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "소유자",
  member: "멤버",
  viewer: "보기 전용",
};
const ROLE_HINT: Record<Role, string> = {
  owner: "모든 권한 · 계정·Hermes 연결·회사 설정·해고",
  member: "채용·업무·회의·대화·칸반",
  viewer: "보기만 가능",
};

/** Whether login is on and who is signed in. `info` is null until the first answer. */
export function useAuth() {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setInfo(await api.me());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Ask again rather than assume: login may have just been turned on from another tab.
    const onLoggedOut = () => void refresh();
    window.addEventListener(LOGGED_OUT_EVENT, onLoggedOut);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, onLoggedOut);
  }, [refresh]);
  return { info, error, setInfo, refresh };
}

function initial(name: string) {
  return name.trim().slice(0, 1) || "?";
}

export function LoginScreen({ onLogin }: { onLogin: (info: AuthInfo) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useAction();
  return (
    <div className="login-screen">
      <form
        className="card login-card stack"
        onSubmit={(e) => {
          e.preventDefault();
          login.run(async () => onLogin(await api.login(username, password)));
        }}
      >
        <div className="row">
          <span className="logo">🏢</span>
          <div>
            <h1>로그인</h1>
            <p className="muted small">이 오피스는 로그인한 사람만 들어올 수 있습니다.</p>
          </div>
        </div>
        <label>
          아이디
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          비밀번호
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorText error={login.error} />
        <button className="btn primary" disabled={login.busy}>
          들어가기
        </button>
      </form>
    </div>
  );
}

/** Header corner: who's online, and the account menu (or the switch that turns login on). */
export function AccountArea({ auth, online, onAuth }: { auth: AuthInfo; online: OnlineUser[]; onAuth: (info: AuthInfo) => void }) {
  const [dialog, setDialog] = useState<"setup" | "account" | null>(null);
  const me = auth.user;
  return (
    <>
      {auth.enabled && me ? (
        <div className="row tight account-area">
          <div className="online" title={`접속 중: ${online.map((u) => u.displayName).join(", ")}`}>
            {online.slice(0, 5).map((u) => (
              <span key={u.id} className={`online-dot role-${u.role} ${u.id === me.id ? "me" : ""}`}>
                {initial(u.displayName)}
              </span>
            ))}
            {online.length > 5 && <span className="muted small">+{online.length - 5}</span>}
          </div>
          <button className="btn small" onClick={() => setDialog("account")}>
            {me.displayName} · {ROLE_LABEL[me.role]}
          </button>
        </div>
      ) : (
        <button className="btn small ghost" onClick={() => setDialog("setup")} title="다른 사람과 같이 쓰려면 로그인을 켜세요">
          🔐 로그인 설정
        </button>
      )}
      {dialog === "setup" && (
        <SetupDialog
          onClose={() => setDialog(null)}
          onDone={(info) => {
            setDialog(null);
            onAuth(info);
          }}
        />
      )}
      {dialog === "account" && me && <AccountDialog me={me} onClose={() => setDialog(null)} onAuth={onAuth} />}
    </>
  );
}

function SetupDialog({ onClose, onDone }: { onClose: () => void; onDone: (info: AuthInfo) => void }) {
  const [draft, setDraft] = useState({
    username: "",
    displayName: "",
    password: "",
    confirm: "",
  });
  const save = useAction();
  return (
    <Modal title="로그인 켜기" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            if (draft.password !== draft.confirm) throw new Error("비밀번호 확인이 일치하지 않습니다.");
            onDone(
              await api.setupLogin({
                username: draft.username,
                displayName: draft.displayName,
                password: draft.password,
              }),
            );
          });
        }}
      >
        <p className="muted small">
          지금은 이 주소에 접속하는 누구나 오피스를 쓸 수 있습니다. 소유자 계정을 만들면 로그인이 필요해지고, 멤버·보기 전용 계정을 추가해 여러 사람이
          같은 오피스에 들어올 수 있습니다. 접속한 사람은 3D 오피스에 방문자로 보입니다.
        </p>
        <div className="grid-2">
          <label>
            아이디
            <input required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="username" />
          </label>
          <label>
            표시 이름
            <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="예: 홍대표" />
          </label>
          <label>
            비밀번호 (8자 이상)
            <input
              type="password"
              required
              minLength={8}
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              autoComplete="new-password"
            />
          </label>
          <label>
            비밀번호 확인
            <input
              type="password"
              required
              value={draft.confirm}
              onChange={(e) => setDraft({ ...draft, confirm: e.target.value })}
              autoComplete="new-password"
            />
          </label>
        </div>
        <ErrorText error={save.error} />
        <div className="row end">
          <button className="btn primary" disabled={save.busy}>
            소유자 계정 만들고 로그인 켜기
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AccountDialog({ me, onClose, onAuth }: { me: User; onClose: () => void; onAuth: (info: AuthInfo) => void }) {
  const [tab, setTab] = useState<"me" | "people">("me");
  return (
    <Modal title="계정" onClose={onClose} wide={tab === "people"}>
      {me.role === "owner" && (
        <div className="segmented">
          <button className={tab === "me" ? "active" : ""} onClick={() => setTab("me")}>
            내 계정
          </button>
          <button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>
            사람 관리
          </button>
        </div>
      )}
      {tab === "me" ? <MyAccount me={me} onAuth={onAuth} /> : <People me={me} />}
    </Modal>
  );
}

function MyAccount({ me, onAuth }: { me: User; onAuth: (info: AuthInfo) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [password, setPassword] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const out = useAction();
  const disable = useAction();
  return (
    <div className="stack">
      <p className="muted small">
        아이디 <strong>{me.username}</strong> · {ROLE_LABEL[me.role]} ({ROLE_HINT[me.role]})
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            const user = await api.updateMe({
              displayName,
              ...(password ? { password } : {}),
            });
            setSaved(true);
            // A new password signs every session out, this one included.
            onAuth({ enabled: true, user: password ? null : user });
            setPassword("");
          });
        }}
      >
        <div className="grid-2">
          <label>
            표시 이름
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label>
            새 비밀번호 (바꿀 때만)
            <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        <ErrorText error={save.error} />
        <div className="row between">
          {saved ? <span className="muted small">저장했습니다.</span> : <span />}
          <button className="btn primary small" disabled={save.busy}>
            저장
          </button>
        </div>
      </form>
      <div className="row between">
        <button
          className="btn"
          disabled={out.busy}
          onClick={() =>
            out.run(async () => {
              await api.logout();
              onAuth({ enabled: true, user: null });
            })
          }
        >
          로그아웃
        </button>
      </div>
      <ErrorText error={out.error} />
      {me.role === "owner" && (
        <details className="danger-zone">
          <summary>로그인 끄기</summary>
          <p className="muted small">
            모든 계정을 지우고, 다시 누구나 로그인 없이 바로 들어오는 혼자 쓰기 모드로 돌아갑니다. 회사 데이터는 그대로입니다.
          </p>
          <div className="row tight">
            <input type="password" placeholder="내 비밀번호" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
            <button
              className="btn danger small"
              disabled={!disablePassword || disable.busy}
              onClick={() => disable.run(async () => onAuth(await api.disableLogin(disablePassword)))}
            >
              로그인 끄기
            </button>
          </div>
          <ErrorText error={disable.error} />
        </details>
      )}
    </div>
  );
}

function People({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [draft, setDraft] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "member" as Role,
  });
  const load = useAction();
  const act = useAction();
  const reload = useCallback(() => load.run(async () => setUsers(await api.users())), [load.run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <div className="stack">
      <ErrorText error={load.error ?? act.error} />
      <table className="people">
        <thead>
          <tr>
            <th>이름</th>
            <th>아이디</th>
            <th>역할</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id}>
              <td>
                {u.displayName}
                {u.id === me.id && <span className="muted small"> (나)</span>}
              </td>
              <td className="muted">{u.username}</td>
              <td>
                <select
                  value={u.role}
                  disabled={act.busy}
                  onChange={(e) =>
                    act.run(
                      async () => (
                        await api.updateUser(u.id, {
                          role: e.target.value as Role,
                        }),
                        reload()
                      ),
                    )
                  }
                >
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <div className="row tight end">
                  <button
                    className="btn ghost small"
                    disabled={act.busy}
                    onClick={() => {
                      const password = prompt(`${u.displayName}님의 새 비밀번호 (8자 이상)`);
                      if (password) act.run(async () => (await api.updateUser(u.id, { password }), reload()));
                    }}
                  >
                    비밀번호
                  </button>
                  {u.id !== me.id && (
                    <button
                      className="btn ghost small danger-text"
                      disabled={act.busy}
                      onClick={() => confirm(`${u.displayName}님의 계정을 지울까요?`) && act.run(async () => (await api.deleteUser(u.id), reload()))}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="stack card new-job"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api.createUser(draft);
            setDraft({
              username: "",
              displayName: "",
              password: "",
              role: draft.role,
            });
            await reload();
          });
        }}
      >
        <h3>사람 추가</h3>
        <div className="grid-2">
          <label>
            아이디
            <input required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" />
          </label>
          <label>
            표시 이름
            <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
          </label>
          <label>
            처음 비밀번호 (8자 이상)
            <input
              required
              minLength={8}
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              autoComplete="new-password"
            />
          </label>
          <label>
            역할
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]} — {ROLE_HINT[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row end">
          <button className="btn primary small" disabled={act.busy}>
            추가
          </button>
        </div>
      </form>
    </div>
  );
}
