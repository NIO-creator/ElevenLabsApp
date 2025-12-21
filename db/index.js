/**
 * Database Connection Pool (Sprint 14.1)
 * 
 * PostgreSQL connection management using pg.Pool
 */

const { Pool } = require('pg');

// Connection pool configuration
const pool = new Pool({
    // Sanitize connection string (remove newlines from secrets)
    connectionString: process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/[\r\n]+/g, '') : undefined,
    max: 10,                    // Maximum connections
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 5000
});

// Log connection events (no secrets)
pool.on('connect', () => {
    console.log('📦 [DB] New client connected to PostgreSQL');
});

pool.on('error', (err) => {
    console.error('❌ [DB] Unexpected pool error:', err.message);
});

/**
 * Execute a query with error handling
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params = []) {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        const duration = Date.now() - start;

        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`🔍 [DB] Query executed in ${duration}ms, rows: ${result.rowCount}`);
        }

        return result;
    } catch (error) {
        console.error(`❌ [DB] Query error: ${error.message}`);
        throw error;
    }
}

/**
 * Get a client for transaction support
 * @returns {Promise<Object>} Client from pool
 */
async function getClient() {
    return pool.connect();
}

/**
 * Close the pool gracefully
 */
async function close() {
    await pool.end();
    console.log('📦 [DB] Pool closed');
}

module.exports = {
    query,
    getClient,
    close,
    pool
};
