# Probe: does `openclaw daemon stop --force` reach retryScheduledTaskLeaseRead,
# and does a forward wall-clock jump during the retry loop distinguish
# pre-fix (Date.now) from post-fix (performance.now)?
param(
  [string]$OpenClawDir,   # directory containing openclaw.mjs
  [string]$ScriptsDir,    # directory containing schema-init.cjs etc.
  [string]$StateDir,      # isolated OPENCLAW_STATE_DIR
  [string]$Mode           # "postfix" or "prefix"
)

$ErrorActionPreference = "Continue"
Write-Host "=== PROBE: shipped daemon stop path (Mode=$Mode) ==="
Write-Host "OpenClawDir = $OpenClawDir"
Write-Host "ScriptsDir  = $ScriptsDir"
Write-Host "StateDir    = $StateDir"
Write-Host ""

# --- canonical state dir (NOT isolated) so isDefaultInstallIdentity passes ---
# canonical = <account home>/.openclaw/state/openclaw.sqlite
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
Write-Host "canonical state db: $dbPath"
node (Join-Path $ScriptsDir "schema-init.cjs") $dbPath
Write-Host "state db exists=$(Test-Path $dbPath)"
node (Join-Path $ScriptsDir "journal-check.cjs") $dbPath "after schema-init"
Write-Host ""
Write-Host "USERPROFILE = $env:USERPROFILE"
Write-Host "HOME        = $env:HOME"
Write-Host "OPENCLAW_PROFILE = $env:OPENCLAW_PROFILE"
Write-Host ""

# --- minimal scheduled task so daemon stop sees the service as loaded ---
$taskName = "OpenClawProbe183002"
schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
$gatewayPort = "19990"
$probeCmd = "node `"$OpenClawDir\openclaw.mjs`" gateway --dev --port $gatewayPort"
schtasks /Create /TN $taskName /TR $probeCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Host
Write-Host "schtasks create exit: $LASTEXITCODE"
schtasks /Query /TN $taskName /FO LIST 2>&1 | Out-Host
Write-Host ""

$env:OPENCLAW_SERVICE_KIND = "schtasks"
$env:OPENCLAW_WINDOWS_TASK_NAME = $taskName
$env:OPENCLAW_DEBUG = "1"
$env:OPENCLAW_GATEWAY_PORT = $gatewayPort

# --- Case 0: no lock, no clock jump (baseline: shipped path should succeed) ---
Write-Host "--- Case 0: daemon stop --force (no lock, no clock jump) ---"
Push-Location $OpenClawDir
node openclaw.mjs daemon stop --force 2>&1 | Out-Host
$case0Exit = $LASTEXITCODE
Pop-Location
Write-Host "Case 0 daemon stop exit: $case0Exit"
node (Join-Path $ScriptsDir "journal-check.cjs") $dbPath "after Case 0 daemon stop"
Write-Host ""

# --- Case 1 setup: recreate task + reset db, then sibling EXCLUSIVE lock ---
# (Case 0 may have removed the task / settled state)
schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
$gatewayPort = "19990"
$probeCmd = "node `"$OpenClawDir\openclaw.mjs`" gateway --dev --port $gatewayPort"
schtasks /Create /TN $taskName /TR $probeCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
Remove-Item $dbPath -ErrorAction SilentlyContinue
node (Join-Path $ScriptsDir "schema-init.cjs") $dbPath
node (Join-Path $ScriptsDir "journal-check.cjs") $dbPath "after Case 1 schema-init"
Write-Host ""
Write-Host "--- start sibling EXCLUSIVE write lock (10s) ---"
$lockProc = Start-Process -PassThru -NoNewWindow `
  -FilePath "node" -ArgumentList (Join-Path $ScriptsDir "hold-exclusive-lock.cjs"),$dbPath,"18" `
  -RedirectStandardOutput (Join-Path $StateDir "lock-out.log") `
  -RedirectStandardError (Join-Path $StateDir "lock-err.log")
Start-Sleep -Seconds 1
Get-Content (Join-Path $StateDir "lock-out.log") -ErrorAction SilentlyContinue

# --- daemon stop with clock injection ---
Write-Host ""
Write-Host "--- daemon stop --force with clock injection ---"
$env:PROOF_JUMP_MS = "20000"
$env:PROOF_JUMP_AT_MS = "12000"
$injectPath = Join-Path $ScriptsDir "clock-inject.mjs"
$injectUrl = "file:///" + ($injectPath -replace '\\','/')
Write-Host "clock-inject url: $injectUrl"
Push-Location $OpenClawDir
$sw = [System.Diagnostics.Stopwatch]::StartNew()
node --import $injectUrl openclaw.mjs daemon stop --force 2>&1 | Out-Host
$stopExit = $LASTEXITCODE
$sw.Stop()
Pop-Location
Remove-Item Env:PROOF_JUMP_MS -ErrorAction SilentlyContinue
Remove-Item Env:PROOF_JUMP_AT_MS -ErrorAction SilentlyContinue
Write-Host "daemon stop exit: $stopExit (elapsed $($sw.Elapsed.TotalSeconds)s)"

# wait for lock to release
Start-Sleep -Seconds 6
Get-Content (Join-Path $StateDir "lock-err.log") -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== PROBE RESULT (Mode=$Mode) ==="
if ($Mode -eq "postfix") {
  Write-Host "postfix: expect SUCCESS (retry survives forward clock jump)"
  if ($stopExit -eq 0) { Write-Host "POSTFIX_OK exit=0" } else { Write-Host "POSTFIX_NONZERO exit=$stopExit" }
} else {
  Write-Host "prefix: expect FAILURE (retry abandons due to Date.now deadline jump)"
  if ($stopExit -ne 0) { Write-Host "PREFIX_FAIL exit=$stopExit" } else { Write-Host "PREFIX_OK exit=$stopExit" }
}
Write-Host "=== PROBE DONE ==="
