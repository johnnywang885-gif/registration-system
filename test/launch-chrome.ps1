# Launch Chrome with remote debugging for chrome-devtools-mcp (opencode).
# Usage: pwsh test/launch-chrome.ps1
# After this script succeeds, the MCP `chrome-devtools` tools are usable
# (opencode.json uses --browserUrl http://127.0.0.1:9222).

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { throw "Chrome not found at $chrome" }

$profile = Join-Path $PSScriptRoot '.chrome-profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null

# Already up?
try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2 | Out-Null
  Write-Host 'Chrome already running on 9222 - nothing to do.'
  exit 0
} catch { }

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  '--remote-debugging-port=9222',
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1400,900'
) | Out-Null

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
    Write-Host ("DevTools ready on 9222 (browser: {0})" -f $v.Browser)
    exit 0
  } catch { }
} while ((Get-Date) -lt $deadline)

throw 'Chrome failed to expose DevTools on 9222 within 30s'
