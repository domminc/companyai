import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Agent } from "../api";

const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

function colorFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({ agent, size = 36 }: { agent: Pick<Agent, "id" | "name"> | undefined; size?: number }) {
  const initials = agent ? [...agent.name.trim()].slice(0, agent.name.match(/[가-힣]/) ? 1 : 2).join("").toUpperCase() : "?";
  return (
    <span
      className="avatar"
      title={agent?.name}
      style={{ width: size, height: size, fontSize: size * 0.42, background: agent ? colorFor(agent.id) : "var(--muted)" }}
    >
      {initials}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  idle: "대기",
  working: "업무 중",
  in_meeting: "회의 중",
  todo: "할 일",
  in_progress: "진행 중",
  review: "검토",
  done: "완료",
  failed: "실패",
  scheduled: "대기 중",
  running: "진행 중",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Wraps an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="error-text">{error}</p> : null;
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

// ------------------------------------------------------------ tiny markdown

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Italic `_x_` only at word boundaries so snake_case identifiers stay intact.
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Minimal Markdown: headings, lists, code fences, bold/italic/code. Renders as React nodes (no HTML injection). */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith("```")) {
        blocks.push(<pre key={blocks.length}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2], `h${blocks.length}`)}</Tag>);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered && !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  if (code) blocks.push(<pre key={blocks.length}><code>{(code as string[]).join("\n")}</code></pre>);
  flushPara();
  flushList();
  return <div className="markdown">{blocks}</div>;
}
