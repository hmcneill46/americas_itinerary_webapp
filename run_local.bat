@echo off
cd /d %~dp0
if not exist .venv\Scripts\python.exe (
  py -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
set ITINERARY_HOST=127.0.0.1
set ITINERARY_PORT=8765
.venv\Scripts\python.exe app.py
pause
