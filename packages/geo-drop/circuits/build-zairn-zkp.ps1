param(
  [string]$Circuit = "zairn_zkp",
  [string]$Ptau = "pot10_final.ptau",
  [string]$BuildDir = "build",
  [switch]$CreatePtau,
  [switch]$CompileOnly
)

$ErrorActionPreference = "Stop"

function Resolve-Command([string[]]$Names) {
  $localBin = Join-Path (Split-Path $PSScriptRoot -Parent) "node_modules\.bin"
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) {
      return $cmd.Source
    }
    foreach ($candidate in @(
      (Join-Path $localBin "$name.cmd"),
      (Join-Path $localBin "$name.ps1"),
      (Join-Path $localBin $name)
    )) {
      if (Test-Path $candidate) {
        return $candidate
      }
    }
  }
  throw "Required command not found. Tried: $($Names -join ', ')"
}

function Invoke-Native([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

$circom = Resolve-Command @("circom2", "circom")
$snarkjs = Resolve-Command @("snarkjs")

$circuitFile = Join-Path $PSScriptRoot "$Circuit.circom"
if (-not (Test-Path $circuitFile)) {
  throw "Circuit file not found: $circuitFile"
}

$buildPath = Join-Path $PSScriptRoot $BuildDir
if (-not (Test-Path $buildPath)) {
  New-Item -ItemType Directory -Path $buildPath | Out-Null
}

$ptauPath = Join-Path $PSScriptRoot $Ptau
if (-not (Test-Path $ptauPath) -and -not $CreatePtau) {
  throw "Powers of Tau file not found: $ptauPath"
}

Push-Location $PSScriptRoot
try {
  if (-not (Test-Path $ptauPath)) {
    Invoke-Native $snarkjs @("powersoftau", "new", "bn128", "10", "pot10_0000.ptau", "-v")
    Invoke-Native $snarkjs @("powersoftau", "contribute", "pot10_0000.ptau", "pot10_0001.ptau", "--name=Zairn local contribution", "-e=zairn-zkp")
    Invoke-Native $snarkjs @("powersoftau", "prepare", "phase2", "pot10_0001.ptau", $Ptau, "-v")
  }

  Invoke-Native $circom @($circuitFile, "--r1cs", "--wasm", "--sym", "-o", $BuildDir)

  $r1csPath = Join-Path $BuildDir "$Circuit.r1cs"

  Write-Host "Compiled circuit artifacts:"
  Write-Host "  R1CS: $BuildDir\\${Circuit}.r1cs"
  Write-Host "  WASM: $BuildDir\\${Circuit}_js\\${Circuit}.wasm"
  Write-Host "  SYM:  $BuildDir\\${Circuit}.sym"

  if (-not $CompileOnly) {
    $zkey0 = "${Circuit}_0000.zkey"
    $zkeyFinal = "${Circuit}_final.zkey"

    Invoke-Native $snarkjs @("groth16", "setup", $r1csPath, $Ptau, $zkey0)
    Invoke-Native $snarkjs @("zkey", "contribute", $zkey0, $zkeyFinal, "--name=Initial contribution", "-e=zairn-zkp")
    Invoke-Native $snarkjs @("zkey", "export", "verificationkey", $zkeyFinal, "verification_key.json")

    Write-Host "Built proving artifacts:"
    Write-Host "  ZKey: $zkeyFinal"
    Write-Host "  VKey: verification_key.json"
  }
} finally {
  Pop-Location
}
