@echo off
rem ---------------------------------------------------------------------
rem  Start JARVIS: the screen (Vite) and the brain (bridge) in two windows,
rem  then open the interface in Chrome (or the default browser).
rem  Close both JARVIS windows, or run "Stop JARVIS.bat", to shut it down.
rem ---------------------------------------------------------------------
setlocal
cd /d "%~dp0..\.."
title Starting JARVIS

rem Lite mode for low-power PCs: JARVIS_LITE=1 in .env.local adds ?lite.
set "Q="
if exist ".env.local" findstr /b /c:"JARVIS_LITE=1" ".env.local" >nul && set "Q=?lite"

rem Already running? Just open the page instead of starting a second copy.
curl -s -o nul http://localhost:5173 && goto open

rem Pick up any fixes pushed since last time. Offline is fine; carry on.
git pull --ff-only >nul 2>&1

rem First run, or a half-finished install: install the parts.
if not exist "node_modules\vite\package.json" (
  echo Installing JARVIS parts - this takes a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo The install failed. If it mentions ENOSPC, the disk is full.
    pause
    exit /b 1
  )
)

rem Serve the finished build rather than the developer server: far lighter in
rem the browser, which matters on a low-power laptop. Rebuilt only when the
rem code has changed since the last build (a new git commit).
set "HEAD="
for /f %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD=%%h"
set "BUILT="
if exist "dist\.built" set /p BUILT=<"dist\.built"
if not exist "dist\index.html" set "BUILT=none"
if not "%HEAD%"=="%BUILT%" (
  echo Preparing JARVIS after an update - this can take a minute...
  call node node_modules\vite\bin\vite.js build --logLevel error
  if errorlevel 1 (
    echo.
    echo Preparing JARVIS failed. The messages above say why.
    pause
    exit /b 1
  )
  >"dist\.built" echo %HEAD%
)

rem node directly rather than npm, which retitles the window and would hide it
rem from "Stop JARVIS.bat".
start "JARVIS - screen" /min cmd /k node node_modules\vite\bin\vite.js preview --port 5173 --strictPort
start "JARVIS - brain" /min cmd /k node bridge\server.mjs

echo Waiting for JARVIS to come up...
set /a tries=0
:wait
curl -s -o nul http://localhost:5173 && goto open
set /a tries+=1
if %tries% geq 60 (
  echo.
  echo The screen did not start within a minute.
  echo Open the "JARVIS - screen" window on the taskbar to see why.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" "http://localhost:5173/%Q%"
) else (
  start "" "http://localhost:5173/%Q%"
)
exit /b 0
