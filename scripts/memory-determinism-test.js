#!/usr/bin/env node
/**
 * Memory Determinism Verification Script (Sprint 14.2.8.6)
 * 
 * Tests cross-session memory visibility under tight reconnect timing.
 * 
 * Test pattern:
 * 1. Session A: Create session, append message with unique token
 * 2. Wait <500ms (configurable)
 * 3. Session B: Start new session, verify context pack has Session A's token
 * 
 * Success criteria: ≥20/20 iterations with deterministic recall
 * 
 * Usage: 
 *   node scripts/memory-determinism-test.js
 *   node scripts/memory-determinism-test.js --iterations=50 --delay=100
 * 
 * Requires: DATABASE_URL in .env
 */

require('dotenv').config();
const memory = require('../db/memory');
const db = require('../db/index');
const crypto = require('crypto');

// Parse CLI args
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.replace('--', '').split('=');
    acc[key] = value;
    return acc;
}, {});

const ITERATIONS = parseInt(args.iterations || '20', 10);
const RECONNECT_DELAY_MS = parseInt(args.delay || '200', 10);
const TEST_USER_PREFIX = 'determinism-test-';

// Generate unique test user for isolation
const testRunId = crypto.randomBytes(4).toString('hex');
const TEST_USER_ID = `${TEST_USER_PREFIX}${testRunId}`;

async function runTest() {
    console.log('\n🧪 Memory Determinism Verification (Sprint 14.2.8.6)\n');
    console.log('='.repeat(70));
    console.log(`  Test User: ${TEST_USER_ID}`);
    console.log(`  Iterations: ${ITERATIONS}`);
    console.log(`  Reconnect Delay: ${RECONNECT_DELAY_MS}ms`);
    console.log('='.repeat(70));

    const results = {
        passed: 0,
        failed: 0,
        retryEngaged: 0,
        timings: []
    };

    try {
        // Get or create test user
        console.log('\n📌 Initializing test user...');
        const { user_id, created } = await memory.getOrCreateUser(TEST_USER_ID);
        console.log(`   User ID: ${user_id.substring(0, 8)}... (created: ${created})`);

        for (let i = 1; i <= ITERATIONS; i++) {
            const iterStart = Date.now();
            const token = `TOKEN_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

            console.log(`\n─── Iteration ${i}/${ITERATIONS} ───`);
            console.log(`   Token: ${token}`);

            // === SESSION A ===
            const sessionA = await memory.startSession(user_id);
            const sessionAHash = sessionA.substring(0, 8);
            console.log(`   Session A: ${sessionAHash}...`);

            // Append message with unique token
            await memory.appendMessage(
                sessionA,
                'user',
                `Remember this token: ${token}`,
                { test: true, iteration: i }
            );
            await memory.appendMessage(
                sessionA,
                'assistant',
                `I will remember the token ${token}. It has been stored in memory.`,
                { test: true, iteration: i }
            );

            // End Session A (ensures summary is committed)
            await memory.endSession(sessionA);
            console.log(`   Session A ended`);

            // === TIGHT RECONNECT ===
            console.log(`   Waiting ${RECONNECT_DELAY_MS}ms...`);
            await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));

            // === SESSION B ===
            const sessionB = await memory.startSession(user_id);
            const sessionBHash = sessionB.substring(0, 8);
            console.log(`   Session B: ${sessionBHash}...`);

            // Get context pack (excludes current session)
            const contextPack = await memory.getContextPack(user_id, sessionB);

            // Verify token is present in transcript
            const transcriptText = contextPack.last_session_transcript
                .map(m => m.content)
                .join(' ');

            const hasToken = transcriptText.includes(token);
            const msgCount = contextPack.last_session_transcript.length;
            const iterDuration = Date.now() - iterStart;

            results.timings.push(iterDuration);

            if (hasToken && msgCount >= 2) {
                results.passed++;
                console.log(`   ✅ PASS: Token found in ${msgCount} messages (${iterDuration}ms)`);
            } else {
                results.failed++;
                console.log(`   ❌ FAIL: Token NOT found. Messages: ${msgCount}`);
                if (msgCount > 0) {
                    console.log(`      First message: "${contextPack.last_session_transcript[0]?.content?.substring(0, 50)}..."`);
                }
            }

            // Clean up Session B
            await memory.endSession(sessionB);
        }

        // === RESULTS SUMMARY ===
        console.log('\n' + '='.repeat(70));
        console.log('📊 RESULTS SUMMARY\n');

        const avgTiming = results.timings.reduce((a, b) => a + b, 0) / results.timings.length;
        const maxTiming = Math.max(...results.timings);
        const minTiming = Math.min(...results.timings);

        console.log(`   Pass Rate: ${results.passed}/${ITERATIONS} (${(results.passed / ITERATIONS * 100).toFixed(1)}%)`);
        console.log(`   Failed: ${results.failed}/${ITERATIONS}`);
        console.log(`   Avg Iteration Time: ${avgTiming.toFixed(0)}ms`);
        console.log(`   Min/Max: ${minTiming}ms / ${maxTiming}ms`);
        console.log(`   Reconnect Delay: ${RECONNECT_DELAY_MS}ms`);

        console.log('\n' + '='.repeat(70));

        if (results.passed === ITERATIONS) {
            console.log('🎉 ALL TESTS PASSED - DETERMINISM VERIFIED\n');
            console.log('   GO ✅ - Safe to promote to canary');
            await db.close();
            process.exit(0);
        } else {
            console.log(`❌ TESTS FAILED - ${results.failed} failures detected\n`);
            console.log('   NO-GO ⛔ - Do not promote');
            await db.close();
            process.exit(1);
        }

    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
        console.error(error.stack);
        await db.close();
        process.exit(1);
    }
}

runTest();
