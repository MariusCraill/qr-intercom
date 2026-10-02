@echo off
title QR Video Intercom Server
color 0B

set "NODEJS=C:\nodejs"
set "LOCAL=%~dp0server"
set "DATA=C:\qr-intercom-data"

if exist "%NODEJS%\node.exe" (
    set "PATH=%NODEJS%;%PATH%"
)

echo ========================================
echo   QR Video Intercom - Starting Up
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo         Download from https://nodejs.org
    pause
    exit /b 1
)

echo [INFO] Node.js found:
node --version
echo.

rem ---- read ports from .env so they only have to be changed in one place ----
set "HTTP_PORT=3100"
set "HTTPS_PORT=3143"
if exist "%LOCAL%\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%LOCAL%\.env") do (
        if /i "%%a"=="PORT" set "HTTP_PORT=%%b"
        if /i "%%a"=="HTTPS_PORT" set "HTTPS_PORT=%%b"
    )
)

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4" ^| findstr /v "127.0.0.1" ^| findstr /v "169.254"') do (
    set "RAWIP=%%a"
    goto :gotip
)
:gotip
set "LOCAL_IP=%RAWIP: =%"

echo [INFO] Local IP:   %LOCAL_IP%
echo [INFO] HTTP port:  %HTTP_PORT%
echo [INFO] HTTPS port: %HTTPS_PORT%
echo.

rem ---- fail early with a clear message instead of a stack trace ----
netstat -ano | findstr /r /c:":%HTTP_PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [ERROR] Port %HTTP_PORT% is already in use.
    echo         Change PORT in %LOCAL%\.env and run this again.
    pause
    exit /b 1
)

if not exist "%LOCAL%\node_modules" (
    echo [INFO] Installing dependencies...
    echo.
    pushd "%LOCAL%"
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        popd
        pause
        exit /b 1
    )
    popd
    echo.
)

if not exist "%LOCAL%\.env" (
    echo [INFO] Creating .env from .env.example with a random JWT_SECRET
    node -e "const fs=require('fs'),c=require('crypto');fs.writeFileSync(process.argv[1],fs.readFileSync(process.argv[2],'utf8').replace(/^JWT_SECRET=.*$/m,'JWT_SECRET='+c.randomBytes(32).toString('hex')))" "%LOCAL%\.env" "%LOCAL%\.env.example"
    if errorlevel 1 (
        echo [ERROR] Could not create .env
        pause
        exit /b 1
    )
    echo [OK]   JWT_SECRET generated and stored in .env
    echo.
)

if not exist "%DATA%" mkdir "%DATA%"

echo [INFO] Starting server...
echo.

start "Intercom Server" cmd /c "pushd "%LOCAL%" && node src/index.js"

rem ---- wait for the server to actually answer instead of guessing ----
echo [INFO] Waiting for the server to become ready...
set "READY="
for /l %%i in (1,1,120) do (
    if not defined READY (
        curl -s -o NUL -w "%%{http_code}" "http://127.0.0.1:%HTTP_PORT%/healthz" 2>NUL | findstr /b "200" >NUL && set "READY=1"
        if not defined READY timeout /t 1 /nobreak >NUL
    )
)

if not defined READY (
    echo [ERROR] Server did not answer on port %HTTP_PORT% within 120s.
    echo         Check the Intercom Server window for the reason.
    pause
    exit /b 1
)

echo [INFO] Server is ready. Opening dashboard...
start "" "http://%LOCAL_IP%:%HTTP_PORT%/"

echo.
echo ========================================
echo   SERVER IS RUNNING
echo ========================================
echo.
echo   --- HTTP (port %HTTP_PORT%) ---
echo   Dashboard:  http://%LOCAL_IP%:%HTTP_PORT%/
echo   Resident:   http://%LOCAL_IP%:%HTTP_PORT%/resident/
echo   Health:     http://%LOCAL_IP%:%HTTP_PORT%/healthz
echo   Gate kiosk: http://%LOCAL_IP%:%HTTP_PORT%/gate/front-gate
echo.
echo   --- HTTPS (port %HTTPS_PORT%) - USE FOR VIDEO CALLS ---
echo   Resident:   https://%LOCAL_IP%:%HTTPS_PORT%/resident/
echo   Call link:  https://%LOCAL_IP%:%HTTPS_PORT%/call/^<residentId^>
echo.
echo   Accept the self-signed cert warning once on each phone,
echo   then camera/mic will work for WebRTC calls.
echo   The certificate is cached in .certs, so the warning
echo   will not reappear after a server restart.
echo ========================================
echo.
echo Press any key to stop the server...
pause >nul

taskkill /FI "WINDOWTITLE eq Intercom Server*" /T /F >nul 2>nul
echo Server stopped.
