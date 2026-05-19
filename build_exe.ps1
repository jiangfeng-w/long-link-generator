$ErrorActionPreference = "Stop"

$Python = if (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe") {
  "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"
} else {
  "python"
}

& $Python -m PyInstaller `
  --onefile `
  --name LongLinkGenerator `
  --add-data "public;public" `
  server.py

Write-Host ""
Write-Host "Build complete: dist\LongLinkGenerator.exe"
