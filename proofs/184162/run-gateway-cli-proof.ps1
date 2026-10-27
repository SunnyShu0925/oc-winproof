param(
  [Parameter(Mandatory = $true)][string]$Label,
  [switch]$Inject
)

# Drives the SHIPPED `openclaw gateway` CLI on Windows and records what happens
# when the host wall clock jumps forward during a process-identity read.
#
#   install  -> real Scheduled Task + real Gateway process
#   stop     -> goes through schtasks ownership verification, which calls the
#               shipped readWindowsProcessStartTimeSync() on the live Gateway PID
#
# $Inject preloads cli-clock-shift.mjs into the stop process (NODE_OPTIONS=--import).

$ErrorActionPreference = "Continue"
$root = (Get-Location).Path
$port = 19123
$taskName = "OpenClaw Gateway"
$stateDir = Join-Path $env:RUNNER_TEMP ("oc-state-" + $Label)

function Reset-State {
  if (Test-Path $stateDir) { Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $env:OPENCLAW_STATE_DIR = $stateDir
  $env:PROC_SAFE_NATIVE = "off"   # force the PowerShell/WMIC identity fallback (no native helper)
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

function Dump-Diagnostics {
  Write-Host "  [diag] schtasks:"
  schtasks /Query /TN $taskName /V /FO LIST 2>&1 | Select-Object -First 40 | ForEach-Object { Write-Host "    $_" }
  Write-Host "  [diag] state dir $stateDir :"
  Get-ChildItem -Recurse -File $stateDir -ErrorAction SilentlyContinue |
    Select-Object -First 40 |
    ForEach-Object { Write-Host "    $($_.FullName) ($($_.Length) bytes)" }
  $logs = Get-ChildItem -Recurse -File $stateDir -Include *.log,*.jsonl -ErrorAction SilentlyContinue
  foreach ($log in $logs) {
    Write-Host "  [diag] tail $($log.FullName):"
    Get-Content $log.FullName -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
  }
}

Write-Host ""
Write-Host "################ SCENARIO $Label (inject=$Inject) ################"
Remove-Service
Reset-State
Write-Host "state dir: $stateDir"
Write-Host "node: $(node --version)"
Write-Host "platform: $([System.Environment]::OSVersion.VersionString)"
Write-Host "deadline line: $((Select-String -Path src/infra/windows-process-start.ts -Pattern 'const deadline =').Line.Trim())"

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
  Dump-Diagnostics
}

Write-Host ""
Write-Host "=== $Label :: openclaw gateway status ==="
$statusOut = (& node openclaw.mjs gateway status --json --timeout 5000 2>&1 | Out-String)
Write-Host "status exit=$LASTEXITCODE"
Write-Host $statusOut

if ($Inject) {
  $env:NODE_OPTIONS = "--import " + (Join-Path $root "proofs/184162/cli-clock-shift.mjs")
  $env:PROOF_SHIFT_MS = "10000"
}
Write-Host ""
Write-Host "=== $Label :: openclaw gateway stop (inject=$Inject) ==="
Write-Host "NODE_OPTIONS=$env:NODE_OPTIONS"
$stopOut = (& node openclaw.mjs gateway stop --force --json 2>&1 | Out-String)
$stopCode = $LASTEXITCODE
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Write-Host "stop exit=$stopCode"
Write-Host $stopOut

Start-Sleep -Seconds 3
$stillListening = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
if ($stillListening) {
  Write-Host "VERDICT[$Label]: STOP_FAILED gateway still listening on $port"
} elseif ($stopCode -eq 0) {
  Write-Host "VERDICT[$Label]: STOPPED gateway identity verified and terminated"
} else {
  Write-Host "VERDICT[$Label]: STOP_REFUSED exit=$stopCode port released"
}

Remove-Service
Write-Host "################ END SCENARIO $Label ################"
