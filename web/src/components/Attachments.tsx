import { useRef } from "react";
import { api, type FileRef, MAX_FILE_BYTES } from "../api";
import { ErrorText, useAction } from "./common";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Files attached to a task: Claude and Hermes employees read the text ones. */
export function AttachmentList({ taskId, files, canEdit }: { taskId: string; files: FileRef[]; canEdit: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  if (!files.length && !canEdit) return null;
  return (
    <div className="attachments stack">
      <div className="row between">
        <strong className="small">📎 첨부 파일 {files.length > 0 && <span className="muted">{files.length}</span>}</strong>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                action.run(async () => {
                  for (const f of picked) await api.attachFile(taskId, f);
                });
              }}
            />
            <button className="btn small" disabled={action.busy} onClick={() => input.current?.click()}>
              {action.busy ? "올리는 중…" : "파일 추가"}
            </button>
          </>
        )}
      </div>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.id}>
              <a href={api.attachmentUrl(taskId, f.id)} download={f.name}>
                {f.name}
              </a>
              <span className="muted small">{formatSize(f.size)}</span>
              {canEdit && (
                <button className="icon-btn" aria-label={`${f.name} 삭제`} disabled={action.busy} onClick={() => action.run(() => api.removeAttachment(taskId, f.id))}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={action.error} />
    </div>
  );
}

/** Files picked in the new-task form; they are uploaded once the task exists. */
export function PendingFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="attachments stack">
      <div className="row between">
        <strong className="small">📎 첨부 파일 (선택)</strong>
        <input ref={input} type="file" multiple hidden onChange={(e) => (onChange([...files, ...(e.target.files ?? [])].slice(0, 10)), (e.target.value = ""))} />
        <button type="button" className="btn small" onClick={() => input.current?.click()}>
          파일 추가
        </button>
      </div>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={`${f.name}${i}`}>
              <span className={f.size > MAX_FILE_BYTES ? "error-text" : ""}>{f.name}</span>
              <span className="muted small">{f.size > MAX_FILE_BYTES ? "10MB 초과" : formatSize(f.size)}</span>
              <button type="button" className="icon-btn" aria-label={`${f.name} 빼기`} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
