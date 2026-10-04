#!/usr/bin/env bash
# Hermes Agent for CompanyAI, one command (Mac, Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/domminc/companyai/claude/agent-hiring-meeting-engine-dd62tj/install-hermes-mac.sh | bash
#
# 1. installs Hermes Agent with its own official installer (skipped when it is already there),
# 2. gives it Claude as its model when you have an Anthropic key (asks first; keeps any model you set),
# 3. turns on its API Server with a fresh key (an existing key is kept),
# 4. installs and enables the DeskRPG plugin, pinned to a reviewed release, for kanban and cron,
# 5. starts the gateway as a background service and checks that CompanyAI can reach it.
# CompanyAI then finds it by itself: Settings (gear) -> Hermes connection -> connect this computer's Hermes.
# Safe to run again.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export HERMES_HOME
PORT="${API_SERVER_PORT:-8642}"
MODEL="${HERMES_MODEL:-claude-sonnet-5}"
INSTALLER_URL="https://hermes-agent.nousresearch.com/install.sh"
PLUGIN_URL="${DESKRPG_PLUGIN_URL:-https://github.com/dandacompany/deskrpg-hermes-plugin}"
# v0.22.0, the release this was tested with.
PLUGIN_SHA="${DESKRPG_PLUGIN_SHA:-4ce077644d9efb3241de1876b5c0c43db4a1e23c}"
COMPANYAI_SETTINGS="${COMPANYAI_HOME:-$HOME/CompanyAI}/data/settings.json"

say() { printf '\n \033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() {
  printf '\n 문제가 생겼습니다: %s\n 이 창의 내용을 복사해서 알려 주세요.\n\n' "$*" >&2
  exit 1
}

has_tty() { (: </dev/tty) 2>/dev/null; }
# Ask on the terminal even though stdin is the script itself (curl | bash).
ask() { # ask "question" [secret]
  has_tty || return 1
  local reply
  if [ "${2:-}" = secret ]; then read -r -s -p " $1 " reply </dev/tty && echo >/dev/tty; else read -r -p " $1 " reply </dev/tty; fi
  printf '%s' "$reply"
}

find_hermes() {
  if command -v hermes >/dev/null 2>&1; then command -v hermes; return 0; fi
  local p
  for p in "$HOME/.hermes/bin/hermes" "$HOME/.local/bin/hermes" "$HERMES_HOME/bin/hermes"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------- 1. Hermes itself
if HERMES=$(find_hermes); then
  say "[1/5] Hermes 가 이미 설치되어 있습니다: $HERMES"
else
  say "[1/5] Hermes Agent 를 설치합니다 (공식 설치 프로그램, 몇 분 걸립니다)..."
  curl -fsSL "$INSTALLER_URL" | bash -s -- --skip-setup || die "Hermes 설치에 실패했습니다"
  HERMES=$(find_hermes) || die "설치는 끝났는데 hermes 를 찾지 못했습니다. 터미널을 새로 열고 다시 실행해 보세요"
fi
hermes() { "$HERMES" "$@"; }
export PATH="$(dirname "$HERMES"):$PATH"

# ---------------------------------------------------------------- 2. model (Claude)
say "[2/5] Hermes 가 쓸 AI 모델을 정합니다..."
if [ -n "$(hermes config get model.default 2>/dev/null || true)" ]; then
  note "이미 모델이 설정되어 있어서 그대로 둡니다: $(hermes config get model.default 2>/dev/null)"
else
  key="${ANTHROPIC_API_KEY:-}"
  if [ -z "$key" ] && [ -r "$COMPANYAI_SETTINGS" ]; then
    saved=$(sed -n 's/.*"anthropicApiKey": *"\([^"]*\)".*/\1/p' "$COMPANYAI_SETTINGS" | head -1)
    if [ -n "$saved" ]; then
      answer=$(ask "CompanyAI에 넣어 둔 Anthropic 키를 Hermes 도 쓰게 할까요? [Y/n]" || echo y)
      case "${answer:-y}" in [nN]*) ;; *) key="$saved" ;; esac
    fi
  fi
  if [ -z "$key" ]; then
    key=$(ask "Anthropic API 키 (없으면 엔터, 나중에 'hermes model' 로 정할 수 있어요):" secret || true)
  fi
  if [ -n "$key" ]; then
    hermes config set ANTHROPIC_API_KEY "$key" >/dev/null
    hermes config set model.provider anthropic >/dev/null
    hermes config set model.default "$MODEL" >/dev/null
    note "Claude ($MODEL)를 Hermes 의 모델로 설정했습니다."
  else
    note "건너뜁니다. 카드나 자동화를 실제로 처리하려면 나중에 터미널에서 'hermes model' 을 실행해 모델을 정해 주세요."
  fi
fi

# ---------------------------------------------------------------- 3. API server
say "[3/5] API 서버를 켭니다 (CompanyAI 가 접속하는 문)..."
env_value() { sed -n "s/^$1=//p" "$HERMES_HOME/.env" 2>/dev/null | tail -1; }
KEY=$(env_value API_SERVER_KEY)
if [ "${#KEY}" -lt 16 ]; then
  KEY=$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 40 || true)
  [ "${#KEY}" -ge 16 ] || die "접속 키를 만들지 못했습니다"
  hermes config set API_SERVER_KEY "$KEY" >/dev/null
  note "새 접속 키를 만들었습니다."
else
  note "기존 접속 키를 그대로 씁니다."
fi
hermes config set API_SERVER_ENABLED true >/dev/null
hermes config set API_SERVER_PORT "$PORT" >/dev/null
# Only this Mac may connect unless someone chose otherwise.
[ -n "$(env_value API_SERVER_HOST)" ] || hermes config set API_SERVER_HOST 127.0.0.1 >/dev/null

# ---------------------------------------------------------------- 4. DeskRPG plugin
say "[4/5] 칸반·자동화 플러그인(DeskRPG)을 설치합니다..."
if hermes plugins list --plain 2>/dev/null | grep -qi 'deskrpg'; then
  note "이미 설치되어 있습니다."
else
  hermes plugins install "$PLUGIN_URL" --ref "$PLUGIN_SHA" || die "플러그인 설치에 실패했습니다 (인터넷과 git 이 필요합니다)"
fi
hermes plugins enable deskrpg || die "플러그인을 켜지 못했습니다"
hermes plugins doctor deskrpg 2>&1 | sed 's/^/   /' || true

# ---------------------------------------------------------------- 5. gateway
say "[5/5] 게이트웨이를 켭니다..."
api() { curl -fsS --max-time 4 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT$1" 2>/dev/null; }
wait_api() { # wait_api seconds
  local i
  for i in $(seq 1 "$1"); do
    api /v1/capabilities >/dev/null && return 0
    sleep 1
  done
  return 1
}
start_service() {
  if api /v1/capabilities >/dev/null; then
    # Already running: restart so it loads the plugin and the new settings.
    hermes gateway restart >/dev/null 2>&1 || true
  else
    hermes gateway install >/dev/null 2>&1 || true
    hermes gateway start >/dev/null 2>&1 || true
  fi
}
start_service
if ! wait_api 45; then
  # A default Hermes install may lack the small web-server library (aiohttp) its API server needs;
  # this is Hermes' own command for adding it.
  note "필요한 구성요소(웹 서버 라이브러리)를 추가하고 다시 시도합니다..."
  hermes pm install --extra sms >/dev/null 2>&1 || true
  hermes gateway restart >/dev/null 2>&1 || start_service
fi
if ! wait_api 45; then
  note "백그라운드 서비스로는 켜지지 않아서, 이 컴퓨터에서 직접 실행해 둡니다 (재부팅하면 꺼져요)."
  mkdir -p "$HERMES_HOME/logs"
  nohup "$HERMES" gateway run >"$HERMES_HOME/logs/gateway-manual.log" 2>&1 &
  wait_api 90 || die "게이트웨이가 켜지지 않았습니다. 로그: $HERMES_HOME/logs/gateway-manual.log"
fi
if api /deskrpg/info >/dev/null; then
  plugin="플러그인 연결됨"
else
  plugin="플러그인 응답 없음 — 'hermes gateway restart' 후에도 같으면 알려 주세요"
fi

say "완료! Hermes 가 켜져 있습니다 ($plugin)"
note "주소: http://127.0.0.1:$PORT"
note "이제 CompanyAI 에서 ⚙ 설정 → Hermes 연결 → '이 컴퓨터의 Hermes 연결하기' 를 누르세요."
note "(접속 키는 앱이 알아서 읽습니다. 직접 쓰시려면: grep API_SERVER_KEY $HERMES_HOME/.env)"
