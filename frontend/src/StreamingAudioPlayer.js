/**
 * ═══════════════════════════════════════════════════════════════════════════
 * StreamingAudioPlayer.js - MSE-based MP3 Streaming Playback (Sprint 14.0)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Provides gapless MP3 streaming playback using Media Source Extensions (MSE).
 * Features:
 * - Continuous MP3 chunk append via SourceBuffer
 * - Mute/unmute control
 * - Stop/cancel with immediate buffer clearing
 * - Browser autoplay policy handling
 * 
 * Usage:
 *   const playerRef = useRef();
 *   <StreamingAudioPlayer ref={playerRef} onStateChange={handleStateChange} />
 *   
 *   playerRef.current.appendChunk(base64Mp3Data);
 *   playerRef.current.endStream();
 *   playerRef.current.stop();
 *   playerRef.current.toggleMute();
 */

import { forwardRef, useImperativeHandle, useRef, useState, useCallback, useEffect } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const MIME_TYPE = 'audio/mpeg';
const MSE_SUPPORTED = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME_TYPE);

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING AUDIO PLAYER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

const StreamingAudioPlayer = forwardRef(({ onStateChange, onError }, ref) => {
    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [error, setError] = useState(null);

    // ─────────────────────────────────────────────────────────────────────────
    // REFS
    // ─────────────────────────────────────────────────────────────────────────
    const audioRef = useRef(null);
    const mediaSourceRef = useRef(null);
    const sourceBufferRef = useRef(null);
    const chunkQueueRef = useRef([]);
    const isAppendingRef = useRef(false);
    const streamEndedRef = useRef(false);
    const isInitializedRef = useRef(false);

    // ─────────────────────────────────────────────────────────────────────────
    // STATE CHANGE CALLBACK
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (onStateChange) {
            onStateChange({ isPlaying, isMuted, isStreaming, error });
        }
    }, [isPlaying, isMuted, isStreaming, error, onStateChange]);

    // ─────────────────────────────────────────────────────────────────────────
    // PROCESS CHUNK QUEUE
    // ─────────────────────────────────────────────────────────────────────────
    const processQueue = useCallback(() => {
        const sourceBuffer = sourceBufferRef.current;

        if (!sourceBuffer || sourceBuffer.updating || isAppendingRef.current) {
            return;
        }

        if (chunkQueueRef.current.length === 0) {
            // Check if stream ended and we should close MediaSource
            if (streamEndedRef.current && mediaSourceRef.current?.readyState === 'open') {
                try {
                    mediaSourceRef.current.endOfStream();
                    console.log('🔊 [StreamingAudioPlayer] MediaSource stream ended');
                } catch (e) {
                    console.warn('⚠️ [StreamingAudioPlayer] endOfStream error:', e.message);
                }
            }
            return;
        }

        isAppendingRef.current = true;
        const chunk = chunkQueueRef.current.shift();

        try {
            sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            console.error('❌ [StreamingAudioPlayer] appendBuffer error:', e);
            isAppendingRef.current = false;
            setError(`Buffer append failed: ${e.message}`);
            if (onError) onError(e);
        }
    }, [onError]);

    // ─────────────────────────────────────────────────────────────────────────
    // INITIALIZE MEDIA SOURCE
    // ─────────────────────────────────────────────────────────────────────────
    const initializeMediaSource = useCallback(() => {
        if (!MSE_SUPPORTED) {
            const err = new Error('Media Source Extensions not supported in this browser');
            setError(err.message);
            if (onError) onError(err);
            return false;
        }

        // Create new MediaSource
        const mediaSource = new MediaSource();
        mediaSourceRef.current = mediaSource;

        // Create audio element
        const audio = new Audio();
        audio.src = URL.createObjectURL(mediaSource);
        audioRef.current = audio;

        // Set up audio event handlers
        audio.onplay = () => {
            setIsPlaying(true);
            console.log('▶️ [StreamingAudioPlayer] Playback started');
        };

        audio.onpause = () => {
            setIsPlaying(false);
            console.log('⏸️ [StreamingAudioPlayer] Playback paused');
        };

        audio.onended = () => {
            setIsPlaying(false);
            setIsStreaming(false);
            console.log('⏹️ [StreamingAudioPlayer] Playback ended');
        };

        audio.onerror = (e) => {
            console.error('❌ [StreamingAudioPlayer] Audio error:', e);
            setError('Audio playback error');
            if (onError) onError(new Error('Audio playback error'));
        };

        // Set up MediaSource event handlers
        mediaSource.addEventListener('sourceopen', () => {
            console.log('🔓 [StreamingAudioPlayer] MediaSource opened');

            try {
                const sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
                sourceBufferRef.current = sourceBuffer;

                sourceBuffer.addEventListener('updateend', () => {
                    isAppendingRef.current = false;
                    processQueue();
                });

                sourceBuffer.addEventListener('error', (e) => {
                    console.error('❌ [StreamingAudioPlayer] SourceBuffer error:', e);
                    isAppendingRef.current = false;
                });

                isInitializedRef.current = true;

                // Process any queued chunks
                processQueue();

            } catch (e) {
                console.error('❌ [StreamingAudioPlayer] Failed to create SourceBuffer:', e);
                setError(`SourceBuffer creation failed: ${e.message}`);
                if (onError) onError(e);
            }
        });

        mediaSource.addEventListener('sourceended', () => {
            console.log('🔒 [StreamingAudioPlayer] MediaSource ended');
        });

        mediaSource.addEventListener('sourceclose', () => {
            console.log('🔒 [StreamingAudioPlayer] MediaSource closed');
            isInitializedRef.current = false;
        });

        return true;
    }, [onError, processQueue]);

    // ─────────────────────────────────────────────────────────────────────────
    // APPEND CHUNK
    // ─────────────────────────────────────────────────────────────────────────
    const appendChunk = useCallback((base64Data) => {
        if (!base64Data) return;

        // Initialize on first chunk
        if (!isInitializedRef.current && !mediaSourceRef.current) {
            if (!initializeMediaSource()) return;
            setIsStreaming(true);
            streamEndedRef.current = false;
        }

        // Decode base64 to ArrayBuffer
        try {
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Queue the chunk
            chunkQueueRef.current.push(bytes.buffer);

            // Process queue if ready
            if (isInitializedRef.current) {
                processQueue();
            }

            // Start playback if not already playing
            if (audioRef.current && audioRef.current.paused && !streamEndedRef.current) {
                audioRef.current.play().catch(e => {
                    console.warn('⚠️ [StreamingAudioPlayer] Autoplay blocked:', e.message);
                    // Autoplay blocked - will need user gesture
                });
            }

        } catch (e) {
            console.error('❌ [StreamingAudioPlayer] Failed to decode chunk:', e);
            setError(`Chunk decode failed: ${e.message}`);
            if (onError) onError(e);
        }
    }, [initializeMediaSource, processQueue, onError]);

    // ─────────────────────────────────────────────────────────────────────────
    // END STREAM
    // ─────────────────────────────────────────────────────────────────────────
    const endStream = useCallback(() => {
        streamEndedRef.current = true;

        // If no pending chunks, close immediately
        if (chunkQueueRef.current.length === 0 && !isAppendingRef.current) {
            if (mediaSourceRef.current?.readyState === 'open') {
                try {
                    mediaSourceRef.current.endOfStream();
                    console.log('🔊 [StreamingAudioPlayer] Stream ended (immediate)');
                } catch (e) {
                    console.warn('⚠️ [StreamingAudioPlayer] endOfStream error:', e.message);
                }
            }
        }
        // Otherwise, processQueue will handle it when queue is empty
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // STOP (IMMEDIATE)
    // ─────────────────────────────────────────────────────────────────────────
    const stop = useCallback(() => {
        console.log('🛑 [StreamingAudioPlayer] Stop requested');

        // Clear chunk queue
        chunkQueueRef.current = [];
        streamEndedRef.current = true;
        isAppendingRef.current = false;

        // Stop audio playback
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }

        // Clear SourceBuffer if possible
        const sourceBuffer = sourceBufferRef.current;
        if (sourceBuffer && !sourceBuffer.updating && mediaSourceRef.current?.readyState === 'open') {
            try {
                sourceBuffer.abort();
                // Remove all buffered data
                if (sourceBuffer.buffered.length > 0) {
                    sourceBuffer.remove(0, sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1));
                }
            } catch (e) {
                console.warn('⚠️ [StreamingAudioPlayer] Buffer clear error:', e.message);
            }
        }

        // Reset state
        setIsPlaying(false);
        setIsStreaming(false);

        // Revoke object URL and clean up
        if (audioRef.current?.src) {
            URL.revokeObjectURL(audioRef.current.src);
        }

        // Reset refs for next stream
        mediaSourceRef.current = null;
        sourceBufferRef.current = null;
        audioRef.current = null;
        isInitializedRef.current = false;

        console.log('🛑 [StreamingAudioPlayer] Stopped and reset');
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // MUTE/UNMUTE
    // ─────────────────────────────────────────────────────────────────────────
    const toggleMute = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.muted = !audioRef.current.muted;
            setIsMuted(audioRef.current.muted);
            console.log(`🔊 [StreamingAudioPlayer] ${audioRef.current.muted ? 'Muted' : 'Unmuted'}`);
        }
    }, []);

    const setMuted = useCallback((muted) => {
        if (audioRef.current) {
            audioRef.current.muted = muted;
            setIsMuted(muted);
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // RESUME (for autoplay policy)
    // ─────────────────────────────────────────────────────────────────────────
    const resume = useCallback(() => {
        if (audioRef.current && audioRef.current.paused) {
            audioRef.current.play().catch(e => {
                console.error('❌ [StreamingAudioPlayer] Resume failed:', e);
            });
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP ON UNMOUNT
    // ─────────────────────────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            stop();
        };
    }, [stop]);

    // ─────────────────────────────────────────────────────────────────────────
    // EXPOSE IMPERATIVE API
    // ─────────────────────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
        appendChunk,
        endStream,
        stop,
        toggleMute,
        setMuted,
        resume,
        isPlaying: () => isPlaying,
        isMuted: () => isMuted,
        isStreaming: () => isStreaming,
        isSupported: () => MSE_SUPPORTED,
    }), [appendChunk, endStream, stop, toggleMute, setMuted, resume, isPlaying, isMuted, isStreaming]);

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER (hidden - no visible UI)
    // ─────────────────────────────────────────────────────────────────────────
    return null;
});

StreamingAudioPlayer.displayName = 'StreamingAudioPlayer';

export default StreamingAudioPlayer;
