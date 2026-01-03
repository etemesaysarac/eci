param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [string]$TranscriptPath = "C:\dev\eci\Çıktılar.txt",
  [string]$WorkerLogPath = "C:\dev\eci\worker.log",
  [string]$ApiLogPath = "C:\dev\eci\api.log",
  [string]$PgContainer = "infra-postgres-1",
  [string]$PgUser = "eci",
  [string]$PgDb = "eci"
)

$ErrorActionPreference = "Stop"

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$outDir = "C:\dev\eci\proofs"
$out = Join-Path $outDir ("SPRINT_8_PROOF_{0}.md" -f $ts)

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function TailFile([string]$path, [int]$n = 200) {
  if (Test-Path -LiteralPath $path) { return Get-Content -LiteralPath $path -Tail $n }
  return @("[missing] $path")
}

function RunPsql([string]$sql) {
  $cmd = @(
    "exec", "-i", $PgContainer,
    "psql", "-U", $PgUser, "-d", $PgDb, "-c", $sql
  )
  # docker exec returns non-zero on SQL error -> catch outside if needed
  return docker @cmd 2>&1
}

$trans = TailFile $TranscriptPath 400
$api   = TailFile $ApiLogPath 200
$worker= TailFile $WorkerLogPath 300

# DB snapshots (will show if migrations/tables exist)
$subSql = 'select id, provider, status, "authenticationType", "remoteWebhookId", "endpointUrl", "createdAt", "updatedAt" from "WebhookSubscription" order by "updatedAt" desc limit 10;'
$evtSql = 'select id, provider, "eventKey", "verifyStatus", "dedupHit", "receivedAt" from "WebhookEvent" order by "receivedAt" desc limit 10;'

$subOut = RunPsql $subSql
$evtOut = RunPsql $evtSql

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# ECI — Sprint 8 Proof Pack")
$md.Add("")
$md.Add("Generated: $ts")
$md.Add("")
$md.Add("BaseUrl: $BaseUrl")
$md.Add("")
$md.Add("## Transcript (Çıktılar.txt tail)")
$md.Add("")
$md.Add("~~~text")
$trans | ForEach-Object { $md.Add($_) }
$md.Add("~~~")
$md.Add("")
$md.Add("## DB — WebhookSubscription snapshot")
$md.Add("")
$md.Add("~~~text")
$subOut | ForEach-Object { $md.Add($_) }
$md.Add("~~~")
$md.Add("")
$md.Add("## DB — WebhookEvent snapshot")
$md.Add("")
$md.Add("~~~text")
$evtOut | ForEach-Object { $md.Add($_) }
$md.Add("~~~")
$md.Add("")
$md.Add("## API log tail")
$md.Add("")
$md.Add("~~~text")
$api | ForEach-Object { $md.Add($_) }
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
