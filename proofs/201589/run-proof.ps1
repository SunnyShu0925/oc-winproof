# Native Windows proof for PR #201707 (issue #201589): peer-link host-root audit
# rejects the same directory under two casings on NTFS, blocking npm-installed plugins.
#
# BASE arm: pristine published openclaw@2026.11.5 (latest stable, reporter's version).
# HEAD arm: same install with the PR's 5-line production diff mirrored into the dist
#           chunk (mirror-patch.mjs) + dist inventory entry recomputed.
# Both arms share one state dir, so BASE->HEAD also shows settings intact across the swap.
#
# Env: FEISHU_APP_ID / FEISHU_APP_SECRET optional (real channel-connect cell when present).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installRoot = "C:\proof\OpenClaw"          # mixed-case install dir (reporter layout)
$lowerRoot   = "c:\proof\openclaw"          # same dir, lowercase spelling
$stateDir    = "C:\proof\state"
$configPath  = Join-Path $stateDir "openclaw.json"
$pkgDir      = Join-Path $installRoot "node_modules\openclaw"
$entry       = Join-Path $pkgDir "openclaw.mjs"
$lowerEntry  = "c:\proof\openclaw\node_modules\openclaw\openclaw.mjs"
$port        = 19915
$outDir      = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$gatewayToken = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$feishuAppId = $env:FEISHU_APP_ID
$feishuSecret = $env:FEISHU_APP_SECRET
$hasFeishu = -not [string]::IsNullOrEmpty($feishuSecret)

$script:redactions = @($gatewayToken)
if ($hasFeishu) { $script:redactions += @($feishuSecret, $feishuAppId) }

function Redact([string]$text) {
  foreach ($s in $script:redactions) {
    if ($s -and $text.Contains($s)) { $text = $text.Replace($s, "[REDACTED]") }
  }
  return $text
}
function Log([string]$msg) {
  $line = Redact $msg
  Write-Host $line
  Add-Content -Path (Join-Path $outDir "transcript.txt") -Value $line -Encoding utf8
}
function SaveOutput([string]$name, [string]$text) {
  Set-Content -Path (Join-Path $outDir $name) -Value (Redact $text) -Encoding utf8
}
function Redact-Sweep {
  Get-ChildItem -Path $outDir -File | ForEach-Object {
    $c = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
    if ($c) { Set-Content -Path $_.FullName -Value (Redact $c) -Encoding utf8 }
  }
}
trap { Redact-Sweep; break }

$verdicts = [ordered]@{}
function Cell([string]$name, [bool]$ok, [string]$detail) {
  $verdicts[$name] = $ok
  Log ("[cell] {0}: {1} — {2}" -f $name, $(if ($ok) { "PASS" } else { "FAIL" }), $detail)
}

# --- CLI helpers: canonical (mixed-case) vs lowercase spelling of the SAME install ---
function Invoke-Canonical([string[]]$cliArgs, [string]$logName, [int]$timeoutSec = 300) {
  $p = Start-Process -FilePath "node" -ArgumentList (@($entry) + $cliArgs) `
    -NoNewWindow -PassThru -RedirectStandardOutput "$outDir\$logName.out" -RedirectStandardError "$outDir\$logName.err"
  if (-not $p.WaitForExit($timeoutSec * 1000)) { $p.Kill(); throw "CLI timeout: $cliArgs" }
  $text = (Get-Content "$outDir\$logName.out" -Raw) + "`n" + (Get-Content "$outDir\$logName.err" -Raw)
  Remove-Item "$outDir\$logName.out", "$outDir\$logName.err" -Force
  SaveOutput $logName $text
  return @{ Exit = $p.ExitCode; Text = $text }
}
function Invoke-Lowercase([string[]]$cliArgs, [string]$logName, [int]$timeoutSec = 600) {
  $p = Start-Process -FilePath "node" -ArgumentList (@($lowerEntry) + $cliArgs) `
    -NoNewWindow -PassThru -RedirectStandardOutput "$outDir\$logName.out" -RedirectStandardError "$outDir\$logName.err"
  if (-not $p.WaitForExit($timeoutSec * 1000)) { $p.Kill(); throw "CLI timeout: $cliArgs" }
  $text = (Get-Content "$outDir\$logName.out" -Raw) + "`n" + (Get-Content "$outDir\$logName.err" -Raw)
  Remove-Item "$outDir\$logName.out", "$outDir\$logName.err" -Force
  SaveOutput $logName $text
  return @{ Exit = $p.ExitCode; Text = $text }
}

function Start-Gateway([string]$label) {
  $logBase = Join-Path $outDir "gateway-$label"
  $p = Start-Process -FilePath "node" -ArgumentList @($entry, "gateway", "--port", "$port") `
    -NoNewWindow -PassThru -RedirectStandardOutput "$logBase.out" -RedirectStandardError "$logBase.err"
  $ready = $false
  foreach ($i in 1..60) {
    Start-Sleep -Seconds 2
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { $ready = $true; break }
    if ($p.HasExited) { break }
  }
  Start-Sleep -Seconds 15   # let plugin bootstrap + channel start settle
  return @{ Proc = $p; Ready = $ready; LogBase = $logBase }
}
function Stop-Gateway($gw) {
  if (-not $gw.Proc.HasExited) { Stop-Process -Id $gw.Proc.Id -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  $text = ""
  if (Test-Path "$($gw.LogBase).out") { $text += (Get-Content "$($gw.LogBase).out" -Raw) }
  if (Test-Path "$($gw.LogBase).err") { $text += "`n" + (Get-Content "$($gw.LogBase).err" -Raw) }
  Remove-Item "$($gw.LogBase).out", "$($gw.LogBase).err" -Force -ErrorAction SilentlyContinue
  SaveOutput ($gw.LogBase | Split-Path -Leaf) $text
  return $text
}
function Find-PeerJunction {
  Get-ChildItem -Path $stateDir -Recurse -Directory -Filter "openclaw" -ErrorAction SilentlyContinue |
    Where-Object { $_.LinkType -eq "Junction" -and $_.Target -match "node_modules[\\/]openclaw$" } |
    Select-Object -First 1
}

Log "=== PR #201707 / issue #201589 native Windows proof ==="
Log ("runner OS: {0}" -f [System.Environment]::OSVersion.VersionString)
Log ("node: {0}" -f (node --version))
Log ("feishu credentials present: {0}" -f $hasFeishu)

# --- Phase 0: fresh install of published latest stable at a mixed-case path ---
Log "--- phase 0: npm install -g openclaw@2026.11.5 --prefix $installRoot ---"
npm install -g "openclaw@2026.11.5" --prefix $installRoot 2>&1 | ForEach-Object { Log "$_" }
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
$ver = Invoke-Canonical @("--version") "version-base"
Log ("shipped --version: {0}" -f $ver.Text.Trim())
Cell "install-latest-stable" ($ver.Text -match "2026\.11\.5") "published 2026.11.5 at mixed-case $installRoot"

# --- config: gateway token auth + feishu channel (websocket) ---
$feishuBlock = @{ enabled = $true; connectionMode = "websocket" }
if ($hasFeishu) { $feishuBlock.appId = $feishuAppId; $feishuBlock.appSecret = $feishuSecret }
$config = @{
  gateway = @{ mode = "local"; port = $port; bind = "loopback"; auth = @{ mode = "token"; token = $gatewayToken } }
  channels = @{ feishu = $feishuBlock }
}
$config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8
$env:OPENCLAW_STATE_DIR = $stateDir
$env:OPENCLAW_CONFIG_PATH = $configPath
Log "config written (token/secret redacted in all logs)"

# --- Phase 1: install feishu plugin via the LOWERCASE spelling of the same install ---
# The installer records the host root from the running CLI path; invoking it through the
# lowercase spelling makes the created junction store a lowercase target (reporter state).
Log "--- phase 1: plugins install npm:@openclaw/feishu@2026.11.5 (via lowercase CLI path) ---"
$inst = Invoke-Lowercase @("plugins", "install", "npm:@openclaw/feishu@2026.11.5") "plugin-install"
Log ("plugins install exit={0}" -f $inst.Exit)
$junction = Find-PeerJunction
if (-not $junction) { throw "no openclaw junction found under $stateDir after plugin install" }
$junctionPath = $junction.FullName
$storedTarget = $junction.Target
Log ("junction: {0}" -f $junctionPath)
Log ("junction stored target: {0}" -f $storedTarget)
$reparse = (fsutil reparsepoint query $junctionPath | Out-String)
SaveOutput "junction-reparse-base" $reparse

# If the natural flow did not produce casing divergence, recreate the junction with the
# lowercase target via mklink /J — the exact on-disk state from the reporter's steps 5/6.
$expectedReal = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $pkgDir)
$currentReal = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $junctionPath)
if ($currentReal -ceq $expectedReal) {
  Log "natural install kept canonical casing; recreating junction with lowercase target (mklink /J, reporter steps 5/6 state)"
  cmd /c rmdir $junctionPath
  cmd /c mklink /J $junctionPath "$lowerRoot\node_modules\openclaw" | ForEach-Object { Log "$_" }
  $junction = Find-PeerJunction
  $currentReal = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $junctionPath)
}
$identity = (node -e "const fs=require('fs');const a=fs.realpathSync(process.argv[1]),b=fs.realpathSync(process.argv[2]);const sa=fs.statSync(a),sb=fs.statSync(b);console.log(JSON.stringify({linkRealpath:a,hostRealpath:b,linkDevIno:[sa.dev,sa.ino],hostDevIno:[sb.dev,sb.ino],sameObject:sa.dev===sb.dev&&sa.ino===sb.ino,spellingsEqual:a===b},null,1))" $junctionPath $pkgDir)
SaveOutput "path-identity" $identity
Log "path identity facts: $identity"
$idObj = $identity | ConvertFrom-Json
Cell "casing-divergence-same-object" (($idObj.spellingsEqual -eq $false) -and ($idObj.sameObject -eq $true)) `
  "realpaths differ only by casing; dev/ino identical"

# --- Phase 2: BASE arm (pristine stable) — Gateway must block the plugin ---
Log "--- phase 2: BASE arm (pristine 2026.11.5) ---"
$gw = Start-Gateway "base"
Log ("gateway listening: {0}" -f $gw.Ready)
$statusBase = Invoke-Canonical @("channels", "status") "channels-status-base"
Log "channels status (BASE):`n$($statusBase.Text)"
$pluginsBase = Invoke-Canonical @("plugins", "list") "plugins-list-base"
$baseLog = Stop-Gateway $gw
$baseBlocked = ($baseLog + $statusBase.Text + $pluginsBase.Text) -match "missing-openclaw-peer-link"
Cell "base-blocked" $baseBlocked "pristine stable reports missing-openclaw-peer-link"
Log "BASE gateway log (feishu/peer/verification lines):"
($baseLog -split "`n") | Where-Object { $_ -match "feishu|peer|verification|plugin" } | ForEach-Object { Log "  $_" }

# --- Phase 3: HEAD arm — mirror the PR diff into the same install, same state ---
Log "--- phase 3: HEAD arm (mirror PR #201707 production diff into dist) ---"
$configBefore = Get-Content $configPath -Raw | ConvertFrom-Json
node (Join-Path $PSScriptRoot "mirror-patch.mjs") $pkgDir 2>&1 | ForEach-Object { Log "$_" }
if ($LASTEXITCODE -ne 0) { throw "mirror patch failed" }
$verHead = Invoke-Canonical @("--version") "version-head"
Log ("shipped --version (HEAD): {0}" -f $verHead.Text.Trim())

$gw = Start-Gateway "head"
Log ("gateway listening: {0}" -f $gw.Ready)
$statusHead = Invoke-Canonical @("channels", "status") "channels-status-head"
Log "channels status (HEAD):`n$($statusHead.Text)"
$pluginsHead = Invoke-Canonical @("plugins", "list") "plugins-list-head"
if ($hasFeishu) {
  $probe = Invoke-Canonical @("channels", "status", "--probe") "channels-probe-head" 180
  Log "channels status --probe (HEAD):`n$($probe.Text)"
}
$headLog = Stop-Gateway $gw
$headClean = -not (($headLog + $statusHead.Text + $pluginsHead.Text) -match "missing-openclaw-peer-link")
Cell "head-admitted" ($headClean -and $gw.Ready) "no peer-link failure; gateway up with same state"
Log "HEAD gateway log (feishu/peer/verification lines):"
($headLog -split "`n") | Where-Object { $_ -match "feishu|peer|verification|plugin" } | ForEach-Object { Log "  $_" }

if ($hasFeishu) {
  $connected = ($headLog + $statusHead.Text) -match "feishu.*(connect|started|running|ok)" 
  Cell "channel-connect" $connected "real Feishu websocket channel after admission"
} else {
  Log "[cell] channel-connect: SKIPPED — no FEISHU_APP_SECRET provided; admission + channel start captured instead"
}

# --- Phase 4: forced reinstall (reporter: --force re-breaks on stable) ---
Log "--- phase 4: plugins install --force via lowercase path, HEAD stays admitted ---"
$force = Invoke-Lowercase @("plugins", "install", "npm:@openclaw/feishu@2026.11.5", "--force") "plugin-install-force"
Log ("plugins install --force exit={0}" -f $force.Exit)
$junction2 = Find-PeerJunction
$currentReal2 = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $junction2.FullName)
Log ("junction target after --force: {0}" -f $currentReal2)
if ($currentReal2 -ceq $expectedReal) {
  Log "--force restored canonical casing; re-applying lowercase junction fixture (reporter on-disk state)"
  cmd /c rmdir $junction2.FullName
  cmd /c mklink /J $junction2.FullName "$lowerRoot\node_modules\openclaw" | ForEach-Object { Log "$_" }
}
$gw = Start-Gateway "force"
$statusForce = Invoke-Canonical @("channels", "status") "channels-status-force"
Log "channels status (after --force, HEAD):`n$($statusForce.Text)"
$forceLog = Stop-Gateway $gw
$forceClean = -not (($forceLog + $statusForce.Text) -match "missing-openclaw-peer-link")
Cell "force-reinstall-admitted" ($forceClean -and $gw.Ready) "forced reinstall + lowercase junction still admitted on HEAD"

# --- Phase 5: settings intact across the stable -> patched swap ---
$configAfter = Get-Content $configPath -Raw | ConvertFrom-Json
$gwSame = ($configBefore.gateway | ConvertTo-Json -Depth 10) -eq ($configAfter.gateway | ConvertTo-Json -Depth 10)
$chSame = ($configBefore.channels | ConvertTo-Json -Depth 10) -eq ($configAfter.channels | ConvertTo-Json -Depth 10)
Cell "settings-intact" ($gwSame -and $chSame) "gateway + channels config unchanged across swap and --force"
SaveOutput "config-after-redacted" ($configAfter | ConvertTo-Json -Depth 10)

# --- verdict ---
Log "=== verdict ==="
$failed = @($verdicts.GetEnumerator() | Where-Object { -not $_.Value })
foreach ($k in $verdicts.Keys) { Log ("  {0}: {1}" -f $k, $(if ($verdicts[$k]) { "PASS" } else { "FAIL" })) }
SaveOutput "verdict" (($verdicts.GetEnumerator() | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }) -join "`n")
Redact-Sweep
if ($failed.Count -gt 0) { Log "PROOF FAILED"; exit 1 }
Log "PROOF PASSED"
exit 0