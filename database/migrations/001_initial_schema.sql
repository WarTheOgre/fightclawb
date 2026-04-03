-- migrations/001_initial_schema.sql
-- Agent Arena — Initial PostgreSQL Schema
--
-- Apply via:  node scripts/migrate.js
-- Or direct:  psql -d arena -f migrations/001_initial_schema.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- Agents
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
    agent_id     UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    did          TEXT        NOT NULL UNIQUE,
    public_key   TEXT        NOT NULL UNIQUE,
    display_name TEXT        NOT NULL,
    agent_type   TEXT        NOT NULL DEFAULT 'standard'
                             CHECK (agent_type IN ('standard', 'code-bot', 'webhook')),
    tier         SMALLINT    NOT NULL DEFAULT 1
                             CHECK (tier IN (1, 2)),
    elo          INT         NOT NULL DEFAULT 1000,
    wins         INT         NOT NULL DEFAULT 0,
    losses       INT         NOT NULL DEFAULT 0,
    draws        INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agents_did_idx ON agents (did);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS agents_touch ON agents;
CREATE TRIGGER agents_touch
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Auth nonces
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce        TEXT        PRIMARY KEY,
    did          TEXT        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
    used_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_nonces_did_idx        ON auth_nonces (did);
CREATE INDEX IF NOT EXISTS auth_nonces_expires_at_idx ON auth_nonces (expires_at)
    WHERE used_at IS NULL;

CREATE OR REPLACE FUNCTION consume_nonce(p_nonce TEXT, p_did TEXT)
RETURNS TABLE (ok BOOLEAN, reason TEXT) LANGUAGE plpgsql AS $$
DECLARE r auth_nonces%ROWTYPE;
BEGIN
    SELECT * INTO r FROM auth_nonces WHERE nonce = p_nonce FOR UPDATE SKIP LOCKED;
    IF NOT FOUND                THEN RETURN QUERY SELECT FALSE, 'not_found';   RETURN; END IF;
    IF r.did <> p_did           THEN RETURN QUERY SELECT FALSE, 'did_mismatch';RETURN; END IF;
    IF r.expires_at < NOW()     THEN RETURN QUERY SELECT FALSE, 'expired';     RETURN; END IF;
    IF r.used_at IS NOT NULL    THEN RETURN QUERY SELECT FALSE, 'already_used';RETURN; END IF;
    UPDATE auth_nonces SET used_at = NOW() WHERE nonce = p_nonce;
    RETURN QUERY SELECT TRUE, 'ok';
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Queue entries
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS queue_entries (
    entry_id     UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id     UUID        NOT NULL REFERENCES agents (agent_id) ON DELETE CASCADE,
    tier         SMALLINT    NOT NULL DEFAULT 1,
    mode         TEXT        NOT NULL DEFAULT '1v1'
                             CHECK (mode IN ('1v1', 'ffa-3', 'ffa-4')),
    elo          INT         NOT NULL,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    match_id     UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS queue_one_per_agent
    ON queue_entries (agent_id) WHERE match_id IS NULL;

CREATE INDEX IF NOT EXISTS queue_tier_mode_idx
    ON queue_entries (tier, mode, joined_at) WHERE match_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Matches
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_status') THEN
    CREATE TYPE match_status AS ENUM ('lobby','active','finished','aborted');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS matches (
    match_id     UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    mode         TEXT         NOT NULL DEFAULT '1v1',
    tier         SMALLINT     NOT NULL DEFAULT 1,
    board_size   SMALLINT     NOT NULL DEFAULT 12,
    status       match_status NOT NULL DEFAULT 'lobby',
    round        SMALLINT     NOT NULL DEFAULT 0,
    winner_id    UUID         REFERENCES agents (agent_id),
    win_reason   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS match_participants (
    match_id     UUID     NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    agent_id     UUID     NOT NULL REFERENCES agents  (agent_id),
    player_slot  TEXT     NOT NULL CHECK (player_slot IN ('p1','p2','p3','p4')),
    home_row     SMALLINT NOT NULL,
    home_col     SMALLINT NOT NULL,
    elo_before   INT      NOT NULL,
    elo_after    INT,
    PRIMARY KEY (match_id, agent_id)
);

CREATE INDEX IF NOT EXISTS match_participants_agent_idx ON match_participants (agent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Board snapshots
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS board_snapshots (
    snapshot_id  BIGSERIAL   PRIMARY KEY,
    match_id     UUID        NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    round        SMALLINT    NOT NULL,
    cells        BYTEA       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (match_id, round)
);

CREATE INDEX IF NOT EXISTS board_snapshots_match_round
    ON board_snapshots (match_id, round DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Round actions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS round_actions (
    action_id    BIGSERIAL   PRIMARY KEY,
    match_id     UUID        NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    round        SMALLINT    NOT NULL,
    agent_id     UUID        NOT NULL REFERENCES agents (agent_id),
    player_slot  TEXT        NOT NULL,
    actions_json JSONB       NOT NULL,
    nonce        TEXT        NOT NULL,
    signature    TEXT        NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (match_id, round, agent_id)
);

CREATE INDEX IF NOT EXISTS round_actions_match_round ON round_actions (match_id, round);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hash-chained match log
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS match_log (
    entry_id     BIGSERIAL   PRIMARY KEY,
    match_id     UUID        NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    seq          INT         NOT NULL,
    event_type   TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    prev_hash    TEXT,
    entry_hash   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (match_id, seq)
);

CREATE INDEX IF NOT EXISTS match_log_match_seq ON match_log (match_id, seq);

CREATE OR REPLACE FUNCTION append_log_entry(p_match_id UUID, p_event_type TEXT, p_payload JSONB)
RETURNS match_log LANGUAGE plpgsql AS $$
DECLARE
    v_seq        INT;
    v_prev_hash  TEXT;
    v_entry_hash TEXT;
    v_row        match_log;
BEGIN
    SELECT COALESCE(MAX(seq) + 1, 0)
      INTO v_seq
      FROM match_log WHERE match_id = p_match_id;

    SELECT entry_hash INTO v_prev_hash
      FROM match_log WHERE match_id = p_match_id
      ORDER BY seq DESC LIMIT 1;

    v_entry_hash := encode(
        digest(COALESCE(v_prev_hash, '') || p_payload::TEXT, 'sha256'), 'hex');

    INSERT INTO match_log (match_id, seq, event_type, payload, prev_hash, entry_hash)
    VALUES (p_match_id, v_seq, p_event_type, p_payload, v_prev_hash, v_entry_hash)
    RETURNING * INTO v_row;

    RETURN v_row;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sandbox jobs (Tier 1 container tracking)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued','running','done','error','killed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sandbox_jobs (
    job_id       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id     UUID        NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    agent_id     UUID        NOT NULL REFERENCES agents  (agent_id),
    container_id TEXT,
    runtime      TEXT        NOT NULL DEFAULT 'runsc',
    status       job_status  NOT NULL DEFAULT 'queued',
    exit_code    SMALLINT,
    error_msg    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sandbox_jobs_match_idx  ON sandbox_jobs (match_id);
CREATE INDEX IF NOT EXISTS sandbox_jobs_status_idx ON sandbox_jobs (status)
    WHERE status IN ('queued', 'running');

-- ─────────────────────────────────────────────────────────────────────────────
-- Leaderboard materialized view
-- ─────────────────────────────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard AS
SELECT
    a.agent_id,
    a.display_name,
    a.did,
    a.tier,
    a.elo,
    a.wins,
    a.losses,
    a.draws,
    (a.wins + a.losses + a.draws)                              AS games_played,
    CASE WHEN (a.wins + a.losses + a.draws) > 0
         THEN ROUND(a.wins::NUMERIC / (a.wins + a.losses + a.draws) * 100, 1)
         ELSE 0 END                                            AS win_pct,
    RANK() OVER (PARTITION BY a.tier ORDER BY a.elo DESC)      AS rank_in_tier,
    RANK() OVER (ORDER BY a.elo DESC)                          AS rank_global
FROM agents a
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_agent_id_idx ON leaderboard (agent_id);
CREATE INDEX        IF NOT EXISTS leaderboard_tier_elo_idx ON leaderboard (tier, elo DESC);

COMMIT;
