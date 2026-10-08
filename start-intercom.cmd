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
REM   startup.log  - launcher decisions: rebuilds, refusals, restarts
REM
REM node is supervised in a loop and its exit code is propagated out of this
REM script. Both matter: endlocal resets ERRORLEVEL, so without the explicit
REM `endlocal & exit /b %RC%` the Scheduled Task sees success after a crash and
REM never applies its restart policy.

setlocal
set "SERVER_DIR=C:\Users\DELL\Projects\Default Project\qr-intercom\server"
set "NODE=C:\Program Files\nodejs\node.exe"
set "LOG_DIR=%LOCALAPPDATA%\Temp\qr-intercom"
set "LOG=%LOG_DIR%\server.log"
set "STARTUP_LOG=%LOG_DIR%\startup.log"
set "MAX_RESTARTS=10"

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

set /a ATTEMPT=0
pushd "%SERVER_DIR%"

:run
set /a ATTEMPT+=1
echo [%date% %time%] Starting QR Intercom server (attempt %ATTEMPT% of %MAX_RESTARTS%)>>"%STARTUP_LOG%"
"%NODE%" dist/index.js >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" (
  echo [%date% %time%] Exited cleanly.>>"%STARTUP_LOG%"
) else (
  echo [%date% %time%] CRASHED with exit code %RC%.>>"%STARTUP_LOG%"
)

if %ATTEMPT% GEQ %MAX_RESTARTS% (
  echo [%date% %time%] Reached %MAX_RESTARTS% attempts - giving up.>>"%STARTUP_LOG%"
  popd
  endlocal & exit /b %RC%
)

echo [%date% %time%] Restarting in 10s...>>"%STARTUP_LOG%"
timeout /t 10 /nobreak >nul
goto run
