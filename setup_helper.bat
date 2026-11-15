@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\install.ps1" -UpdateDependencies
if errorlevel 1 (
    echo Helper setup failed. See the error above.
) else (
    echo Helper setup complete. Reload the extension in chrome://extensions.
)
pause
