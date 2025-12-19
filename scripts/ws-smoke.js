#!/usr/bin/env node
/**
 * WebSocket Smoke Test Harness for jarvis-relay v12.9.3
 * 
 * Opens N concurrent WebSocket connections to the relay endpoint,
 * waits for session.created + session.updated events, and reports
 * success/failure statistics with forensic details.
 * 
 * Usage:
 *   node scripts/ws-smoke.js --url wss://jarvis-relay-xxx.run.app --n 25 --timeout 10000
 * 
 * Exit codes:
 *   0 = all connections succeeded
 *   1 = one or more connections failed
 */

const WebSocket = require('ws');

// ==================== CLI ARGUMENT PARSING ====================
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        url: 'ws://localhost:8081',
        n: 10,
        timeout: 10000
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) {
            config.url = args[i + 1];
            i++;
        } else if (args[i] === '--n' && args[i + 1]) {
            config.n = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--timeout' && args[i + 1]) {
            config.timeout = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
WebSocket Smoke Test Harness for jarvis-relay

Usage:
  node scripts/ws-smoke.js [options]

Options:
  --url <WSS_URL>     WebSocket URL to test (default: ws://localhost:8081)
  --n <count>         Number of concurrent connections (default: 10)
  --timeout <ms>      Timeout per connection in ms (default: 10000)
  --help, -h          Show this help message

Examples:
  node scripts/ws-smoke.js --url ws://localhost:8081 --n 10
  node scripts/ws-smoke.js --url wss://jarvis-relay-xxx.run.app --n 25 --timeout 15000
`);
            process.exit(0);
        }
    }

    return config;
}

// ==================== FAILURE CATEGORIES ====================
const FailureCategory = {
    TIMEOUT: 'timeout',
    CLOSE: 'close',
    ERROR: 'error',
    UNEXPECTED_RESPONSE: 'unexpected-response',
    NON_101: 'non-101',
    AUTH: 'auth'
};

// ==================== CONNECTION TEST ====================
function testConnection(url, timeout, connectionIndex) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let connId = 'unknown';
        let sessionCreated = false;
        let sessionUpdated = false;
        let resolved = false;
        let ws = null;

        const cleanup = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        };

        const succeed = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve({
                success: true,
                connId,
                index: connectionIndex,
                durationMs: Date.now() - startTime
            });
        };

        const fail = (category, details = {}) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve({
                success: false,
                connId,
                index: connectionIndex,
                category,
                missingEvent: !sessionCreated ? 'session.created' : (!sessionUpdated ? 'session.updated' : 'none'),
                durationMs: Date.now() - startTime,
                ...details
            });
        };

        // Timeout handler
        const timeoutId = setTimeout(() => {
            fail(FailureCategory.TIMEOUT, {
                message: `Timed out after ${timeout}ms`
            });
        }, timeout);

        try {
            ws = new WebSocket(url);

            ws.on('open', () => {
                // Connection opened, waiting for handshake events
            });

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());

                    // Capture conn_id from diag message
                    if (message.type === 'diag.conn_id') {
                        connId = message.conn_id || 'unknown';
                    }

                    // Track handshake events
                    if (message.type === 'session.created') {
                        sessionCreated = true;
                    }

                    if (message.type === 'session.updated') {
                        sessionUpdated = true;
                    }

                    // Success: both events received
                    if (sessionCreated && sessionUpdated) {
                        clearTimeout(timeoutId);
                        succeed();
                    }
                } catch (err) {
                    // Ignore parse errors for non-JSON messages
                }
            });

            ws.on('close', (code, reason) => {
                clearTimeout(timeoutId);
                const reasonStr = reason ? reason.toString() : 'none';

                // If we got both events before close, it's a success
                if (sessionCreated && sessionUpdated) {
                    succeed();
                    return;
                }

                // Categorize auth failures
                if (code === 1008 || code === 4001) {
                    fail(FailureCategory.AUTH, {
                        closeCode: code,
                        closeReason: reasonStr,
                        message: 'Authentication failure'
                    });
                } else {
                    fail(FailureCategory.CLOSE, {
                        closeCode: code,
                        closeReason: reasonStr,
                        message: `Unexpected close before handshake complete`
                    });
                }
            });

            ws.on('error', (error) => {
                clearTimeout(timeoutId);
                fail(FailureCategory.ERROR, {
                    message: error.message
                });
            });

            ws.on('unexpected-response', (request, response) => {
                clearTimeout(timeoutId);

                // Read response body
                let body = '';
                response.on('data', chunk => body += chunk);
                response.on('end', () => {
                    const category = response.statusCode === 401 ? FailureCategory.AUTH :
                        response.statusCode !== 101 ? FailureCategory.NON_101 :
                            FailureCategory.UNEXPECTED_RESPONSE;

                    fail(category, {
                        statusCode: response.statusCode,
                        statusMessage: response.statusMessage || 'none',
                        message: `HTTP ${response.statusCode}: ${body.substring(0, 100)}`
                    });
                });
            });

        } catch (err) {
            clearTimeout(timeoutId);
            fail(FailureCategory.ERROR, {
                message: err.message
            });
        }
    });
}

// ==================== MAIN ====================
async function main() {
    const config = parseArgs();

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║     WebSocket Smoke Test Harness - jarvis-relay v12.9.3      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log(`🎯 Target URL:    ${config.url}`);
    console.log(`🔢 Connections:   ${config.n}`);
    console.log(`⏱️  Timeout:       ${config.timeout}ms\n`);

    console.log('Starting concurrent connections...\n');

    // Launch all connections concurrently
    const promises = [];
    for (let i = 0; i < config.n; i++) {
        promises.push(testConnection(config.url, config.timeout, i + 1));
    }

    // Wait for all to complete
    const results = await Promise.all(promises);

    // Analyze results
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    // Count failures by category
    const failuresByCategory = {};
    for (const f of failures) {
        failuresByCategory[f.category] = (failuresByCategory[f.category] || 0) + 1;
    }

    // Print summary
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                        SUMMARY                                ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const successRate = ((successes.length / config.n) * 100).toFixed(1);
    const avgDuration = results.length > 0
        ? (results.reduce((sum, r) => sum + r.durationMs, 0) / results.length).toFixed(0)
        : 0;

    console.log(`📊 Results:`);
    console.log(`   Total:        ${config.n}`);
    console.log(`   ✅ Success:   ${successes.length} (${successRate}%)`);
    console.log(`   ❌ Failed:    ${failures.length}`);
    console.log(`   ⏱️  Avg time:  ${avgDuration}ms\n`);

    if (Object.keys(failuresByCategory).length > 0) {
        console.log(`📋 Failures by category:`);
        for (const [category, count] of Object.entries(failuresByCategory)) {
            console.log(`   ${category}: ${count}`);
        }
        console.log('');
    }

    // Print failure details
    if (failures.length > 0) {
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    FAILURE DETAILS                            ║');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');

        for (const f of failures) {
            console.log(`❌ Connection #${f.index}`);
            console.log(`   conn_id:   ${f.connId}`);
            console.log(`   category:  ${f.category}`);
            console.log(`   missing:   ${f.missingEvent}`);
            if (f.closeCode !== undefined) {
                console.log(`   close:     ${f.closeCode} (${f.closeReason})`);
            }
            if (f.statusCode !== undefined) {
                console.log(`   status:    ${f.statusCode} ${f.statusMessage}`);
            }
            console.log(`   message:   ${f.message}`);
            console.log(`   duration:  ${f.durationMs}ms\n`);
        }
    }

    // Exit code
    if (failures.length > 0) {
        console.log('🔴 SMOKE TEST FAILED - see failures above\n');
        process.exit(1);
    } else {
        console.log('🟢 SMOKE TEST PASSED - all connections succeeded\n');
        process.exit(0);
    }
}

// Run
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
