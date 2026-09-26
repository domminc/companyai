import { useState } from "react";
import { api, type CompanyState, type Task, type TaskReview, USER_SPEAKER } from "../api";
import { Avatar, ErrorText, Markdown, Modal, StatusBadge, timeAgo, useAction } from "./common";

const COLUMNS: { status: Task["status"]; label: string }[] = [
  { status: "todo", label: "할 일" },
  { status: "in_progress", label: "진행 중" },
  { status: "review", label: "검토" },
  { status: "done", label: "완료" },
  { status: "failed", label: "실패" },
];

/** Prerequisites that aren't done yet. */
export function pendingDeps(task: Task, state: CompanyState): Task[] {
  return task.dependsOn
    .map((id) => state.tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status !== "done");
}

export function reviewerName(review: TaskReview, state: CompanyState): string {
  if (review.mode === "human") return "대표";
  if (review.mode === "agent") return state.agents.find((a) => a.id === review.reviewerId)?.name ?? "퇴사자";
  return "";
}

export function TasksView({ state }: { state: CompanyState }) {
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const task = state.tasks.find((t) => t.id === selected);
  const waitingForMe = state.tasks.filter((t) => t.status === "review" && t.review.mode === "human" && !t.reviewing).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>업무</h2>
          <p className="muted">
            담당자가 한가해지고 선행 업무가 끝나면 자동으로 시작합니다.
            {waitingForMe > 0 && <strong className="attention"> 대표 검토 대기 {waitingForMe}건</strong>}
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={state.agents.length === 0}>
          + 업무 지시
        </button>
      </div>

      <div className="kanban">
        {COLUMNS.map((col) => {
          const tasks = state.tasks.filter((t) => t.status === col.status).reverse();
          return (
            <div key={col.status} className={`kanban-col col-${col.status}`}>
              <h3>
                {col.label} <span className="count">{tasks.length}</span>
              </h3>
              {tasks.map((t) => (
                <TaskCard key={t.id} task={t} state={state} onOpen={() => setSelected(t.id)} />
              ))}
            </div>
          );
        })}
      </div>

      {creating && <NewTaskDialog state={state} onClose={() => setCreating(false)} />}
      {task && <TaskDialog task={task} state={state} onClose={() => setSelected(null)} onOpen={setSelected} />}
    </section>
  );
}

function TaskCard({ task: t, state, onOpen }: { task: Task; state: CompanyState; onOpen: () => void }) {
  const assignee = state.agents.find((a) => a.id === t.assigneeId);
  const blocked = t.status === "todo" ? pendingDeps(t, state) : [];
  return (
    <button className={`card task-card status-${t.status}`} onClick={onOpen}>
      <strong>{t.title}</strong>
      <div className="row tight">
        {blocked.length > 0 && <span className="tag-chip wait">🔒 선행 {blocked.length}건 대기</span>}
        {t.review.mode !== "none" && (
          <span className={`tag-chip ${t.status === "review" && t.review.mode === "human" ? "attention" : ""}`}>
            {t.reviewing ? "🔍 AI 검토 중" : `검토: ${reviewerName(t.review, state)}`}
          </span>
        )}
        {t.revision > 0 && <span className="tag-chip">수정 {t.revision}차</span>}
        {t.activeTool && <span className="tool-chip">🔧 {t.activeTool}</span>}
      </div>
      {t.status === "in_progress" && <p className="task-preview">{t.output.slice(-140) || "생각하는 중…"}</p>}
      {t.status === "failed" && <p className="error-text small">{t.error}</p>}
      <div className="task-meta">
        {assignee ? (
          <span className="row tight">
            <Avatar agent={assignee} size={20} /> {assignee.name}
          </span>
        ) : (
          <span className="muted">미배정</span>
        )}
        <span className="muted">
          {t.sourceMeetingId && "📋 "}
          {timeAgo(t.updatedAt)}
        </span>
      </div>
    </button>
  );
}

/** Review mode + reviewer. `exclude` is the assignee (nobody reviews their own work). */
export function ReviewPicker({
  state,
  value,
  onChange,
  exclude,
}: {
  state: CompanyState;
  value: TaskReview;
  onChange: (v: TaskReview) => void;
  exclude?: string | null;
}) {
  const reviewers = state.agents.filter((a) => a.id !== exclude);
  return (
    <div className="grid-2">
      <label>
        검토
        <select
          value={value.mode}
          onChange={(e) => {
            const mode = e.target.value as TaskReview["mode"];
            onChange(mode === "agent" ? { mode, reviewerId: reviewers[0]?.id } : { mode });
          }}
        >
          <option value="human">대표가 검토 후 완료</option>
          <option value="agent" disabled={!reviewers.length}>
            AI 동료가 검토
          </option>
          <option value="none">검토 없이 바로 완료</option>
        </select>
      </label>
      {value.mode === "agent" && (
        <label>
          검토자
          <select value={value.reviewerId ?? ""} onChange={(e) => onChange({ mode: "agent", reviewerId: e.target.value })}>
            {reviewers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function NewTaskDialog({
  state,
  onClose,
  initial,
}: {
  state: CompanyState;
  onClose: () => void;
  initial?: { title?: string; description?: string; assigneeId?: string };
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [acceptance, setAcceptance] = useState("");
  const [assigneeId, setAssigneeId] = useState(initial?.assigneeId ?? state.agents[0]?.id ?? "");
  const [review, setReview] = useState<TaskReview>({ mode: "human" });
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const create = useAction();
  const open = state.tasks.filter((t) => t.status !== "done" && t.status !== "failed");

  const pickAssignee = (id: string) => {
    setAssigneeId(id);
    if (review.mode === "agent" && review.reviewerId === id) setReview({ mode: "human" });
  };

  return (
    <Modal title="업무 지시" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.run(async () => {
            await api.createTask({ title, description, acceptance, assigneeId: assigneeId || null, review, dependsOn });
            onClose();
          });
        }}
      >
        <label>
          제목
          <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 신규 기능 PRD 작성" />
        </label>
        <label>
          상세 설명
          <textarea
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="배경, 기대 결과물, 제약 조건 등을 적어 주세요."
          />
        </label>
        <label>
          완료 조건 (선택)
          <input value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="예: 목표·범위·성공 지표가 모두 포함될 것" />
        </label>
        <label>
          담당자
          <select value={assigneeId} onChange={(e) => pickAssignee(e.target.value)}>
            <option value="">미배정</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role}) · {a.status === "idle" ? "바로 시작" : "대기열에 추가"}
              </option>
            ))}
          </select>
        </label>
        <ReviewPicker state={state} value={review} onChange={setReview} exclude={assigneeId} />
        {open.length > 0 && (
          <label>
            선행 업무 (이 업무들이 끝나야 시작)
            <select multiple value={dependsOn} onChange={(e) => setDependsOn([...e.target.selectedOptions].map((o) => o.value))} size={Math.min(4, open.length)}>
              {open.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <ErrorText error={create.error} />
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={create.busy}>
            지시하기
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDialog({ task, state, onClose, onOpen }: { task: Task; state: CompanyState; onClose: () => void; onOpen: (id: string) => void }) {
  const action = useAction();
  const [feedback, setFeedback] = useState("");
  const meeting = state.meetings.find((m) => m.id === task.sourceMeetingId);
  const locked = task.status === "in_progress" || !!task.reviewing;
  const deps = task.dependsOn.map((id) => state.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
  const myReview = task.status === "review" && task.review.mode === "human" && !task.reviewing;
  const nameOf = (id: string) => (id === USER_SPEAKER ? "대표" : (state.agents.find((a) => a.id === id)?.name ?? "퇴사자"));

  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="stack">
        <div className="row">
          <StatusBadge status={task.status} />
          <label className="row tight inline-label">
            담당
            <select
              value={task.assigneeId ?? ""}
              disabled={locked}
              onChange={(e) => action.run(() => api.updateTask(task.id, { assigneeId: e.target.value || null }))}
            >
              <option value="">미배정</option>
              {state.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
          </label>
          {task.review.mode !== "none" && <span className="tag-chip">검토: {reviewerName(task.review, state)}</span>}
          {task.revision > 0 && <span className="tag-chip">수정 {task.revision}차</span>}
          {meeting && <span className="muted">📋 회의 "{meeting.topic}"에서 생성</span>}
          {task.activeTool && <span className="tool-chip">🔧 {task.activeTool} 사용 중</span>}
        </div>
        {task.description && <p className="task-desc">{task.description}</p>}
        {task.acceptance && (
          <p className="acceptance">
            <strong>완료 조건</strong> {task.acceptance}
          </p>
        )}
        {deps.length > 0 && (
          <div className="row tight">
            <span className="muted small">선행 업무:</span>
            {deps.map((d) => (
              <button key={d.id} className="tag-chip link" onClick={() => onOpen(d.id)}>
                {d.status === "done" ? "✅" : "🔒"} {d.title}
              </button>
            ))}
          </div>
        )}

        <div className="output">
          {task.output ? (
            <Markdown text={task.output} />
          ) : (
            <p className="muted">
              {task.status === "todo"
                ? pendingDeps(task, state).length
                  ? "선행 업무가 끝나기를 기다리는 중입니다."
                  : task.revision > 0
                    ? "피드백을 반영해 다시 작업할 차례입니다."
                    : "아직 시작 전입니다."
                : task.status === "in_progress"
                  ? "생각하는 중…"
                  : "결과물이 없습니다."}
            </p>
          )}
          {task.status === "in_progress" && <span className="cursor" />}
        </div>
        {task.error && <p className="error-text">{task.error}</p>}

        {task.reviewing && <p className="notice-line">🔍 {reviewerName(task.review, state)}님이 검토하는 중입니다…</p>}
        {myReview && (
          <div className="review-box">
            <strong>대표 검토</strong>
            <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="수정이 필요하면 무엇을 고칠지 적어 주세요 (승인할 때는 비워도 됩니다)" />
            <div className="row end">
              <button className="btn" disabled={action.busy || !feedback.trim()} onClick={() => action.run(async () => (await api.reviewTask(task.id, false, feedback), setFeedback("")))}>
                수정 요청
              </button>
              <button className="btn primary" disabled={action.busy} onClick={() => action.run(() => api.reviewTask(task.id, true, feedback))}>
                승인
              </button>
            </div>
          </div>
        )}
        {task.reviews.length > 0 && (
          <ul className="review-history">
            {task.reviews.map((r, i) => (
              <li key={i}>
                <span className={`tag-chip ${r.verdict === "approved" ? "ok" : "attention"}`}>{r.verdict === "approved" ? "승인" : "수정 요청"}</span>
                <span className="muted small">
                  {nameOf(r.by)} · {r.revision + 1}차 결과물 · {timeAgo(r.at)}
                </span>
                {r.comment && <p>{r.comment}</p>}
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={action.error} />

        <div className="row between">
          <button
            className="btn danger ghost"
            disabled={locked || action.busy}
            onClick={() => confirm("이 업무를 삭제할까요?") && action.run(async () => (await api.deleteTask(task.id), onClose()))}
          >
            삭제
          </button>
          <div className="row">
            {task.output && (
              <button className="btn ghost" onClick={() => navigator.clipboard.writeText(task.output)}>
                복사
              </button>
            )}
            {(task.status === "done" || task.status === "failed") && (
              <button className="btn" disabled={action.busy} onClick={() => action.run(() => api.retryTask(task.id))}>
                다시 시키기
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
