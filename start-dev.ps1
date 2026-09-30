# Starts the FastAPI backend and the Vite dev server in two windows.
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root 'backend\.venv\Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host 'Creating backend virtualenv...'
    python -m venv (Join-Path $root 'backend\.venv')
    & $py -m pip install -r (Join-Path $root 'backend\requirements.txt')
}
if (-not (Test-Path (Join-Path $root 'frontend\node_modules'))) {
    Write-Host 'Installing frontend packages...'
    Push-Location (Join-Path $root 'frontend'); npm install; Pop-Location
}

Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd '$root\backend'; & '$py' -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd '$root\frontend'; npm run dev"
Write-Host 'Backend: http://127.0.0.1:8000/docs   Frontend: http://localhost:5173'
