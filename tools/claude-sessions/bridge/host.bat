@echo off
rem Switchboard bridge launcher. Chrome starts this; stdout must carry only the host's frames.
setlocal
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0host.mjs" %*
