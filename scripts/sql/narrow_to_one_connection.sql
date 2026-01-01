BEGIN;
-- Tek bir connection'ı aktif bırak, diğerlerini kapat (ID: cmju5r9cv000qe6x07ke409ni)
UPDATE "Connection" SET status='disabled' WHERE id <> 'cmju5r9cv000qe6x07ke409ni';
UPDATE "Connection" SET status='enabled'  WHERE id  = 'cmju5r9cv000qe6x07ke409ni';
COMMIT;
