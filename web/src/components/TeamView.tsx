import { useState } from "react";
import { api, type Agent, type CandidateProfile, type CompanyState, type ModelOption } from "../api";
import { Avatar, ErrorText, Modal, StatusBadge, useAction } from "./common";

export function TeamView({ state, models }: { state: CompanyState; models: ModelOption[] }) {
  const [hiring, setHiring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const agent = state.agents.find((a) => a.id === selected);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>직원</h2>
          <p className="muted">{state.agents.length}명 재직 중</p>
        </div>
        <button className="btn primary" onClick={() => setHiring(true)}>
          + 채용하기
        </button>
      </div>

      {state.agents.length === 0 ? (
        <div className="empty">
          <p>아직 직원이 없습니다.</p>
          <p className="muted">채용 공고를 쓰면 AI가 후보를 추천해 줍니다.</p>
          <button className="btn primary" onClick={() => setHiring(true)}>
            첫 직원 채용하기
          </button>
        </div>
      ) : (
        <div className="agent-grid">
          {state.agents.map((a) => {
            const current = state.tasks.find((t) => t.assigneeId === a.id && t.status === "in_progress");
            const queued = state.tasks.filter((t) => t.assigneeId === a.id && t.status === "todo").length;
            return (
              <button key={a.id} className="card agent-card" onClick={() => setSelected(a.id)}>
                <div className="agent-card-top">
                  <Avatar agent={a} size={44} />
                  <div className="agent-card-name">
                    <strong>{a.name}</strong>
                    <span className="muted">{a.role}</span>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <p className="agent-now">
                  {current ? `▶ ${current.title}` : a.status === "in_meeting" ? "회의에 참석 중" : "다음 일을 기다리는 중"}
                </p>
                {a.skills.length > 0 && (
                  <div className="chips">
                    {a.skills.slice(0, 4).map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                <div className="agent-stats muted">
                  <span>완료 {a.stats.tasksDone}</span>
                  <span>대기 {queued}</span>
                  <span>회의 {a.stats.meetingsAttended}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {hiring && <HireDialog models={models} defaultModel={state.defaultModel} onClose={() => setHiring(false)} />}
      {agent && <AgentDialog agent={agent} models={models} onClose={() => setSelected(null)} />}
    </section>
  );
}

function HireDialog({ models, defaultModel, onClose }: { models: ModelOption[]; defaultModel: string; onClose: () => void }) {
  const [mode, setMode] = useState<"recruit" | "manual">("recruit");
  const [jd, setJd] = useState("");
  const [profile, setProfile] = useState<CandidateProfile>({ name: "", role: "", persona: "", skills: [] });
  const [model, setModel] = useState(defaultModel);
  const [haveCandidate, setHaveCandidate] = useState(false);
  const recruit = useAction();
  const hire = useAction();

  const showForm = mode === "manual" || haveCandidate;

  return (
    <Modal title="채용하기" onClose={onClose} wide>
      <div className="segmented">
        <button className={mode === "recruit" ? "active" : ""} onClick={() => setMode("recruit")}>
          AI 추천 채용
        </button>
        <button className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>
          직접 입력
        </button>
      </div>

      {mode === "recruit" && (
        <div className="stack">
          <label>
            채용 공고
            <textarea
              rows={4}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="예: B2B SaaS 경험이 있는 시니어 프로덕트 매니저. 데이터 기반으로 우선순위를 정하고 엔지니어와 잘 소통하는 사람."
            />
          </label>
          <div className="row">
            <button
              className="btn"
              disabled={recruit.busy || !jd.trim()}
              onClick={() =>
                recruit.run(async () => {
                  const c = await api.recruit(jd);
                  setProfile(c);
                  setHaveCandidate(true);
                })
              }
            >
              {recruit.busy ? "후보 찾는 중…" : haveCandidate ? "다른 후보 추천" : "후보 추천받기"}
            </button>
          </div>
          <ErrorText error={recruit.error} />
        </div>
      )}

      {showForm && (
        <form
          className="stack candidate"
          onSubmit={(e) => {
            e.preventDefault();
            hire.run(async () => {
              await api.hire({ ...profile, model });
              onClose();
            });
          }}
        >
          {mode === "recruit" && <h3>추천 후보</h3>}
          <div className="grid-2">
            <label>
              이름
              <input required value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </label>
            <label>
              직무
              <input required value={profile.role} onChange={(e) => setProfile({ ...profile, role: e.target.value })} />
            </label>
          </div>
          <label>
            페르소나 (성격·경력·일하는 방식)
            <textarea rows={4} value={profile.persona} onChange={(e) => setProfile({ ...profile, persona: e.target.value })} />
          </label>
          <div className="grid-2">
            <label>
              강점 (쉼표로 구분)
              <input
                value={profile.skills.join(", ")}
                onChange={(e) => setProfile({ ...profile, skills: e.target.value.split(",") })}
              />
            </label>
            <label>
              모델
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorText error={hire.error} />
          <div className="row end">
            <button type="button" className="btn ghost" onClick={onClose}>
              취소
            </button>
            <button className="btn primary" disabled={hire.busy}>
              {hire.busy ? "채용 중…" : "채용 확정"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function AgentDialog({ agent, models, onClose }: { agent: Agent; models: ModelOption[]; onClose: () => void }) {
  const [draft, setDraft] = useState({ ...agent, skillsText: agent.skills.join(", ") });
  const save = useAction();
  const fire = useAction();

  return (
    <Modal title={`${agent.name} · ${agent.role}`} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            await api.updateAgent(agent.id, {
              name: draft.name,
              role: draft.role,
              persona: draft.persona,
              skills: draft.skillsText.split(","),
              model: draft.model,
            });
            onClose();
          });
        }}
      >
        <div className="row">
          <Avatar agent={agent} size={48} />
          <StatusBadge status={agent.status} />
          <span className="muted">입사 {new Date(agent.hiredAt).toLocaleDateString("ko-KR")}</span>
        </div>
        <div className="grid-2">
          <label>
            이름
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            직무
            <input value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
          </label>
        </div>
        <label>
          페르소나
          <textarea rows={5} value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} />
        </label>
        <div className="grid-2">
          <label>
            강점
            <input value={draft.skillsText} onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })} />
          </label>
          <label>
            모델
            <select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText error={save.error ?? fire.error} />
        <div className="row between">
          <button
            type="button"
            className="btn danger"
            disabled={fire.busy || agent.status !== "idle"}
            title={agent.status !== "idle" ? "일하는 중에는 내보낼 수 없습니다" : undefined}
            onClick={() => {
              if (!confirm(`${agent.name}님을 내보낼까요? 대기 중인 업무는 미배정으로 돌아갑니다.`)) return;
              fire.run(async () => {
                await api.fire(agent.id);
                onClose();
              });
            }}
          >
            내보내기
          </button>
          <button className="btn primary" disabled={save.busy}>
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}
