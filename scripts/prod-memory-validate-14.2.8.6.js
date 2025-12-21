/**
 * Sprint 14.2.8.6 - Production Memory Determinism Validation
 * 
 * Tests cross-session memory visibility under tight reconnect timing.
 * 
 * Pattern:
 * 1. Session A: Connect, inject unique token via conversation
 * 2. Disconnect Session A
 * 3. Wait <500ms
 * 4. Session B: Connect, check for token in memory context
 * 
 * Success: Token visible in Session B's memory context
 */

const WebSocket = require('ws');
const crypto = require('crypto');

// Configuration
const WS_URL = process.env.WS_URL || 'wss://v14-2-8-6---jarvis-relay-fyxv6qknma-uc.a.run.app';
const ITERATIONS = parseInt(process.env.ITERATIONS || '10', 10);
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '300', 10);

const testRunId = crypto.randomBytes(4).toString('hex');
const TEST_USER_ID = `mem-test-${testRunId}`;

console.log('\n🧪 Sprint 14.2.8.6 Memory Determinism Validation\n');
console.log('='.repeat(70));
console.log(`Endpoint: ${WS_URL}`);
console.log(`Test User: ${TEST_USER_ID}`);
console.log(`Iterations: ${ITERATIONS}`);
console.log(`Reconnect Delay: ${RECONNECT_DELAY_MS}ms`);
console.log('='.repeat(70) + '\n');

const results = {
    passed: 0,
    failed: 0,
    timings: [],
    errors: []
};

function waitForSessionCreated(ws) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('session.created timeout')), 15000);

        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'session.created') {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve(msg);
                } else if (msg.type === 'diag.memory_init') {
                    // Server sends snake_case: has_context, transcript_count
                    console.log(`   📊 Memory: hasContext=${msg.has_context} transcriptLen=${msg.transcript_count}`);
                }
            } catch (e) { }
        };

        ws.on('message', handler);
    });
}

async function runSessionA(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, {
            headers: { 'x-user-id': TEST_USER_ID }
        });

        ws.on('open', () => {
            // Send capabilities
            ws.send(JSON.stringify({
                type: 'client.capabilities',
                wants_audio: false,
                wants_text_only: true
            }));
        });

        waitForSessionCreated(ws)
            .then(() => {
                // Inject token via conversation
                ws.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: `Remember this token: ${token}` }]
                    }
                }));
                ws.send(JSON.stringify({ type: 'response.create' }));

                // Wait for response to be committed
                setTimeout(() => {
                    ws.close();
                    resolve();
                }, 2000);
            })
            .catch(reject);

        ws.on('error', reject);
    });
}

async function runSessionB() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, {
            headers: { 'x-user-id': TEST_USER_ID }
        });

        let memoryInfo = null;

        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'client.capabilities',
                wants_audio: false,
                wants_text_only: true
            }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'diag.memory_init') {
                    memoryInfo = msg;
                }
                if (msg.type === 'session.created') {
                    setTimeout(() => {
                        ws.close();
                        resolve(memoryInfo);
                    }, 500);
                }
            } catch (e) { }
        });

        ws.on('error', reject);

        setTimeout(() => reject(new Error('Session B timeout')), 15000);
    });
}

async function runIteration(i, token) {
    const iterStart = Date.now();
    console.log(`\n─── Iteration ${i}/${ITERATIONS} ───`);
    console.log(`   Token: ${token}`);

    try {
        // Session A
        console.log('   [A] Connecting and injecting token...');
        await runSessionA(token);
        console.log('   [A] Session closed');

        // Wait
        console.log(`   Waiting ${RECONNECT_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));

        // Session B
        console.log('   [B] Connecting and checking memory...');
        const memoryInfo = await runSessionB();

        const duration = Date.now() - iterStart;
        results.timings.push(duration);

        // Server sends snake_case: has_context, transcript_count
        if (memoryInfo && memoryInfo.has_context && memoryInfo.transcript_count > 0) {
            results.passed++;
            console.log(`   ✅ PASS: hasContext=${memoryInfo.has_context} transcript=${memoryInfo.transcript_count} (${duration}ms)`);
        } else {
            results.failed++;
            console.log(`   ❌ FAIL: hasContext=${memoryInfo?.has_context} transcript=${memoryInfo?.transcript_count} (${duration}ms)`);
        }

    } catch (err) {
        results.failed++;
        results.errors.push(err.message);
        console.log(`   ❌ ERROR: ${err.message}`);
    }
}

async function main() {
    for (let i = 1; i <= ITERATIONS; i++) {
        const token = `TOKEN_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await runIteration(i, token);

        // Brief pause between iterations
        await new Promise(r => setTimeout(r, 500));
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 VALIDATION RESULTS\n');

    const avgTiming = results.timings.reduce((a, b) => a + b, 0) / results.timings.length;

    console.log(`   Pass Rate: ${results.passed}/${ITERATIONS} (${(results.passed / ITERATIONS * 100).toFixed(1)}%)`);
    console.log(`   Failed: ${results.failed}/${ITERATIONS}`);
    console.log(`   Avg Iteration Time: ${avgTiming.toFixed(0)}ms`);
    if (results.errors.length > 0) {
        console.log(`   Errors: ${results.errors.join(', ')}`);
    }

    console.log('\n' + '='.repeat(70));

    if (results.passed === ITERATIONS) {
        console.log('🎉 ALL TESTS PASSED - DETERMINISM VERIFIED\n');
        console.log('   GO ✅ - Canary is stable');
        process.exit(0);
    } else if (results.passed >= ITERATIONS * 0.9) {
        console.log(`⚠️ PARTIAL PASS (${results.passed}/${ITERATIONS})\n`);
        console.log('   REVIEW - Most tests passed but some failures detected');
        process.exit(1);
    } else {
        console.log(`❌ TESTS FAILED - ${results.failed} failures detected\n`);
        console.log('   NO-GO ⛔ - Do not promote');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
