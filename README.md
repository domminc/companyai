# CompanyAI

AI 에이전트를 **직원으로 고용**하고, **업무를 지시**하고, **회의**를 여는 엔진과 웹 화면입니다.
직원의 두뇌는 두 가지 중에서 고릅니다.

- **Claude 직접** — 앱이 Claude API를 바로 호출합니다. 페르소나가 곧 정체성입니다.
- **Hermes 프로필** — [Hermes Agent](https://github.com/NousResearch/hermes-agent) 게이트웨이의 프로필을 직원으로 채용합니다. 프로필의 SOUL.md·도구(터미널, 웹 검색, 파일)·스킬·메모리를 그대로 가지고 일합니다.

회의는 [DeskRPG](https://github.com/dandacompany/deskrpg)의 회의 방식을 참고한 **발언권 시스템**으로 진행되고, 끝나면 서기가 회의록을 쓰고 액션 아이템을 담당자에게 업무로 배정합니다.

첫 화면은 **3D 오피스**입니다. 엔진 상태에 따라 직원들이 실제로 움직입니다: 일하는 직원은 책상에서 타이핑하고(모니터가 켜짐), 회의가 시작되면 회의실로 걸어가 앉고, 발언자는 말풍선으로 말하고, 손을 든 사람은 팔을 듭니다. 업무를 끝내면 대표 자리로 걸어와 완료 보고를 하고, 한가한 직원은 가끔 라운지로 쉬러 갑니다. 새로 채용한 직원은 입구로 들어오고, 내보낸 직원은 입구로 나갑니다. 브라우저 세션마다 처음 열 때는 모두가 차례로 **출근**해 자리에 앉습니다.

직원 외형은 [Kenney Mini Characters](https://kenney.nl/assets/mini-characters)(CC0) 12종 중 하나가 자동으로 배정되고, 걷기·앉기·끄덕임 애니메이션을 씁니다. 타이핑·발언 제스처·손들기는 애니메이션 위에 팔과 머리를 직접 움직여 표현합니다. 모델을 불러오지 못하면 코드로 만든 기본 캐릭터로 표시됩니다.

```
채용(공고 → AI 후보 추천 → 확정, Claude 또는 Hermes 프로필)  →  업무 지시  →  직원이 스트리밍으로 결과물 작성
          ↘  회의 소집  →  진행자 개회 → 손들기(SPEAK/PASS) → 발언 … → 회의록 · 액션 아이템  →  자동 업무 배정
```

## 빠른 시작

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY 입력 (없으면 mock 데모 모드)
npm run dev               # 엔진 :8787 + UI :5173
```

브라우저에서 http://localhost:5173 을 엽니다.

API 키가 없으면 **mock 모드**로 켜져서 가짜 응답으로 전체 흐름(채용 → 업무 → 회의 → 자동 배정)을 체험할 수 있습니다. 화면 오른쪽 위 배지로 현재 모드를 확인할 수 있습니다.

Hermes 직원을 써 보려면 상단 **Hermes 연결**에서 게이트웨이(예: `http://localhost:8642`, `API_SERVER_KEY`)를 등록한 뒤, 채용할 때 두뇌를 **Hermes 프로필**로 고르고 프로필 이름을 입력합니다.
실제 Hermes 없이 화면만 확인하려면 가짜 게이트웨이를 띄울 수 있습니다.

```bash
npm run fake-hermes       # http://127.0.0.1:8642, API 키 dev-key, 프로필 default·researcher·coder
```

데모 모드는 응답이 너무 빨라서 걸어가는 모습을 보기 전에 회의가 끝납니다. 천천히 보고 싶으면 지연을 늘리세요.

```bash
COMPANYAI_MOCK_DELAY_MS=200 npm run dev   # mock 응답 단어당 지연(ms)
FAKE_HERMES_DELAY_MS=200 npm run fake-hermes
```

배포/단일 프로세스 실행:

```bash
npm run build && npm start   # http://localhost:8787 에서 UI와 API를 함께 서빙
```

## 기능

| 화면 | 할 수 있는 일 |
|---|---|
| **오피스 (3D)** | 사무실 전체를 보며 회전·이동·확대. 직원을 클릭하면 상태·지금 하는 일을 보고 바로 업무를 지시. **회의실**·**발언자 따라가기** 카메라. 회의 테이블을 클릭하면 회의 화면으로 |
| **직원** | 채용 공고를 쓰면 AI가 후보(이름·직무·페르소나·강점)를 추천 → 수정 후 채용. 직접 입력 채용, 페르소나/모델 수정, 내보내기 |
| **업무** | 칸반(할 일/진행 중/완료/실패). 업무를 지시하면 담당자가 한가할 때 자동으로 시작하고, 결과물이 실시간으로 스트리밍됩니다. 재배정·다시 시키기·삭제 |
| **회의** | 주제·안건·참석자(첫 번째가 진행자)·1인당 발언 횟수를 정해 소집. 누가 손을 들었고 누가 PASS했는지, 지금 누가 발언 중인지 실시간으로 보입니다. 대표(사용자)도 발언하고 `@이름`으로 지명하거나 발언권을 주고, 회의를 끝낼 수 있습니다. 끝나면 회의록·결정사항·액션 아이템이 정리되고 업무로 배정됩니다 |
| **Hermes 연결** | Hermes API Server 등록·연결 확인·해제. 키는 서버의 `data/company.json`에만(평문) 저장되고 브라우저로는 나가지 않습니다 |
| **활동** | 입사, 업무 시작/완료, 회의 시작/종료 등 회사의 모든 이벤트 로그 |

## 엔진 동작 규칙

- 직원은 **한 번에 한 가지 일**만 합니다 (업무 또는 회의).
- 직원이 한가해지면 자신에게 배정된 가장 오래된 `할 일`을 **자동으로 시작**합니다.
- 회의는 **참석자 전원이 한가해지면** 시작합니다. 대기 중인 회의의 참석자는 새 업무를 잡지 않고 회의를 기다립니다.

### 회의 발언권 규칙 (`engine/meeting.ts`)

1. **진행자**(첫 번째 참석자)가 회의를 엽니다.
2. 이후 매 턴 전에 발언권이 남은 참석자 모두에게 묻습니다(**손들기**). 첫 줄에 `SPEAK: 이유` 또는 `PASS`로 답합니다. 동시에 최대 4명씩 묻습니다 (Hermes 동시 실행 한도 고려).
3. 손을 든 사람 중 **가장 오래 말하지 않은 사람**이 발언합니다 (동률이면 참석자 순서).
4. 발언 중 `@이름`으로 지명하면 그 사람이 다음 발언자가 됩니다. 단, 발언 횟수가 남아 있어야 하며 없으면 건너뛰었다고 기록합니다.
5. **대표(사용자)**는 언제든 발언할 수 있습니다. 대표의 `@지명`과 **발언권** 버튼은 횟수 제한을 무시하고 우선합니다.
6. 연결에 실패한 참석자는 PASS가 아니라 **응답 없음**으로 따로 기록합니다. 모두 실패하면 회의는 실패 처리합니다.
7. 모두 PASS하거나, 발언 횟수를 다 쓰거나, 대표가 **회의 종료**를 누르면 끝납니다. 종료 요청은 현재 발언이 끝난 뒤 적용됩니다.
8. Claude 키가 없고(데모 모드) Hermes 참석자가 있으면, 회의록은 Hermes 참석자가 작성합니다.

### Claude와 Hermes의 차이 (`engine/backends.ts`)

| | Claude 직접 | Hermes 프로필 |
|---|---|---|
| 정체성 | 채용 시 적은 페르소나 | 프로필의 SOUL.md (앱은 페르소나를 보내지 않음) |
| 앱이 보내는 것 | 페르소나 + 회사 맥락 + 회의 규칙 | 회사 맥락 + 회의 규칙 (`instructions`로 덧붙임) |
| 도구 | 없음 (텍스트만) | 프로필에 켜진 도구·스킬·메모리 전부. 사용 중인 도구가 업무 카드에 표시됩니다 |
| 호출 | Messages API 스트리밍 | `POST /p/<프로필>/v1/runs` + `GET /v1/runs/<id>/events` (SSE) |
- 회의에서 나온 업무는 회의 요약·결정사항을 컨텍스트로 받아 진행합니다.
- 상태는 `data/company.json`에 저장됩니다. 서버가 도중에 꺼지면 진행 중이던 업무는 `할 일`로 되돌아가 다시 실행되고, 진행 중이던 회의는 `실패`로 표시됩니다.

## 구조

```
engine/            # UI와 무관한 순수 엔진 (다른 앱에서도 import 가능)
  company.ts       # Company: 채용·업무·회의 진행·스케줄러, 모든 변경을 이벤트로 발행
  meeting.ts       # 회의 규칙(프로토콜), 손들기/발언 프롬프트, SPEAK/PASS 파싱, @지명, 발언자 선정
  backends.ts      # AgentBackend: ClaudeBackend / HermesBackend
  hermes.ts        # Hermes API Server 클라이언트 (Runs API + SSE, 429 재시도)
  llm.ts           # LLM 인터페이스 + AnthropicLLM(Claude) + MockLLM
  prompts.ts       # 정체성/회사 맥락/업무/서기/리크루터 프롬프트와 JSON 스키마
  store.ts         # JsonFileStore / MemoryStore
  types.ts         # Agent, Task, Meeting, CompanyEvent ...
  *.test.ts        # 엔진·회의 발언권·Hermes 연동 테스트
  testing/         # 가짜 Hermes 게이트웨이, 스크립트 LLM
server/index.ts    # REST API + SSE(/api/events) + 빌드된 UI 서빙
web/public/models/kenney/  # Kenney Mini Characters (CC0) — License.txt 포함
web/               # React + Vite UI
  src/office/      # 3D 오피스 (three.js)
    layout.ts      #   평면도: 책상·회의실·대표석·라운지 배치 (인원에 따라 커짐)
    pathfinding.ts #   A* 길찾기 (가구·유리벽을 돌아 문으로)
    plan.ts        #   엔진 상태 → 직원별 목적지·말풍선·동작 (순수 함수, 테스트 있음)
    figure.ts      #   위치·선택 표시·클릭 영역을 담는 컨테이너 (외형 교체 가능)
    kenney.ts      #   Kenney 캐릭터(GLB) 로딩과 애니메이션·제스처
    character.ts   #   코드로 만든 기본 캐릭터 (모델 로딩 전/실패 시)
    furniture.ts   #   방·가구
    scene.ts       #   렌더링 루프, 카메라, 클릭, 보고/휴식 이벤트
```

### 엔진을 코드에서 직접 쓰기

```ts
import { Company } from "./engine/company";
import { AnthropicLLM } from "./engine/llm";
import { JsonFileStore } from "./engine/store";

const company = await Company.open({ llm: new AnthropicLLM(), store: new JsonFileStore("data/company.json") });
company.subscribe((event) => console.log(event.type));

const gw = await company.addGateway({ name: "local", url: "http://localhost:8642", apiKey: process.env.HERMES_KEY });
const pm = company.hire({ name: "김하늘", role: "프로덕트 매니저" });                       // Claude
const dev = company.hire({ name: "이도윤", role: "엔지니어", hermes: { gatewayId: gw.id, profile: "coder" } }); // Hermes
company.createTask({ title: "온보딩 개선 PRD", assigneeId: pm.id });
const m = company.startMeeting({ topic: "3분기 로드맵", participantIds: [pm.id, dev.id], maxTurnsPerAgent: 3 });
company.postMeetingMessage(m.id, "@이도윤 기술 리스크부터 말해 주세요"); // 회의가 진행 중일 때

await company.settle(); // 모든 업무와 회의가 끝날 때까지 대기
```

### REST API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | 전체 상태 + provider + 선택 가능한 모델 |
| GET | `/api/events` | SSE 스트림 (처음에 `state`, 이후 변경 이벤트와 토큰 단위 `task.delta` / `meeting.delta`) |
| PATCH | `/api/company` | 회사 이름·미션·기본 모델 |
| POST | `/api/recruit` | `{ jobDescription }` → 후보 프로필 (채용은 하지 않음) |
| POST / PATCH / DELETE | `/api/agents[/:id]` | 채용(`hermes: { gatewayId, profile, profileKey? }`면 연결 확인 후) / 수정 / 내보내기 |
| POST / PATCH / DELETE | `/api/tasks[/:id]` | 업무 생성 / 수정·재배정 / 삭제 |
| POST | `/api/tasks/:id/retry` | 다시 시키기 |
| GET / POST / DELETE | `/api/gateways[/:id]` | Hermes 게이트웨이 목록 / 등록(연결 확인 후) / 해제 |
| POST | `/api/gateways/:id/test` | 연결 확인 |
| POST | `/api/meetings` | `{ topic, agenda?, participantIds, maxTurnsPerAgent?, createTasks? }` (첫 참석자가 진행) |
| POST | `/api/meetings/:id/messages` | `{ content }` 대표 발언. `@이름`은 지명 |
| POST | `/api/meetings/:id/grant` | `{ agentId }` 다음 발언권 주기 |
| POST | `/api/meetings/:id/end` | 현재 발언 후 종료하고 회의록 작성 |
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

- 회의 결과를 바로 배정하지 않고 초안(완료 조건·선후관계)으로 검토 후 등록 — DeskRPG 방식
- 업무 검토·승인 단계 (사람 또는 다른 AI 직원이 승인/반려)
- 직원과 1:1 대화, Hermes 칸반·크론 연동
- Claude 직원에게 도구 쥐여주기 (웹 검색, 코드 실행) — Claude tool use

## 참고

- [DeskRPG](https://github.com/dandacompany/deskrpg) · [DeskRPG Hermes 플러그인](https://github.com/dandacompany/deskrpg-hermes-plugin) — 3D 가상 오피스 컨셉, 회의 발언권(손들기·공정성·발언 한도·지명), Hermes 연동 방식. DeskRPG는 Sustainable Use License라서 코드·에셋은 가져오지 않았고, 3D 오피스와 캐릭터는 모두 이 저장소에서 새로 만들었습니다.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — API Server / Runs API
- [Kenney Mini Characters](https://kenney.nl/assets/mini-characters) — 직원 3D 캐릭터 (CC0, www.kenney.nl)
