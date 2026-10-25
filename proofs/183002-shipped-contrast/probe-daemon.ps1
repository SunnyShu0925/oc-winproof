# Shipped-contrast probe for PR 183002.
# Drives the real `openclaw daemon stop --force` on Windows with:
#   - a real Scheduled Task (service loads as schtasks-backed)
#   - a real sibling process holding BEGIN EXCLUSIVE on the state SQLite db
#   - a real forward wall-clock jump injected into the shipped process
# Measures the elapsed time of the shipped command for three cases.
param(
  [Parameter(Mandatory = $true)][string]$OpenClawDir,
  [Parameter(Mandatory = $true)][string]$ScriptsDir,
  [Parameter(Mandatory = $true)][string]$Mode,
  [int]$LockSeconds = 25,
  [int]$JumpAtMs = 12000,
  [int]$JumpMs = 20000
)

$ErrorActionPreference = "Continue"
$runDir = Join-Path $OpenClawDir "proof-run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$resultFile = Join-Path $runDir "$Mode-results.txt"
function Log([string]$message) {
  Write-Host $message
  Add-Content -Path $resultFile -Value $message
}

Log "=== SHIPPED CONTRAST PROBE mode=$Mode ==="
Log ("node=" + (node --version) + " platform=" + [System.Environment]::OSVersion.VersionString)

# Canonical (non-isolated) state dir so the default-install identity gate passes.
$accountHome = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($accountHome)) { $accountHome = $env:HOME }
$stateDir = Join-Path $accountHome ".openclaw"
$stateDbDir = Join-Path $stateDir "state"
Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stateDbDir | Out-Null
Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_HOME -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_PROFILE -ErrorAction SilentlyContinue
$dbPath = Join-Path $stateDbDir "openclaw.sqlite"

$taskName = "OpenClawProbe183002"
$gatewayPort = "19990"
$env:OPENCLAW_SERVICE_KIND = "schtasks"
$env:OPENCLAW_WINDOWS_TASK_NAME = $taskName
$env:OPENCLAW_DEBUG = "1"
$env:OPENCLAW_GATEWAY_PORT = $gatewayPort

function Reset-ProbeState {
  schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
  Remove-Item $dbPath -ErrorAction SilentlyContinue
  node (Join-Path $ScriptsDir "schema-init.cjs") $dbPath | Out-Null
  $probeCmd = "node `"$OpenClawDir\openclaw.mjs`" gateway --dev --port $gatewayPort"
  schtasks /Create /TN $taskName /TR $probeCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
}

function Invoke-ShippedStop([string]$label, [int]$lockSec, [int]$jumpAt, [int]$jump) {
  Reset-ProbeState
  $lockProc = $null
  if ($lockSec -gt 0) {
    $outLog = Join-Path $runDir "$Mode-$label-lock-out.log"
    $errLog = Join-Path $runDir "$Mode-$label-lock-err.log"
    $lockProc = Start-Process -PassThru -NoNewWindow -FilePath "node" `
      -ArgumentList (Join-Path $ScriptsDir "hold-exclusive-lock.cjs"), $dbPath, "$lockSec" `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Start-Sleep -Seconds 1
    if (Test-Path $outLog) { Log ((Get-Content $outLog -Raw).Trim()) }
  }

  Remove-Item Env:PROOF_JUMP_MS -ErrorAction SilentlyContinue
  Remove-Item Env:PROOF_JUMP_AT_MS -ErrorAction SilentlyContinue
  if ($jump -gt 0) {
    $env:PROOF_JUMP_MS = "$jump"
    $env:PROOF_JUMP_AT_MS = "$jumpAt"
  }
  $injectUrl = "file:///" + ((Join-Path $ScriptsDir "clock-inject.mjs") -replace '\\', '/')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Push-Location $OpenClawDir
  $output = node --import $injectUrl openclaw.mjs daemon stop --force 2>&1 | Out-String
  $stopExit = $LASTEXITCODE
  Pop-Location
  $sw.Stop()
  Remove-Item Env:PROOF_JUMP_MS -ErrorAction SilentlyContinue
  Remove-Item Env:PROOF_JUMP_AT_MS -ErrorAction SilentlyContinue

  foreach ($line in ($output -split "`r?`n")) {
    if ($line -match "clock-inject|Gateway stop failed|database is locked|SQLITE_BUSY|Error:") {
      Log ("  " + $line.Trim())
    }
  }
  $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  Log ("CASE $label lock=${lockSec}s jumpAt=${jumpAt}ms jump=${jump}ms => exit=$stopExit elapsed=${elapsed}s")

  if ($lockProc -ne $null) {
    $lockProc.WaitForExit(60000) | Out-Null
    Start-Sleep -Seconds 1
  }
  return [pscustomobject]@{ Label = $label; Exit = $stopExit; Elapsed = $elapsed }
}

# Case A: baseline, no lock and no clock jump (shipped path is healthy).
$caseA = Invoke-ShippedStop "caseA-baseline" 0 0 0
# Case B: lock past the retry budget, no clock jump (control for the jump).
$caseB = Invoke-ShippedStop "caseB-lock-no-jump" $LockSeconds 0 0
# Case C: same lock, forward clock jump after the retry loop has started.
$caseC = Invoke-ShippedStop "caseC-lock-jump" $LockSeconds $JumpAtMs $JumpMs

Log "=== PROBE SUMMARY mode=$Mode ==="
Log ("caseA-baseline          exit=" + $caseA.Exit + " elapsed=" + $caseA.Elapsed + "s")
Log ("caseB-lock-no-jump      exit=" + $caseB.Exit + " elapsed=" + $caseB.Elapsed + "s")
Log ("caseC-lock-jump         exit=" + $caseC.Exit + " elapsed=" + $caseC.Elapsed + "s")
Write-Host "=== PROBE DONE mode=$Mode ==="
exit 0
