/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MicRecorder.js - Browser Microphone Capture & STT Streaming (v13.2)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Captures microphone audio using MediaRecorder API with webm/opus encoding.
 * Streams Base64-encoded audio chunks to jarvis-relay via WebSocket.
 * 
 * Protocol (client → relay):
 *   - audio.start { format, sampleRate, encoding }
 *   - audio.chunk { data: "<base64>" }
 *   - audio.end {}
 * 
 * Protocol (relay → client):
 *   - transcript.final { text, duration_ms, provider, failover }
 *   - transcript.error { code, message }
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Tagged relay endpoint for STT
const RELAY_WS_URL = 'wss://v13-1-1---jarvis-relay-fyxv6qknma-ew.a.run.app';

// MediaRecorder settings
const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus';
const FALLBACK_MIME_TYPE = 'audio/webm';
const CHUNK_INTERVAL_MS = 300; // ~300ms chunks (configurable 250-500ms)

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: ArrayBuffer to Base64
// ═══════════════════════════════════════════════════════════════════════════
const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY: Get supported MIME type
// ═══════════════════════════════════════════════════════════════════════════
const getSupportedMimeType = () => {
    if (MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)) {
        return PREFERRED_MIME_TYPE;
    }
    if (MediaRecorder.isTypeSupported(FALLBACK_MIME_TYPE)) {
        return FALLBACK_MIME_TYPE;
    }
    // Last resort - let browser choose
    return '';
};

// ═══════════════════════════════════════════════════════════════════════════
// MIC RECORDER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

const MicRecorder = ({
    onTranscript,
    onError,
    onStatusChange,
    mode = 'toggle', // 'toggle' or 'hold'
    className = ''
}) => {
    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────
    const [isConnected, setIsConnected] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [lastTranscript, setLastTranscript] = useState(null);
    const [error, setError] = useState(null);
    const [mimeType, setMimeType] = useState(null);

    // ─────────────────────────────────────────────────────────────────────────
    // REFS
    // ─────────────────────────────────────────────────────────────────────────
    const wsRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const mediaStreamRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSOCKET CONNECTION
    // ─────────────────────────────────────────────────────────────────────────
    const connectWebSocket = useCallback(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            return;
        }

        console.log('🔌 Connecting to relay:', RELAY_WS_URL);
        const ws = new WebSocket(RELAY_WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('✅ WebSocket connected to relay');
            setIsConnected(true);
            setError(null);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleRelayMessage(data);
            } catch (err) {
                console.error('Failed to parse relay message:', err);
            }
        };

        ws.onerror = (err) => {
            console.error('❌ WebSocket error:', err);
            setError('Connection error');
        };

        ws.onclose = (event) => {
            console.log('🔌 WebSocket disconnected:', event.code);
            setIsConnected(false);

            // Auto-reconnect after 3 seconds (unless intentional close)
            if (event.code !== 1000) {
                reconnectTimeoutRef.current = setTimeout(() => {
                    connectWebSocket();
                }, 3000);
            }
        };
    }, []);

    const disconnectWebSocket = useCallback(() => {
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
        }
        if (wsRef.current) {
            wsRef.current.close(1000, 'User disconnect');
            wsRef.current = null;
        }
        setIsConnected(false);
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // RELAY MESSAGE HANDLER
    // ─────────────────────────────────────────────────────────────────────────
    const handleRelayMessage = useCallback((data) => {
        switch (data.type) {
            case 'transcript.final':
                console.log('📝 Transcript received:', data);
                setIsTranscribing(false);
                setLastTranscript({
                    text: data.text,
                    duration_ms: data.duration_ms,
                    provider: data.provider,
                    failover: data.failover
                });
                if (onTranscript) {
                    onTranscript(data);
                }
                break;

            case 'transcript.error':
                console.error('❌ Transcript error:', data);
                setIsTranscribing(false);
                setError(data.message || 'Transcription failed');
                if (onError) {
                    onError(data);
                }
                break;

            case 'connection.ready':
                console.log('🤖 Relay ready');
                break;

            default:
                console.log('📨 Relay message:', data.type, data);
        }
    }, [onTranscript, onError]);

    // ─────────────────────────────────────────────────────────────────────────
    // RECORDING CONTROLS
    // ─────────────────────────────────────────────────────────────────────────
    const startRecording = useCallback(async () => {
        if (!isConnected) {
            setError('Not connected to relay');
            return;
        }

        try {
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });
            mediaStreamRef.current = stream;

            // Determine supported MIME type
            const mime = getSupportedMimeType();
            setMimeType(mime);
            console.log('🎤 Using MIME type:', mime || 'browser default');

            // Create MediaRecorder
            const options = mime ? { mimeType: mime } : {};
            const recorder = new MediaRecorder(stream, options);
            mediaRecorderRef.current = recorder;

            // Send audio.start to relay
            const audioSettings = stream.getAudioTracks()[0].getSettings();
            wsRef.current.send(JSON.stringify({
                type: 'audio.start',
                format: mime || 'audio/webm',
                sampleRate: audioSettings.sampleRate || 48000,
                encoding: 'opus'
            }));

            // Handle audio chunks
            recorder.ondataavailable = async (event) => {
                if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
                    const arrayBuffer = await event.data.arrayBuffer();
                    const base64Data = arrayBufferToBase64(arrayBuffer);

                    wsRef.current.send(JSON.stringify({
                        type: 'audio.chunk',
                        data: base64Data
                    }));
                }
            };

            // Start recording with chunk interval
            recorder.start(CHUNK_INTERVAL_MS);
            setIsRecording(true);
            setError(null);
            setLastTranscript(null);
            console.log('🔴 Recording started');

        } catch (err) {
            console.error('Failed to start recording:', err);
            setError(`Microphone access denied: ${err.message}`);
        }
    }, [isConnected]);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }

        // Stop all tracks
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }

        // Send audio.end to relay
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'audio.end'
            }));
        }

        setIsRecording(false);
        setIsTranscribing(true);
        console.log('⏹️ Recording stopped, awaiting transcript...');
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // TOGGLE / HOLD HANDLERS
    // ─────────────────────────────────────────────────────────────────────────
    const handleToggle = useCallback(() => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    }, [isRecording, startRecording, stopRecording]);

    const handleMouseDown = useCallback(() => {
        if (mode === 'hold' && !isRecording) {
            startRecording();
        }
    }, [mode, isRecording, startRecording]);

    const handleMouseUp = useCallback(() => {
        if (mode === 'hold' && isRecording) {
            stopRecording();
        }
    }, [mode, isRecording, stopRecording]);

    // ─────────────────────────────────────────────────────────────────────────
    // STATUS CALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (onStatusChange) {
            onStatusChange({
                isConnected,
                isRecording,
                isTranscribing,
                error,
                mimeType
            });
        }
    }, [isConnected, isRecording, isTranscribing, error, mimeType, onStatusChange]);

    // ─────────────────────────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        connectWebSocket();
        return () => {
            stopRecording();
            disconnectWebSocket();
        };
    }, [connectWebSocket, disconnectWebSocket, stopRecording]);

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className={`mic-recorder ${className}`}>
            {/* Connection Status */}
            <div className="flex items-center gap-2 mb-3">
                <div className={`w-2 h-2 rounded-full ${isConnected
                        ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]'
                        : 'bg-red-500'
                    }`} />
                <span className="text-xs text-gray-400 tracking-wider uppercase">
                    {isConnected ? 'Relay Connected' : 'Connecting...'}
                </span>
            </div>

            {/* Record Button */}
            <button
                onClick={mode === 'toggle' ? handleToggle : undefined}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onMouseLeave={mode === 'hold' && isRecording ? handleMouseUp : undefined}
                onTouchStart={handleMouseDown}
                onTouchEnd={handleMouseUp}
                disabled={!isConnected || isTranscribing}
                className={`relative w-full py-4 rounded-lg font-bold tracking-wider uppercase text-sm transition-all duration-300 flex items-center justify-center gap-3 ${isRecording
                        ? 'bg-red-500/20 border-2 border-red-500 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                        : isTranscribing
                            ? 'bg-yellow-500/10 border-2 border-yellow-500/50 text-yellow-400'
                            : 'bg-cyan-500/10 border-2 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/20 hover:border-cyan-400'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
                {/* Recording indicator animation */}
                {isRecording && (
                    <div className="absolute inset-0 rounded-lg bg-red-500/10 animate-pulse" />
                )}

                {/* Icon */}
                <div className="relative z-10">
                    {isRecording ? (
                        <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
                    ) : isTranscribing ? (
                        <div className="w-4 h-4 border-2 border-yellow-400/30 border-t-yellow-400 rounded-full animate-spin" />
                    ) : (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                        </svg>
                    )}
                </div>

                {/* Label */}
                <span className="relative z-10">
                    {isRecording
                        ? (mode === 'hold' ? 'Recording...' : 'Stop Recording')
                        : isTranscribing
                            ? 'Transcribing...'
                            : (mode === 'hold' ? 'Hold to Talk' : 'Start Recording')
                    }
                </span>
            </button>

            {/* Error Display */}
            {error && (
                <div className="mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs">
                    ⚠️ {error}
                </div>
            )}

            {/* Transcript Display */}
            {lastTranscript && (
                <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                    <p className="text-gray-200 text-sm leading-relaxed mb-2">
                        "{lastTranscript.text}"
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-gray-500 uppercase tracking-wider">
                        <span className="flex items-center gap-1">
                            <div className={`w-1.5 h-1.5 rounded-full ${lastTranscript.provider === 'openai' ? 'bg-green-400' : 'bg-purple-400'
                                }`} />
                            {lastTranscript.provider}
                        </span>
                        {lastTranscript.failover && (
                            <span className="text-yellow-400">
                                ⚡ Failover
                            </span>
                        )}
                        <span>{lastTranscript.duration_ms}ms</span>
                    </div>
                </div>
            )}

            {/* MIME Type Debug */}
            {mimeType && (
                <div className="mt-2 text-[10px] text-gray-600 tracking-wider">
                    Codec: {mimeType}
                </div>
            )}
        </div>
    );
};

export default MicRecorder;
