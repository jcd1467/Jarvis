@echo off
rem Stop JARVIS: closes the two windows "Start JARVIS.bat" opened, and
rem anything still listening on JARVIS's ports (5173 screen, 8787 brain) -
rem which also covers copies started by hand with npm run dev / bridge.
taskkill /FI "WINDOWTITLE eq JARVIS - screen*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq JARVIS - brain*" /T /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":5173 .*LISTENING" /C:":8787 .*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
echo JARVIS stopped.
timeout /t 2 /nobreak >nul
