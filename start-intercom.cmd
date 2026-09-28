@echo off
REM ── QR Intercom server launcher ──────────────────────────────────────────────
REM Started by the "QR Intercom Server" scheduled task at logon, and usable by
REM hand. Keeps the working directory pinned to the server folder, because both
REM the .env loader and the TLS cert lookup resolve paths against the cwd:
REM   config/index.ts  -> path.resolve(process.cwd(), ".env")
REM   index.ts         -> path.resolve("../certs")
REM Getting this wrong silently starts with no config and no certs.
REM
REM Two logs, deliberately separate: node holds server.log open for the lifetime
REM of the process, so the launcher cannot append to it (Windows file lock).
REM   server.log   - the node process's own stdout/stderr
REM   startup.log  - launcher decisions: rebuilds, refusals, start attempts

setlocal
set "SERVER_DIR=C:\Users\DELL\Projects\Default Project\qr-intercom\server"
set "NODE=C:\Program Files\nodejs\node.exe"
set "LOG_DIR=%LOCALAPPDATA%\Temp\qr-intercom"
set "LOG=%LOG_DIR%\server.log"
set "STARTUP_LOG=%LOG_DIR%\startup.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

REM Rebuild if dist is missing (first run after a clone, or after a tsc failure).
if not exist "%SERVER_DIR%\dist\index.js" (
  echo [%date% %time%] dist missing - building...>>"%STARTUP_LOG%"
  pushd "%SERVER_DIR%"
  "%NODE%" "%SERVER_DIR%\node_modules\typescript\bin\tsc" >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo [%date% %time%] BUILD FAILED - see server.log>>"%STARTUP_LOG%"
    popd
    exit /b 1
  )
  echo [%date% %time%] build ok>>"%STARTUP_LOG%"
  popd
)

REM Refuse to start a second copy: EADDRINUSE on 3010 would silently take the
REM funnel's only backend path down with it.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3010 "') do (
  echo [%date% %time%] Port 3010 already in use by PID %%p - not starting a second instance.>>"%STARTUP_LOG%"
  exit /b 0
)

echo [%date% %time%] Starting QR Intercom server>>"%STARTUP_LOG%"
pushd "%SERVER_DIR%"
"%NODE%" dist/index.js >>"%LOG%" 2>&1
popd
endlocal
