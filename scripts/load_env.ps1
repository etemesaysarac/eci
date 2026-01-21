param(
  [Parameter(Mandatory=$false)]
  [string]$Path = ".env"
)

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Host "ENV file not found: $Path" -ForegroundColor Red
  return
}

Get-Content -LiteralPath $Path | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }

  $parts = $line -split "=", 2
  if ($parts.Count -ne 2) { return }

  $name  = $parts[0].Trim()
  $value = $parts[1].Trim()

  # strip quotes
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    if ($value.Length -ge 2) { $value = $value.Substring(1, $value.Length-2) }
  }

  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}
