import { useState } from "react";
import { api, type CompanyState, type Task } from "../api";
import { Avatar, ErrorText, Markdown, Modal, StatusBadge, timeAgo, useAction } from "./common";

const COLUMNS: { status: Task["status"]; label: string }[] = [
  { status: "todo", label: "할 일" },
  { status: "in_progress", label: "진행 중" },
  { status: "done", label: "완료" },
  { status: "failed", label: "실패" },
];

export function TasksView({ state }: { state: CompanyState }) {
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const task = state.tasks.find((t) => t.id === selected);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>업무</h2>
          <p className="muted">담당자가 한가해지면 자동으로 일을 시작합니다.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={state.agents.length === 0}>
          + 업무 지시
        </button>
      </div>

      <div className="kanban">
        {COLUMNS.map((col) => {
          const tasks = state.tasks.filter((t) => t.status === col.status).reverse();
          return (
            <div key={col.status} className="kanban-col">
              <h3>
                {col.label} <span className="count">{tasks.length}</span>
              </h3>
              {tasks.map((t) => {
                const assignee = state.agents.find((a) => a.id === t.assigneeId);
                return (
                  <button key={t.id} className={`card task-card status-${t.status}`} onClick={() => setSelected(t.id)}>
                    <strong>{t.title}</strong>
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
              })}
            </div>
          );
        })}
      </div>

      {creating && <NewTaskDialog state={state} onClose={() => setCreating(false)} />}
      {task && <TaskDialog task={task} state={state} onClose={() => setSelected(null)} />}
    </section>
  );
}

function NewTaskDialog({ state, onClose }: { state: CompanyState; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState(state.agents[0]?.id ?? "");
  const create = useAction();

  return (
    <Modal title="업무 지시" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.run(async () => {
            await api.createTask({ title, description, assigneeId: assigneeId || null });
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
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="배경, 기대 결과물, 제약 조건 등을 적어 주세요."
          />
        </label>
        <label>
          담당자
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">미배정</option>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role}) · {a.status === "idle" ? "바로 시작" : "대기열에 추가"}
              </option>
            ))}
          </select>
        </label>
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

function TaskDialog({ task, state, onClose }: { task: Task; state: CompanyState; onClose: () => void }) {
  const action = useAction();
  const meeting = state.meetings.find((m) => m.id === task.sourceMeetingId);
  const locked = task.status === "in_progress";

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
          {meeting && <span className="muted">📋 회의 "{meeting.topic}"에서 생성</span>}
        </div>
        {task.description && <p className="task-desc">{task.description}</p>}

        <div className="output">
          {task.output ? (
            <Markdown text={task.output} />
          ) : (
            <p className="muted">
              {task.status === "todo" ? "아직 시작 전입니다." : task.status === "in_progress" ? "생각하는 중…" : "결과물이 없습니다."}
            </p>
          )}
          {locked && <span className="cursor" />}
        </div>
        {task.error && <p className="error-text">{task.error}</p>}
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
