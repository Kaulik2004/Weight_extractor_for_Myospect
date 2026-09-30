# Builds the React app and serves everything from FastAPI on one port.
# Usage:  powershell -ExecutionPolicy Bypass -File .\start-prod.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root 'backend\.venv\Scripts\python.exe'

Push-Location (Join-Path $root 'frontend')
if (-not (Test-Path node_modules)) { npm install }
npm run build
Pop-Location

Push-Location (Join-Path $root 'backend')
Write-Host 'Open http://127.0.0.1:8000'
& $py -m uvicorn app.main:app --host 127.0.0.1 --port 8000
Pop-Location
