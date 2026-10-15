@echo off
rem Sferic gallery dev server on http://127.0.0.1:8779 (port from ~/.claude/port-registry.md)
cd /d "%~dp0"
if not exist node_modules\.bin\vite.cmd (
  echo node_modules missing. Run: npm install
  pause
  exit /b 1
)
call node_modules\.bin\vite.cmd --open %*
if errorlevel 1 (
  echo Vite exited with an error. Try: npm install
  pause
)
