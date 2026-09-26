# CompanyAI

AI 에이전트를 **직원으로 고용**하고, **업무를 지시**하고, **회의**를 여는 엔진과 웹 화면입니다.
각 직원은 이름·직무·페르소나를 가진 Claude 에이전트이고, 회의가 끝나면 서기가 회의록을 쓰고 액션 아이템을 담당자에게 업무로 배정합니다.

```
채용(공고 → AI 후보 추천 → 확정)  →  업무 지시  →  직원이 스트리밍으로 결과물 작성
                         ↘  회의 소집  →  라운드별 발언  →  회의록 · 결정사항 · 액션 아이템  →  자동 업무 배정
```

## 빠른 시작

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY 입력 (없으면 mock 데모 모드)
npm run dev               # 엔진 :8787 + UI :5173
```

브라우저에서 http://localhost:5173 을 엽니다.

API 키가 없으면 **mock 모드**로 켜져서 가짜 응답으로 전체 흐름(채용 → 업무 → 회의 → 자동 배정)을 체험할 수 있습니다. 화면 오른쪽 위 배지로 현재 모드를 확인할 수 있습니다.

배포/단일 프로세스 실행:

```bash
npm run build && npm start   # http://localhost:8787 에서 UI와 API를 함께 서빙
```

## 기능

| 화면 | 할 수 있는 일 |
|---|---|
| **직원** | 채용 공고를 쓰면 AI가 후보(이름·직무·페르소나·강점)를 추천 → 수정 후 채용. 직접 입력 채용, 페르소나/모델 수정, 내보내기 |
| **업무** | 칸반(할 일/진행 중/완료/실패). 업무를 지시하면 담당자가 한가할 때 자동으로 시작하고, 결과물이 실시간으로 스트리밍됩니다. 재배정·다시 시키기·삭제 |
| **회의** | 주제·안건·참석자·라운드 수를 정해 소집. 참석자들이 차례로 발언하는 모습을 실시간으로 보고, 끝나면 회의록·결정사항·액션 아이템이 정리됩니다. 액션 아이템은 자동으로(또는 버튼으로) 업무가 됩니다 |
| **활동** | 입사, 업무 시작/완료, 회의 시작/종료 등 회사의 모든 이벤트 로그 |

## 엔진 동작 규칙

- 직원은 **한 번에 한 가지 일**만 합니다 (업무 또는 회의).
- 직원이 한가해지면 자신에게 배정된 가장 오래된 `할 일`을 **자동으로 시작**합니다.
- 회의는 **참석자 전원이 한가해지면** 시작합니다. 대기 중인 회의의 참석자는 새 업무를 잡지 않고 회의를 기다립니다.
- 회의 발언자는 앞선 발언 전체를 보고 이야기하며, 마지막 라운드에서는 합의와 본인이 맡을 일을 정리합니다.
- 회의에서 나온 업무는 회의 요약·결정사항을 컨텍스트로 받아 진행합니다.
- 상태는 `data/company.json`에 저장됩니다. 서버가 도중에 꺼지면 진행 중이던 업무는 `할 일`로 되돌아가 다시 실행되고, 진행 중이던 회의는 `실패`로 표시됩니다.

## 구조

```
engine/            # UI와 무관한 순수 엔진 (다른 앱에서도 import 가능)
  company.ts       # Company: 채용·업무·회의·스케줄러, 모든 변경을 이벤트로 발행
  llm.ts           # LLM 인터페이스 + AnthropicLLM(Claude) + MockLLM
  prompts.ts       # 직원/회의/서기/리크루터 프롬프트와 JSON 스키마
  store.ts         # JsonFileStore / MemoryStore
  types.ts         # Agent, Task, Meeting, CompanyEvent ...
  company.test.ts  # 엔진 테스트 (mock LLM)
server/index.ts    # REST API + SSE(/api/events) + 빌드된 UI 서빙
web/               # React + Vite UI
```

### 엔진을 코드에서 직접 쓰기

```ts
import { Company } from "./engine/company";
import { AnthropicLLM } from "./engine/llm";
import { JsonFileStore } from "./engine/store";

const company = await Company.open({ llm: new AnthropicLLM(), store: new JsonFileStore("data/company.json") });
company.subscribe((event) => console.log(event.type));

const pm = company.hire({ name: "김하늘", role: "프로덕트 매니저" });
const dev = company.hire({ name: "이도윤", role: "백엔드 엔지니어" });
company.createTask({ title: "온보딩 개선 PRD", assigneeId: pm.id });
company.startMeeting({ topic: "3분기 로드맵", participantIds: [pm.id, dev.id], rounds: 2 });

await company.settle(); // 모든 업무와 회의가 끝날 때까지 대기
```

### REST API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | 전체 상태 + provider + 선택 가능한 모델 |
| GET | `/api/events` | SSE 스트림 (처음에 `state`, 이후 변경 이벤트와 토큰 단위 `task.delta` / `meeting.delta`) |
| PATCH | `/api/company` | 회사 이름·미션·기본 모델 |
| POST | `/api/recruit` | `{ jobDescription }` → 후보 프로필 (채용은 하지 않음) |
| POST / PATCH / DELETE | `/api/agents[/:id]` | 채용 / 수정 / 내보내기 |
| POST / PATCH / DELETE | `/api/tasks[/:id]` | 업무 생성 / 수정·재배정 / 삭제 |
| POST | `/api/tasks/:id/retry` | 다시 시키기 |
| POST | `/api/meetings` | `{ topic, agenda?, participantIds, rounds?, createTasks? }` |
| POST | `/api/meetings/:id/cancel` | 대기 중인 회의 취소 |
| POST | `/api/meetings/:id/action-items/:index/promote` | 액션 아이템을 업무로 |

## 모델

기본 모델은 **Claude Opus 5**(`claude-opus-5`)이고, 회사 기본값과 직원별로 Opus 5.5 / Sonnet 5 / Haiku 4.5 중에서 바꿀 수 있습니다.
Opus 계열 요청에는 서버 측 거절 폴백(`fallbacks: "default"`)이 켜져 있어, 안전 분류기가 요청을 거절하면 Anthropic이 권장하는 대체 모델로 같은 호출 안에서 다시 실행합니다.
업무는 `effort: high`, 회의 발언·회의록·후보 추천은 `effort: medium`으로 호출합니다 (`engine/company.ts`에서 조정).

## 개발

```bash
npm test          # 엔진 테스트
npm run typecheck
```

## 다음에 해볼 만한 것

- 직원에게 도구 쥐여주기 (웹 검색, 코드 실행, 파일 저장) — Claude tool use
- 업무 결과물 리뷰/승인 단계, 직원 간 업무 위임
- 1:1 대화, 부서/팀 구조, 비용(토큰) 대시보드
