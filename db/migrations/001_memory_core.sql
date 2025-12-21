-- ============================================================================
-- Sprint 14.1 - Memory Core Schema (Tony's Notebook v0)
-- ============================================================================
-- Run: psql -d jarvis -f db/migrations/001_memory_core.sql
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- USERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- USER IDENTITIES (external ID mapping)
-- Maps external identifiers (auth tokens, usernames) to internal user_id
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_identities (
    external_id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    summary JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);

-- ============================================================================
-- MESSAGES TABLE (JSONL-exportable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- ============================================================================
-- USER MEMORY TABLE (long-term persistent memory)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_memory (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    history_summary TEXT,
    key_points JSONB DEFAULT '[]'::jsonb,
    open_loops JSONB DEFAULT '[]'::jsonb,
    preferences JSONB DEFAULT '[]'::jsonb,
    entities JSONB DEFAULT '{}'::jsonb,
    last_session_id UUID REFERENCES sessions(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memory_last_session_id ON user_memory(last_session_id);

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE 'Memory Core schema created successfully';
END $$;
