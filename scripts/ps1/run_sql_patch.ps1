# Güvenli çalıştırma: SQL dosyasını container içine kopyala ve -f ile çalıştır
$ErrorActionPreference = "Stop"

$SqlLocal = Join-Path $PSScriptRoot "..\sql\narrow_to_one_connection.sql"
if (!(Test-Path $SqlLocal)) { throw "SQL dosyası bulunamadı: $SqlLocal" }

Write-Host ">> narrow_to_one_connection.sql container'a kopyalanıyor..."
docker cp $SqlLocal infra-postgres-1:/tmp/narrow_to_one_connection.sql

Write-Host ">> Ön kontrol: mevcut Connection kayıtları"
docker exec -it infra-postgres-1 psql -U eci -d eci -c "select id, name, type, status from ""Connection"" order by ""createdAt"" desc limit 50;"

Write-Host ">> Patch uygulanıyor..."
docker exec -it infra-postgres-1 psql -U eci -d eci -v ON_ERROR_STOP=1 -f /tmp/narrow_to_one_connection.sql

Write-Host ">> Son kontrol: Connection kayıtları"
docker exec -it infra-postgres-1 psql -U eci -d eci -c "select id, name, type, status from ""Connection"" order by ""createdAt"" desc limit 50;"
