@echo off
setlocal

rem Windows batch parses .cmd as OEM code page. Any non-ASCII byte here breaks
rem command tokenization (measured: "'rse-proxy' is not recognized"). Keep this
rem file pure ASCII; explanations belong in the .md docs.

set "NODE=C:\Program Files\nodejs\node.exe"
set "LOGDIR=$DSH_HOME\logs"
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

rem --- Detect an existing listener on 8788 -------------------------------
rem netstat output is localized; only the ASCII "127.0.0.1:8788" and
rem "LISTENING" tokens are matched. ALREADY is assigned from the do-body, so
rem it is only ever defined when a match really exists.
rem
rem goto-based flow is deliberate: a block spanning a `for` statement has
rem bitten us with parser quirks in this shell.
set "ALREADY="
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /C:"127.0.0.1:8788" ^| findstr /C:"LISTENING"') do set "ALREADY=1"

if not defined ALREADY goto :start

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

rem Run UNDER the cmd redirection instead of `start /B`: `start` detaches the
rem exit code, which is exactly how the earlier silent death went undiagnosed.
set "T0=%TIME%"
"%NODE%" "%PROXY%" 1>> "%OUT%" 2>> "%ERR%"
set "RC=%ERRORLEVEL%"
set "T1=%TIME%"

if "%RC%"=="0" goto :report
rem Exit code 2 is the proxy's own contract (bad config / EADDRINUSE /
rem missing credential) - retrying would just reproduce it.
if "%RC%"=="2" goto :report
rem Any other non-zero code is treated as a transient startup failure
rem (typically the credential vault still locked right after login) and gets
rem exactly one retry.
echo [%TS%] retry after rc=%RC%>> "%AUTOSTART_LOG%"
timeout /t 20 /nobreak >nul 2>&1
for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK" 2^>nul') do set "TS=%%I"
set "T0=%TIME%"
"%NODE%" "%PROXY%" 1>> "%OUT%" 2>> "%ERR%"
set "RC=%ERRORLEVEL%"
set "T1=%TIME%"

:report
echo [%TS%] exit rc=%RC% start=%T0% end=%T1%>> "%EXITLOG%"
exit /b 0

:nodate
echo [%TS%] error node-not-found=%NODE%>> "%AUTOSTART_LOG%"
exit /b 1

:noproxy
echo [%TS%] error proxy-not-found=%PROXY%>> "%AUTOSTART_LOG%"
exit /b 1
