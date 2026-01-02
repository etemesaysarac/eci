function Resolve-ExpectedError {
  param(
    [int]$Status,
    $BodyJson
  )
  $res = @{ classification="FAIL"; label="UNEXPECTED"; key=$null }
  if (-not $BodyJson) { return $res }

  $key = $null
  try { $key = $BodyJson.detail.errors[0].key } catch {}

  if ($Status -eq 400 -and $key -eq "shipment.package.cargo.tracking.number.update.not.allowed") {
    return @{ classification="EXPECTED"; label="EXPECTED_400_TRACKING_NOT_ALLOWED"; key=$key }
  }

  if ($Status -eq 409 -and $key -eq "fulfillment.api.shipment.package.item.status.cannot.be.changed") {
    return @{ classification="EXPECTED"; label="EXPECTED_409_STATUS_TRANSITION"; key=$key }
  }

  return $res
}
