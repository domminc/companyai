import { useCallback, useEffect, useState } from "react";
import { type Agent, api, type CompanyState, type KanbanAction, type KanbanBoard, type KanbanBoardMeta, type KanbanCard, type KanbanCardDetail } from "../api";
import { Avatar, ErrorText, Markdown, Modal, useAction } from "./common";

const COLUMN_LABEL: Record<string, string> = {
  triage: "분류",
  todo: "할 일",
  scheduled: "예약",
  ready: "대기",
  running: "진행 중",
  blocked: "막힘",
  review: "검토",
  done: "완료",
  archived: "보관",
};
/** Shown even when empty; the rest only when they hold cards. */
const ALWAYS = new Set(["todo", "ready", "running", "review", "done"]);

type HermesAgent = Agent & { runtime: { kind: "hermes"; gatewayId: string; profile: string } };

function staffOf(state: CompanyState, gatewayId: string): HermesAgent[] {
  return state.agents.filter((a): a is HermesAgent => a.runtime.kind === "hermes" && a.runtime.gatewayId === gatewayId);
}

function seconds(v: unknown): string {
  if (typeof v === "number") return new Date(v * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (typeof v === "string") return new Date(v).toLocaleString("ko-KR");
  return "";
}

/**
 * The Hermes kanban of a gateway, through the DeskRPG plugin. Cards assigned to a profile are
 * picked up by Hermes workers on their own; our Hermes employees are those profiles.
 */
export function HermesKanbanView({ state }: { state: CompanyState }) {
  const [gatewayId, setGatewayId] = useState(state.gateways[0]?.id ?? "");
  const [overview, setOverview] = useState<{ plugin: boolean; version?: string; boards: KanbanBoardMeta[] } | null>(null);
  const [slug, setSlug] = useState("");
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBoard, setNewBoard] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);

  useEffect(() => {
    if (!state.gateways.some((g) => g.id === gatewayId)) setGatewayId(state.gateways[0]?.id ?? "");
  }, [state.gateways, gatewayId]);

  const loadOverview = useCallback(async () => {
    if (!gatewayId) return;
    try {
      const res = await api.kanban(gatewayId);
      setOverview(res);
      setError(null);
      setSlug((s) => (res.boards.some((b) => b.slug === s) ? s : (res.current ?? res.boards[0]?.slug ?? "")));
    } catch (err) {
      setOverview(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [gatewayId]);

  useEffect(() => {
    setOverview(null);
    setBoard(null);
    void loadOverview();
  }, [loadOverview]);

  const loadBoard = useCallback(async () => {
    if (!gatewayId || !slug) return;
    try {
      setBoard(await api.kanbanBoard(gatewayId, slug));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [gatewayId, slug]);

  useEffect(() => {
    setBoard(null);
    void loadBoard();
    const timer = setInterval(() => void loadBoard(), 4000);
    return () => clearInterval(timer);
  }, [loadBoard]);

  if (!state.gateways.length) {
    return (
      <section>
        <div className="section-head">
          <h2>Hermes 칸반</h2>
        </div>
        <div className="empty">
          <p>Hermes 게이트웨이가 없습니다. 상단의 "Hermes 연결"에서 게이트웨이를 등록하면 그 게이트웨이의 칸반 보드를 여기서 운영할 수 있습니다.</p>
        </div>
      </section>
    );
  }

  const staff = staffOf(state, gatewayId);
  const byProfile = new Map(staff.map((a) => [a.runtime.profile, a]));
  const columns = board?.columns.filter((c) => ALWAYS.has(c.name) || c.tasks.length > 0) ?? [];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Hermes 칸반</h2>
          <p className="muted">
            카드를 Hermes 직원(프로필)에게 배정하면 게이트웨이의 워커가 알아서 가져가 처리합니다. 진행 중인 카드는 3D 오피스에도 보입니다.
          </p>
        </div>
        <div className="row tight wrap">
          {state.gateways.length > 1 && (
            <select value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} aria-label="게이트웨이">
              {state.gateways.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {overview?.plugin && (
            <>
              <select value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="보드">
                {overview.boards.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.name || b.slug}
                  </option>
                ))}
              </select>
              <button className="btn small needs-edit" onClick={() => setNewBoard(true)}>
                + 보드
              </button>
              <button className="btn primary needs-edit" disabled={!slug} onClick={() => setCreating(true)}>
                + 카드
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorText error={error} />

      {overview && !overview.plugin && (
        <div className="empty">
          <p>
            이 게이트웨이에는 DeskRPG 플러그인이 없습니다. 칸반은 플러그인 API로 운영됩니다. 게이트웨이 호스트에서 다음을 실행한 뒤 게이트웨이를 재시작하세요.
          </p>
          <pre className="code">{"hermes plugins install https://github.com/dandacompany/deskrpg-hermes-plugin\nhermes plugins enable deskrpg"}</pre>
          <p className="muted small">자동화(크론)는 플러그인 없이도 Hermes 기본 Jobs API로 동작합니다.</p>
        </div>
      )}
      {overview === null && !error && <p className="muted">불러오는 중…</p>}

      {board && (
        <div className="kanban hermes-kanban" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(180px, 1fr))` }}>
          {columns.map((col) => (
            <div key={col.name} className={`kanban-col col-${col.name}`}>
              <h3>
                {COLUMN_LABEL[col.name] ?? col.name} <span className="count">{col.tasks.length}</span>
              </h3>
              {col.tasks.map((card) => (
                <CardTile key={card.id} card={card} agent={card.assignee ? byProfile.get(card.assignee) : undefined} onOpen={() => setOpenCard(card.id)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewCardDialog
          gatewayId={gatewayId}
          slug={slug}
          staff={staff}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void loadBoard();
          }}
        />
      )}
      {newBoard && (
        <NewBoardDialog
          gatewayId={gatewayId}
          onClose={() => setNewBoard(false)}
          onCreated={async (s) => {
            setNewBoard(false);
            await loadOverview();
            setSlug(s);
          }}
        />
      )}
      {openCard && (
        <CardDialog
          gatewayId={gatewayId}
          slug={slug}
          cardId={openCard}
          staff={staff}
          onClose={() => setOpenCard(null)}
          onChanged={() => void loadBoard()}
        />
      )}
    </section>
  );
}

function CardTile({ card, agent, onOpen }: { card: KanbanCard; agent?: Agent; onOpen: () => void }) {
  return (
    <button className={`card task-card hermes-card status-${card.status}`} onClick={onOpen}>
      <strong>{card.title}</strong>
      {card.latest_summary && <p className="task-preview">{card.latest_summary}</p>}
      <div className="task-meta">
        {agent ? (
          <span className="row tight">
            <Avatar agent={agent} size={20} /> {agent.name}
          </span>
        ) : card.assignee ? (
          <span className="muted">프로필 {card.assignee}</span>
        ) : (
          <span className="muted">미배정</span>
        )}
        {card.priority ? <span className="tag-chip">P{card.priority}</span> : null}
      </div>
    </button>
  );
}

function NewBoardDialog({ gatewayId, onClose, onCreated }: { gatewayId: string; onClose: () => void; onCreated: (slug: string) => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const save = useAction();
  return (
    <Modal title="새 칸반 보드" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            await api.createKanbanBoard(gatewayId, slug, name);
            onCreated(slug);
          });
        }}
      >
        <label>
          이름
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="신제품 출시" required />
        </label>
        <label>
          보드 ID (영문 소문자·숫자·-)
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="launch" pattern="[a-z0-9][a-z0-9-]*" required />
        </label>
        <ErrorText error={save.error} />
        <div className="row end">
          <button className="btn primary" disabled={save.busy}>
            만들기
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewCardDialog({
  gatewayId,
  slug,
  staff,
  onClose,
  onCreated,
}: {
  gatewayId: string;
  slug: string;
  staff: HermesAgent[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState({ title: "", body: "", assigneeId: staff[0]?.id ?? "", profile: "", priority: 0, triage: false });
  const save = useAction();
  return (
    <Modal title="Hermes 칸반 카드" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(async () => {
            await api.createKanbanCard(gatewayId, slug, {
              title: draft.title,
              body: draft.body || undefined,
              ...(draft.assigneeId === "__profile" ? { assignee: draft.profile } : draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
              priority: draft.priority || undefined,
              triage: draft.triage || undefined,
            });
            onCreated();
          });
        }}
      >
        <label>
          제목
          <input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="경쟁사 가격표 정리" autoFocus />
        </label>
        <label>
          내용
          <textarea rows={4} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="무엇을, 어떤 결과물로, 언제까지" />
        </label>
        <div className="grid-2">
          <label>
            담당
            <select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}>
              {staff.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.runtime.profile})
                </option>
              ))}
              <option value="__profile">다른 프로필…</option>
              <option value="">미배정</option>
            </select>
          </label>
          <label>
            우선순위
            <input type="number" min={0} max={10} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
          </label>
        </div>
        {draft.assigneeId === "__profile" && (
          <label>
            Hermes 프로필 이름
            <input required value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={draft.triage} onChange={(e) => setDraft({ ...draft, triage: e.target.checked })} />
          분류(triage)부터 — 오케스트레이터가 쪼개고 담당을 정하게 합니다
        </label>
        <ErrorText error={save.error} />
        <div className="row end">
          <button className="btn primary" disabled={save.busy}>
            카드 올리기
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CardDialog({
  gatewayId,
  slug,
  cardId,
  staff,
  onClose,
  onChanged,
}: {
  gatewayId: string;
  slug: string;
  cardId: string;
  staff: HermesAgent[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<KanbanCardDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const act = useAction();

  const load = useCallback(async () => {
    try {
      setDetail(await api.kanbanCard(gatewayId, slug, cardId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [gatewayId, slug, cardId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const doAction = (action: KanbanAction, body: Record<string, unknown> = {}) =>
    act.run(async () => {
      await api.kanbanAction(gatewayId, slug, cardId, action, body);
      await load();
      onChanged();
    });

  const task = detail?.task;
  const owner = staff.find((a) => a.runtime.profile === task?.assignee);
  const status = task?.status ?? "";

  return (
    <Modal title={task ? task.title : "카드"} onClose={onClose} wide>
      <ErrorText error={loadError} />
      {!detail && !loadError && <p className="muted">불러오는 중…</p>}
      {task && detail && (
        <div className="stack">
          <div className="row tight wrap">
            <span className={`tag-chip status-${status}`}>{COLUMN_LABEL[status] ?? status}</span>
            {owner ? (
              <span className="row tight">
                <Avatar agent={owner} size={22} /> {owner.name}
              </span>
            ) : (
              <span className="muted">{task.assignee ? `프로필 ${task.assignee}` : "미배정"}</span>
            )}
            {task.priority ? <span className="tag-chip">P{task.priority}</span> : null}
            <span className="muted small">{seconds(task.created_at)}</span>
          </div>
          {task.body && <p className="task-desc">{task.body}</p>}
          {task.result && (
            <div className="output">
              <Markdown text={task.result} />
            </div>
          )}

          <div className="row tight wrap">
            {["running", "ready", "blocked", "review"].includes(status) && (
              <button className="btn primary small" disabled={act.busy} onClick={() => doAction("approve")}>
                ✅ 완료 처리
              </button>
            )}
            {status === "blocked" && (
              <button className="btn small" disabled={act.busy} onClick={() => doAction("unblock", comment ? { comment } : {})}>
                막힘 해제
              </button>
            )}
            {status === "running" && (
              <button className="btn small" disabled={act.busy} onClick={() => doAction("terminate")}>
                ⏹ 실행 중단
              </button>
            )}
            {status !== "archived" && (
              <button className="btn ghost small" disabled={act.busy} onClick={() => doAction("archive")}>
                보관
              </button>
            )}
            <button
              className="btn ghost small danger-text"
              disabled={act.busy}
              onClick={() =>
                confirm("이 카드를 삭제할까요?") &&
                act.run(async () => {
                  await api.deleteKanbanCard(gatewayId, slug, cardId);
                  onChanged();
                  onClose();
                })
              }
            >
              삭제
            </button>
          </div>

          {staff.length > 0 && status !== "done" && status !== "archived" && (
            <div className="row tight">
              <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} aria-label="다시 배정">
                <option value="">다른 직원에게…</option>
                {staff
                  .filter((a) => a.runtime.profile !== task.assignee)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.runtime.profile})
                    </option>
                  ))}
              </select>
              <button
                className="btn small"
                disabled={!reassignTo || act.busy}
                onClick={() => doAction("reassign", { agentId: reassignTo, reclaim_first: status === "running" })}
              >
                다시 배정
              </button>
            </div>
          )}
          <ErrorText error={act.error} />

          <h3>댓글</h3>
          {detail.comments.length === 0 && <p className="muted small">댓글이 없습니다. 워커는 다음 실행 때 댓글을 읽습니다.</p>}
          <ul className="comments">
            {detail.comments.map((c) => (
              <li key={c.id}>
                <strong>{c.author}</strong> <span className="muted small">{seconds(c.created_at)}</span>
                <div className="pre">{c.body}</div>
              </li>
            ))}
          </ul>
          <div className="stack tight-stack">
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="댓글 또는 수정 요청" />
            <div className="row tight end">
              <button
                className="btn small"
                disabled={!comment.trim() || act.busy}
                onClick={() =>
                  act.run(async () => {
                    await api.commentKanbanCard(gatewayId, slug, cardId, comment);
                    setComment("");
                    await load();
                  })
                }
              >
                댓글 달기
              </button>
              {(status === "review" || status === "done") && (
                <button
                  className="btn small"
                  disabled={!comment.trim() || act.busy}
                  onClick={() =>
                    doAction("request-changes", { comment }).then(() => setComment(""))
                  }
                >
                  ↩ 수정 요청
                </button>
              )}
            </div>
          </div>

          {detail.runs.length > 0 && (
            <>
              <h3>실행 기록</h3>
              <ul className="comments">
                {detail.runs.map((r) => (
                  <li key={r.id}>
                    <span className="tag-chip">{r.outcome ?? r.status}</span> {r.profile && <span className="muted small">{r.profile}</span>}{" "}
                    <span className="muted small">{seconds(r.started_at)}</span>
                    {r.summary && <div className="small">{r.summary}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
