import { useCallback, useEffect, useState } from "react";
import { api, type CompanyState, type HermesJob, type HermesJobRun } from "../api";
import { ErrorText, Markdown, Modal, timeAgo, useAction } from "./common";

const PRESETS: { label: string; schedule: string }[] = [
  { label: "매일 오전 9시", schedule: "0 9 * * *" },
  { label: "평일 오전 9시", schedule: "0 9 * * 1-5" },
  { label: "매시간", schedule: "every 1h" },
  { label: "30분마다", schedule: "every 30m" },
  { label: "매주 월요일 10시", schedule: "0 10 * * 1" },
];

const STATE_LABEL: Record<string, string> = {
  scheduled: "예약됨",
  paused: "일시정지",
  running: "실행 중",
  completed: "완료",
};

function when(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  return diff > 0 ? `${d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : timeAgo(iso);
}

/**
 * A Hermes employee's cron jobs: things they do on a schedule by themselves, on the gateway.
 * Through the DeskRPG plugin when it is installed (with run history), else Hermes' own jobs API.
 */
export function AutomationsDialog({ agentId, state, onClose }: { agentId: string; state: CompanyState; onClose: () => void }) {
  const agent = state.agents.find((a) => a.id === agentId);
  const [jobs, setJobs] = useState<HermesJob[] | null>(null);
  const [source, setSource] = useState<"plugin" | "core" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", schedule: PRESETS[0].schedule, prompt: "" });
  const [open, setOpen] = useState<string | null>(null);
  const create = useAction();
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const res = await api.automations(agentId);
      setJobs(res.jobs);
      setSource(res.source);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (!agent) return null;

  const run = (fn: () => Promise<unknown>) => act.run(async () => {
    await fn();
    await load();
  });

  return (
    <Modal title={`⏰ ${agent.name}님의 자동화`} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">
          Hermes 게이트웨이의 크론으로 정해진 시간마다 {agent.name}님이 스스로 일합니다. 이 앱이 꺼져 있어도 돌아갑니다.
          {source === "plugin" && " (DeskRPG 플러그인 연결 — 실행 기록 확인 가능)"}
          {source === "core" && " (Hermes 기본 Jobs API — 실행 기록은 게이트웨이에서 확인)"}
        </p>
        <ErrorText error={loadError ?? act.error} />

        {jobs === null && !loadError && <p className="muted">불러오는 중…</p>}
        {jobs?.length === 0 && <p className="muted">아직 자동화가 없습니다. 아래에서 첫 자동화를 만들어 보세요.</p>}
        <ul className="job-list">
          {jobs?.map((job) => (
            <li key={job.id} className={`card job state-${job.state}`}>
              <div className="row between">
                <div>
                  <strong>{job.name}</strong>
                  <div className="muted small">
                    🗓 {job.schedule} · 다음 {when(job.nextRunAt)} · 마지막 {when(job.lastRunAt)}
                    {job.lastStatus && ` (${job.lastStatus})`}
                  </div>
                </div>
                <span className={`tag-chip ${job.state === "running" ? "attention" : ""}`}>{STATE_LABEL[job.state] ?? job.state}</span>
              </div>
              <p className="task-desc small">{job.prompt}</p>
              {job.lastError && <p className="error-text small">{job.lastError}</p>}
              <div className="row tight">
                <button className="btn small" disabled={act.busy || job.state === "running"} onClick={() => run(() => api.automationAction(agentId, job.id, "run"))}>
                  ▶ 지금 실행
                </button>
                {job.enabled ? (
                  <button className="btn ghost small" disabled={act.busy} onClick={() => run(() => api.automationAction(agentId, job.id, "pause"))}>
                    ⏸ 일시정지
                  </button>
                ) : (
                  <button className="btn ghost small" disabled={act.busy} onClick={() => run(() => api.automationAction(agentId, job.id, "resume"))}>
                    ⏵ 재개
                  </button>
                )}
                {source === "plugin" && (
                  <button className="btn ghost small" onClick={() => setOpen(open === job.id ? null : job.id)}>
                    {open === job.id ? "기록 닫기" : "실행 기록"}
                  </button>
                )}
                <button
                  className="btn ghost small danger-text"
                  disabled={act.busy}
                  onClick={() => confirm(`"${job.name}" 자동화를 삭제할까요?`) && run(() => api.deleteAutomation(agentId, job.id))}
                >
                  삭제
                </button>
              </div>
              {open === job.id && <JobRuns agentId={agentId} jobId={job.id} />}
            </li>
          ))}
        </ul>

        <form
          className="stack card new-job"
          onSubmit={(e) => {
            e.preventDefault();
            create.run(async () => {
              await api.createAutomation(agentId, draft);
              setDraft({ name: "", schedule: draft.schedule, prompt: "" });
              await load();
            });
          }}
        >
          <h3>새 자동화</h3>
          <div className="grid-2">
            <label>
              이름
              <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="아침 뉴스 브리핑" />
            </label>
            <label>
              일정 (cron 또는 every 30m / every 1h)
              <input required value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} />
            </label>
          </div>
          <div className="row tight wrap">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.schedule}
                className={`chip-btn ${draft.schedule === p.schedule ? "active" : ""}`}
                onClick={() => setDraft({ ...draft, schedule: p.schedule })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label>
            할 일
            <textarea
              required
              rows={3}
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="업계 주요 뉴스 5개를 찾아 한 줄씩 요약하고, 우리 회사에 미칠 영향을 덧붙여 줘"
            />
          </label>
          <ErrorText error={create.error} />
          <div className="row end">
            <button className="btn primary" disabled={create.busy}>
              자동화 만들기
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function JobRuns({ agentId, jobId }: { agentId: string; jobId: string }) {
  const [runs, setRuns] = useState<HermesJobRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .automationRuns(agentId, jobId)
        .then((r) => alive && setRuns(r))
        .catch((err) => alive && setError(String(err.message ?? err)));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId, jobId]);
  if (error) return <ErrorText error={error} />;
  if (!runs) return <p className="muted small">불러오는 중…</p>;
  if (!runs.length) return <p className="muted small">아직 실행 기록이 없습니다.</p>;
  return (
    <div className="job-runs">
      {runs.map((r) => (
        <details key={r.id} open={r === runs[0]}>
          <summary>
            <span className={`tag-chip ${r.status === "error" ? "danger" : ""}`}>{r.status}</span> {r.startedAt ? timeAgo(r.startedAt) : ""} {r.summary}
          </summary>
          {r.resultText ? <Markdown text={r.resultText} /> : <p className="muted small">{r.status === "running" ? "실행 중…" : "결과 없음"}</p>}
        </details>
      ))}
    </div>
  );
}
