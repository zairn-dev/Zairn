<#
  measure.ps1 — bounded per-arm on-device energy capture via adb.

  Two phases per arm:
    ./measure.ps1 -Action begin -Arm continuous
        resets batterystats, snapshots charge_counter/current_now/level, writes <base>.begin.json
        --> then open the harness for this arm and leave the phone 2-4h
    ./measure.ps1 -Action end   -Arm continuous
        snapshots again, dumps `dumpsys batterystats --charged` + `dumpsys location`,
        writes <base>.end.json and parses -> <base>.run.json

  Flags:
    -Serial <id>      target a specific adb device (adb -s)
    -Session <base>   explicit session (default: newest un-ended begin for the arm)
    -DryRun           use bundled fixtures instead of a real device (no adb needed)

  After all three arms:  node ..\merge-results.mjs
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('begin', 'end')][string]$Action,
  [Parameter(Mandatory = $true)][ValidateSet('continuous', 'naive', 'gated')][string]$Arm,
  [string]$Serial = '',
  [string]$Session = '',
  [string]$ResultsDir = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$DeviceDir = Split-Path -Parent $ScriptDir
if ($ResultsDir -eq '') { $ResultsDir = Join-Path $DeviceDir 'results' }
if (-not (Test-Path $ResultsDir)) { New-Item -ItemType Directory -Path $ResultsDir | Out-Null }
$FixturesDir = Join-Path $ScriptDir 'fixtures'

# per-arm canned counters for -DryRun (POCO X7 Pro, 6000 mAh, ~2h screen-on)
$DryTable = @{
  continuous = @{ level0 = 92; level1 = 85; cc0 = 4800000; cc1 = 4380000; cur0 = -210000; cur1 = -208000; capfull = 6000000 }
  naive      = @{ level0 = 92; level1 = 85; cc0 = 4790000; cc1 = 4360000; cur0 = -215000; cur1 = -212000; capfull = 6000000 }
  gated      = @{ level0 = 92; level1 = 86; cc0 = 4780000; cc1 = 4410000; cur0 = -186000; cur1 = -95000;  capfull = 6000000 }
}
$dry = $DryTable[$Arm]

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  # PS 5.1 Set-Content -Encoding utf8 emits a BOM, which breaks Node JSON.parse.
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Json { param([string]$Path, $Obj) Write-Utf8NoBom $Path (($Obj | ConvertTo-Json -Depth 6)) }

$script:AdbExe = $null
function Resolve-Adb {
  if ($script:AdbExe) { return $script:AdbExe }
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { $script:AdbExe = $cmd.Source; return $script:AdbExe }
  foreach ($c in @("$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
                   "C:\platform-tools\adb.exe",
                   "$env:USERPROFILE\platform-tools\adb.exe")) {
    if (Test-Path $c) { $script:AdbExe = $c; return $script:AdbExe }
  }
  throw "adb not found: install platform-tools or add adb to PATH"
}

function Invoke-AdbRaw {
  param([string[]]$AdbArgs)
  $adbExe = Resolve-Adb
  $full = @()
  if ($Serial -ne '') { $full += @('-s', $Serial) }
  $full += $AdbArgs
  return (& $adbExe @full)
}

function Get-Sysfs {
  param([string]$Node, [long]$DryValue)
  if ($DryRun) { return $DryValue }
  $v = ("" + (Invoke-AdbRaw @('shell', 'cat', "/sys/class/power_supply/battery/$Node"))).Trim()
  if ($v -match '^-?\d+$') { return [long]$v }
  # HyperOS/MIUI deny direct sysfs reads to the shell user; dumpsys battery
  # exposes the same charge counter (uAh)
  if ($Node -eq 'charge_counter') {
    $out = "" + (Invoke-AdbRaw @('shell', 'dumpsys', 'battery'))
    $m = [regex]::Match($out, 'Charge counter:\s*(-?\d+)')
    if ($m.Success) { return [long]$m.Groups[1].Value }
  }
  return $null
}

function Get-BatteryLevel {
  param([int]$DryValue)
  if ($DryRun) { return $DryValue }
  $out = "" + (Invoke-AdbRaw @('shell', 'dumpsys', 'battery'))
  $m = [regex]::Match($out, 'level:\s*(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value } else { return $null }
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Find-LatestBegin {
  param([string]$ArmName)
  $begins = Get-ChildItem -Path $ResultsDir -Filter "$ArmName.*.begin.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($b in $begins) {
    $base = $b.Name -replace '\.begin\.json$', ''
    if (-not (Test-Path (Join-Path $ResultsDir "$base.run.json"))) { return $base }
  }
  if ($begins.Count -gt 0) { return ($begins[0].Name -replace '\.begin\.json$', '') }
  return $null
}

if ($Action -eq 'begin') {
  $stamp = (Get-Date -Format 'yyyyMMddTHHmmss')
  $base = "$Arm.$stamp"
  Write-Host "[measure] BEGIN arm=$Arm session=$base dryrun=$($DryRun.IsPresent)"
  if (-not $DryRun) {
    Write-Host "[measure] resetting batterystats..."
    Invoke-AdbRaw @('shell', 'dumpsys', 'batterystats', '--reset') | Out-Null
  }
  $capfull = Get-Sysfs -Node 'charge_full' -DryValue $dry.capfull
  $capMah = $null
  if ($capfull) { $capMah = [math]::Round($capfull / 1000.0, 0) }
  $begin = [ordered]@{
    arm                 = $Arm
    session             = $base
    schema              = 'sensing-gate-arm/begin/v1'
    started_at          = (Get-Date).ToString('o')
    t0_ms               = (Get-NowMs)
    level0              = (Get-BatteryLevel -DryValue $dry.level0)
    capacity_mAh        = $capMah
    charge_counter0_uAh = (Get-Sysfs -Node 'charge_counter' -DryValue $dry.cc0)
    current_now0_uA     = (Get-Sysfs -Node 'current_now' -DryValue $dry.cur0)
    screen_policy       = 'screen-on-foreground'
    dry_run             = [bool]$DryRun
  }
  Write-Json -Path (Join-Path $ResultsDir "$base.begin.json") -Obj $begin
  Write-Host "[measure] wrote $base.begin.json"
  Write-Host ""
  Write-Host "NEXT: open the harness for this arm and leave the phone 2-4h:" -ForegroundColor Cyan
  Write-Host "      harness/index.html?arm=$Arm&autostart=1"
  $endHint = "./measure.ps1 -Action end -Arm $Arm"
  if ($DryRun) { $endHint += ' -DryRun' }
  Write-Host "      then:  $endHint"
  exit 0
}

# ---- Action = end ----
if ($Session -eq '') { $Session = Find-LatestBegin -ArmName $Arm }
if (-not $Session) { Write-Error "no un-ended begin session found for arm=$Arm (run -Action begin first)"; exit 1 }
$beginPath = Join-Path $ResultsDir "$Session.begin.json"
if (-not (Test-Path $beginPath)) { Write-Error "begin file missing: $beginPath"; exit 1 }
$begin = Get-Content $beginPath -Raw | ConvertFrom-Json

Write-Host "[measure] END arm=$Arm session=$Session dryrun=$($DryRun.IsPresent)"

$bsPath = Join-Path $ResultsDir "$Session.batterystats.txt"
$locPath = Join-Path $ResultsDir "$Session.location.txt"
if ($DryRun) {
  Copy-Item (Join-Path $FixturesDir "$Arm.batterystats.txt") $bsPath -Force
  Copy-Item (Join-Path $FixturesDir 'location.txt') $locPath -Force
  $t1 = [long]$begin.t0_ms + 7200000   # deterministic 2h window for the dry run
} else {
  Write-Host "[measure] dumping batterystats --charged (may take a few seconds)..."
  Write-Utf8NoBom $bsPath (((Invoke-AdbRaw @('shell', 'dumpsys', 'batterystats', '--charged'))) -join "`n")
  Write-Utf8NoBom $locPath (((Invoke-AdbRaw @('shell', 'dumpsys', 'location'))) -join "`n")
  $t1 = (Get-NowMs)
}

$end = [ordered]@{
  arm                 = $Arm
  session             = $Session
  schema              = 'sensing-gate-arm/end/v1'
  stopped_at          = (Get-Date).ToString('o')
  t1_ms               = $t1
  level1              = (Get-BatteryLevel -DryValue $dry.level1)
  charge_counter1_uAh = (Get-Sysfs -Node 'charge_counter' -DryValue $dry.cc1)
  current_now1_uA     = (Get-Sysfs -Node 'current_now' -DryValue $dry.cur1)
  dry_run             = [bool]$DryRun
}
Write-Json -Path (Join-Path $ResultsDir "$Session.end.json") -Obj $end
Write-Host "[measure] wrote $Session.end.json + raw dumps"

Write-Host "[measure] parsing -> $Session.run.json"
node (Join-Path $DeviceDir 'parse-run.mjs') --session $Session --results $ResultsDir
Write-Host ""
Write-Host "When all three arms are done:  node ..\merge-results.mjs" -ForegroundColor Cyan
