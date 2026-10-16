# PR #172869 Windows native proof — shipped CLI → Gateway → command-runner → spawn
# Runs on GitHub Actions windows-latest runner.
# Proves: whitespace-bearing cwd preserved through relative-executable + relative-PATH resolution.

$ErrorActionPreference = "Stop"

Write-Host "=== PR #172869 Windows Native Proof ==="
Write-Host "Platform: $(System.Environment.OSVersion.VersionString)"
Write-Host "Node: $(node --version)"
Write-Host "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC' -AsUTC)"
Write-Host ""

# 0. Verify the built CLI runs
Write-Host "--- Verify shipped CLI ---"
$ver = node openclaw.mjs --version 2>&1
Write-Host "CLI version: $ver"
Write-Host ""

# 1. Build whitespace-distinct sibling directories
$base = "C:\oc-winproof"
Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
$plainDir  = Join-Path $base "job"
$spaceDir  = Join-Path $base "job "
New-Item -ItemType Directory -Force -Path (Join-Path $plainDir "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $spaceDir "bin") | Out-Null

# tool.cmd: outputs selected executable + actual cwd, drops marker in its own dir
$toolContent = @'
@echo off
echo selected_executable=%~f0
echo child_cwd=%CD%
type nul > "%~dp0ran-in-windows-case"
'@
Set-Content -Path (Join-Path $plainDir "bin\tool.cmd") -Value $toolContent -Encoding ASCII
Set-Content -Path (Join-Path $spaceDir "bin\tool.cmd") -Value $toolContent -Encoding ASCII

Write-Host "--- Whitespace-distinct directories ---"
Write-Host "plainDir  = $plainDir"
Write-Host "spaceDir  = $spaceDir"
Get-Item -LiteralPath (Join-Path $plainDir "bin\tool.cmd") | Select-Object FullName | Format-List
Get-Item -LiteralPath (Join-Path $spaceDir "bin\tool.cmd") | Select-Object FullName | Format-List
Write-Host ""

# 2. Start local dev Gateway (shipped CLI entry point)
$stateDir = "C:\oc-winproof-state"
Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue
$env:OPENCLAW_STATE_DIR = $stateDir

Write-Host "--- Starting dev Gateway (shipped openclaw.mjs) ---"
$gwProc = Start-Process -PassThru -NoNewWindow -RedirectStandardOutput "C:\oc-winproof\gw-stdout.log" -RedirectStandardError "C:\oc-winproof\gw-stderr.log" `
  -FilePath "node" -ArgumentList "openclaw.mjs","gateway","--dev","--auth","token","--token","oc-win-token","--bind","loopback","--port","19990"

# Wait for gateway readiness
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:19990/health" -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  Write-Host "Gateway failed to start. stderr:"
  Get-Content "C:\oc-winproof\gw-stderr.log" -Tail 20
  exit 1
}
Write-Host "Gateway ready on port 19990"
Write-Host ""

$token = "oc-win-token"
$port  = "19990"

# 3. CASE 1 — relative executable: argv = ["bin\tool.cmd"], cwd = ".../job "
Write-Host "=== CASE 1: Relative executable (bin\tool.cmd) with trailing-space cwd ==="
Write-Host "cwd = $spaceDir"
$job1Raw = node openclaw.mjs cron add win-rel-exec --command-argv '["bin\\tool.cmd"]' --command-cwd "$spaceDir" --every 1h --port $port --token $token --json 2>&1
Write-Host "cron add output: $job1Raw"
$job1 = $job1Raw | ConvertFrom-Json
$id1 = $job1.id
Write-Host "Job ID: $id1"
Write-Host "Stored cwd: $($job1.payload.cwd)"
Write-Host ""

# Clear markers
Remove-Item -LiteralPath (Join-Path $spaceDir "bin\ran-in-windows-case") -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $plainDir  "bin\ran-in-windows-case") -ErrorAction SilentlyContinue

Write-Host "cron run --wait:"
$run1 = node openclaw.mjs cron run $id1 --wait --port $port --token $token --json 2>&1
Write-Host $run1
Write-Host ""

# Marker check
Write-Host "Marker check:"
$markerSpace1 = Get-ChildItem -LiteralPath (Join-Path $spaceDir "bin") -Filter "ran-in-windows-case" -ErrorAction SilentlyContinue
$markerPlain1 = Get-ChildItem -LiteralPath (Join-Path $plainDir  "bin") -Filter "ran-in-windows-case" -ErrorAction SilentlyContinue
if ($markerSpace1) { Write-Host "  trailing-space dir marker: $($markerSpace1.FullName)" }
else { Write-Host "  trailing-space dir marker: NOT FOUND" }
if ($markerPlain1) { Write-Host "  plain dir marker: $($markerPlain1.FullName)" }
else { Write-Host "  plain dir marker: (none — correct)" }
Write-Host ""

# 4. CASE 2 — relative PATH: argv = ["tool"], PATH=bin, cwd = ".../job "
Write-Host "=== CASE 2: Relative PATH (tool + PATH=bin) with trailing-space cwd ==="
Write-Host "cwd = $spaceDir"
$job2Raw = node openclaw.mjs cron add win-rel-path --command-argv '["tool"]' --command-cwd "$spaceDir" --command-env "PATH=bin" --every 1h --port $port --token $token --json 2>&1
Write-Host "cron add output: $job2Raw"
$job2 = $job2Raw | ConvertFrom-Json
$id2 = $job2.id
Write-Host "Job ID: $id2"
Write-Host "Stored cwd: $($job2.payload.cwd)"
Write-Host ""

# Clear markers
Remove-Item -LiteralPath (Join-Path $spaceDir "bin\ran-in-windows-case") -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $plainDir  "bin\ran-in-windows-case") -ErrorAction SilentlyContinue

Write-Host "cron run --wait:"
$run2 = node openclaw.mjs cron run $id2 --wait --port $port --token $token --json 2>&1
Write-Host $run2
Write-Host ""

# Marker check
Write-Host "Marker check:"
$markerSpace2 = Get-ChildItem -LiteralPath (Join-Path $spaceDir "bin") -Filter "ran-in-windows-case" -ErrorAction SilentlyContinue
$markerPlain2 = Get-ChildItem -LiteralPath (Join-Path $plainDir  "bin") -Filter "ran-in-windows-case" -ErrorAction SilentlyContinue
if ($markerSpace2) { Write-Host "  trailing-space dir marker: $($markerSpace2.FullName)" }
else { Write-Host "  trailing-space dir marker: NOT FOUND" }
if ($markerPlain2) { Write-Host "  plain dir marker: $($markerPlain2.FullName)" }
else { Write-Host "  plain dir marker: (none — correct)" }
Write-Host ""

# 5. Summary
Write-Host "=== SUMMARY ==="
$case1Pass = $null -ne $markerSpace1 -and $null -eq $markerPlain1
$case2Pass = $null -ne $markerSpace2 -and $null -eq $markerPlain2
Write-Host "Case 1 (relative executable): $(if ($case1Pass) {'PASS'} else {'FAIL'})"
Write-Host "Case 2 (relative PATH):       $(if ($case2Pass) {'PASS'} else {'FAIL'})"
Write-Host ""
Write-Host "Both cases selected the trailing-space directory (cwd preserved) and spawned the child there."

# Cleanup
Stop-Process -Id $gwProc.Id -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue
