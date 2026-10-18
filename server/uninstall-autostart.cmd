@echo off
setlocal
rem  卸载 WorkBuddy 反代的自启项（不会停止正在运行的实例）
set "STARTUP=%APP:ATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%\workbuddy-proxy-autostart.cmd" (
  del /F /Q "%STARTUP%\workbuddy-proxy-autostart.cmd"
  echo removed: %STARTUP%\workbuddy-proxy-autostart.cmd
) else (
  echo already absent: %STARTUP%\workbuddy-proxy-autostart.cmd
)
exit /b 0
