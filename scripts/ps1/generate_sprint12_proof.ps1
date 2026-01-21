# generate_sprint12_proof.ps1
# Sprint 12 Proof Generator (DEV/MOCK) - SAFE POWERSHELL 5.1 VERSION
# Writes: services/core/proofs/SPRINT_12_PROOF.md

$ErrorActionPreference = 'Stop'
$BASE = 'http://127.0.0.1:3001'
# Ensure UTF-8 output (helps Turkish characters in JSON dumps)
try { chcp 65001 | Out-Null } catch {}
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

function Find-RepoRoot {
  $cur = (Get-Location).Path
  while ($true) {
    if (Test-Path (Join-Path $cur 'services\core')) { return $cur }
    $parent = Split-Path $cur -Parent
    if ($parent -eq $cur -or [string]::IsNullOrWhiteSpace($parent)) { break }
    $cur = $parent
  }
  throw "Repo root not found. Please 'cd C:\dev\eci' and retry."
}

$ROOT = Find-RepoRoot
Set-Location $ROOT

$proofDir  = Join-Path $ROOT 'services\core\proofs'
$proofPath = Join-Path $proofDir 'SPRINT_12_PROOF.md'
New-Item -ItemType Directory -Force -Path $proofDir | Out-Null

function WL([string]$Line) { Add-Content -LiteralPath $proofPath -Value $Line -Encoding UTF8 }
function FenceJson([string]$RawJson) {
  WL '```json'
  if ([string]::IsNullOrWhiteSpace($RawJson)) { WL '{}' } else { WL $RawJson }
  WL '```'
  WL ''
}
function FenceText([string]$RawText) {
  WL '```text'
  if ([string]::IsNullOrWhiteSpace($RawText)) { WL '' } else { WL $RawText }
  WL '```'
  WL ''
}

Set-Content -LiteralPath $proofPath -Value '# ECI - Sprint 12 (Claims / Iade) - PROOF (DEV/MOCK)' -Encoding UTF8
WL ''
WL ('GeneratedAt (UTC): ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))
WL ('Base URL: ' + $BASE)
WL ''
WL '> Note: This run generates DEV/MOCK proofs (no real Trendyol claim exists in the test account).'
WL ''

# 1) Health
WL '## 1) Health'
try { FenceJson (curl.exe -s "$BASE/health") } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }

# 2) Connections
WL '## 2) Connections'
$connectionsJson = ''
try { $connectionsJson = (curl.exe -s "$BASE/v1/connections") } catch { $connectionsJson = '[]' }
FenceJson $connectionsJson

$connections = @()
try { $connections = $connectionsJson | ConvertFrom-Json } catch { $connections = @() }

if (-not $connections -or $connections.Count -lt 1) {
  WL 'ERROR: /v1/connections returned empty. Cannot continue.'
  WL ''
  Write-Host "Wrote: $proofPath (but no connections found)" -ForegroundColor Yellow
  exit 0
}

$CONN = $connections[0].id
WL ('Selected connectionId: ' + $CONN)
WL ''

# helper header for endpoints requiring connectionId
$H = @('-H', ("x-eci-connectionid: " + $CONN))

# 3) Seed DEV claims
WL '## 3) DEV seed (mock claims)'
$seedBody = '{"claims":2,"itemsPerClaim":1,"includeAudits":true}'
$seedTmp  = Join-Path $env:TEMP 'eci_sprint12_seed.json'
Set-Content -LiteralPath $seedTmp -Value $seedBody -Encoding UTF8

$seedJson = ''
try {
  $seedJson = (curl.exe -s -X POST "$BASE/v1/connections/$CONN/dev/seed-claims" -H "Content-Type: application/json" --data-binary "@$seedTmp")
} catch { $seedJson = ('{"error":"' + $_.Exception.Message + '"}') }
FenceJson $seedJson

$seedObj = $null
try { $seedObj = $seedJson | ConvertFrom-Json } catch { $seedObj = $null }

$claimA = $null; $itemA = $null; $claimB = $null; $itemB = $null
if ($seedObj -and $seedObj.seeded -and $seedObj.seeded.Count -ge 2) {
  $claimA = $seedObj.seeded[0].claimId
  $claimB = $seedObj.seeded[1].claimId
  if ($seedObj.seeded[0].items -and $seedObj.seeded[0].items.Count -ge 1) { $itemA = $seedObj.seeded[0].items[0].claimItemId }
  if ($seedObj.seeded[1].items -and $seedObj.seeded[1].items.Count -ge 1) { $itemB = $seedObj.seeded[1].items[0].claimItemId }
}
WL ('Resolved IDs: claimA=' + $claimA + ' itemA=' + $itemA)
WL ('Resolved IDs: claimB=' + $claimB + ' itemB=' + $itemB)
WL ''

# 4) Read API
WL '## 4) Read API'

WL '### GET /v1/claims/stats'
try { FenceJson (curl.exe -s "$BASE/v1/claims/stats?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }

WL '### GET /v1/claims (list)'
$listJson = ''
try { $listJson = (curl.exe -s "$BASE/v1/claims?connectionId=$CONN&page=0&pageSize=20" @H) } catch { $listJson = ('{"error":"' + $_.Exception.Message + '"}') }
FenceJson $listJson

# Parse list to resolve internal DB ids (safer than claimId in some environments)
$listObj = $null
try { $listObj = $listJson | ConvertFrom-Json } catch { $listObj = $null }
$claimA_dbId = $null
$claimB_dbId = $null
if ($listObj -and $listObj.items) {
  if ($claimA) { $claimA_dbId = (@($listObj.items | Where-Object { $_.claimId -eq $claimA } | Select-Object -First 1).id) }
  if ($claimB) { $claimB_dbId = (@($listObj.items | Where-Object { $_.claimId -eq $claimB } | Select-Object -First 1).id) }
}

if (-not $claimA -or -not $claimB) {
  try {
    $listObj = $listJson | ConvertFrom-Json
    $mock = @($listObj.items | Where-Object { $_.claimId -like 'MOCK*' } | Select-Object -First 2)
    if ($mock.Count -ge 2) { $claimA = $mock[0].claimId; $claimB = $mock[1].claimId }
  } catch {}
}

if ($claimA) {
  WL ('### GET /v1/claims/' + $claimA + ' (detail)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/$claimA?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}
if ($claimB) {
  WL ('### GET /v1/claims/' + $claimB + ' (detail)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/$claimB?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}

# Extra: detail by internal DB id (robust; endpoint supports both claimId and id)
if ($claimA_dbId) {
  WL ('### GET /v1/claims/' + $claimA_dbId + ' (detail by dbId)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/$claimA_dbId?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}
if ($claimB_dbId) {
  WL ('### GET /v1/claims/' + $claimB_dbId + ' (detail by dbId)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/$claimB_dbId?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}


WL '### GET /v1/claims/items (list)'
try { FenceJson (curl.exe -s "$BASE/v1/claims/items?connectionId=$CONN&page=0&pageSize=50" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }

if ($itemA) {
  WL ('### GET /v1/claims/items/' + $itemA + '/audits (before)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/items/$itemA/audits?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}
if ($itemB) {
  WL ('### GET /v1/claims/items/' + $itemB + '/audits (before)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/items/$itemB/audits?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}

# 4.5 Issue reasons dictionary (Reject UI)
WL '### GET /v1/claims/issue-reasons (dictionary)'
try { FenceJson (curl.exe -s "$BASE/v1/claims/issue-reasons?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }

# 5) Commands (DEV/MOCK)
WL '## 5) Commands (DEV/MOCK)'

if ($claimA -and $itemA) {
  $approveBody = '{"claimLineItemIdList":["' + $itemA + '"]}'
  $approveTmp  = Join-Path $env:TEMP 'eci_sprint12_approve.json'
  Set-Content -LiteralPath $approveTmp -Value $approveBody -Encoding UTF8
  WL ('### POST /v1/claims/' + $claimA + '/approve')
  try { FenceJson (curl.exe -s -X POST "$BASE/v1/claims/$claimA/approve?connectionId=$CONN" -H "Content-Type: application/json" --data-binary "@$approveTmp" @H) }
  catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
} else { WL 'approve skipped (missing claimA/itemA)'; WL '' }

if ($claimB -and $itemB) {
  $rejectBody = '{"claimLineItemIdList":["' + $itemB + '"],"claimIssueReasonId":1651,"description":"Mock reject (DEV proof)"}'
  $rejectTmp  = Join-Path $env:TEMP 'eci_sprint12_reject.json'
  Set-Content -LiteralPath $rejectTmp -Value $rejectBody -Encoding UTF8
  WL ('### POST /v1/claims/' + $claimB + '/reject')
  try { FenceJson (curl.exe -s -X POST "$BASE/v1/claims/$claimB/reject?connectionId=$CONN" -H "Content-Type: application/json" --data-binary "@$rejectTmp" @H) }
  catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
} else { WL 'reject skipped (missing claimB/itemB)'; WL '' }

# Audits after commands
if ($itemA) {
  WL ('### GET /v1/claims/items/' + $itemA + '/audits (after)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/items/$itemA/audits?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}
if ($itemB) {
  WL ('### GET /v1/claims/items/' + $itemB + '/audits (after)')
  try { FenceJson (curl.exe -s "$BASE/v1/claims/items/$itemB/audits?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }
}

# 6) DB counts (via API - avoids docker/psql quoting issues)
WL '## 6) DB counts (via API)'
try { FenceJson (curl.exe -s "$BASE/v1/claims/dev/counts?connectionId=$CONN" @H) } catch { FenceJson ('{"error":"' + $_.Exception.Message + '"}') }

# Rate-limit note (mock run)
WL '## 7) Rate limit note'
WL '- In DEV/MOCK mode: no external Trendyol calls are made.'
WL '- Real Trendyol limits (from Trendyol.pdf): list/audit 1000 req/min, approve/reject/create 5 req/min.'
WL ''

WL '## 8) Closing'
WL '- DEV/MOCK proof generated. Real Trendyol audit (executorApp=SellerIntegrationApi) requires real claim flow.'
WL ''

Write-Host ("OK: created -> " + $proofPath) -ForegroundColor Green
