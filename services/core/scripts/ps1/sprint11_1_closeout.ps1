Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Wrapper so you can run the Sprint 11.1 closeout from within:
#   services\core\
# (i.e., this path exists: .\scripts\ps1\sprint11_1_closeout.ps1)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$real = Join-Path $repoRoot 'scripts\ps1\sprint11_1_closeout.ps1'

if (-not (Test-Path $real)) {
  throw "Closeout script not found at expected path: $real"
}

& $real @args
