#!/usr/bin/env node
/**
 * Transcription Test Harness (Sprint 13.0)
 * 
 * Tests the Whisper transcription pipeline via WebSocket.
 * 
 * Usage:
 *   node scripts/transcribe-test.js [audio-file]
 *   node scripts/transcribe-test.js sample.webm
 *   node scripts/transcribe-test.js --test-limits   # Test size/time caps
 * 
 * Requirements:
 *   - Relay server running (npm run relay)
 *   - TRANSCRIPTION_ENABLED=true in .env
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Configuration
const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8080';
const CHUNK_SIZE = 32 * 1024; // 32KB chunks
const TEST_MODE = process.argv.includes('--test-limits');
const AUDIO_FILE = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : null;

console.log('\n🎙️ Transcription Test Harness v13.0');
console.log(`📡 Relay: ${RELAY_URL}`);
console.log(`📁 Audio: ${AUDIO_FILE || '(generating test data)'}`);
console.log(`🧪 Test Mode: ${TEST_MODE ? 'LIMITS' : 'NORMAL'}\n`);

// Connect to relay
const ws = new WebSocket(RELAY_URL);
let startTime = null;

ws.on('open', () => {
    console.log('✅ Connected to relay');

    if (TEST_MODE) {
        runLimitsTest();
    } else if (AUDIO_FILE) {
        sendAudioFile(AUDIO_FILE);
    } else {
        sendTestAudio();
    }
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'audio.started') {
            console.log('📤 Server acknowledged audio.start');
        } else if (msg.type === 'transcript.final') {
            const elapsed = startTime ? Date.now() - startTime : 0;
            console.log('\n🟢 TRANSCRIPT RECEIVED');
            console.log(`   Text: "${msg.text}"`);
            console.log(`   Duration: ${msg.duration_ms}ms`);
            console.log(`   Roundtrip: ${elapsed}ms`);
            if (msg.conn_id) console.log(`   Conn ID: ${msg.conn_id}`);
            console.log('\n✅ TEST PASSED\n');
            ws.close();
            process.exit(0);
        } else if (msg.type === 'transcript.error') {
            console.log('\n🔴 TRANSCRIPT ERROR');
            console.log(`   Code: ${msg.code}`);
            console.log(`   Message: ${msg.message}`);
            if (msg.conn_id) console.log(`   Conn ID: ${msg.conn_id}`);

            // In limits test, error is expected
            if (TEST_MODE && (msg.code === 'audio_too_large' || msg.code === 'audio_too_long')) {
                console.log('\n✅ LIMITS TEST PASSED (error expected)\n');
                ws.close();
                process.exit(0);
            } else {
                console.log('\n❌ TEST FAILED\n');
                ws.close();
                process.exit(1);
            }
        } else if (msg.type === 'diag.conn_id') {
            console.log(`🔬 Conn ID: ${msg.conn_id}`);
        } else {
            console.log(`📨 ${msg.type}:`, JSON.stringify(msg).substring(0, 100));
        }
    } catch (e) {
        console.log('📨 Non-JSON:', data.toString().substring(0, 100));
    }
});

ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
    process.exit(1);
});

ws.on('close', (code) => {
    console.log(`🔌 Disconnected (code: ${code})`);
});

/**
 * Send a real audio file
 */
function sendAudioFile(filePath) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        console.error(`❌ File not found: ${resolvedPath}`);
        process.exit(1);
    }

    const audioBuffer = fs.readFileSync(resolvedPath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    // Explicit format mapping - fail fast for unsupported
    const FORMAT_MAP = {
        'webm': { format: 'webm', encoding: 'opus', mime: 'audio/webm' },
        'wav': { format: 'wav', encoding: 'pcm', mime: 'audio/wav' },
        'mp3': { format: 'mp3', encoding: 'mp3', mime: 'audio/mpeg' }
    };

    if (!FORMAT_MAP[ext]) {
        console.error(`❌ Unsupported audio format: .${ext}`);
        console.error('   Supported: .webm, .wav, .mp3');
        ws.close();
        process.exit(1);
    }

    const audioConfig = FORMAT_MAP[ext];
    console.log(`📂 Loaded ${audioBuffer.length} bytes (${audioConfig.format}, ${audioConfig.mime})`);

    // Send audio.start
    ws.send(JSON.stringify({
        type: 'audio.start',
        format: audioConfig.format,
        sampleRate: 16000,
        encoding: audioConfig.encoding
    }));

    startTime = Date.now();

    // Send chunks
    let offset = 0;
    let chunkNum = 0;

    function sendNextChunk() {
        if (offset >= audioBuffer.length) {
            // All chunks sent, send audio.end
            console.log(`📤 Sent ${chunkNum} chunks, sending audio.end`);
            ws.send(JSON.stringify({ type: 'audio.end' }));
            return;
        }

        const chunk = audioBuffer.slice(offset, offset + CHUNK_SIZE);
        ws.send(JSON.stringify({
            type: 'audio.chunk',
            data: chunk.toString('base64')
        }));

        offset += chunk.length;
        chunkNum++;

        // Small delay between chunks to simulate streaming
        setTimeout(sendNextChunk, 10);
    }

    sendNextChunk();
}

/**
 * Send minimal test audio (silence)
 */
function sendTestAudio() {
    console.log('📤 Sending minimal test audio...');

    // Create a minimal valid WebM file header (this is a stub - real test needs real audio)
    // For proper testing, use a real audio file
    const testData = Buffer.alloc(1024); // 1KB of zeros (silence)

    ws.send(JSON.stringify({
        type: 'audio.start',
        format: 'webm',
        sampleRate: 16000,
        encoding: 'opus'
    }));

    startTime = Date.now();

    setTimeout(() => {
        ws.send(JSON.stringify({
            type: 'audio.chunk',
            data: testData.toString('base64')
        }));

        setTimeout(() => {
            ws.send(JSON.stringify({ type: 'audio.end' }));
            console.log('📤 audio.end sent, waiting for transcript...');
        }, 100);
    }, 100);
}

/**
 * Test size/time limits
 */
function runLimitsTest() {
    console.log('🧪 Running limits test (sending oversized audio)...');

    ws.send(JSON.stringify({
        type: 'audio.start',
        format: 'webm',
        sampleRate: 16000,
        encoding: 'opus'
    }));

    // Send 6MB of data (exceeds 5MB default limit)
    const bigChunk = Buffer.alloc(1024 * 1024); // 1MB chunk
    let sent = 0;

    function sendBigChunk() {
        if (sent >= 6) {
            // Should have errored by now
            console.log('⚠️ Sent 6MB without error - limit may be disabled');
            ws.send(JSON.stringify({ type: 'audio.end' }));
            return;
        }

        ws.send(JSON.stringify({
            type: 'audio.chunk',
            data: bigChunk.toString('base64')
        }));

        sent++;
        console.log(`📤 Sent ${sent}MB...`);

        setTimeout(sendBigChunk, 50);
    }

    sendBigChunk();
}

// Timeout safety
setTimeout(() => {
    console.error('⏱️ Test timed out after 30 seconds');
    ws.close();
    process.exit(1);
}, 30000);
