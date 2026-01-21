# ECI — Sprint 12 (Claims / İade) — CLOSEOUT

Bu ZIP, Sprint 12’yi **DEV/MOCK modunda** kapatmak için gereken kapanış dokümanlarını içerir.

## Durum Özeti (mevcut kanıt dosyasına göre)
- ✅ **Read path**: Claim list + items + stats endpoint’leri çalışıyor; DB’ye yazılmış mock claim/item verisi üzerinden panelde listeleme yapılabilir.
- ✅ **Issue Reasons**: `/v1/claims/issue-reasons` Trendyol sözlüğünü (DEV/MOCK) dönüyor.
- ✅ **Command path (DEV/MOCK)**:
  - Approve komutu `ClaimCommand` kaydı üretip ilgili `ClaimItem` statülerini güncelliyor.
  - Reject (create issue) komutu `ClaimCommand` kaydı üretip ilgili `ClaimItem` statülerini güncelliyor.
  - Audit logları DB’ye yazılıyor.
- ⚠️ **Bilinen eksik / bug**:
  - `GET /v1/claims/:id` (detail) şu an `not_found` dönebiliyor.
  - Workaround: Detail ekranını `GET /v1/claims/items?connectionId=...&claimId=...` + list endpoint’inden gelen üst seviye claim metadata ile birleştir.
  - Not: Bu issue gerçek Trendyol claim’leriyle test edilemediği için (test hesapta iade yok) DEV/MOCK kapanış yapıldı.

## Gerçek (Trendyol) kanıtı ne zaman tamamlanır?
Test hesapta gerçek claim oluştuğu anda:
- SYNC_CLAIMS gerçek `getClaims` ile çekilir,
- Approve/Reject gerçek endpoint’leri çağrılır,
- `getClaimAudits` ile `executorApp = SellerIntegrationApi` kanıtı alınır,
- Bu kanıtlar aynı proof formatına eklenir.

## İçerik
- `services/core/proofs/SPRINT_12_PROOF.md` : Sprint 12 kanıt paketi (otomatik üretilmiş çıktı).
- `services/core/proofs/SPRINT_12_CLOSEOUT.md` : Bu dosya (özet + notlar).

