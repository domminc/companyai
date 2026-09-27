import { useEffect, useState } from "react";
import { api, type ClaudeStatus } from "../api";
import { ErrorText, Modal, useAction } from "./common";

/** Paste an Anthropic API key to switch from demo mode to real Claude, no files or restarts. */
export function ClaudeKeyDialog({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const load = useAction();
  const save = useAction();

  useEffect(() => {
    void load.run(async () => setStatus(await api.claudeStatus()));
  }, [load.run]);

  return (
    <Modal title="Claude 연결" onClose={onClose}>
      <div className="stack">
        <ErrorText error={load.error} />
        {status?.source === "env" && <p>서버의 <code>.env</code>에 있는 API 키로 Claude에 연결되어 있습니다.</p>}
        {status?.source === "app" && (
          <p>
            Claude에 연결되어 있습니다 (키 <code>{status.keyHint}</code>).
          </p>
        )}
        {status?.source === "none" && (
          <p>
            지금은 <strong>데모 모드</strong>입니다. 직원들이 미리 정해진 가짜 답을 합니다. Anthropic API 키를 넣으면 바로 실제 Claude가 일합니다.
          </p>
        )}
        {canEdit && status && status.source !== "env" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save.run(async () => {
                setStatus(await api.setClaudeKey(apiKey));
                setApiKey("");
              });
            }}
          >
            <label>
              Anthropic API 키
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="muted small">
              키는{" "}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com
              </a>
              에서 만들 수 있습니다. 넣으면 실제로 연결되는지 확인한 뒤 이 컴퓨터의 <code>data/settings.json</code>에만 저장합니다.
            </p>
            <ErrorText error={save.error} />
            <div className="row between">
              {status.source === "app" ? (
                <button
                  type="button"
                  className="btn ghost small danger-text"
                  disabled={save.busy}
                  onClick={() => save.run(async () => setStatus(await api.removeClaudeKey()))}
                >
                  키 지우고 데모 모드로
                </button>
              ) : (
                <span />
              )}
              <button className="btn primary" disabled={!apiKey.trim() || save.busy}>
                {save.busy ? "확인하는 중…" : status.source === "app" ? "키 바꾸기" : "연결하기"}
              </button>
            </div>
          </form>
        )}
        {!canEdit && status?.source !== "env" && <p className="muted small">키는 소유자만 바꿀 수 있습니다.</p>}
      </div>
    </Modal>
  );
}
