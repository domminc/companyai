import { useState } from "react";
import { api, type Agent, type CandidateProfile, type CompanyState, type ModelOption } from "../api";
import { ChatDialog } from "./ChatDialog";
import { Avatar, ErrorText, Modal, StatusBadge, useAction } from "./common";

export function TeamView({ state, models }: { state: CompanyState; models: ModelOption[] }) {
  const [hiring, setHiring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatWith, setChatWith] = useState<string | null>(null);
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
                <RuntimeBadge agent={a} state={state} models={models} />
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

      {hiring && <HireDialog state={state} models={models} onClose={() => setHiring(false)} />}
      {agent && (
        <AgentDialog
          agent={agent}
          state={state}
          models={models}
          onClose={() => setSelected(null)}
          onChat={() => {
            setSelected(null);
            setChatWith(agent.id);
          }}
        />
      )}
      {chatWith && <ChatDialog agentId={chatWith} state={state} onClose={() => setChatWith(null)} />}
    </section>
  );
}

export function RuntimeBadge({ agent, state, models }: { agent: Agent; state: CompanyState; models: ModelOption[] }) {
  if (agent.runtime.kind === "claude") {
    const model = agent.runtime.model;
    return <span className="runtime claude">{models.find((m) => m.id === model)?.label ?? model}</span>;
  }
  const { gatewayId, profile } = agent.runtime;
  const gw = state.gateways.find((g) => g.id === gatewayId);
  return (
    <span className="runtime hermes" title="Hermes Agent 프로필 — 도구·스킬·메모리를 가진 에이전트">
      Hermes · {profile}
      {gw && <span className="muted"> @{gw.name}</span>}
    </span>
  );
}

function HireDialog({ state, models, onClose }: { state: CompanyState; models: ModelOption[]; onClose: () => void }) {
  const [mode, setMode] = useState<"recruit" | "manual">("recruit");
  const [jd, setJd] = useState("");
  const [profile, setProfile] = useState<CandidateProfile>({ name: "", role: "", persona: "", skills: [] });
  const [model, setModel] = useState(state.defaultModel);
  const [brain, setBrain] = useState<"claude" | "hermes">("claude");
  const [hermes, setHermes] = useState({ gatewayId: state.gateways[0]?.id ?? "", profile: "default", profileKey: "" });
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
              await api.hire(brain === "hermes" ? { ...profile, hermes } : { ...profile, model });
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
          <fieldset>
            <legend>두뇌</legend>
            <div className="segmented">
              <button type="button" className={brain === "claude" ? "active" : ""} onClick={() => setBrain("claude")}>
                Claude 직접
              </button>
              <button
                type="button"
                className={brain === "hermes" ? "active" : ""}
                disabled={!state.gateways.length}
                title={state.gateways.length ? undefined : "먼저 상단의 'Hermes 연결'에서 게이트웨이를 등록하세요"}
                onClick={() => setBrain("hermes")}
              >
                Hermes 프로필
              </button>
            </div>
            {brain === "claude" ? (
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
            ) : (
              <HermesFields gateways={state.gateways} value={hermes} onChange={setHermes} />
            )}
          </fieldset>
          <label>
            페르소나 (성격·경력·일하는 방식)
            {brain === "hermes" && <span className="muted small">Hermes 직원의 정체성은 프로필의 SOUL.md를 따릅니다. 여기 적은 내용은 소개용입니다.</span>}
            <textarea rows={4} value={profile.persona} onChange={(e) => setProfile({ ...profile, persona: e.target.value })} />
          </label>
          <label>
            강점 (쉼표로 구분)
            <input value={profile.skills.join(", ")} onChange={(e) => setProfile({ ...profile, skills: e.target.value.split(",") })} />
          </label>
          <ErrorText error={hire.error} />
          <div className="row end">
            <button type="button" className="btn ghost" onClick={onClose}>
              취소
            </button>
            <button className="btn primary" disabled={hire.busy}>
              {hire.busy ? (brain === "hermes" ? "프로필 연결 확인 중…" : "채용 중…") : "채용 확정"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function HermesFields({
  gateways,
  value,
  onChange,
  lockGateway,
}: {
  gateways: CompanyState["gateways"];
  value: { gatewayId: string; profile: string; profileKey: string };
  onChange: (v: { gatewayId: string; profile: string; profileKey: string }) => void;
  lockGateway?: boolean;
}) {
  return (
    <div className="grid-3">
      <label>
        게이트웨이
        <select value={value.gatewayId} disabled={lockGateway} onChange={(e) => onChange({ ...value, gatewayId: e.target.value })}>
          {gateways.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        프로필
        <input value={value.profile} onChange={(e) => onChange({ ...value, profile: e.target.value })} placeholder="default" />
      </label>
      <label>
        프로필 키 (선택)
        <input
          type="password"
          autoComplete="off"
          value={value.profileKey}
          onChange={(e) => onChange({ ...value, profileKey: e.target.value })}
          placeholder="비우면 게이트웨이 키 사용"
        />
      </label>
    </div>
  );
}

function AgentDialog({
  agent,
  state,
  models,
  onClose,
  onChat,
}: {
  agent: Agent;
  state: CompanyState;
  models: ModelOption[];
  onClose: () => void;
  onChat: () => void;
}) {
  const [draft, setDraft] = useState({
    ...agent,
    skillsText: agent.skills.join(", "),
    model: agent.runtime.kind === "claude" ? agent.runtime.model : "",
  });
  const [hermes, setHermes] = useState(
    agent.runtime.kind === "hermes" ? { gatewayId: agent.runtime.gatewayId, profile: agent.runtime.profile, profileKey: "" } : null,
  );
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
              ...(hermes
                ? { hermes: { profile: hermes.profile, ...(hermes.profileKey ? { profileKey: hermes.profileKey } : {}) } }
                : { model: draft.model }),
            });
            onClose();
          });
        }}
      >
        <div className="row">
          <Avatar agent={agent} size={48} />
          <StatusBadge status={agent.status} />
          <span className="muted">입사 {new Date(agent.hiredAt).toLocaleDateString("ko-KR")}</span>
          <button type="button" className="btn small" onClick={onChat}>
            💬 대화하기
          </button>
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
          {hermes && <span className="muted small">정체성은 Hermes 프로필의 SOUL.md가 결정합니다.</span>}
          <textarea rows={5} value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} />
        </label>
        <label>
          강점
          <input value={draft.skillsText} onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })} />
        </label>
        {hermes ? (
          <>
            <HermesFields gateways={state.gateways} value={hermes} onChange={setHermes} lockGateway />
            {agent.runtime.kind === "hermes" && agent.runtime.hasProfileKey && (
              <p className="muted small">프로필 키가 저장되어 있습니다. 새 키를 입력하면 교체됩니다.</p>
            )}
          </>
        ) : (
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
        )}
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
