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

// Create WebSocket server for frontend connections
const wss = new WebSocket.Server({ port: PORT });

console.log(`\n🚀 OpenAI + ElevenLabs Relay Server v12.1`);
console.log(`📡 Listening on ws://localhost:${PORT}`);
console.log(`🔗 OpenAI: ${OPENAI_REALTIME_URL}`);
console.log(`🎤 ElevenLabs Voice: ${ELEVENLABS_VOICE_ID} (J.A.R.V.I.S.)\n`);

wss.on('connection', (clientWs, req) => {
    const sessionId = uuidv4();
    console.log(`✅ [${sessionId}] Frontend connected from ${req.socket.remoteAddress}`);

    let openaiWs = null;
    let elevenLabsWs = null;
    let openaiConnected = false;
    let elevenLabsConnected = false;
    let currentResponseId = null;
    let textBuffer = '';

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
        if (!elevenLabsConnected || elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.warn(`⚠️ [${sessionId}] ElevenLabs not connected, buffering text`);
            textBuffer += text;
            return;
        }

        // Send text chunk to ElevenLabs
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
        console.log(`🔗 [${sessionId}] Connected to OpenAI Realtime API`);

        // Send session.update with J.A.R.V.I.S. persona and tuned VAD
        const sessionUpdate = {
            type: 'session.update',
            session: {
                modalities: ['text'], // Text only - we use ElevenLabs for audio
                instructions: JARVIS_SYSTEM_INSTRUCTIONS,
                voice: 'alloy', // Required field but won't be used
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,           // Filter background noise
                    prefix_padding_ms: 300,
                    silence_duration_ms: 600  // Natural breathing room
                }
            }
        };
        openaiWs.send(JSON.stringify(sessionUpdate));
        console.log(`🛡️ J.A.R.V.I.S. Protocol Engaged: Persona Locked`);
        console.log(`⚙️ [${sessionId}] VAD tuned: threshold=0.5, silence=600ms`);

        // Connect to ElevenLabs for voice synthesis
        connectToElevenLabs();
    });

    openaiWs.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // Log important events
            if (message.type === 'session.created') {
                console.log(`🎉 [${sessionId}] OpenAI session created:`, message.session?.id || 'unknown');
            } else if (message.type === 'session.updated') {
                console.log(`⚙️ [${sessionId}] OpenAI session updated`);
            } else if (message.type === 'error') {
                console.error(`❌ [${sessionId}] OpenAI error:`, message.error);
            }

            // T1: Speech stopped - user finished speaking
            if (message.type === 'input_audio_buffer.speech_stopped') {
                resetLatencyTracking();
                latencyMetrics.t1SpeechStopped = process.hrtime();
                console.log(`🎙️ [${sessionId}] T1: Speech stopped detected`);
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
        console.error(`❌ [${sessionId}] OpenAI error:`, error.message);

        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'relay.error',
                error: { message: 'OpenAI connection error', details: error.message }
            }));
        }
    });

    openaiWs.on('close', (code, reason) => {
        openaiConnected = false;
        console.log(`🔌 [${sessionId}] OpenAI disconnected: ${code}`);

        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, 'OpenAI connection closed');
        }
    });

    // ==================== Frontend Event Handlers ====================

    clientWs.on('message', (data) => {
        if (!openaiConnected || openaiWs.readyState !== WebSocket.OPEN) {
            console.warn(`⚠️ [${sessionId}] Cannot forward - OpenAI not connected`);
            return;
        }

        try {
            const message = JSON.parse(data.toString());
            console.log(`📤 [${sessionId}] Relaying to OpenAI:`, message.type || 'unknown');
            openaiWs.send(data.toString());
        } catch (err) {
            openaiWs.send(data.toString());
        }
    });

    clientWs.on('close', (code, reason) => {
        console.log(`👋 [${sessionId}] Frontend disconnected: ${code}`);

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
        }
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
        }
    });

    clientWs.on('error', (error) => {
        console.error(`❌ [${sessionId}] Frontend error:`, error.message);
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
