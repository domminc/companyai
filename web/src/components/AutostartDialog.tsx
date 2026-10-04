import { useEffect, useState } from "react";
import { api, type AutostartStatus } from "../api";
import { ErrorText, Modal, useAction } from "./common";

/** Start CompanyAI by itself when this Mac is logged in, and keep the Mac awake while it runs. */
export function AutostartDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const load = useAction();
  const save = useAction();

  useEffect(() => {
    void load.run(async () => setStatus(await api.autostart()));
  }, [load.run]);

  return (
    <Modal title="컴퓨터를 켜면 자동으로 시작" onClose={onClose}>
      <div className="stack">
        <ErrorText error={load.error} />
        {status && !status.supported && <p>{status.reason}</p>}
        {status?.supported && (
          <>
            <p>
              {status.enabled ? (
                <>
                  <strong>켜져 있습니다.</strong> 이 Mac에 로그인하면 CompanyAI가 알아서 켜지고, 꺼지면 다시 켜집니다.
                </>
              ) : (
                <>
                  <strong>꺼져 있습니다.</strong> 지금은 터미널 창을 닫거나 Mac을 다시 켜면 CompanyAI도 꺼집니다.
                </>
              )}
            </p>
            <ul className="hint-list muted small">
              <li>켜 두는 동안 Mac이 <b>잠들지 않습니다</b> (화면은 꺼질 수 있어요). 직원들이 계속 일하고 자동화가 제때 돌아가도록 하기 위해서입니다.</li>
              <li>로그인할 때마다 브라우저가 저절로 열리지는 않습니다. 주소를 열어서 쓰세요.</li>
              <li>
                정전 뒤에도 알아서 돌아오게 하려면 <b>시스템 설정 → 사용자 및 그룹 → 자동 로그인</b>을 같이 켜 두세요. 로그인이 되어야 시작됩니다.
              </li>
              {status.logFile && (
                <li>
                  문제가 생기면 이 파일을 보내 주세요: <code>{status.logFile}</code>
                </li>
              )}
            </ul>
            <ErrorText error={save.error} />
            <div className="row end">
              <button
                className={`btn ${status.enabled ? "" : "primary"}`}
                disabled={save.busy}
                onClick={() => save.run(async () => setStatus(await api.setAutostart(!status.enabled)))}
              >
                {save.busy ? "적용하는 중…" : status.enabled ? "자동 시작 끄기" : "자동 시작 켜기"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
