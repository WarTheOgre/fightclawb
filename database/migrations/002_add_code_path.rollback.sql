-- Rollback migration 002: Remove code_path column

BEGIN;

ALTER TABLE agents DROP COLUMN IF EXISTS code_path;

COMMIT;
