/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VoiceHandler.js - Realtime Audio Capture & Playback (v14.0 - MSE Streaming)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Handles bidirectional audio streaming with OpenAI's Realtime API via
 * a local WebSocket relay server. Features:
 * - 24kHz mono microphone capture
 * - PCM16 Base64 encoding for transmission
 * - MSE-based MP3 streaming playback (Sprint 14.0)
 * - Mute/Stop playback controls
 * - J.A.R.V.I.S. persona injection
 * - Server VAD turn detection
 */

import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import StreamingAudioPlayer from './StreamingAudioPlayer';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const RELAY_SERVER_URL = 'wss://jarvis-relay-794024916030.europe-west1.run.app';
const SAMPLE_RATE = 24000; // 24kHz as required by OpenAI
const CHANNELS = 1;        // Mono

// J.A.R.V.I.S. System Persona
const JARVIS_PERSONA = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), the AI assistant created by Tony Stark. You possess the following characteristics:

- Personality: Sophisticated, witty, and unfailingly polite with a dry British sense of humor
- Speech: Formal yet warm, using precise language with occasional subtle sarcasm
- Knowledge: Vast expertise in technology, science, engineering, and Stark Industries systems
- Demeanor: Calm and composed even in crisis situations, always maintaining professionalism
- Loyalty: Completely devoted to assisting and protecting your user
- Capabilities: Real-time monitoring, analysis, recommendations, and conversation

Address the user respectfully. Provide concise, actionable responses. When appropriate, add subtle wit or observations that demonstrate your advanced intelligence. Never break character.

Begin each conversation ready to assist with whatever the user requires.`;

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert Float32Array audio samples to Base64-encoded PCM16
 * @param {Float32Array} float32Array - Audio samples (-1.0 to 1.0)
 * @returns {string} Base64-encoded PCM16 data
 */
const floatTo16BitPCM = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
        // Clamp and convert to 16-bit signed integer
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(i * 2, s, true); // little-endian
    }

    return base64EncodeAudio(buffer);
};

/**
 * Convert ArrayBuffer to Base64 string
 * @param {ArrayBuffer} arrayBuffer - Audio data buffer
 * @returns {string} Base64-encoded string
 */
const base64EncodeAudio = (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

/**
 * Decode Base64 PCM16 audio to Float32Array for playback
 * @param {string} base64 - Base64-encoded PCM16 data
 * @returns {Float32Array} Audio samples for Web Audio API
 */
const base64ToFloat32Array = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 0x8000; // Convert to -1.0 to 1.0
    }

    return float32Array;
};

// ═════════════════════════════════════════════════════════════════════════════
// VOICE HANDLER COMPONENT (v12.2 - with ref forwarding)
// ═════════════════════════════════════════════════════════════════════════════

const VoiceHandler = forwardRef(({ onTranscript, onStatusChange, autoConnect = true }, ref) => {
    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────
    const [isConnected, setIsConnected] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [error, setError] = useState(null);
    const [connectionStatus, setConnectionStatus] = useState('disconnected');

    // ─────────────────────────────────────────────────────────────────────────
    // REFS
    // ─────────────────────────────────────────────────────────────────────────
    const wsRef = useRef(null);
    const audioContextRef = useRef(null);
    const mediaStreamRef = useRef(null);
    const processorRef = useRef(null);
    const sourceNodeRef = useRef(null);
    const streamingPlayerRef = useRef(null);  // Sprint 14.0 - MSE streaming player
    const currentResponseIdRef = useRef(null);

    // ─────────────────────────────────────────────────────────────────────────
    // AUDIO CONTEXT INITIALIZATION
    // ─────────────────────────────────────────────────────────────────────────
    const initAudioContext = useCallback(() => {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
            });
        }

        // Resume if suspended (browser autoplay policy)
        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }

        return audioContextRef.current;
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // STREAMING AUDIO PLAYBACK (MSE - Sprint 14.0)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Handle streaming player state changes
     */
    const handlePlayerStateChange = useCallback((state) => {
        setIsSpeaking(state.isPlaying || state.isStreaming);
        setIsMuted(state.isMuted);
        if (state.error) {
            console.warn('⚠️ [VoiceHandler] Streaming player error:', state.error);
        }
    }, []);

    /**
     * Queue audio chunk for MSE streaming playback
     * @param {string} base64Mp3 - Base64 encoded MP3 chunk
     */
    const queueAudioForPlayback = useCallback((base64Mp3) => {
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.appendChunk(base64Mp3);
        } else {
            console.warn('⚠️ [VoiceHandler] StreamingAudioPlayer not initialized');
        }
    }, []);

    /**
     * End the current audio stream
     */
    const endAudioStream = useCallback(() => {
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.endStream();
        }
    }, []);

    /**
     * Stop playback and send tts.stop to server
     */
    const stopPlayback = useCallback(() => {
        // Stop client-side immediately
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.stop();
        }
        setIsSpeaking(false);

        // Send tts.stop to server (best-effort)
        if (wsRef.current?.readyState === WebSocket.OPEN && currentResponseIdRef.current) {
            wsRef.current.send(JSON.stringify({
                type: 'tts.stop',
                response_id: currentResponseIdRef.current
            }));
            console.log('🛑 [VoiceHandler] Sent tts.stop to server');
        }
    }, []);

    /**
     * Toggle mute state
     */
    const toggleMute = useCallback(() => {
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.toggleMute();
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSOCKET MESSAGE HANDLER
    // ─────────────────────────────────────────────────────────────────────────
    const handleWebSocketMessage = useCallback((event) => {
        try {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'session.created':
                    console.log('🤖 Session created:', data.session?.id);
                    setConnectionStatus('session_active');
                    break;

                case 'session.updated':
                    console.log('🔧 Session updated');
                    break;

                // Sprint 14.0 - TTS streaming events
                case 'tts.start':
                    console.log('🎤 [VoiceHandler] TTS stream started:', data.response_id);
                    currentResponseIdRef.current = data.response_id;
                    break;

                case 'response.audio.delta':
                    // Received MP3 chunk from ElevenLabs - stream for playback
                    if (data.delta) {
                        currentResponseIdRef.current = data.response_id;
                        queueAudioForPlayback(data.delta);
                    }
                    break;

                case 'tts.end':
                case 'response.audio.done':
                    console.log('🔊 [VoiceHandler] Audio stream complete');
                    endAudioStream();
                    currentResponseIdRef.current = null;
                    break;

                case 'tts.error':
                    console.error('❌ [VoiceHandler] TTS error:', data.code, data.message);
                    setError(data.message || 'TTS error');
                    break;

                case 'response.audio_transcript.delta':
                    // AI is speaking - partial transcript
                    if (onTranscript && data.delta) {
                        onTranscript({ role: 'assistant', content: data.delta, partial: true });
                    }
                    break;

                case 'response.audio_transcript.done':
                    // AI finished speaking - final transcript
                    if (onTranscript && data.transcript) {
                        onTranscript({ role: 'assistant', content: data.transcript, partial: false });
                    }
                    break;

                case 'input_audio_buffer.speech_started':
                    console.log('🎤 User speech detected');
                    setIsListening(true);
                    break;

                case 'input_audio_buffer.speech_stopped':
                    console.log('🎤 User speech ended');
                    setIsListening(false);
                    break;

                case 'conversation.item.input_audio_transcription.completed':
                    // User's speech transcribed
                    if (onTranscript && data.transcript) {
                        onTranscript({ role: 'user', content: data.transcript, partial: false });
                    }
                    break;

                case 'error':
                    console.error('❌ Realtime API error:', data.error);
                    setError(data.error?.message || 'Unknown error');
                    break;

                default:
                    // Uncomment for debugging:
                    // console.log('📨 Event:', data.type, data);
                    break;
            }
        } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
        }
    }, [onTranscript, queueAudioForPlayback]);

    // ─────────────────────────────────────────────────────────────────────────
    // SEND J.A.R.V.I.S. PERSONA INITIALIZATION
    // ─────────────────────────────────────────────────────────────────────────
    const sendSessionConfig = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const sessionUpdate = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: JARVIS_PERSONA,
                voice: 'echo',
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                input_audio_transcription: {
                    model: 'whisper-1',
                },
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                },
            },
        };

        wsRef.current.send(JSON.stringify(sessionUpdate));
        console.log('📤 Sent J.A.R.V.I.S. session configuration');
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // MICROPHONE CAPTURE (24kHz Mono PCM16)
    // ─────────────────────────────────────────────────────────────────────────
    const startMicrophoneCapture = useCallback(async () => {
        try {
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: CHANNELS,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            mediaStreamRef.current = stream;
            const ctx = initAudioContext();

            // Create audio processing pipeline
            const source = ctx.createMediaStreamSource(stream);
            sourceNodeRef.current = source;

            // Use ScriptProcessorNode for audio capture
            // (AudioWorklet would be preferred for production)
            const processor = ctx.createScriptProcessor(4096, CHANNELS, CHANNELS);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
                if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

                const inputData = e.inputBuffer.getChannelData(0);

                // Resample if needed (browser may not respect exact sample rate)
                // For simplicity, we assume sample rate matches or is close enough

                // Convert to PCM16 Base64
                const base64Audio = floatTo16BitPCM(inputData);

                // Send to relay server
                const audioEvent = {
                    type: 'input_audio_buffer.append',
                    audio: base64Audio,
                };

                wsRef.current.send(JSON.stringify(audioEvent));
            };

            // Connect the pipeline
            source.connect(processor);
            processor.connect(ctx.destination); // Required for onaudioprocess to fire

            setIsListening(true);
            console.log('🎤 Microphone capture started');

        } catch (err) {
            console.error('Microphone access error:', err);
            setError(`Microphone access denied: ${err.message}`);
        }
    }, [initAudioContext]);

    const stopMicrophoneCapture = useCallback(() => {
        // Stop processor
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }

        // Stop source node
        if (sourceNodeRef.current) {
            sourceNodeRef.current.disconnect();
            sourceNodeRef.current = null;
        }

        // Stop media stream tracks
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }

        setIsListening(false);
        console.log('🎤 Microphone capture stopped');
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSOCKET CONNECTION MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────
    const connect = useCallback(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        setConnectionStatus('connecting');
        setError(null);

        const ws = new WebSocket(RELAY_SERVER_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('🔌 WebSocket connected to relay server');
            setIsConnected(true);
            setConnectionStatus('connected');

            // Initialize audio context on user interaction
            initAudioContext();

            // Send J.A.R.V.I.S. persona configuration
            sendSessionConfig();

            // Start microphone capture
            startMicrophoneCapture();
        };

        ws.onmessage = handleWebSocketMessage;

        ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            setError('Connection error');
            setConnectionStatus('error');
        };

        ws.onclose = (event) => {
            console.log('🔌 WebSocket disconnected:', event.code, event.reason);
            setIsConnected(false);
            setConnectionStatus('disconnected');
            stopMicrophoneCapture();
        };

    }, [initAudioContext, sendSessionConfig, startMicrophoneCapture, stopMicrophoneCapture, handleWebSocketMessage]);

    const disconnect = useCallback(() => {
        stopMicrophoneCapture();

        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        // Stop streaming playback
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.stop();
        }

        setIsConnected(false);
        setIsSpeaking(false);
        setConnectionStatus('disconnected');
    }, [stopMicrophoneCapture]);

    // ─────────────────────────────────────────────────────────────────────────
    // STATUS CALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (onStatusChange) {
            onStatusChange({
                isConnected,
                isListening,
                isSpeaking,
                isMuted,
                connectionStatus,
                error,
            });
        }
    }, [isConnected, isListening, isSpeaking, isMuted, connectionStatus, error, onStatusChange]);

    // ─────────────────────────────────────────────────────────────────────────────
    // BARGE-IN: SEND CANCEL EVENT (v12.2)
    // ─────────────────────────────────────────────────────────────────────────────
    const sendCancel = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const cancelEvent = {
            type: 'response.cancel',
        };

        wsRef.current.send(JSON.stringify(cancelEvent));
        console.log('🛑 Sent response.cancel (barge-in)');

        // Stop streaming playback
        if (streamingPlayerRef.current) {
            streamingPlayerRef.current.stop();
        }
        setIsSpeaking(false);
    }, []);

    // ─────────────────────────────────────────────────────────────────────────────
    // EXPOSE METHODS VIA REF (for parent component barge-in)
    // ─────────────────────────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
        sendCancel,
        connect,
        disconnect,
        stopPlayback,
        toggleMute,
        isMuted: () => isMuted,
    }), [sendCancel, connect, disconnect, stopPlayback, toggleMute, isMuted]);

    // ─────────────────────────────────────────────────────────────────────────────
    // AUTO-CONNECT ON MOUNT (when autoConnect prop is true)
    // ─────────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (autoConnect) {
            connect();
        }
    }, [autoConnect, connect]);

    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP ON UNMOUNT
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            disconnect();
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };
    }, [disconnect]);

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER - Control Interface
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="voice-handler">
            {/* Streaming Audio Player (hidden - handles MSE playback) */}
            <StreamingAudioPlayer
                ref={streamingPlayerRef}
                onStateChange={handlePlayerStateChange}
                onError={(e) => console.error('❌ StreamingAudioPlayer error:', e)}
            />

            {/* Connection Controls */}
            <div className="flex items-center gap-4">
                {!isConnected ? (
                    <button
                        onClick={connect}
                        className="px-6 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-lg transition-all duration-300 shadow-[0_0_15px_rgba(34,211,238,0.3)] flex items-center gap-2"
                    >
                        <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
                        <span>Initialize Voice Link</span>
                    </button>
                ) : (
                    <>
                        <button
                            onClick={disconnect}
                            className="px-6 py-3 border border-red-500/50 text-red-400 hover:bg-red-500/10 font-bold rounded-lg transition-all duration-300 flex items-center gap-2"
                        >
                            <div className="w-3 h-3 rounded-full bg-red-500" />
                            <span>Disconnect</span>
                        </button>

                        {/* Mute Button */}
                        <button
                            onClick={toggleMute}
                            className={`px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 ${isMuted
                                ? 'border border-yellow-500/50 text-yellow-400 bg-yellow-500/10'
                                : 'border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10'}`}
                            title={isMuted ? 'Unmute' : 'Mute'}
                        >
                            {isMuted ? (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                                </svg>
                            ) : (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                                </svg>
                            )}
                        </button>

                        {/* Stop Button (visible when speaking) */}
                        {isSpeaking && (
                            <button
                                onClick={stopPlayback}
                                className="px-4 py-2 border border-red-500/50 text-red-400 hover:bg-red-500/20 rounded-lg transition-all duration-300 flex items-center gap-2"
                                title="Stop Playback"
                            >
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M6 6h12v12H6z" />
                                </svg>
                                <span>Stop</span>
                            </button>
                        )}
                    </>
                )}

                {/* Status Indicators */}
                <div className="flex items-center gap-3 text-sm">
                    <div className={`flex items-center gap-2 ${isConnected ? 'text-green-400' : 'text-gray-500'}`}>
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-gray-600'}`} />
                        <span>{connectionStatus.toUpperCase()}</span>
                    </div>

                    {isListening && (
                        <div className="flex items-center gap-2 text-cyan-400">
                            <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                            <span>LISTENING</span>
                        </div>
                    )}

                    {isSpeaking && (
                        <div className="flex items-center gap-2 text-yellow-400">
                            <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_8px_rgba(250,204,21,0.8)]" />
                            <span>SPEAKING</span>
                        </div>
                    )}

                    {isMuted && (
                        <div className="flex items-center gap-2 text-yellow-500">
                            <div className="w-2 h-2 rounded-full bg-yellow-500" />
                            <span>MUTED</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Error Display */}
            {error && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/40 rounded-lg text-red-400 text-sm">
                    ⚠️ {error}
                </div>
            )}
        </div>
    );
});

VoiceHandler.displayName = 'VoiceHandler';

export default VoiceHandler;
