import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API_CONFIG, tokenManager, authFetch } from './config';
import VoiceHandler from './VoiceHandler';

/**
 * Dashboard Component - Iron Man HUD Interface (v12.2 Vocal Link)
 * 
 * The primary command center for interacting with Jarvis AI.
 * Features real-time WebSocket audio streaming via VoiceHandler.
 * Integrated with hardened Cloud Run backend with JWT authentication.
 * 
 * @param {Object} user - Authenticated user object from Auth component
 * @param {Function} onLogout - Callback to handle user logout
 */

// WebSocket Relay Server for Realtime Audio
const RELAY_SERVER_URL = 'ws://localhost:8081';

// Production API Base URL from centralized config
const API_BASE_URL = API_CONFIG.BASE_URL;

const Dashboard = ({ user, onLogout }) => {
    // ═══════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [autoplayBlocked, setAutoplayBlocked] = useState(false);
    const [audioEnabled, setAudioEnabled] = useState(false); // v12.3.1 - Track audio permission
    const [currentTime, setCurrentTime] = useState(new Date());
    const [systemMetrics, setSystemMetrics] = useState({
        cpu: 23,
        memory: 47,
        network: 98,
        power: 100
    });

    // ═══════════════════════════════════════════════════════════════
    // VOCAL LINK STATE (v12.2)
    // ═══════════════════════════════════════════════════════════════
    const [vocalLinkEnabled, setVocalLinkEnabled] = useState(false);
    const [vocalLinkStatus, setVocalLinkStatus] = useState(null);
    const [streamingText, setStreamingText] = useState('');
    const [audioIntensity, setAudioIntensity] = useState(0);

    // Refs
    const messagesEndRef = useRef(null);
    const audioRef = useRef(null);
    const blobUrlRef = useRef(null);
    const voiceHandlerRef = useRef(null);
    const streamingMessageIdRef = useRef(null);
    const audioEnabledRef = useRef(false); // Track if user has enabled audio

    // ═══════════════════════════════════════════════════════════════
    // EFFECTS
    // ═══════════════════════════════════════════════════════════════

    // Real-time clock
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    // Simulate fluctuating system metrics
    useEffect(() => {
        const metricsTimer = setInterval(() => {
            setSystemMetrics(prev => ({
                cpu: Math.min(100, Math.max(10, prev.cpu + (Math.random() - 0.5) * 10)),
                memory: Math.min(100, Math.max(20, prev.memory + (Math.random() - 0.5) * 5)),
                network: Math.min(100, Math.max(80, prev.network + (Math.random() - 0.5) * 8)),
                power: Math.min(100, Math.max(85, prev.power + (Math.random() - 0.5) * 3))
            }));
        }, 2000);
        return () => clearInterval(metricsTimer);
    }, []);

    // Auto-scroll messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Cleanup blob URL on unmount
    useEffect(() => {
        return () => {
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, []);

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL JARVIS VOICE TEST FUNCTION (v12.3.1)
    // ═══════════════════════════════════════════════════════════════
    useEffect(() => {
        /**
         * Manual voice test function - accessible via browser console
         * Usage: window.jarvisVoice.test("Hello Sir, system check complete.")
         */
        window.jarvisVoice = {
            test: async (text = "Hello Sir, system check complete.") => {
                console.log('🔊 jarvisVoice.test() triggered with:', text);

                // Ensure audio is enabled
                if (!audioEnabledRef.current) {
                    console.warn('⚠️ Audio not enabled. Click the ENABLE AUDIO button first.');
                    return;
                }

                try {
                    const token = localStorage.getItem('jarvis_token');
                    if (!token) {
                        console.error('❌ No auth token found. Please login first.');
                        return;
                    }

                    console.log('📤 Sending TTS request...');
                    const response = await fetch(`${API_BASE_URL}/chat`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ text })
                    });

                    if (!response.ok) {
                        throw new Error(`Server error: ${response.status}`);
                    }

                    const contentType = response.headers.get('content-type');
                    if (contentType && contentType.includes('audio/mpeg')) {
                        const arrayBuffer = await response.arrayBuffer();
                        console.log('🔊 Audio chunk received:', arrayBuffer.byteLength, 'bytes');

                        const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
                        const blobUrl = URL.createObjectURL(blob);
                        const audio = new Audio(blobUrl);

                        audio.onended = () => {
                            URL.revokeObjectURL(blobUrl);
                            console.log('✅ Audio playback complete');
                        };

                        await audio.play();
                        console.log('▶️ Audio playing...');
                    } else {
                        const data = await response.json();
                        console.log('📝 Text response (no audio):', data);
                    }
                } catch (error) {
                    console.error('❌ Voice test failed:', error);
                }
            },

            enableAudio: () => {
                audioEnabledRef.current = true;
                console.log('✅ Audio enabled via jarvisVoice.enableAudio()');
            },

            status: () => {
                return {
                    audioEnabled: audioEnabledRef.current,
                    hasToken: !!localStorage.getItem('jarvis_token')
                };
            }
        };

        console.log('🎙️ jarvisVoice debug interface loaded. Use window.jarvisVoice.test("text") to test.');

        return () => {
            delete window.jarvisVoice;
        };
    }, []);

    // ═══════════════════════════════════════════════════════════════
    // VOCAL LINK HANDLERS (v12.2)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Handle incoming transcripts from VoiceHandler
     * Creates typing effect for streaming text
     */
    const handleVocalTranscript = useCallback((transcript) => {
        const { role, content, partial } = transcript;

        if (role === 'assistant') {
            if (partial) {
                // Streaming: update or create streaming message
                if (!streamingMessageIdRef.current) {
                    streamingMessageIdRef.current = Date.now();
                    setMessages(prev => [...prev, {
                        id: streamingMessageIdRef.current,
                        role: 'assistant',
                        content: content,
                        timestamp: new Date(),
                        streaming: true
                    }]);
                } else {
                    // Update existing streaming message (typing effect)
                    setMessages(prev => prev.map(msg =>
                        msg.id === streamingMessageIdRef.current
                            ? { ...msg, content: msg.content + content }
                            : msg
                    ));
                }
            } else {
                // Final transcript - finalize streaming message
                if (streamingMessageIdRef.current) {
                    setMessages(prev => prev.map(msg =>
                        msg.id === streamingMessageIdRef.current
                            ? { ...msg, content, streaming: false }
                            : msg
                    ));
                    streamingMessageIdRef.current = null;
                } else {
                    // Direct final message
                    setMessages(prev => [...prev, {
                        id: Date.now(),
                        role: 'assistant',
                        content,
                        timestamp: new Date()
                    }]);
                }
            }
        } else if (role === 'user') {
            // User's transcribed speech
            setMessages(prev => [...prev, {
                id: Date.now(),
                role: 'user',
                content,
                timestamp: new Date()
            }]);
        }
    }, []);

    /**
     * Handle VoiceHandler status changes
     * Syncs HUD indicators with realtime audio state
     */
    const handleVocalStatusChange = useCallback((status) => {
        setVocalLinkStatus(status);
        setIsListening(status.isListening);
        setIsSpeaking(status.isSpeaking);

        // Simulate audio intensity for Arc Reactor visualization
        if (status.isSpeaking) {
            setAudioIntensity(Math.random() * 0.5 + 0.5); // 0.5-1.0
        } else {
            setAudioIntensity(0);
        }
    }, []);

    /**
     * Send barge-in cancel event when user starts speaking
     * Makes conversation feel natural by interrupting AI
     */
    const handleBargeIn = useCallback(() => {
        if (isSpeaking && voiceHandlerRef.current?.sendCancel) {
            console.log('🛑 Barge-in: Canceling AI response');
            voiceHandlerRef.current.sendCancel();
            setIsSpeaking(false);

            // Clear any streaming message
            if (streamingMessageIdRef.current) {
                setMessages(prev => prev.map(msg =>
                    msg.id === streamingMessageIdRef.current
                        ? { ...msg, content: msg.content + ' [interrupted]', streaming: false }
                        : msg
                ));
                streamingMessageIdRef.current = null;
            }
        }
    }, [isSpeaking]);

    // Trigger barge-in when user starts listening while AI is speaking
    useEffect(() => {
        if (isListening && isSpeaking) {
            handleBargeIn();
        }
    }, [isListening, isSpeaking, handleBargeIn]);

    // ═══════════════════════════════════════════════════════════════
    // AUDIO EVENT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * useEffect hook for managing audio element event listeners.
     * Syncs the isSpeaking state with actual audio playback status
     * to drive the HUD visualizer animations.
     */
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        // Event handlers for audio state synchronization
        const handlePlay = () => {
            setIsSpeaking(true);
            setAutoplayBlocked(false);
        };

        const handleEnded = () => {
            setIsSpeaking(false);
            // Cleanup blob URL after playback completes
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };

        const handlePause = () => {
            setIsSpeaking(false);
        };

        const handleError = (e) => {
            console.error('Audio playback error:', e);
            setIsSpeaking(false);
        };

        // Attach event listeners
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('error', handleError);

        // Cleanup: remove event listeners when audio element changes
        return () => {
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('error', handleError);
        };
    }, [audioRef.current]); // Re-run when audio element changes

    // ═══════════════════════════════════════════════════════════════
    // CHAT LOGIC
    // ═══════════════════════════════════════════════════════════════

    const sendMessage = async (text = inputText) => {
        if (!text.trim() || isLoading) return;

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: text.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setInputText('');
        setIsLoading(true);

        try {
            // ─────────────────────────────────────────────────────────────
            // INTERRUPT PREVIOUS AUDIO: Stop and clean up any playing audio
            // ─────────────────────────────────────────────────────────────
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.currentTime = 0;
                audioRef.current = null;
            }

            // Revoke previous blob URL to prevent memory leaks
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }

            // Reset autoplay blocked state for new request
            setAutoplayBlocked(false);
            setIsSpeaking(false);

            // ─────────────────────────────────────────────────────────────
            // AUTHENTICATED POST REQUEST to /chat endpoint
            // Using authFetch wrapper to ensure proper method and headers
            // ─────────────────────────────────────────────────────────────
            const response = await authFetch(API_CONFIG.ENDPOINTS.CHAT, {
                method: 'POST',
                body: JSON.stringify({ text: text.trim() }),
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            // ─────────────────────────────────────────────────────────────
            // RESPONSE HANDLING (Audio vs JSON Failover) - v11.3
            // ─────────────────────────────────────────────────────────────
            const contentType = response.headers.get('content-type');

            // Check for JSON response (Audio Generation Failed / Text-Only)
            if (contentType && contentType.includes('application/json')) {
                const data = await response.json();

                // Add assistant message (text-only)
                const assistantMessage = {
                    id: Date.now() + 1,
                    role: 'assistant',
                    content: data.text || 'Received empty response',
                    timestamp: new Date()
                };
                setMessages(prev => [...prev, assistantMessage]);

                // Handle Audio Failure Flag
                if (data.audioFailed) {
                    console.warn('⚠️ Audio generation failed - Fallback to Text Mode');

                    // Trigger System Notification
                    const systemNotification = {
                        id: Date.now() + 2,
                        role: 'system',
                        content: '⚠️ Voice System Offline - Text Mode Active',
                        timestamp: new Date()
                    };
                    setMessages(prev => [...prev, systemNotification]);
                }

                setIsLoading(false);
                return; // processing complete, no audio to play
            }

            // ─────────────────────────────────────────────────────────────
            // AUDIO RESPONSE HANDLING (Standard Flow)
            // ─────────────────────────────────────────────────────────────

            // Extract Gemini response from header (Base64 encoded) for audio streams
            const geminiResponseBase64 = response.headers.get('X-Gemini-Response');
            let assistantText = 'Audio response received';

            if (geminiResponseBase64) {
                try {
                    assistantText = atob(geminiResponseBase64);
                } catch (e) {
                    console.error('Failed to decode response:', e);
                }
            }

            const assistantMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: assistantText,
                timestamp: new Date()
            };

            setMessages(prev => [...prev, assistantMessage]);

            // Process audio blob
            const arrayBuffer = await response.arrayBuffer();
            console.log('🔊 Audio chunk received:', arrayBuffer.byteLength, 'bytes');
            const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);
            blobUrlRef.current = blobUrl;

            const audio = new Audio(blobUrl);
            audioRef.current = audio;

            // Autoplay handling
            try {
                await audio.play();
            } catch (playError) {
                if (playError.name === 'NotAllowedError') {
                    console.warn('Autoplay blocked. User interaction required.');
                    setAutoplayBlocked(true);

                    const autoplayWarning = {
                        id: Date.now() + 2,
                        role: 'system',
                        content: '⚠️ Audio autoplay blocked. Click to enable audio.',
                        timestamp: new Date()
                    };
                    setMessages(prev => [...prev, autoplayWarning]);
                } else {
                    throw playError;
                }
            }

        } catch (error) {
            console.error('Chat error:', error);
            const errorMessage = {
                id: Date.now() + 1,
                role: 'system',
                content: `Connection error: ${error.message}`,
                timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Manual trigger for audio playback when autoplay is blocked.
     * Called from the HUD when user clicks to enable audio.
     */
    const triggerManualPlay = async () => {
        if (audioRef.current && autoplayBlocked) {
            try {
                await audioRef.current.play();
                setAutoplayBlocked(false);
            } catch (error) {
                console.error('Manual play failed:', error);
            }
        }
    };

    /**
     * Enable audio context - must be called on user interaction
     * This satisfies browser autoplay policy requirements
     */
    const enableAudio = useCallback(() => {
        audioEnabledRef.current = true;
        setAudioEnabled(true); // Update state to trigger re-render
        setAutoplayBlocked(false);
        console.log('✅ Audio enabled by user interaction');

        // Resume any suspended AudioContext
        if (window.AudioContext || window.webkitAudioContext) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') {
                ctx.resume();
            }
        }
    }, []);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const toggleVoiceCommand = () => {
        setIsListening(!isListening);
        // TODO: Implement Web Speech API for voice recognition
        console.log('Voice command toggled:', !isListening);
    };

    // ═══════════════════════════════════════════════════════════════
    // RENDER HELPERS
    // ═══════════════════════════════════════════════════════════════

    const formatTime = (date) => {
        return date.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    const formatDate = (date) => {
        return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: '2-digit',
            year: 'numeric'
        }).toUpperCase();
    };

    // ═══════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 font-mono text-white overflow-hidden relative">

            {/* ─────────────────────────────────────────────────────────
                BACKGROUND EFFECTS
            ───────────────────────────────────────────────────────── */}
            {/* HUD Grid */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(34,211,238,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none" />

            {/* Scanning Line Animation */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute w-full h-1 bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent animate-scan" />
            </div>

            {/* Radial Glow */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.05)_0%,transparent_50%)] pointer-events-none" />

            {/* ─────────────────────────────────────────────────────────
                TOP HEADER
            ───────────────────────────────────────────────────────── */}
            <header className="relative z-10 flex justify-between items-center px-6 py-4 border-b border-cyan-500/20">
                {/* Left - System Status */}
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.6)] animate-pulse" />
                        <span className="text-green-400 text-sm tracking-[0.2em] uppercase">System Status: Active</span>
                    </div>
                    {user && (
                        <div className="text-cyan-400/60 text-xs tracking-wide border-l border-cyan-500/30 pl-4">
                            OPERATOR: <span className="text-cyan-400">{user.username?.toUpperCase() || 'UNKNOWN'}</span>
                        </div>
                    )}
                </div>

                {/* Center - Logo */}
                <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3">
                    <div className="w-8 h-8 relative">
                        <div className="absolute inset-0 rounded-full bg-cyan-400/20 animate-ping" style={{ animationDuration: '3s' }} />
                        <div className="absolute inset-1 rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_15px_rgba(34,211,238,0.5)]" />
                        <div className="absolute inset-2.5 rounded-full bg-gray-900 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                        </div>
                    </div>
                    <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500 tracking-[0.3em]">J.A.R.V.I.S</span>
                </div>

                {/* Right - Clock, Audio Enable & Logout */}
                <div className="flex items-center gap-4">
                    {/* ENABLE AUDIO Button - Red until enabled */}
                    <button
                        onClick={enableAudio}
                        className={`px-4 py-2 text-xs uppercase tracking-wider rounded font-bold transition-all duration-300 flex items-center gap-2 ${audioEnabled
                            ? 'border border-green-500/50 text-green-400 bg-green-500/10 shadow-[0_0_10px_rgba(74,222,128,0.3)]'
                            : 'border-2 border-red-500 text-red-400 bg-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.4)] animate-pulse hover:bg-red-500/30'
                            }`}
                    >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                        </svg>
                        {audioEnabled ? 'AUDIO ON' : 'ENABLE AUDIO'}
                    </button>

                    <div className="text-right">
                        <div className="text-2xl text-cyan-400 tracking-[0.15em] font-bold shadow-[0_0_20px_rgba(34,211,238,0.3)]">
                            {formatTime(currentTime)}
                        </div>
                        <div className="text-xs text-cyan-500/50 tracking-[0.2em]">
                            {formatDate(currentTime)}
                        </div>
                    </div>
                    {onLogout && (
                        <button
                            onClick={onLogout}
                            className="px-4 py-2 border border-red-500/30 text-red-400 text-xs uppercase tracking-wider rounded hover:bg-red-500/10 hover:border-red-500/50 transition-all duration-300"
                        >
                            Logout
                        </button>
                    )}
                </div>
            </header>

            {/* ─────────────────────────────────────────────────────────
                MAIN CONTENT AREA
            ───────────────────────────────────────────────────────── */}
            <main className="relative z-10 flex h-[calc(100vh-140px)]">

                {/* ─────────────────────────────────────────────────────
                    LEFT SIDE PANEL - System Metrics
                ───────────────────────────────────────────────────── */}
                <aside className="w-48 p-4 border-r border-cyan-500/20">
                    <h3 className="text-cyan-400/60 text-xs tracking-[0.2em] uppercase mb-4">System Metrics</h3>

                    {/* CPU */}
                    <div className="mb-4">
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-cyan-400/70">CPU LOAD</span>
                            <span className="text-cyan-400">{systemMetrics.cpu.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(34,211,238,0.5)]"
                                style={{ width: `${systemMetrics.cpu}%` }}
                            />
                        </div>
                    </div>

                    {/* Memory */}
                    <div className="mb-4">
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-cyan-400/70">MEMORY</span>
                            <span className="text-cyan-400">{systemMetrics.memory.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(96,165,250,0.5)]"
                                style={{ width: `${systemMetrics.memory}%` }}
                            />
                        </div>
                    </div>

                    {/* Network */}
                    <div className="mb-4">
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-cyan-400/70">NETWORK</span>
                            <span className="text-green-400">{systemMetrics.network.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(74,222,128,0.5)]"
                                style={{ width: `${systemMetrics.network}%` }}
                            />
                        </div>
                    </div>

                    {/* Power */}
                    <div className="mb-4">
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-cyan-400/70">ARC POWER</span>
                            <span className="text-yellow-400">{systemMetrics.power.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-yellow-500 to-yellow-400 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(250,204,21,0.5)]"
                                style={{ width: `${systemMetrics.power}%` }}
                            />
                        </div>
                    </div>

                    {/* Status Indicators */}
                    <div className="mt-8 pt-4 border-t border-cyan-500/20">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-xs">
                                <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
                                <span className="text-gray-400">AI Core Online</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]" />
                                <span className="text-gray-400">Voice Synth Ready</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.8)] animate-pulse' : 'bg-gray-600'}`} />
                                <span className="text-gray-400">Mic {isListening ? 'Active' : 'Standby'}</span>
                            </div>
                        </div>
                    </div>

                    {/* ─────────────────────────────────────────────────
                        VOCAL PROTOCOL (v12.2)
                    ───────────────────────────────────────────────── */}
                    <div className="mt-6 pt-4 border-t border-cyan-500/20">
                        <h3 className="text-cyan-400/60 text-xs tracking-[0.2em] uppercase mb-4">Vocal Protocol</h3>

                        {/* Toggle Button */}
                        <button
                            onClick={() => setVocalLinkEnabled(!vocalLinkEnabled)}
                            className={`w-full flex items-center justify-between px-3 py-3 rounded-lg border transition-all duration-300 ${vocalLinkEnabled
                                ? 'border-cyan-400/60 bg-cyan-500/10 shadow-[0_0_15px_rgba(34,211,238,0.3)]'
                                : 'border-cyan-500/20 bg-gray-800/50 hover:border-cyan-500/40'
                                }`}
                        >
                            <div className="flex items-center gap-2">
                                <div className={`w-3 h-3 rounded-full transition-all duration-300 ${vocalLinkEnabled
                                    ? 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)] animate-pulse'
                                    : 'bg-gray-600'
                                    }`} />
                                <span className={`text-xs tracking-wider ${vocalLinkEnabled ? 'text-cyan-400' : 'text-gray-400'}`}>
                                    {vocalLinkEnabled ? 'ACTIVE' : 'STANDBY'}
                                </span>
                            </div>
                            <span className="text-[10px] text-cyan-500/50 tracking-wider">
                                {vocalLinkEnabled ? 'v12.2' : 'INIT'}
                            </span>
                        </button>

                        {/* Vocal Link Status */}
                        {vocalLinkEnabled && vocalLinkStatus && (
                            <div className="mt-3 space-y-2 text-xs">
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Connection</span>
                                    <span className={vocalLinkStatus.isConnected ? 'text-green-400' : 'text-red-400'}>
                                        {vocalLinkStatus.connectionStatus?.toUpperCase() || 'UNKNOWN'}
                                    </span>
                                </div>
                                {vocalLinkStatus.error && (
                                    <div className="text-red-400/80 text-[10px]">
                                        ⚠ {vocalLinkStatus.error}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Hidden VoiceHandler - mounts when enabled */}
                        {vocalLinkEnabled && (
                            <div className="hidden">
                                <VoiceHandler
                                    ref={voiceHandlerRef}
                                    onTranscript={handleVocalTranscript}
                                    onStatusChange={handleVocalStatusChange}
                                />
                            </div>
                        )}
                    </div>
                </aside>

                {/* ─────────────────────────────────────────────────────
                    CENTER CONSOLE
                ───────────────────────────────────────────────────── */}
                <div className="flex-1 flex flex-col items-center p-6">

                    {/* Voice Visualizer */}
                    <div className="relative mb-6">
                        {/* Outer Rings */}
                        <div className={`w-48 h-48 relative ${isSpeaking ? 'animate-pulse' : ''}`}>
                            {/* Pulsing outer ring when speaking */}
                            {isSpeaking && (
                                <div className="absolute -inset-4 rounded-full bg-cyan-400/10 animate-ping" style={{ animationDuration: '1s' }} />
                            )}
                            {/* Outer decorative ring */}
                            <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20" />
                            <div className="absolute inset-2 rounded-full border border-cyan-500/30" />
                            {/* Main visualizer ring */}
                            <div className={`absolute inset-4 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border-2 border-cyan-400/50 shadow-[0_0_30px_rgba(34,211,238,0.3)] transition-all duration-300 ${isSpeaking ? 'scale-105 shadow-[0_0_50px_rgba(34,211,238,0.5)]' : ''}`} />
                            {/* Inner rings */}
                            <div className="absolute inset-8 rounded-full border border-cyan-400/40" />
                            <div className="absolute inset-12 rounded-full bg-gray-900/80 border border-cyan-500/30 flex items-center justify-center">
                                {/* Core indicator */}
                                <div className={`w-12 h-12 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 shadow-[0_0_20px_rgba(34,211,238,0.6)] flex items-center justify-center transition-all duration-300 ${isSpeaking ? 'scale-110' : ''}`}>
                                    {isLoading ? (
                                        <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : isSpeaking ? (
                                        <div className="flex gap-1">
                                            <div className="w-1 h-4 bg-white rounded animate-soundbar1" />
                                            <div className="w-1 h-6 bg-white rounded animate-soundbar2" />
                                            <div className="w-1 h-3 bg-white rounded animate-soundbar3" />
                                        </div>
                                    ) : (
                                        <div className="w-4 h-4 rounded-full bg-white shadow-[0_0_10px_#fff]" />
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Status Label */}
                        <div className={`absolute -bottom-2 left-1/2 -translate-x-1/2 px-4 py-1 bg-gray-900/90 border rounded text-xs tracking-[0.2em] uppercase ${autoplayBlocked ? 'border-yellow-500/50 text-yellow-400 cursor-pointer hover:bg-yellow-500/10' : 'border-cyan-500/30 text-cyan-400'}`}
                            onClick={autoplayBlocked ? triggerManualPlay : undefined}
                        >
                            {autoplayBlocked ? '⚠️ Click to Play Audio' : isLoading ? 'Processing...' : isSpeaking ? 'Speaking...' : isListening ? 'Listening...' : 'Standby'}
                        </div>
                    </div>

                    {/* ─────────────────────────────────────────────────
                        CONVERSATION DISPLAY
                    ───────────────────────────────────────────────── */}
                    <div className="flex-1 w-full max-w-2xl overflow-hidden flex flex-col">
                        <div className="flex-1 overflow-y-auto pr-2 space-y-3 scrollbar-thin scrollbar-thumb-cyan-500/30 scrollbar-track-transparent">
                            {messages.length === 0 ? (
                                <div className="text-center text-cyan-500/40 text-sm py-8">
                                    <p className="tracking-wider">JARVIS INTERFACE INITIALIZED</p>
                                    <p className="mt-2 text-xs tracking-wide">Awaiting command input...</p>
                                </div>
                            ) : (
                                messages.map((msg) => (
                                    <div
                                        key={msg.id}
                                        className={`p-3 rounded-lg ${msg.role === 'user'
                                            ? 'bg-cyan-500/10 border border-cyan-500/30 ml-12'
                                            : msg.role === 'system'
                                                ? 'bg-red-500/10 border border-red-500/30'
                                                : 'bg-blue-500/10 border border-blue-500/30 mr-12'
                                            }`}
                                    >
                                        <div className="flex justify-between items-center mb-1">
                                            <span className={`text-xs uppercase tracking-wider ${msg.role === 'user' ? 'text-cyan-400' : msg.role === 'system' ? 'text-red-400' : 'text-blue-400'
                                                }`}>
                                                {msg.role === 'user' ? '👤 You' : msg.role === 'system' ? '⚠ System' : '🤖 Jarvis'}
                                            </span>
                                            <span className="text-gray-500 text-xs">
                                                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <p className="text-gray-200 text-sm leading-relaxed">{msg.content}</p>
                                    </div>
                                ))
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {/* ─────────────────────────────────────────────────────
                    RIGHT SIDE PANEL - Quick Actions
                ───────────────────────────────────────────────────── */}
                <aside className="w-48 p-4 border-l border-cyan-500/20">
                    <h3 className="text-cyan-400/60 text-xs tracking-[0.2em] uppercase mb-4">Quick Commands</h3>

                    <div className="space-y-2">
                        {['System Status', 'Weather Report', 'News Brief', 'Set Reminder'].map((cmd) => (
                            <button
                                key={cmd}
                                onClick={() => sendMessage(cmd)}
                                disabled={isLoading}
                                className="w-full text-left px-3 py-2 text-xs text-cyan-400/70 border border-cyan-500/20 rounded hover:bg-cyan-500/10 hover:border-cyan-500/40 hover:text-cyan-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed tracking-wide"
                            >
                                ▸ {cmd}
                            </button>
                        ))}
                    </div>

                    {/* Session Info */}
                    <div className="mt-8 pt-4 border-t border-cyan-500/20">
                        <h4 className="text-cyan-400/60 text-xs tracking-[0.2em] uppercase mb-3">Session Info</h4>
                        <div className="space-y-2 text-xs">
                            <div className="flex justify-between">
                                <span className="text-gray-500">Messages</span>
                                <span className="text-cyan-400">{messages.length}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Uptime</span>
                                <span className="text-cyan-400">Active</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Latency</span>
                                <span className="text-green-400">12ms</span>
                            </div>
                        </div>
                    </div>
                </aside>
            </main>

            {/* ─────────────────────────────────────────────────────────
                BOTTOM TRAY - Input Area
            ───────────────────────────────────────────────────────── */}
            <footer className="absolute bottom-0 left-0 right-0 z-10 border-t border-cyan-500/20 bg-gray-900/95 backdrop-blur-xl p-4">
                <div className="max-w-4xl mx-auto flex items-center gap-4">
                    {/* Voice Command Toggle */}
                    <button
                        onClick={toggleVoiceCommand}
                        className={`relative p-4 rounded-full border-2 transition-all duration-300 ${isListening
                            ? 'border-cyan-400 bg-cyan-400/20 shadow-[0_0_20px_rgba(34,211,238,0.5)]'
                            : 'border-cyan-500/30 bg-gray-800/50 hover:border-cyan-500/50'
                            }`}
                    >
                        {isListening && (
                            <div className="absolute inset-0 rounded-full bg-cyan-400/20 animate-ping" />
                        )}
                        <svg className={`w-6 h-6 ${isListening ? 'text-cyan-400' : 'text-cyan-500/70'}`} fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                        </svg>
                    </button>

                    {/* Text Input */}
                    <div className="flex-1 relative">
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={isLoading}
                            placeholder="Enter command or speak..."
                            className="w-full bg-gray-800/60 border border-cyan-500/30 rounded-lg px-5 py-4 text-cyan-100 placeholder-gray-500 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 tracking-wide disabled:opacity-50 disabled:cursor-not-allowed pr-24"
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-cyan-500/50 tracking-wider">
                            PRESS ENTER
                        </div>
                    </div>

                    {/* Send Button */}
                    <button
                        onClick={() => sendMessage()}
                        disabled={isLoading || !inputText.trim()}
                        className="px-6 py-4 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-lg transition-all duration-300 shadow-[0_0_15px_rgba(34,211,238,0.3)] disabled:opacity-50 disabled:cursor-not-allowed tracking-widest text-sm uppercase flex items-center gap-2"
                    >
                        {isLoading ? (
                            <>
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>Sending</span>
                            </>
                        ) : (
                            <>
                                <span>Execute</span>
                                <span>▶</span>
                            </>
                        )}
                    </button>
                </div>
            </footer>

            {/* ─────────────────────────────────────────────────────────
                CUSTOM ANIMATIONS
            ───────────────────────────────────────────────────────── */}
            <style>{`
                @keyframes scan {
                    0% { top: 0; opacity: 0; }
                    10% { opacity: 1; }
                    90% { opacity: 1; }
                    100% { top: 100%; opacity: 0; }
                }
                .animate-scan {
                    animation: scan 4s linear infinite;
                }
                
                @keyframes soundbar1 {
                    0%, 100% { height: 8px; }
                    50% { height: 16px; }
                }
                @keyframes soundbar2 {
                    0%, 100% { height: 16px; }
                    50% { height: 8px; }
                }
                @keyframes soundbar3 {
                    0%, 100% { height: 12px; }
                    50% { height: 20px; }
                }
                .animate-soundbar1 { animation: soundbar1 0.4s ease-in-out infinite; }
                .animate-soundbar2 { animation: soundbar2 0.4s ease-in-out infinite 0.1s; }
                .animate-soundbar3 { animation: soundbar3 0.4s ease-in-out infinite 0.2s; }

                /* Scrollbar styling */
                .scrollbar-thin::-webkit-scrollbar { width: 4px; }
                .scrollbar-thumb-cyan-500\\/30::-webkit-scrollbar-thumb { background: rgba(34,211,238,0.3); border-radius: 2px; }
                .scrollbar-track-transparent::-webkit-scrollbar-track { background: transparent; }
            `}</style>
        </div>
    );
};

export default Dashboard;
