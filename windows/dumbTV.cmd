@echo off
rem dumbTV launcher (Windows). Starts the local server, opens the config page,
rem and plays via the bundled mpv. Everything ships in this folder.
setlocal
set "HERE=%~dp0"
set "DUMBTV_PLAYER=mpv"
set "DUMBTV_MPV=%HERE%mpv\mpv.exe"
start "" "http://localhost:8080"
"%HERE%node\node.exe" "%HERE%src\index.js"
