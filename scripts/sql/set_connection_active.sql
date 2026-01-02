-- Set connection status to active (works with server.sprint7.ts)
UPDATE "Connection" SET status='active' WHERE id=:connectionId;
