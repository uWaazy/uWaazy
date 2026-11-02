@echo off
cd /d "%~dp0.."
set MSG=%~1
if "%MSG%"=="" set MSG=update
git add -A
git commit -m "%MSG%"
git push
pause
