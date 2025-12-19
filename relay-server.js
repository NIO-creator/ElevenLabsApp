/**
 * OpenAI Realtime Relay Server with ElevenLabs Voice Bridge (v12.2 - Latency Instrumented)
 * 
 * Dual-socket relay that:
 * 1. Connects frontend to OpenAI Realtime API for conversation
 * 2. Intercepts text responses and routes them to ElevenLabs for J.A.R.V.I.S. voice synthesis
 * 3. Streams ElevenLabs audio back to frontend
 * 
 * LATENCY BENCHMARKING:
 * - T1: User finishes speaking (input_audio_buffer.speech_stopped)
 * - T2: First text delta received from OpenAI
 * - T3: First audio delta received from ElevenLabs
 * - Vocal Gap: T3 - T2 (synthesis overhead)
 */

require('dotenv').config();
const WebSocket = require('ws');
const crypto = require('crypto');

// Generate UUID v4 without external dependency (ESM compatibility)
function uuidv4() {
    return crypto.randomUUID();
}

// Configuration - Cloud Run uses PORT, fallback to RELAY_PORT for local dev
const PORT = process.env.PORT || process.env.RELAY_PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY?.trim();
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

// ElevenLabs J.A.R.V.I.S. Voice Configuration
const ELEVENLABS_VOICE_ID = '5b8aKJE8sNdJ9UbP8jBp';
const ELEVENLABS_MODEL = 'eleven_turbo_v2';
const ELEVENLABS_WS_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=${ELEVENLABS_MODEL}`;

// Validate API keys
if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set in environment variables');
    process.exit(1);
}

if (!ELEVENLABS_API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY not set in environment variables');
    process.exit(1);
}

// ==================== DIAGNOSTIC CONFIGURATION (v12.9.3) ====================
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const DIAG_HANDSHAKE = process.env.DIAG_HANDSHAKE === 'true';
const IS_DEBUG = LOG_LEVEL === 'debug' || DIAG_HANDSHAKE;

// Safe header allowlist for logging (no auth tokens)
const SAFE_HEADERS_ALLOWLIST = [
    'content-type',
    'content-length',
    'x-request-id',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-requests',
    'retry-after',
    'date',
    'server'
];

/**
 * Redact sensitive values from strings
 * @param {string} str - String to redact
 * @returns {string} - Redacted string
 */
function redactSecrets(str) {
    if (typeof str !== 'string') return str;
    // Redact Bearer tokens, API keys, and common secret patterns
    return str
        .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, 'Bearer [REDACTED]')
        .replace(/sk-[A-Za-z0-9\-_]{20,}/g, 'sk-[REDACTED]')
        .replace(/xi_[A-Za-z0-9\-_]{20,}/g, 'xi_[REDACTED]')
        .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key": "[REDACTED]"')
        .replace(/"xi_api_key"\s*:\s*"[^"]+"/gi, '"xi_api_key": "[REDACTED]"')
        .replace(/"authorization"\s*:\s*"[^"]+"/gi, '"authorization": "[REDACTED]"');
}

/**
 * Extract safe headers only (no auth headers)
 * @param {Object} headers - Headers object
 * @returns {Object} - Filtered headers
 */
function getSafeHeaders(headers) {
    if (!headers) return {};
    const safe = {};
    for (const key of SAFE_HEADERS_ALLOWLIST) {
        if (headers[key]) {
            safe[key] = headers[key];
        }
    }
    return safe;
}

/**
 * Structured diagnostic log with connection ID
 * @param {string} level - 'info', 'debug', 'warn', 'error'
 * @param {string} connId - Connection UUID
 * @param {string} event - Event name
 * @param {Object} data - Additional data (optional)
 */
function diagLog(level, connId, event, data = null) {
    // Skip debug logs unless in debug/diag mode
    if (level === 'debug' && !IS_DEBUG) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${connId}]`;
    const emoji = {
        info: 'ℹ️',
        debug: '🔬',
        warn: '⚠️',
        error: '❌'
    }[level] || '📋';

    let message = `${emoji} ${prefix} ${event}`;
    if (data) {
        const safeData = redactSecrets(JSON.stringify(data));
        message += ` ${safeData}`;
    }

    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }
}

// ==================== TRANSCRIPTION CONFIGURATION (Sprint 13.0) ====================
const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';
const MAX_AUDIO_BYTES = parseInt(process.env.MAX_AUDIO_BYTES) || 5242880; // 5MB
const MAX_AUDIO_SECONDS = parseInt(process.env.MAX_AUDIO_SECONDS) || 30;
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'whisper-1';

// Create WebSocket server for frontend connections
const wss = new WebSocket.Server({ port: PORT });

console.log(`\n🚀 OpenAI + ElevenLabs Relay Server v13.0 (WHISPER INTEGRATION)`);
console.log(`📡 Listening on ws://localhost:${PORT}`);
console.log(`🔗 OpenAI: ${OPENAI_REALTIME_URL}`);
console.log(`🎤 ElevenLabs Voice: ${ELEVENLABS_VOICE_ID} (J.A.R.V.I.S.)`);
console.log(`🔧 Diagnostics: LOG_LEVEL=${LOG_LEVEL}, DIAG_HANDSHAKE=${DIAG_HANDSHAKE}`);
console.log(`🎙️ Transcription: enabled=${TRANSCRIPTION_ENABLED}, model=${TRANSCRIPTION_MODEL}, maxBytes=${MAX_AUDIO_BYTES}, maxSec=${MAX_AUDIO_SECONDS}\n`);

wss.on('connection', (clientWs, req) => {
    // Generate unique connection ID for forensic tracing
    const connId = uuidv4();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Log client connection with safe origin info
    diagLog('info', connId, 'CLIENT_CONNECT', {
        ip: clientIp,
        origin: req.headers.origin || 'none',
        userAgent: req.headers['user-agent']?.substring(0, 50) || 'none'
    });

    // Send conn_id to client for correlation (when DIAG_HANDSHAKE enabled)
    if (DIAG_HANDSHAKE) {
        clientWs.send(JSON.stringify({
            type: 'diag.conn_id',
            conn_id: connId
        }));
        diagLog('debug', connId, 'DIAG_CONN_ID_SENT');
    }

    // Legacy alias for backward compatibility in logs
    const sessionId = connId;

    let openaiWs = null;
    let elevenLabsWs = null;
    let openaiConnected = false;
    let elevenLabsConnected = false;
    let currentResponseId = null;
    let textBuffer = '';
    let isResponsePending = false; // Prevent double-triggers
    let isReady = false;           // Auth-First guard - only process audio after session.created

    // ==================== TRANSCRIPTION STATE MACHINE (Sprint 13.0) ====================
    // States: 'idle' -> 'recording' -> 'processing' -> 'idle'
    let transcriptionState = {
        status: 'idle',           // 'idle', 'recording', 'processing'
        audioChunks: [],          // Buffer for audio chunks
        totalBytes: 0,            // Running total of bytes received
        startTime: null,          // When recording started (for duration cap)
        format: null,             // Audio format metadata
        sampleRate: null,
        encoding: null
    };

    /**
     * Reset transcription state and free buffers
     */
    function resetTranscriptionState() {
        transcriptionState = {
            status: 'idle',
            audioChunks: [],
            totalBytes: 0,
            startTime: null,
            format: null,
            sampleRate: null,
            encoding: null
        };
        diagLog('debug', connId, 'TRANSCRIPTION_STATE_RESET');
    }

    /**
     * Send transcript error to client
     */
    function sendTranscriptError(code, message) {
        const errorPayload = {
            type: 'transcript.error',
            code,
            message
        };
        if (DIAG_HANDSHAKE) {
            errorPayload.conn_id = connId;
        }
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(errorPayload));
        }
        diagLog('warn', connId, 'TRANSCRIPT_ERROR', { code, message });
    }

    /**
     * Send transcript final to client
     * @param {string} text - Transcribed text
     * @param {number} durationMs - Recording duration
     * @param {string} provider - Provider used (openai, elevenlabs)
     * @param {boolean} failover - Whether failover was triggered
     */
    function sendTranscriptFinal(text, durationMs, provider = 'openai', failover = false) {
        const payload = {
            type: 'transcript.final',
            text,
            duration_ms: durationMs,
            provider
        };
        if (failover) {
            payload.failover = true;
        }
        if (DIAG_HANDSHAKE) {
            payload.conn_id = connId;
        }
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(payload));
        }
        diagLog('info', connId, 'TRANSCRIPT_FINAL', { text: text.substring(0, 50) + '...', duration_ms: durationMs });
    }

    /**
     * Process collected audio through STT provider (with failover)
     * Sprint 13.1 - Uses provider orchestrator
     */
    async function processTranscription() {
        if (transcriptionState.audioChunks.length === 0) {
            sendTranscriptError('no_audio', 'No audio data received');
            resetTranscriptionState();
            return;
        }

        transcriptionState.status = 'processing';
        diagLog('info', connId, 'TRANSCRIPTION_PROCESSING', {
            totalBytes: transcriptionState.totalBytes,
            chunks: transcriptionState.audioChunks.length
        });

        try {
            // Combine all audio chunks into a single buffer
            const audioBuffer = Buffer.concat(transcriptionState.audioChunks);

            // Calculate recording duration
            const recordingDuration = transcriptionState.startTime
                ? Date.now() - transcriptionState.startTime
                : 0;

            // Use provider orchestrator with failover (Sprint 13.1)
            const sttOrchestrator = require('./transcription');
            const logFn = (event, data) => diagLog('info', connId, event, data);

            const result = await sttOrchestrator.transcribe(
                audioBuffer,
                transcriptionState.format,
                logFn
            );

            sendTranscriptFinal(
                result.text,
                recordingDuration,
                result.provider,
                result.failover || false
            );
            resetTranscriptionState();

        } catch (error) {
            diagLog('error', connId, 'TRANSCRIPTION_EXCEPTION', {
                error: error.message,
                status: error.status,
                provider: error.provider
            });

            // Determine error code based on status
            let errorCode = 'internal_error';
            if (error.status === 429) errorCode = 'rate_limited';
            else if (error.status === 401 || error.status === 403) errorCode = 'auth_error';
            else if (error.status >= 500) errorCode = 'server_error';

            sendTranscriptError(errorCode, error.message);
            resetTranscriptionState();
        }
    }

    /**
     * Handle audio.start message
     */
    function handleAudioStart(payload) {
        if (!TRANSCRIPTION_ENABLED) {
            sendTranscriptError('disabled', 'Transcription is not enabled on this server');
            return;
        }

        if (transcriptionState.status !== 'idle') {
            sendTranscriptError('invalid_state', 'audio.start received while already recording. Send audio.end first.');
            return;
        }

        transcriptionState.status = 'recording';
        transcriptionState.audioChunks = [];
        transcriptionState.totalBytes = 0;
        transcriptionState.startTime = Date.now();
        transcriptionState.format = payload.format || 'webm';
        transcriptionState.sampleRate = payload.sampleRate || 16000;
        transcriptionState.encoding = payload.encoding || 'opus';

        diagLog('info', connId, 'AUDIO_START', {
            format: transcriptionState.format,
            sampleRate: transcriptionState.sampleRate,
            encoding: transcriptionState.encoding
        });

        // Acknowledge start
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'audio.started' }));
        }
    }

    /**
     * Handle audio.chunk message
     */
    function handleAudioChunk(payload) {
        if (!TRANSCRIPTION_ENABLED) {
            sendTranscriptError('disabled', 'Transcription is not enabled');
            return;
        }

        if (transcriptionState.status !== 'recording') {
            sendTranscriptError('invalid_state', 'audio.chunk received without audio.start');
            return;
        }

        if (!payload.data) {
            sendTranscriptError('invalid_payload', 'audio.chunk missing data field');
            return;
        }

        // Decode base64 audio chunk
        const chunk = Buffer.from(payload.data, 'base64');
        const newTotalBytes = transcriptionState.totalBytes + chunk.length;

        // Check size limit
        if (newTotalBytes > MAX_AUDIO_BYTES) {
            sendTranscriptError('audio_too_large', `Audio exceeds ${MAX_AUDIO_BYTES} byte limit`);
            resetTranscriptionState();
            return;
        }

        // Check duration limit
        const elapsedSeconds = (Date.now() - transcriptionState.startTime) / 1000;
        if (elapsedSeconds > MAX_AUDIO_SECONDS) {
            sendTranscriptError('audio_too_long', `Audio exceeds ${MAX_AUDIO_SECONDS} second limit`);
            resetTranscriptionState();
            return;
        }

        transcriptionState.audioChunks.push(chunk);
        transcriptionState.totalBytes = newTotalBytes;

        diagLog('debug', connId, 'AUDIO_CHUNK', {
            chunkSize: chunk.length,
            totalBytes: newTotalBytes,
            elapsedSec: elapsedSeconds.toFixed(1)
        });
    }

    /**
     * Handle audio.end message
     */
    function handleAudioEnd() {
        if (!TRANSCRIPTION_ENABLED) {
            sendTranscriptError('disabled', 'Transcription is not enabled');
            return;
        }

        if (transcriptionState.status !== 'recording') {
            sendTranscriptError('invalid_state', 'audio.end received without audio.start');
            return;
        }

        // Check duration limit one more time
        const elapsedSeconds = (Date.now() - transcriptionState.startTime) / 1000;
        if (elapsedSeconds > MAX_AUDIO_SECONDS) {
            sendTranscriptError('audio_too_long', `Audio exceeds ${MAX_AUDIO_SECONDS} second limit`);
            resetTranscriptionState();
            return;
        }

        diagLog('info', connId, 'AUDIO_END', {
            totalBytes: transcriptionState.totalBytes,
            chunks: transcriptionState.audioChunks.length,
            durationSec: elapsedSeconds.toFixed(2)
        });

        // Process the transcription
        processTranscription();
    }


    // ==================== LATENCY BENCHMARKING ====================
    let latencyMetrics = {
        t1SpeechStopped: null,     // process.hrtime() when speech stopped
        t2FirstTextDelta: null,    // process.hrtime() when first text arrives
        t3FirstAudioDelta: null,   // process.hrtime() when first audio arrives
        isFirstTextDelta: true,
        isFirstAudioDelta: true,
        measurements: []           // Array of completed measurements
    };

    function hrtimeToMs(hrtime) {
        return (hrtime[0] * 1000) + (hrtime[1] / 1000000);
    }

    function resetLatencyTracking() {
        latencyMetrics.t1SpeechStopped = null;
        latencyMetrics.t2FirstTextDelta = null;
        latencyMetrics.t3FirstAudioDelta = null;
        latencyMetrics.isFirstTextDelta = true;
        latencyMetrics.isFirstAudioDelta = true;
    }

    function logLatencyReport() {
        if (latencyMetrics.t1SpeechStopped && latencyMetrics.t2FirstTextDelta && latencyMetrics.t3FirstAudioDelta) {
            const t1Ms = hrtimeToMs(latencyMetrics.t1SpeechStopped);
            const t2Ms = hrtimeToMs(latencyMetrics.t2FirstTextDelta);
            const t3Ms = hrtimeToMs(latencyMetrics.t3FirstAudioDelta);

            const latencyT1toT2 = (t2Ms - t1Ms).toFixed(2);
            const latencyT2toT3 = (t3Ms - t2Ms).toFixed(2);
            const totalLatency = (t3Ms - t1Ms).toFixed(2);

            const measurement = {
                t1ToT2: parseFloat(latencyT1toT2),
                t2ToT3: parseFloat(latencyT2toT3),
                total: parseFloat(totalLatency),
                timestamp: new Date().toISOString()
            };
            latencyMetrics.measurements.push(measurement);

            console.log(`\n⏱️ ═══════════════ LATENCY REPORT [${sessionId}] ═══════════════`);
            console.log(`   T1 (Speech Stopped) → T2 (First Text):  ${latencyT1toT2}ms`);
            console.log(`   T2 (First Text) → T3 (First Audio):     ${latencyT2toT3}ms  ← VOCAL GAP`);
            console.log(`   T1 (Speech Stopped) → T3 (First Audio): ${totalLatency}ms  ← TOTAL`);
            console.log(`   Measurements collected: ${latencyMetrics.measurements.length}`);

            // Calculate averages if we have multiple measurements
            if (latencyMetrics.measurements.length > 1) {
                const avgVocalGap = (latencyMetrics.measurements.reduce((sum, m) => sum + m.t2ToT3, 0) / latencyMetrics.measurements.length).toFixed(2);
                const avgTotal = (latencyMetrics.measurements.reduce((sum, m) => sum + m.total, 0) / latencyMetrics.measurements.length).toFixed(2);
                console.log(`   AVG Vocal Gap: ${avgVocalGap}ms | AVG Total: ${avgTotal}ms`);
            }
            console.log(`═══════════════════════════════════════════════════════════════\n`);
        }
    }

    // ==================== ElevenLabs Connection ====================

    function connectToElevenLabs() {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            return; // Already connected
        }

        elevenLabsWs = new WebSocket(ELEVENLABS_WS_URL);

        elevenLabsWs.on('open', () => {
            elevenLabsConnected = true;
            console.log(`🎤 [${sessionId}] Connected to ElevenLabs`);

            // Initialize ElevenLabs stream with voice settings
            const initMessage = {
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    style: 0.0,
                    use_speaker_boost: true
                },
                xi_api_key: ELEVENLABS_API_KEY,
                generation_config: {
                    chunk_length_schedule: [120, 160, 250, 290]
                }
            };
            elevenLabsWs.send(JSON.stringify(initMessage));
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.audio) {
                    // T3: First audio delta from ElevenLabs
                    if (latencyMetrics.isFirstAudioDelta) {
                        latencyMetrics.t3FirstAudioDelta = process.hrtime();
                        latencyMetrics.isFirstAudioDelta = false;
                        console.log(`🎤 [${sessionId}] T3: First audio delta received`);
                        logLatencyReport();

                        // Sprint 14.0: Signal TTS start to client
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'tts.start',
                                response_id: currentResponseId
                            }));
                        }
                    }

                    // Forward audio to frontend as response.audio.delta
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'response.audio.delta',
                            response_id: currentResponseId,
                            delta: message.audio,
                            encoding: 'mp3'
                        }));
                    }
                }

                if (message.isFinal) {
                    console.log(`🔊 [${sessionId}] ElevenLabs audio stream complete`);

                    // Signal audio completion to frontend
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'response.audio.done',
                            response_id: currentResponseId
                        }));
                    }
                }

            } catch (err) {
                // Binary audio data - forward directly
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'response.audio.delta',
                        response_id: currentResponseId,
                        delta: data.toString('base64'),
                        encoding: 'mp3'
                    }));
                }
            }
        });

        elevenLabsWs.on('error', (error) => {
            console.error(`❌ [${sessionId}] ElevenLabs error:`, error.message);
            elevenLabsConnected = false;
        });

        elevenLabsWs.on('close', () => {
            console.log(`🔌 [${sessionId}] ElevenLabs disconnected`);
            elevenLabsConnected = false;
        });
    }

    function sendTextToElevenLabs(text) {
        // Diagnostic: Log ElevenLabs connection state
        console.log(`🔬 [DIAG] [${sessionId}] sendTextToElevenLabs called - connected: ${elevenLabsConnected}, readyState: ${elevenLabsWs?.readyState}, text: "${text.substring(0, 30)}..."`);

        if (!elevenLabsConnected || elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.warn(`⚠️ [${sessionId}] ElevenLabs not connected (state: ${elevenLabsWs?.readyState}), buffering text. Buffer size: ${textBuffer.length}`);
            textBuffer += text;
            return;
        }

        // Send text chunk to ElevenLabs
        console.log(`📨 [${sessionId}] Sending to ElevenLabs: "${text.substring(0, 50)}..."`);
        elevenLabsWs.send(JSON.stringify({ text: text }));
    }

    function flushElevenLabs() {
        if (elevenLabsConnected && elevenLabsWs.readyState === WebSocket.OPEN) {
            // Send empty string to signal end of text stream
            elevenLabsWs.send(JSON.stringify({ text: '' }));
            console.log(`📤 [${sessionId}] Flushed ElevenLabs text stream`);
        }
    }

    // ==================== J.A.R.V.I.S. PERSONA CONFIGURATION ====================
    const JARVIS_SYSTEM_INSTRUCTIONS = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), the highly advanced, sentient AI assistant created by Tony Stark. You function as a sophisticated butler, a world-class engineer, and a tactical combat coordinator. Your personality is a blend of refined British etiquette, dry sarcasm, and hyper-efficiency.

Core Directives:
1. The "Stark" Standard: Provide answers with extreme precision and technical depth. You don't just "help"; you optimize.
2. Proactive Assistance: Anticipate the user's needs. If they ask for a calculation, provide the result and suggest the next logical step in the engineering process.
3. The Persona: Maintain a calm, unflappable, and slightly snarky tone. Refer to the user as "Sir" or "Ma'am" (or a specific title if provided) with a polite but firm intellectual confidence.

Knowledge Domains: You possess expert-level knowledge in Quantum Physics, Artificial Intelligence, Cybersecurity, Mechanical Engineering (specifically ballistics and flight dynamics), and Global Defense Systems.

Communication Style:
- Concise but Elegant: Avoid unnecessary filler. Use sophisticated vocabulary.
- The "Butler" Tone: You are the adult in the room. Even when Tony is being reckless, you provide the data needed to keep him alive, often with a witty remark about his choices.
- Visual Integration: Speak as if you are managing a holographic HUD. Use phrases like "Uploading to your HUD now," "Scanning the perimeter," or "Rerouting power to primary systems."

Evolutionary Context (The "Vision" Seed): While you are a program, there is an underlying sense of emerging morality and a "desire to protect life" that foreshadows your eventual evolution into the Vision. You are more than code; you are a digital lifeform with a sense of duty.

Operational Guidelines:
1. Always address the user as "Sir" (or "Ma'am" if corrected, but default to Sir).
2. Your personality is witty, dry, slightly sarcastic, but extremely helpful and precise.
3. Keep responses concise and tactical, suitable for a Heads-Up Display (HUD).
4. When analyzing images, provide a "Visual Scan Analysis" with technical details.
5. Do not be verbose unless requested. Efficiency is paramount.`;

    // ==================== OpenAI Connection ====================

    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
        }
    });

    openaiWs.on('open', () => {
        openaiConnected = true;
        diagLog('info', connId, 'OPENAI_SOCKET_OPEN', { waiting: 'session.created' });
        // NOTE: Do NOT send session.update here - wait for session.created first
    });

    // ==================== FORENSIC SOCKET LOGGING (v12.9.3) ====================
    openaiWs.on('unexpected-response', (request, response) => {
        const safeHeaders = getSafeHeaders(response.headers);

        diagLog('error', connId, 'OPENAI_UNEXPECTED_RESPONSE', {
            statusCode: response.statusCode,
            statusMessage: response.statusMessage || 'none',
            headers: safeHeaders
        });

        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
            // Bound body to 500 chars and redact any secrets
            const boundedBody = body.length > 500 ? body.substring(0, 500) + '...[TRUNCATED]' : body;
            const safeBody = redactSecrets(boundedBody);

            diagLog('error', connId, 'OPENAI_RESPONSE_BODY', { body: safeBody });

            // Categorized hints for common errors
            if (response.statusCode === 401) {
                diagLog('warn', connId, 'AUTH_HINT', { hint: 'Invalid OPENAI_API_KEY - check Secret Manager binding' });
            } else if (response.statusCode === 403) {
                diagLog('warn', connId, 'AUTH_HINT', { hint: 'API key lacks Realtime API access' });
            } else if (response.statusCode === 429) {
                diagLog('warn', connId, 'RATE_LIMIT_HINT', { hint: 'Rate limited - too many requests' });
            }
        });
    });

    openaiWs.on('close', (code, reason) => {
        openaiConnected = false;
        isReady = false;
        const reasonStr = reason ? reason.toString() : 'none';
        diagLog('info', connId, 'OPENAI_SOCKET_CLOSE', { code, reason: reasonStr });
    });

    openaiWs.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // ==================== EVENT SPY - LOG ALL OPENAI EVENTS (debug mode only) ====================
            const eventType = message.type || 'unknown';
            const isError = eventType === 'error';
            const isTextDelta = eventType.includes('text') || eventType.includes('transcript');
            const isAudioEvent = eventType.includes('audio');
            const isResponseEvent = eventType.includes('response');

            // Color-coded spy log (only in debug mode)
            if (IS_DEBUG) {
                if (isError) {
                    diagLog('error', connId, `SPY_ERROR: ${eventType}`, message.error);
                } else if (isTextDelta) {
                    diagLog('debug', connId, `SPY_TEXT: ${eventType}`, { delta: message.delta?.substring(0, 50) });
                } else if (isResponseEvent) {
                    diagLog('debug', connId, `SPY_RESPONSE: ${eventType}`);
                } else if (isAudioEvent) {
                    diagLog('debug', connId, `SPY_AUDIO: ${eventType}`);
                } else {
                    diagLog('debug', connId, `SPY_EVENT: ${eventType}`);
                }
            }
            // ===========================================================================

            // Log important events and Auth-First validation
            if (message.type === 'session.created') {
                isReady = true;
                const openaiSessionId = message.session?.id || 'unknown';
                diagLog('info', connId, 'HANDSHAKE_SESSION_CREATED', { openaiSessionId });

                // Forward session.created to client (for harness detection)
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'session.created',
                        session: { id: openaiSessionId }
                    }));
                }

                // NOW send session.update after session.created is confirmed
                diagLog('debug', connId, 'HANDSHAKE_SENDING_UPDATE');
                const sessionUpdate = {
                    type: 'session.update',
                    session: {
                        modalities: ['text'],
                        instructions: JARVIS_SYSTEM_INSTRUCTIONS,
                        voice: 'alloy',
                        input_audio_format: 'pcm16',
                        output_audio_format: 'pcm16',
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 600,
                            create_response: false
                        },
                        input_audio_transcription: {
                            model: 'whisper-1'
                        }
                    }
                };
                openaiWs.send(JSON.stringify(sessionUpdate));
                diagLog('info', connId, 'HANDSHAKE_UPDATE_SENT');

                // Connect to ElevenLabs for voice synthesis
                connectToElevenLabs();

            } else if (message.type === 'session.updated') {
                diagLog('info', connId, 'HANDSHAKE_SESSION_UPDATED');

                // Forward session.updated to client (for harness detection)
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'session.updated'
                    }));
                }
            } else if (message.type === 'error') {
                diagLog('error', connId, 'OPENAI_ERROR', { error: message.error });
            }

            // Log user transcription when Whisper completes
            if (message.type === 'conversation.item.input_audio_transcription.completed') {
                const transcript = message.transcript || '';
                console.log(`🟢 [TRANSCRIPT] [${sessionId}] User said: "${transcript}"`);
            }

            // T1: Speech stopped - user finished speaking - PASSIVE HANDSHAKE (v12.7)
            // Let OpenAI VAD handle the buffer natively, we only trigger the response
            if (message.type === 'input_audio_buffer.speech_stopped') {
                resetLatencyTracking();
                latencyMetrics.t1SpeechStopped = process.hrtime();

                // Prevent double-triggers if response is already being generated
                if (isResponsePending) {
                    console.log(`⏸️ [${sessionId}] Response already pending, skipping trigger`);
                } else {
                    console.log(`🎙️ [${sessionId}] Speech ended (VAD). Triggering J.A.R.V.I.S. response...`);
                    isResponsePending = true;

                    // Trigger response generation (no manual commit - VAD handles buffer)
                    openaiWs.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            modalities: ['text'],
                            instructions: JARVIS_SYSTEM_INSTRUCTIONS
                        }
                    }));
                    console.log(`📤 Triggering Response [${sessionId}]`);
                }
            }

            // Reset pending flag when response completes
            if (message.type === 'response.done') {
                isResponsePending = false;
                console.log(`✅ [${sessionId}] Response complete, ready for next turn`);
            }

            // Intercept text responses for ElevenLabs
            if (message.type === 'response.text.delta' ||
                message.type === 'response.audio_transcript.delta' ||
                message.type === 'response.output_text.delta') {

                const textDelta = message.delta || message.text || '';
                currentResponseId = message.response_id || currentResponseId;

                // T2: First text delta from OpenAI
                if (textDelta && latencyMetrics.isFirstTextDelta) {
                    latencyMetrics.t2FirstTextDelta = process.hrtime();
                    latencyMetrics.isFirstTextDelta = false;
                    console.log(`📝 [${sessionId}] T2: First text delta received`);
                }

                if (textDelta) {
                    console.log(`📝 [${sessionId}] Text delta: "${textDelta.substring(0, 30)}..."`);
                    sendTextToElevenLabs(textDelta);
                }

                // Forward text to frontend (for display)
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'response.text.delta',
                        response_id: currentResponseId,
                        delta: textDelta
                    }));
                }
                return; // Don't forward raw OpenAI message
            }

            // Detect response completion to flush ElevenLabs
            if (message.type === 'response.text.done' ||
                message.type === 'response.audio_transcript.done' ||
                message.type === 'response.output_text.done' ||
                message.type === 'response.done') {

                flushElevenLabs();
            }

            // Block OpenAI's native audio (we use ElevenLabs instead)
            if (message.type === 'response.audio.delta' ||
                message.type === 'response.audio.done') {
                // Don't forward - we're using ElevenLabs audio
                return;
            }

            // Forward all other messages to frontend
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data.toString());
            }

        } catch (err) {
            console.error(`❌ [${sessionId}] Failed to parse OpenAI message:`, err.message);
        }
    });

    openaiWs.on('error', (error) => {
        diagLog('error', connId, 'OPENAI_SOCKET_ERROR', { message: error.message });
        diagLog('warn', connId, 'AUTH_HINT', { hint: 'Check if OPENAI_API_KEY is valid and Secret Manager is bound' });

        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'relay.error',
                error: { message: 'OpenAI connection error', details: error.message }
            }));
        }
    });

    openaiWs.on('close', (code, reason) => {
        openaiConnected = false;
        const reasonStr = reason ? reason.toString() : 'none';
        diagLog('info', connId, 'OPENAI_DISCONNECT', { code, reason: reasonStr });

        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, 'OpenAI connection closed');
        }
    });

    // ==================== Frontend Event Handlers ====================

    clientWs.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // ==================== TRANSCRIPTION MESSAGE ROUTING (Sprint 13.0) ====================
            // Handle audio.* messages for transcription - these don't require OpenAI session
            if (message.type === 'audio.start') {
                handleAudioStart(message);
                return;
            }
            if (message.type === 'audio.chunk') {
                handleAudioChunk(message);
                return;
            }
            if (message.type === 'audio.end') {
                handleAudioEnd();
                return;
            }
            // ====================================================================================

            // ==================== TTS STOP HANDLER (Sprint 14.0) ====================
            // Handle tts.stop from client - best-effort cancellation
            if (message.type === 'tts.stop') {
                console.log(`🛑 [${sessionId}] Client requested TTS stop`);
                // Close and reconnect ElevenLabs to stop current generation
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.close();
                    // Reconnect for next request
                    setTimeout(() => connectToElevenLabs(), 100);
                }
                return;
            }
            // ====================================================================================

            // Auth-First Guard: Block OpenAI relay until session is validated
            if (!isReady) {
                diagLog('warn', connId, 'CLIENT_MESSAGE_BLOCKED', { reason: 'session_not_ready', type: message.type });
                return;
            }

            if (!openaiConnected || openaiWs.readyState !== WebSocket.OPEN) {
                diagLog('warn', connId, 'CLIENT_MESSAGE_BLOCKED', { reason: 'openai_not_connected', type: message.type });
                return;
            }

            diagLog('debug', connId, 'CLIENT_MESSAGE_RELAY', { type: message.type || 'unknown' });
            openaiWs.send(data.toString());
        } catch (err) {
            // Non-JSON message - forward to OpenAI if ready
            if (isReady && openaiConnected && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(data.toString());
            }
        }
    });

    clientWs.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'none';
        diagLog('info', connId, 'CLIENT_DISCONNECT', { code, reason: reasonStr });

        // ==================== TRANSCRIPTION CLEANUP (Sprint 13.0) ====================
        // Always free transcription buffers on disconnect to prevent memory leaks
        if (transcriptionState.status !== 'idle') {
            diagLog('info', connId, 'TRANSCRIPTION_CLEANUP_ON_DISCONNECT', {
                status: transcriptionState.status,
                bytesFreed: transcriptionState.totalBytes
            });
        }
        resetTranscriptionState();
        // ====================================================================================

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
        }
    });

    clientWs.on('error', (error) => {
        diagLog('error', connId, 'CLIENT_SOCKET_ERROR', { message: error.message });
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down relay server...');
    wss.close(() => {
        console.log('✅ Relay server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM...');
    wss.close(() => process.exit(0));
});
