param(
  [Parameter(Mandatory=$false)][string]$RepoRoot = ""
)

function ResolveRepoRoot {
  if (-not [string]::IsNullOrWhiteSpace($RepoRoot)) { return $RepoRoot }
  try {
    # assume script is <repo>\scripts\ps1\eci_stop.ps1
    return Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  } catch {
    return (Get-Location).Path
  }
}

$root = ResolveRepoRoot
Write-Host ("RepoRoot=" + $root)

# Kill Node processes whose command line points to this repo's core server/worker
$targets = @(
  "services\\core\\src\\eci\\server.ts",
  "services\\core\\src\\eci\\worker.ts"
)

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -or $_.Name -eq "node" -or $_.Name -eq "tsx.exe" -or $_.Name -eq "tsx"
}

$killed = 0
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
  if ($cmd -notmatch [regex]::Escape($root)) { continue }

  $hit = $false
  foreach ($t in $targets) {
    if ($cmd -like ("*" + $t + "*")) { $hit = $true; break }
  }
  if (-not $hit) { continue }

  try {
    Write-Host ("Stopping PID {0} :: {1}" -f $p.ProcessId, $cmd)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $killed++
  } catch {
    Write-Host ("WARN: failed to stop PID {0} :: {1}" -f $p.ProcessId, ($_ | Out-String))
  }
}

Write-Host ("OK: stopped {0} process(es)." -f $killed)
