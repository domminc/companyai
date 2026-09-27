#!/usr/bin/env bash
# CompanyAI: install what's needed, build the screens, start, and open the browser.
cd "$(dirname "$0")" || exit 1

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1; fi
}

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Node.js 가 필요합니다. 설치 페이지를 엽니다."
  echo " \"LTS\" 버전을 설치한 뒤 이 파일을 다시 실행하세요."
  open_url "https://nodejs.org/ko/download"
  read -r -p " 엔터를 누르면 닫힙니다..." _
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo " Node.js 22 이상이 필요합니다 (지금 $(node -v)). 최신 LTS 를 설치한 뒤 다시 실행하세요."
  open_url "https://nodejs.org/ko/download"
  read -r -p " 엔터를 누르면 닫힙니다..." _
  exit 1
fi

fail() {
  echo
  echo " 문제가 생겼습니다. 위의 메시지를 복사해서 알려 주세요."
  read -r -p " 엔터를 누르면 닫힙니다..." _
  exit 1
}

echo
echo " [1/3] 필요한 파일을 설치합니다 (처음에는 몇 분 걸립니다)..."
npm install --no-audit --no-fund || fail
echo " [2/3] 화면을 준비합니다..."
npm run build || fail
echo " [3/3] 시작합니다. 잠시 후 브라우저가 열립니다: http://localhost:8787"
echo " 끝내려면 이 창을 닫거나 Ctrl+C 를 누르세요."
echo
(sleep 4 && open_url "http://localhost:8787") &
npm start
