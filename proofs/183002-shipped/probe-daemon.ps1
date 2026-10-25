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

# --- isolated state dir + schema ---
Remove-Item -Recurse -Force $StateDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $StateDir "state") | Out-Null
$env:OPENCLAW_STATE_DIR = $StateDir
$dbPath = Join-Path $StateDir "state\openclaw.sqlite"
node (Join-Path $ScriptsDir "schema-init.cjs") $dbPath
Write-Host "state db exists=$(Test-Path $dbPath)"

# --- minimal scheduled task so daemon stop sees the service as loaded ---
$taskName = "OpenClawProbe183002"
schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
$probeCmd = "node `"$OpenClawDir\openclaw.mjs`" --version"
schtasks /Create /TN $taskName /TR $probeCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Host
Write-Host "schtasks create exit: $LASTEXITCODE"
schtasks /Query /TN $taskName /FO LIST 2>&1 | Out-Host
Write-Host ""

$env:OPENCLAW_SERVICE_KIND = "schtasks"
$env:OPENCLAW_WINDOWS_TASK_NAME = $taskName

# --- Case 0: no lock, no clock jump (baseline: shipped path should succeed) ---
Write-Host "--- Case 0: daemon stop --force (no lock, no clock jump) ---"
Push-Location $OpenClawDir
node openclaw.mjs daemon stop --force 2>&1 | Out-Host
$case0Exit = $LASTEXITCODE
Pop-Location
Write-Host "Case 0 daemon stop exit: $case0Exit"
Write-Host ""

# --- sibling EXCLUSIVE write lock (SQLITE_BUSY source) ---
Write-Host "--- start sibling EXCLUSIVE write lock (8s) ---"
$lockProc = Start-Process -PassThru -NoNewWindow `
  -FilePath "node" -ArgumentList (Join-Path $ScriptsDir "hold-exclusive-lock.cjs"),$dbPath,"8" `
  -RedirectStandardOutput (Join-Path $StateDir "lock-out.log") `
  -RedirectStandardError (Join-Path $StateDir "lock-err.log")
Start-Sleep -Seconds 1
Get-Content (Join-Path $StateDir "lock-out.log") -ErrorAction SilentlyContinue

# --- daemon stop with clock injection ---
Write-Host ""
Write-Host "--- daemon stop --force with clock injection ---"
$env:PROOF_JUMP_MS = "20000"
$env:PROOF_JUMP_AT_MS = "2500"
$injectPath = Join-Path $ScriptsDir "clock-inject.mjs"
$injectUrl = "file:///" + ($injectPath -replace '\\','/')
Write-Host "clock-inject url: $injectUrl"
Push-Location $OpenClawDir
node --import $injectUrl openclaw.mjs daemon stop --force 2>&1 | Out-Host
$stopExit = $LASTEXITCODE
Pop-Location
Remove-Item Env:PROOF_JUMP_MS -ErrorAction SilentlyContinue
Remove-Item Env:PROOF_JUMP_AT_MS -ErrorAction SilentlyContinue
Write-Host "daemon stop exit: $stopExit"

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
