-- Migration 002: Add code_path column to agents table
-- Required for code-bot agents to execute custom JavaScript during battles

BEGIN;

-- Add code_path column (nullable - only code-bot agents will have this)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS code_path TEXT;

-- Add comment for documentation
COMMENT ON COLUMN agents.code_path IS 'Path to JavaScript file for code-bot agents. NULL for standard/webhook agents.';

COMMIT;
