/**
 * Memory Core CRUD Operations (Sprint 14.1)
 * 
 * All memory operations for Tony's Notebook v0
 */

const db = require('./index');
const fs = require('fs');
const path = require('path');

// ============================================================================
// USER MANAGEMENT
// ============================================================================

/**
 * Get or create a user by external identifier
 * @param {string} externalId - External user identifier (auth token, username, etc)
 * @returns {Promise<{user_id: string, created: boolean}>}
 */
async function getOrCreateUser(externalId) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Check if identity exists
        const identityResult = await client.query(
            'SELECT user_id FROM user_identities WHERE external_id = $1',
            [externalId]
        );

        if (identityResult.rows.length > 0) {
            await client.query('COMMIT');
            return { user_id: identityResult.rows[0].user_id, created: false };
        }

        // Create new user
        const userResult = await client.query(
            'INSERT INTO users DEFAULT VALUES RETURNING id'
        );
        const userId = userResult.rows[0].id;

        // Create identity mapping
        await client.query(
            'INSERT INTO user_identities (external_id, user_id) VALUES ($1, $2)',
            [externalId, userId]
        );

        // Initialize user_memory
        await client.query(
            `INSERT INTO user_memory (user_id, preferences) 
             VALUES ($1, $2::jsonb)`,
            [userId, JSON.stringify(['No MP3 downloads by default; streaming playback only.'])]
        );

        await client.query('COMMIT');
        return { user_id: userId, created: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Start a new session for a user
 * @param {string} userId - User UUID
 * @returns {Promise<string>} Session UUID
 */
async function startSession(userId) {
    const result = await db.query(
        'INSERT INTO sessions (user_id) VALUES ($1) RETURNING id',
        [userId]
    );
    return result.rows[0].id;
}

/**
 * Append a message to a session
 * @param {string} sessionId - Session UUID
 * @param {string} role - Message role (user|assistant|system|tool)
 * @param {string} content - Message content
 * @param {Object} metadata - Optional metadata
 * @returns {Promise<{success: boolean, latency_ms: number}>} Result with timing
 */
async function appendMessage(sessionId, role, content, metadata = null) {
    const startTime = Date.now();
    const sessionIdHash = sessionId ? sessionId.substring(0, 8) : 'null';

    console.log(`📝 [MEMORY] appendMessage.start session=${sessionIdHash} role=${role} length=${content?.length || 0}`);

    try {
        await db.query(
            `INSERT INTO messages (session_id, role, content, metadata) 
             VALUES ($1, $2, $3, $4)`,
            [sessionId, role, content, metadata ? JSON.stringify(metadata) : null]
        );

        const latencyMs = Date.now() - startTime;
        console.log(`✅ [MEMORY] appendMessage.ok session=${sessionIdHash} role=${role} latency_ms=${latencyMs}`);

        return { success: true, latency_ms: latencyMs };
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        console.error(`❌ [MEMORY] appendMessage.err session=${sessionIdHash} role=${role} latency_ms=${latencyMs} error=${error.message}`);
        throw error;
    }
}

/**
 * End a session and generate summary
 * @param {string} sessionId - Session UUID
 * @param {Object} summary - Optional pre-computed summary
 */
async function endSession(sessionId, summary = null) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Get session messages if summary not provided
        if (!summary) {
            const messagesResult = await client.query(
                `SELECT role, content FROM messages 
                 WHERE session_id = $1 ORDER BY created_at`,
                [sessionId]
            );
            summary = generateSummary(messagesResult.rows);
        }

        // Update session
        await client.query(
            `UPDATE sessions SET ended_at = NOW(), summary = $1 WHERE id = $2`,
            [JSON.stringify(summary), sessionId]
        );

        // Get user_id for this session
        const sessionResult = await client.query(
            'SELECT user_id FROM sessions WHERE id = $1',
            [sessionId]
        );
        const userId = sessionResult.rows[0].user_id;

        // Update user's last_session_id
        await client.query(
            `UPDATE user_memory SET last_session_id = $1, updated_at = NOW() WHERE user_id = $2`,
            [sessionId, userId]
        );

        await client.query('COMMIT');
        return summary;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// MEMORY RETRIEVAL
// ============================================================================

/**
 * Get the last session's full transcript for a user
 * Sprint 14.2.8.6: Deterministic ordering + bounded retry for commit visibility
 * @param {string} userId - User UUID
 * @param {string} excludeSessionId - Optional session ID to exclude (current session)
 * @returns {Promise<Array>} Array of messages
 */
async function getLastSessionTranscript(userId, excludeSessionId = null) {
    const userIdHash = userId ? userId.substring(0, 8) : 'null';
    const excludeHash = excludeSessionId ? excludeSessionId.substring(0, 8) : 'none';

    // Strategy: Find the most recent session that is NOT the current one
    // Sprint 14.2.8.6: Use id::text DESC as deterministic tie-breaker for identical started_at
    // (UUIDs are not time-ordered, but this ensures consistent selection across queries)

    let query = `SELECT id FROM sessions WHERE user_id = $1`;
    const params = [userId];

    if (excludeSessionId) {
        query += ` AND id != $2`;
        params.push(excludeSessionId);
    }

    // Deterministic tie-breaker: id::text DESC ensures same session is always selected
    // even if started_at values are identical (microsecond collision under rapid reconnects)
    query += ` ORDER BY started_at DESC, id::text DESC LIMIT 1`;

    const lastSessionResult = await db.query(query, params);

    if (lastSessionResult.rows.length === 0) {
        console.log(`🔍 [MEMORY] getLastSessionTranscript: No prior session found user=${userIdHash} excluded=${excludeHash}`);
        return [];
    }

    const lastSessionId = lastSessionResult.rows[0].id;
    const lastSessionHash = lastSessionId.substring(0, 8);

    // First attempt to fetch messages
    let messagesResult = await db.query(
        `SELECT id, role, content, metadata, created_at
         FROM messages WHERE session_id = $1 ORDER BY created_at`,
        [lastSessionId]
    );

    // Sprint 14.2.8.6: Bounded retry for commit visibility race
    // If prior session exists but has no messages, retry up to 2 times with 150ms delay
    // This covers the window where Session A's messages/endSession haven't committed yet
    // Total max delay: 300ms (2 * 150ms)
    let retryCount = 0;
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 150;

    while (messagesResult.rows.length === 0 && retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`⏳ [MEMORY] getLastSessionTranscript: Prior session ${lastSessionHash} empty, retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));

        messagesResult = await db.query(
            `SELECT id, role, content, metadata, created_at
             FROM messages WHERE session_id = $1 ORDER BY created_at`,
            [lastSessionId]
        );
    }

    const msgCount = messagesResult.rows.length;
    console.log(`🔍 [MEMORY] getLastSessionTranscript: user=${userIdHash} session=${lastSessionHash} messages=${msgCount} retries=${retryCount}`);

    return messagesResult.rows;
}

/**
 * Get user's long-term memory
 * @param {string} userId - User UUID
 * @returns {Promise<Object>} User memory record
 */
async function getUserMemory(userId) {
    const result = await db.query(
        `SELECT history_summary, key_points, open_loops, preferences, entities, last_session_id, updated_at
         FROM user_memory WHERE user_id = $1`,
        [userId]
    );

    if (result.rows.length === 0) {
        return {
            history_summary: null,
            key_points: [],
            open_loops: [],
            preferences: ['No MP3 downloads by default; streaming playback only.'],
            entities: {},
            last_session_id: null
        };
    }

    return result.rows[0];
}

/**
 * Get full context pack for a user (before first response)
 * Sprint 14.2.8.6: Enhanced observability for context injection decision
 * @param {string} userId - User UUID
 * @param {string} currentSessionId - Optional: current session ID to exclude from history
 * @returns {Promise<Object>} Context pack with transcript and memory
 */
async function getContextPack(userId, currentSessionId = null) {
    const userIdHash = userId ? userId.substring(0, 8) : 'null';
    const startTime = Date.now();

    const [lastSessionTranscript, userMemory] = await Promise.all([
        getLastSessionTranscript(userId, currentSessionId),
        getUserMemory(userId)
    ]);

    const latencyMs = Date.now() - startTime;
    const transcriptCount = lastSessionTranscript?.length || 0;
    const keyPointsCount = userMemory?.key_points?.length || 0;
    const hasContext = transcriptCount > 0 || keyPointsCount > 0;

    // Determine reason code for observability
    let reasonCode = 'none';
    if (transcriptCount > 0 && keyPointsCount > 0) {
        reasonCode = 'full_context';
    } else if (transcriptCount > 0) {
        reasonCode = 'transcript_only';
    } else if (keyPointsCount > 0) {
        reasonCode = 'memory_only';
    } else {
        reasonCode = 'no_history';
    }

    console.log(`📦 [MEMORY] getContextPack: user=${userIdHash} hasContext=${hasContext} reason=${reasonCode} transcript=${transcriptCount} keyPoints=${keyPointsCount} latency_ms=${latencyMs}`);

    return {
        last_session_transcript: lastSessionTranscript,
        user_memory: userMemory
    };
}

// ============================================================================
// MEMORY UPDATES
// ============================================================================

/**
 * Merge session summary into user's long-term memory
 * @param {string} userId - User UUID
 * @param {Object} sessionSummary - Summary from ended session
 */
async function mergeUserMemory(userId, sessionSummary) {
    const currentMemory = await getUserMemory(userId);

    // De-duplicate helper (case-insensitive trim)
    const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter(item => {
            const normalized = String(item).toLowerCase().trim();
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
    };

    // Merge arrays with de-duplication
    const mergedKeyPoints = dedupe([
        ...(currentMemory.key_points || []),
        ...(sessionSummary.key_points || [])
    ]).slice(-20); // Keep last 20

    const mergedOpenLoops = dedupe([
        ...(currentMemory.open_loops || []),
        ...(sessionSummary.open_loops || [])
    ]);

    const mergedPreferences = dedupe([
        ...(currentMemory.preferences || []),
        ...(sessionSummary.preferences || [])
    ]);

    // Shallow merge entities (newer wins)
    const mergedEntities = {
        ...(currentMemory.entities || {}),
        ...(sessionSummary.entities || {})
    };

    // Update history summary (append)
    const newHistorySummary = sessionSummary.history_snippet
        ? `${currentMemory.history_summary || ''}\n${sessionSummary.history_snippet}`.trim()
        : currentMemory.history_summary;

    await db.query(
        `UPDATE user_memory SET 
            history_summary = $1,
            key_points = $2::jsonb,
            open_loops = $3::jsonb,
            preferences = $4::jsonb,
            entities = $5::jsonb,
            updated_at = NOW()
         WHERE user_id = $6`,
        [
            newHistorySummary,
            JSON.stringify(mergedKeyPoints),
            JSON.stringify(mergedOpenLoops),
            JSON.stringify(mergedPreferences),
            JSON.stringify(mergedEntities),
            userId
        ]
    );
}

// ============================================================================
// SUMMARY GENERATION (V0 - Deterministic)
// ============================================================================

/**
 * Generate a deterministic summary from messages (no LLM)
 * @param {Array} messages - Array of {role, content}
 * @returns {Object} Summary with key_points, open_loops, decisions
 */
function generateSummary(messages) {
    const keyPoints = [];
    const openLoops = [];
    const decisions = [];

    const assistantMessages = messages.filter(m => m.role === 'assistant');

    // Extract key points: first sentence of last 5 assistant messages
    const lastFive = assistantMessages.slice(-5);
    for (const msg of lastFive) {
        const firstSentence = msg.content.split(/[.!?]/)[0]?.trim();
        if (firstSentence && firstSentence.length > 10 && firstSentence.length < 200) {
            keyPoints.push(firstSentence);
        }
    }

    // Scan all messages for patterns
    for (const msg of messages) {
        const content = msg.content;
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // Open loops: TODO, Next, We should
            if (/^(TODO:|Next:|We should|I'll need to|Let's|We need to)/i.test(trimmed)) {
                openLoops.push(trimmed.substring(0, 100));
            }

            // Decisions: Decision, Approved, We will
            if (/^(Decision:|Approved:|We will|I'll|Confirmed:)/i.test(trimmed)) {
                decisions.push(trimmed.substring(0, 100));
            }
        }
    }

    return {
        key_points: [...new Set(keyPoints)].slice(0, 10),
        open_loops: [...new Set(openLoops)].slice(0, 10),
        decisions: [...new Set(decisions)].slice(0, 10),
        preferences: [],
        entities: {},
        history_snippet: keyPoints.length > 0 ? keyPoints[0] : null
    };
}

// ============================================================================
// JSONL EXPORT
// ============================================================================

/**
 * Export a session as JSONL string
 * @param {string} sessionId - Session UUID
 * @returns {Promise<string>} JSONL content
 */
async function exportSessionAsJSONL(sessionId) {
    const result = await db.query(
        `SELECT created_at as ts, role, content, metadata 
         FROM messages WHERE session_id = $1 ORDER BY created_at`,
        [sessionId]
    );

    return result.rows.map(row => JSON.stringify({
        ts: row.ts,
        role: row.role,
        content: row.content,
        metadata: row.metadata
    })).join('\n');
}

/**
 * Write session JSONL to local file (dev only)
 * @param {string} userId - User UUID
 * @param {string} sessionId - Session UUID
 */
async function writeSessionJSONLFile(userId, sessionId) {
    const jsonl = await exportSessionAsJSONL(sessionId);

    const dir = path.join(process.cwd(), 'memory', userId, 'sessions');
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, jsonl);

    return filePath;
}

module.exports = {
    getOrCreateUser,
    startSession,
    appendMessage,
    endSession,
    getLastSessionTranscript,
    getUserMemory,
    getContextPack,
    mergeUserMemory,
    generateSummary,
    exportSessionAsJSONL,
    writeSessionJSONLFile
};
