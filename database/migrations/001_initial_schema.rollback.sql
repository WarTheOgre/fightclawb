-- Rollback for 001_initial_schema
-- Drops all objects created by the initial migration

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS leaderboard CASCADE;

DROP TABLE IF EXISTS
  match_log, round_actions, board_snapshots,
  match_participants, sandbox_jobs, queue_entries,
  matches, auth_nonces, agents
CASCADE;

DROP TYPE IF EXISTS match_status CASCADE;
DROP TYPE IF EXISTS job_status CASCADE;

DROP FUNCTION IF EXISTS touch_updated_at CASCADE;
DROP FUNCTION IF EXISTS consume_nonce CASCADE;
DROP FUNCTION IF EXISTS append_log_entry CASCADE;

COMMIT;
