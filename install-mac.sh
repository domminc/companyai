#!/usr/bin/env bash
# CompanyAI one-line installer for Mac (and Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/domminc/companyai/claude/agent-hiring-meeting-engine-dd62tj/install-mac.sh | bash
#
# Installs into ~/CompanyAI, brings its own Node.js when the Mac has none (no admin password),
# builds the app, puts a "CompanyAI" launcher on the Desktop and starts it. Files fetched with
# curl aren't quarantined by Gatekeeper, so nothing gets blocked. Run it again to update; the
# company data in ~/CompanyAI/data is kept.
set -euo pipefail

BRANCH="claude/agent-hiring-meeting-engine-dd62tj"
ZIP_URL="https://github.com/domminc/companyai/archive/refs/heads/${BRANCH}.zip"
HOME_DIR="${COMPANYAI_HOME:-$HOME/CompanyAI}"
APP="$HOME_DIR/app"
NODE_DIR="$HOME_DIR/node"
NODE_MAJOR=22

say() { printf '\n \033[1m%s\033[0m\n' "$*"; }
die() {
  printf '\n 문제가 생겼습니다: %s\n 이 창의 내용을 복사해서 알려 주세요.\n\n' "$*" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)
case "$os-$arch" in
  Darwin-arm64) node_platform="darwin-arm64" ;;
  Darwin-x86_64) node_platform="darwin-x64" ;;
  Linux-x86_64) node_platform="linux-x64" ;;
  Linux-aarch64 | Linux-arm64) node_platform="linux-arm64" ;;
  *) die "지원하지 않는 컴퓨터입니다 ($os $arch)" ;;
esac

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

mkdir -p "$HOME_DIR" "$HOME_DIR/data"

# 1. Node.js: use the Mac's own if it is new enough, otherwise a private copy in ~/CompanyAI/node.
have_node() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; }
if [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi
if [ "${COMPANYAI_PORTABLE_NODE:-}" = "1" ] || ! have_node; then
  say "[1/4] Node.js 를 준비합니다 (관리자 암호 없이 ~/CompanyAI 안에만 설치)..."
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || die "Node.js 목록을 받지 못했습니다 (인터넷 연결 확인)"
  line=$(printf '%s\n' "$sums" | grep " node-v[0-9.]*-${node_platform}.tar.gz$" | head -1)
  [ -n "$line" ] || die "Node.js 파일을 찾지 못했습니다 ($node_platform)"
  expected=${line%% *}
  file=${line##* }
  tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/$file" "$base/$file" || die "Node.js 를 받지 못했습니다"
  [ "$(sha256 "$tmp/$file")" = "$expected" ] || die "받은 Node.js 파일이 손상되었습니다. 다시 실행해 주세요"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
else
  say "[1/4] Node.js $(node -v) 가 이미 있습니다."
fi

# 2. The app itself: latest code, replacing the old copy but never the data.
say "[2/4] CompanyAI 를 받습니다..."
tmp=$(mktemp -d)
curl -fL --progress-bar -o "$tmp/app.zip" "$ZIP_URL" || die "코드를 받지 못했습니다"
unzip -q "$tmp/app.zip" -d "$tmp"
src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -name 'companyai-*' | head -1)
[ -n "$src" ] || die "받은 파일에 앱이 없습니다"
# Keep installed packages across updates so the second run is quick.
[ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$src/node_modules"
rm -rf "$APP"
mv "$src" "$APP"
rm -rf "$tmp"

# 3. Packages and the screens.
say "[3/4] 필요한 파일을 설치하고 화면을 만듭니다 (처음에는 몇 분 걸립니다)..."
cd "$APP"
npm install --no-audit --no-fund --loglevel=error --update-notifier=false || die "npm install 실패"
if ! npm run build >"$HOME_DIR/build.log" 2>&1; then
  tail -30 "$HOME_DIR/build.log"
  die "화면 만들기 실패"
fi

# 4. A launcher made here rather than downloaded, so Gatekeeper lets it open with a double-click.
launcher_body() {
  cat <<EOF
#!/usr/bin/env bash
# CompanyAI 시작 (설치 프로그램이 만든 파일)
export PATH="$NODE_DIR/bin:\$PATH"
export COMPANYAI_DATA="$HOME_DIR/data/company.json"
cd "$APP" || exit 1
if lsof -ti tcp:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo " 이미 켜져 있습니다. 브라우저를 엽니다."
  open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787
  exit 0
fi
echo
echo " CompanyAI 를 켭니다. 잠시 후 브라우저가 열립니다: http://localhost:8787"
echo " 끝내려면 이 창을 닫으세요."
(sleep 4 && (open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787 >/dev/null 2>&1)) &
exec npm start
EOF
}
launcher="$HOME_DIR/CompanyAI.command"
launcher_body >"$launcher"
chmod +x "$launcher"
if [ -d "$HOME/Desktop" ]; then
  cp "$launcher" "$HOME/Desktop/CompanyAI.command"
  chmod +x "$HOME/Desktop/CompanyAI.command"
  where="바탕화면의 CompanyAI.command"
else
  where="$launcher"
fi

say "[4/4] 설치 완료! 지금 켭니다."
echo "  다음부터는 ${where} 를 더블클릭하면 됩니다."
echo "  업데이트할 때는 같은 한 줄 명령을 다시 붙여 넣으세요 (회사 데이터는 그대로 남습니다)."
[ "${COMPANYAI_NO_START:-}" = "1" ] && exit 0
exec bash "$launcher"
