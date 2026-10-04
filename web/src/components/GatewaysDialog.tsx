import { useEffect, useState } from "react";
import { api, type CompanyState, type LocalHermes } from "../api";
import { ErrorText, Modal, timeAgo, useAction } from "./common";

/** Register Hermes Agent API Servers whose profiles can be hired as employees. */
export function GatewaysDialog({ state, onClose }: { state: CompanyState; onClose: () => void }) {
  const [form, setForm] = useState({ name: "", url: "http://localhost:8642", apiKey: "" });
  const add = useAction();
  const row = useAction();
  const [tested, setTested] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<LocalHermes | null>(null);
  const connect = useAction();
  useEffect(() => {
    api.localHermes().then(setLocal, () => setLocal(null));
  }, [state.gateways.length]);

  return (
    <Modal title="Hermes 게이트웨이" onClose={onClose} wide>
      <div className="stack">
        <p className="muted">
          <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
            Hermes Agent
          </a>{" "}
          게이트웨이를 연결하면 그 프로필을 직원으로 채용할 수 있습니다. Hermes 직원은 프로필의 SOUL.md·도구·스킬·메모리를 그대로 가지고 일합니다.
          게이트웨이에서 <code>API_SERVER_ENABLED=true</code>와 <code>API_SERVER_KEY</code>를 설정하고 <code>hermes gateway</code>로 실행하세요.
        </p>

        {local && !local.connected && (
          <div className="card local-hermes">
            {local.found ? (
              <>
                <div>
                  <strong>이 컴퓨터에서 Hermes를 찾았습니다</strong>
                  <div className="muted small">
                    {local.url} ·{" "}
                    {local.reachable ? (local.plugin ? "켜져 있음 · 칸반·자동화 플러그인 있음" : "켜져 있음 · 플러그인 없음 (칸반을 쓰려면 설치 명령을 다시 실행)") : "아직 켜지지 않았습니다"}
                  </div>
                </div>
                <button
                  className="btn primary"
                  disabled={connect.busy || !local.reachable}
                  onClick={() =>
                    connect.run(async () => {
                      await api.connectLocalHermes();
                      setLocal({ ...local, connected: true });
                    })
                  }
                >
                  이 컴퓨터의 Hermes 연결하기
                </button>
              </>
            ) : (
              <div>
                <strong>이 컴퓨터에는 아직 Hermes가 없습니다.</strong>
                <div className="muted small">터미널에 아래 한 줄을 붙여 넣으면 설치하고 설정까지 끝냅니다. 끝나면 이 창을 다시 열어 주세요.</div>
                <pre className="code">curl -fsSL https://raw.githubusercontent.com/domminc/companyai/claude/agent-hiring-meeting-engine-dd62tj/install-hermes-mac.sh | bash</pre>
              </div>
            )}
            <ErrorText error={connect.error} />
          </div>
        )}

        {state.gateways.length > 0 && (
          <ul className="gateway-list">
            {state.gateways.map((g) => {
              const users = state.agents.filter((a) => a.runtime.kind === "hermes" && a.runtime.gatewayId === g.id);
              return (
                <li key={g.id} className="gateway-row">
                  <div>
                    <strong>{g.name}</strong> <span className="muted small">{g.url}</span>
                    <div className="muted small">
                      {g.hasApiKey ? "API 키 저장됨" : "API 키 없음"} · 직원 {users.length}명 · {timeAgo(g.createdAt)} 연결
                      {tested[g.id] && ` · ${tested[g.id]}`}
                    </div>
                  </div>
                  <div className="row tight">
                    <button
                      className="btn small"
                      disabled={row.busy}
                      onClick={() =>
                        row.run(async () => {
                          setTested((t) => ({ ...t, [g.id]: "확인 중…" }));
                          try {
                            await api.testGateway(g.id);
                            setTested((t) => ({ ...t, [g.id]: "✅ 연결됨" }));
                          } catch (err) {
                            setTested((t) => ({ ...t, [g.id]: "❌ 실패" }));
                            throw err;
                          }
                        })
                      }
                    >
                      연결 확인
                    </button>
                    <button
                      className="btn small danger ghost"
                      disabled={row.busy || users.length > 0}
                      title={users.length ? "이 게이트웨이를 쓰는 직원이 있습니다" : undefined}
                      onClick={() => confirm(`${g.name} 연결을 해제할까요?`) && row.run(() => api.removeGateway(g.id))}
                    >
                      해제
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <ErrorText error={row.error} />

        <form
          className="stack gateway-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.run(async () => {
              await api.addGateway(form);
              setForm({ name: "", url: "http://localhost:8642", apiKey: "" });
            });
          }}
        >
          <h3>새 게이트웨이</h3>
          <div className="grid-3">
            <label>
              이름
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예: 내 VPS" />
            </label>
            <label>
              주소
              <input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </label>
            <label>
              API 키
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="API_SERVER_KEY"
              />
            </label>
          </div>
          <ErrorText error={add.error} />
          <div className="row end">
            <button className="btn primary" disabled={add.busy}>
              {add.busy ? "연결 확인 중…" : "연결"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
