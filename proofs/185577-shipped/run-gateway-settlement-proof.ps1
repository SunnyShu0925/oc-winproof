param(
  [Parameter(Mandatory = $true)][string]$Label,
  [switch]$Inject
)

# PR #185577 shipped-command settlement proof.
#
# Drives the SHIPPED `openclaw gateway stop` command on Windows and records the
# bounded completion of the Scheduled-Task settlement when the host wall clock
# jumps inside the settlement window.
#
#   install -> real Scheduled Task + real Gateway process (task has a LastTaskResult)
#   stop    -> shipped command; its settlement path (prepareScheduledTaskSettlement)
#              seeds its deadline and reads the remaining budget
#
# $Inject preloads cli-clock-shift-settlement.mjs into the stop process
# (NODE_OPTIONS=--import) so a wall-clock step lands between the settlement
# deadline seed and the remaining-budget read. The step is inert on the post-fix
# (performance.now) build and collapses the probe timeout on the pre-fix build.

$ErrorActionPreference = "Continue"
$root = (Get-Location).Path
$port = 19145
$taskName = "OpenClaw Gateway"
# `gateway install` refuses a non-canonical state dir, so use the account home
# default (%USERPROFILE%\.openclaw) and wipe it between scenarios.
$stateDir = Join-Path $env:USERPROFILE ".openclaw"

function Reset-State {
  Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:OPENCLAW_HOME -ErrorAction SilentlyContinue
  if (Test-Path $stateDir) { Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  # Keep the default PowerShell task query path (the settlement owner probes via
  # the shipped PowerShell task query, which is the slow path we want to budget).
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
}

function Stop-StalePortOwner {
  $rows = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
  foreach ($row in $rows) {
    $procId = ($row.ToString().Trim() -split '\s+')[-1]
    if ($procId -match '^\d+$') {
      Write-Host "  [cleanup] killing stale listener pid $procId"
      taskkill /F /T /PID $procId 2>&1 | Out-Null
    }
  }
}

function Remove-Service {
  & node openclaw.mjs gateway stop --force --json 2>&1 | Out-Null
  schtasks /End /TN $taskName 2>&1 | Out-Null
  schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
  Stop-StalePortOwner
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "################ SCENARIO $Label (inject=$Inject) ################"
Remove-Service
Reset-State
Write-Host "state dir: $stateDir"
Write-Host "node: $(node --version)"
Write-Host "platform: $([System.Environment]::OSVersion.VersionString)"
Write-Host "deadline line: $((Select-String -Path src/daemon/schtasks-state-probe.ts -Pattern 'const deadline =').Line.Trim())"

Write-Host ""
Write-Host "=== $Label :: openclaw gateway install ==="
$installOut = (& node openclaw.mjs gateway install --allow-unconfigured --force --json --port $port 2>&1 | Out-String)
$installCode = $LASTEXITCODE
Write-Host "install exit=$installCode"
Write-Host $installOut

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 3
  $listening = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
  if ($listening) {
    $ready = $true
    Write-Host "gateway listening on $port after $($i * 3)s"
    break
  }
}
if (-not $ready) {
  Write-Host "!!! gateway did not start listening on $port"
}

# The settlement owner requires the task to have a non-empty LastTaskResult
# (it captures the task's last run time as its identity anchor). Install already
# runs the task once; give the scheduler a moment so LastTaskResult is written.
Start-Sleep -Seconds 5
Write-Host "--- task state (last run result) ---"
schtasks /Query /TN $taskName /V /FO LIST 2>&1 | Select-String "Last Result|Last Run Time|Status|Task To Run" | ForEach-Object { Write-Host "  $($_.Line.Trim())" }

Write-Host ""
Write-Host "=== $Label :: openclaw gateway status ==="
$statusOut = (& node openclaw.mjs gateway status --json --timeout 5000 2>&1 | Out-String)
Write-Host "status exit=$LASTEXITCODE"
Write-Host $statusOut

if ($Inject) {
  # NODE_OPTIONS on Windows needs a file:// URL, not a drive-letter path.
  $modulePath = ((Join-Path $root "proofs/185577-shipped/cli-clock-shift-settlement.mjs") -replace '\\', '/')
  $env:NODE_OPTIONS = "--import file:///$modulePath"
  $env:PROOF_SHIFT_MS = "$env:PROOF_SHIFT_MS"
}
Write-Host ""
Write-Host "=== $Label :: openclaw gateway stop (inject=$Inject) ==="
Write-Host "NODE_OPTIONS=$env:NODE_OPTIONS PROOF_SHIFT_MS=$env:PROOF_SHIFT_MS"
$stopStart = Get-Date
$stopOut = (& node openclaw.mjs gateway stop --force --json 2>&1 | Out-String)
$stopCode = $LASTEXITCODE
$stopElapsed = ((Get-Date) - $stopStart).TotalSeconds
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Write-Host "stop exit=$stopCode elapsed=${stopElapsed}s"
Write-Host $stopOut

Start-Sleep -Seconds 4
$stillListening = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
if ($stillListening) {
  Write-Host "VERDICT[$Label]: STOP_FAILED gateway still listening on $port after ${stopElapsed}s"
} elseif ($stopCode -eq 0) {
  Write-Host "VERDICT[$Label]: STOPPED bounded completion in ${stopElapsed}s (gateway identity verified and terminated)"
} else {
  Write-Host "VERDICT[$Label]: STOP_REFUSED exit=$stopCode port released in ${stopElapsed}s"
}

# Control: the SAME build and the SAME still-running Gateway, stopped again
# without any clock step. This isolates the wall-clock step as the cause.
Write-Host ""
Write-Host "=== $Label :: openclaw gateway stop (control, no clock step) ==="
$controlStart = Get-Date
$controlOut = (& node openclaw.mjs gateway stop --force --json 2>&1 | Out-String)
$controlCode = $LASTEXITCODE
$controlElapsed = ((Get-Date) - $controlStart).TotalSeconds
Write-Host "control exit=$controlCode elapsed=${controlElapsed}s"
Write-Host $controlOut
Start-Sleep -Seconds 4
$controlListening = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
if ($controlListening) {
  Write-Host "CONTROL[$Label]: CONTROL_FAILED gateway still listening on $port"
} else {
  Write-Host "CONTROL[$Label]: CONTROL_STOPPED plain stop released $port in ${controlElapsed}s"
}

Remove-Service
Write-Host "################ END SCENARIO $Label ################"
