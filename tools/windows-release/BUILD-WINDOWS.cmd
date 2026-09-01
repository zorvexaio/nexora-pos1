@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-WINDOWS.ps1"
if errorlevel 1 (
  echo.
  echo Nexora POS Windows build FAILED.
  exit /b 1
)
echo.
echo Nexora POS Windows build completed successfully.
endlocal
