@echo off
chcp 65001 >nul
title CompanyAI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js 가 필요합니다. 설치 페이지를 엽니다.
  echo  "LTS" 버전을 설치한 뒤 이 파일을 다시 더블클릭하세요.
  echo.
  start "" https://nodejs.org/ko/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 22 (
  echo.
  echo  Node.js 22 이상이 필요합니다. 지금 버전:
  node -v
  echo  설치 페이지에서 최신 LTS 를 설치한 뒤 다시 실행하세요.
  start "" https://nodejs.org/ko/download
  pause
  exit /b 1
)

echo.
echo  [1/3] 필요한 파일을 설치합니다 (처음에는 몇 분 걸립니다)...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo  [2/3] 화면을 준비합니다...
call npm run build
if errorlevel 1 goto fail

echo  [3/3] 시작합니다. 잠시 후 브라우저가 열립니다: http://localhost:8787
echo  끝내려면 이 창을 닫으세요.
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8787"
call npm start
goto end

:fail
echo.
echo  문제가 생겼습니다. 위의 메시지를 복사해서 알려 주세요.
pause
:end
