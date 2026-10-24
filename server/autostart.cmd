@echo off
setlocal

rem Windows batch parses .cmd as OEM code page. Any non-ASCII byte here breaks
rem command tokenization (measured: "'rse-proxy' is not recognized"). Keep this
rem file pure ASCII; explanations belong in the .md docs.

set "NODE=C:\Program Files\nodejs\node.exe"
rem Batch expands %VAR%, not $VAR. This was written as "$DSH_HOME\logs" and
rem silently created a literal "$DSH_HOME" directory under whatever the
rem current working directory was, so the real log file was never touched.
if defined DSH_HOME (set "LOGDIR=%DSH_HOME%\logs") else (set "LOGDIR=D:\dsh\logs")
set "OUT=%LOGDIR%\workbuddy-proxy.out.log"
set "ERR=%LOGDIR%\workbuddy-proxy.err.log"
set "AUTOSTART_LOG=%LOGDIR%\autostart.log"
set "EXITLOG=%LOGDIR%\workbuddy-proxy.exit.log"
set "MAXBYTES=5242880"

rem Resolve the proxy script: prefer %HERMES_HOME%, fall back to D:\Hermes.
if not defined HERMES_HOME set "HERMES_HOME=D:\Hermes"
set "PROXY=%HERMES_HOME%\skills\workbuddy-reverse-proxy\server\workbuddy-proxy.mjs"

rem Log with an ISO timestamp: %date%/%time% are localized and their encoding
rem depends on the OEM code page, which turned the log into unreadable mojibake.
for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK" 2^>nul') do set "TS=%%I"
if not defined TS set "TS=unknown"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul

if not exist "%NODE%" goto :nodate
if not exist "%PROXY%" goto :noproxy

rem --- Probe the proxy HTTP endpoint instead of the port table -------------
rem HARDENED 2026-10-24. The previous check was:
rem   netstat -ano ^| findstr /C:"127.0.0.1:8788" ^| findstr /C:"LISTENING"
rem and it produced a FALSE POSITIVE on that day: the 10:52:52 logon run
rem decided "already listening", wrote no log line at all and returned 0,
rem while nothing held 8788. The task therefore reported success forever and
rem the proxy never came back after an earlier Ctrl+C. netstat also misses
rem listeners owned by a higher integrity level (measured separately), so the
rem port table is not a trustworthy liveness source on this machine.
rem /healthz answers only when the proxy really serves, so ask it directly.
rem
rem ALIVE is set from the do-body, so it exists only on a real HTTP answer.
rem goto-based flow is deliberate: a block spanning a `for` statement has
rem bitten us with parser quirks in this shell.
set "ALIVE="
for /f "delims=" %%A in ('powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8788/healthz' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop; if ($r.StatusCode -eq 200) { 'ALIVE' } } catch { }" 2^>nul') do set "ALIVE=1"

if not defined ALIVE goto :start

rem Skip logging goes to its OWN file: the running instance holds an
rem exclusive append handle on OUT/ERR, so appending there would fail with
rem "The process cannot access the file because it is being used by another
rem process."
echo [%TS%] skip already-listening=8788>> "%AUTOSTART_LOG%"
exit /b 0

:start
rem Rotate the proxy's own logs above ~5 MB so they cannot grow forever.
rem Only rotate when no instance is running, which is the case here.
for %%F in ("%OUT%") do if %%~zF GTR %MAXBYTES% move /Y "%OUT%" "%OUT%.1" >nul 2>&1
for %%F in ("%ERR%") do if %%~zF GTR %MAXBYTES% move /Y "%ERR%" "%ERR%.1" >nul 2>&1

echo [%TS%] start proxy=%PROXY%>> "%AUTOSTART_LOG%"

rem DETACHED START (2026-10-24, second revision). This used to run node in the
rem foreground, chosen because `start /B` detaches the exit code and that hid an
rem earlier silent death. The cost was worse: while the proxy ran this script
rem never returned, so the task sat in "running" forever and its retry /
rem RestartCount logic could never fire - a dead proxy stayed dead across
rem logons.
rem
rem Two detach mechanisms were measured. Win32_Process.Create returns a PID but
rem the created process was reaped as soon as its host exited (rc=255, node
rem gone within 2.4s), so it is useless here. Spawning through a launcher .cmd
rem survives: the node process kept serving after its parent cmd was killed.
rem
rem The launcher file carries the redirection, because a detached process has
rem no stdio of its own - and the proxy logs via console.log, which throws on a
rem null stream instead of failing quietly.
set "T0=%TIME%"
set "LAUNCHER=%~dp0run-proxy.cmd"
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo start "" /b "%NODE%" "%PROXY%" 1^>^>"%OUT%" 2^>^>"%ERR%"
set "LAUNCHED="
for /f "delims=" %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath cmd.exe -ArgumentList '/c', '%LAUNCHER%' -WindowStyle Hidden -PassThru; $p.Id" 2^>nul') do set "LAUNCHED=%%P"

if not defined LAUNCHED goto :launchfail
echo [%TS%] launched=%LAUNCHED%>> "%AUTOSTART_LOG%"
set "READY="
for /f "delims=" %%W in ('powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8788/healthz' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; if ($r.StatusCode -eq 200) { 'READY'; break } } catch { Start-Sleep -Milliseconds 1000 } }" 2^>nul') do set "READY=%%W"
set "T1=%TIME%"

if defined READY goto :report
rem Nothing answered within 30s. The child may have died on a credential
rem vault that was still locked right after logon, so retry exactly once.
echo [%TS%] retry after no-healthz pid=%LAUNCHED%>> "%AUTOSTART_LOG%"
timeout /t 20 /nobreak >nul 2>&1
for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK" 2^>nul') do set "TS=%%I"
set "LAUNCHED="
for /f "delims=" %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath cmd.exe -ArgumentList '/c', '%LAUNCHER%' -WindowStyle Hidden -PassThru; $p.Id" 2^>nul') do set "LAUNCHED=%%P"
echo [%TS%] relaunched pid=%LAUNCHED%>> "%AUTOSTART_LOG%"
set "READY="
for /f "delims=" %%W in ('powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8788/healthz' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; if ($r.StatusCode -eq 200) { 'READY'; break } } catch { Start-Sleep -Milliseconds 1000 } }" 2^>nul') do set "READY=%%W"
set "T1=%TIME%"

:report
rem No node exit code exists any more (the process is detached), so rc reports
rem the only thing this script actually knows: whether /healthz answered.
if defined READY (set "RC=0") else (set "RC=1")
echo [%TS%] exit rc=%RC% start=%T0% end=%T1%>> "%EXITLOG%"
exit /b %RC%

:nodate
echo [%TS%] error node-not-found=%NODE%>> "%AUTOSTART_LOG%"
exit /b 1

:noproxy
echo [%TS%] error proxy-not-found=%PROXY%>> "%AUTOSTART_LOG%"
exit /b 1

:launchfail
echo [%TS%] error cannot-create-process>> "%AUTOSTART_LOG%"
exit /b 1
