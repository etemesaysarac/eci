param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [Parameter(Mandatory=$true)][string]$ConnectionId,
  [Parameter(Mandatory=$true)][string]$PackageId,
  [Parameter(Mandatory=$true)][long]$LineId,
  [string]$WorkerLogPath = "C:\dev\eci\worker.log",
  [string]$ActionsTranscriptPath = "C:\dev\eci\Çıktılar.txt"
)

$ErrorActionPreference = "Stop"

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$out = "C:\dev\eci\proofs\SPRINT_7_2_PROOF_{0}.md" -f $ts

function Read-LastLines([string]$Path, [int]$N = 500) {
  if (-not (Test-Path $Path)) { return @() }
  $lines = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
  if (-not $lines) { return @() }
  if ($lines.Count -le $N) { return $lines }
  return $lines | Select-Object -Last $N
}

$trans = Read-LastLines $ActionsTranscriptPath 120
$worker = Read-LastLines $WorkerLogPath 600

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Sprint 7.2 Proof Pack")
$md.Add("")
$md.Add(("- GeneratedAt: {0}" -f (Get-Date).ToString("s")))
$md.Add(("- BaseUrl: {0}" -f $BaseUrl))
$md.Add(("- ConnectionId: {0}" -f $ConnectionId))
$md.Add(("- PackageId: {0}" -f $PackageId))
$md.Add(("- LineId: {0}" -f $LineId))
$md.Add("")
$md.Add("## Transcript tail")
$md.Add("")
$md.Add("~~~text")
$trans | ForEach-Object { $md.Add($_) }
$md.Add("~~~")
$md.Add("")
$md.Add("## Worker log tail")
$md.Add("")
$md.Add("~~~text")
$worker | ForEach-Object { $md.Add($_) }
$md.Add("~~~")
$md.Add("")

Set-Content -LiteralPath $out -Value ($md -join "`n") -Encoding UTF8
Write-Host ("OK: proof generated -> {0}" -f $out) -ForegroundColor Green
