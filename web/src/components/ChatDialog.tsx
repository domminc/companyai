import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type CompanyState } from "../api";
import { Avatar, ErrorText, Markdown, Modal, StatusBadge, timeAgo, useAction } from "./common";
import { NewTaskDialog } from "./TasksView";

/** A task title from a chat reply: its first meaningful line, without Markdown. */
function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\d.\s]+/, "").replace(/[*_`]/g, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function ChatDialog({ agentId, state, onClose }: { agentId: string; state: CompanyState; onClose: () => void }) {
  const agent = state.agents.find((a) => a.id === agentId);
  const thread = state.chats.find((c) => c.agentId === agentId);
  const messages = thread?.messages ?? [];
  const [text, setText] = useState("");
  const [asTask, setAsTask] = useState<ChatMessage | null>(null);
  const send = useAction();
  const clear = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const lastLength = messages.at(-1)?.content.length ?? 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, lastLength]);

  if (!agent) {
    return (
      <Modal title="대화" onClose={onClose}>
        <p className="muted">퇴사한 직원입니다.</p>
      </Modal>
    );
  }

  const submit = () => {
    if (!text.trim() || thread?.replying) return;
    send.run(async () => {
      await api.chat(agent.id, text);
      setText("");
    });
  };

  if (asTask) {
    return (
      <NewTaskDialog
        state={state}
        onClose={() => setAsTask(null)}
        initial={{ title: titleFrom(asTask.content), description: asTask.content, assigneeId: agent.id }}
      />
    );
  }

  return (
    <Modal title={`${agent.name}님과 대화`} onClose={onClose} wide>
      <div className="chat">
        <div className="row between">
          <div className="row tight">
            <Avatar agent={agent} size={32} />
            <span className="muted small">{agent.role}</span>
            <StatusBadge status={agent.status} />
          </div>
          {messages.length > 0 && (
            <button
              className="btn ghost small"
              disabled={clear.busy || thread?.replying}
              onClick={() => confirm("대화 기록을 지울까요?") && clear.run(() => api.clearChat(agent.id))}
            >
              대화 지우기
            </button>
          )}
        </div>

        <div className="chat-log">
          {messages.length === 0 && (
            <p className="muted center">
              {agent.name}님에게 무엇이든 물어보세요. 일을 시키고 싶으면 답변 아래의 "업무로 등록"을 누르면 됩니다.
            </p>
          )}
          {messages.map((m) => {
            const streaming = m.from === "agent" && !m.endedAt;
            return (
              <div key={m.id} className={`utterance ${m.from === "user" ? "mine" : ""}`}>
                {m.from === "user" ? <span className="avatar me">대</span> : <Avatar agent={agent} size={32} />}
                <div className={`bubble ${m.error ? "failed" : ""}`}>
                  {m.from === "agent" ? (
                    m.content ? <Markdown text={m.content} /> : <p className="muted">생각하는 중…</p>
                  ) : (
                    <div className="pre">{m.content}</div>
                  )}
                  {streaming && <span className="cursor" />}
                  <div className="row between chat-meta">
                    <span className="muted small">{timeAgo(m.at)}</span>
                    {m.from === "agent" && !streaming && !m.error && m.content && (
                      <button className="btn ghost small" onClick={() => setAsTask(m)}>
                        + 업무로 등록
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
        </div>

        <div className="composer-row">
          <textarea
            rows={2}
            autoFocus
            value={text}
            placeholder={thread?.replying ? `${agent.name}님이 답하는 중…` : "메시지 (Enter 전송, Shift+Enter 줄바꿈)"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="btn primary" disabled={send.busy || !text.trim() || !!thread?.replying} onClick={submit}>
            보내기
          </button>
        </div>
        <ErrorText error={send.error ?? clear.error} />
      </div>
    </Modal>
  );
}
