import React, { useState, useEffect } from 'react';
import { API_CONFIG, tokenManager, audioManager } from './config';

/**
 * Auth Component - Iron Man HUD Style Authentication Interface (v11.0 Production)
 * 
 * Integrated with hardened Cloud Run backend for authentication.
 * Features Arc Reactor initialization animation on successful login.
 * Uses centralized config for API endpoints and token management.
 * 
 * @param {Function} onAuthSuccess - Callback fired on successful authentication with user data
 */

// Re-export tokenManager and authFetch for backward compatibility
export { tokenManager, authFetch } from './config';

// Production API Base URL from centralized config
const API_BASE_URL = API_CONFIG.BASE_URL;

const Auth = ({ onAuthSuccess }) => {
    // ═══════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    const [isLoginMode, setIsLoginMode] = useState(true);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');

    // Arc Reactor Initialization Animation State
    const [showInitAnimation, setShowInitAnimation] = useState(false);
    const [initPhase, setInitPhase] = useState(0);
    const [initMessages, setInitMessages] = useState([]);

    // Check for existing auth on mount
    useEffect(() => {
        const token = tokenManager.getToken();
        const user = tokenManager.getUser();
        if (token && user && onAuthSuccess) {
            onAuthSuccess(user);
        }
    }, [onAuthSuccess]);

    // ═══════════════════════════════════════════════════════════════
    // ARC REACTOR INITIALIZATION ANIMATION
    // ═══════════════════════════════════════════════════════════════
    const runInitializationSequence = async (user) => {
        setShowInitAnimation(true);

        const phases = [
            { phase: 1, message: 'ESTABLISHING SECURE CONNECTION...', delay: 600 },
            { phase: 2, message: 'AUTHENTICATING STARK CREDENTIALS...', delay: 800 },
            { phase: 3, message: 'LOADING USER PROFILE...', delay: 600 },
            { phase: 4, message: 'INITIALIZING ARC REACTOR CORE...', delay: 1000 },
            { phase: 5, message: `WELCOME, ${user.username?.toUpperCase() || 'OPERATOR'}`, delay: 800 },
            { phase: 6, message: 'SYSTEM ONLINE. ALL SYSTEMS NOMINAL.', delay: 600 },
        ];

        for (const { phase, message, delay } of phases) {
            setInitPhase(phase);
            setInitMessages(prev => [...prev, message]);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Final flash and redirect
        await new Promise(resolve => setTimeout(resolve, 500));

        if (onAuthSuccess) {
            onAuthSuccess(user);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // LIVE AUTHENTICATION HANDLER
    // ═══════════════════════════════════════════════════════════════
    const handleAuthSubmit = async (isRegister) => {
        setError('');

        // ─────────────────────────────────────────────────────────────
        // CLIENT-SIDE VALIDATION
        // ─────────────────────────────────────────────────────────────
        if (!username.trim()) {
            setError('Username is required');
            return;
        }

        if (!password.trim()) {
            setError('Password is required');
            return;
        }

        if (password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }

        if (isRegister) {
            if (!confirmPassword.trim()) {
                setError('Please confirm your password');
                return;
            }
            if (password !== confirmPassword) {
                setError('Passwords do not match');
                return;
            }
        }

        setIsLoading(true);

        console.log('══════════════════════════════════════════════════════');
        console.log(`🔐 STARK SECURITY PROTOCOL v9.0 - ${isRegister ? 'REGISTER' : 'LOGIN'}`);
        console.log(`👤 Username: ${username}`);
        console.log(`📡 Target: ${API_BASE_URL}`);
        console.log('══════════════════════════════════════════════════════');

        // ─────────────────────────────────────────────────────────────
        // LIVE API INTEGRATION
        // ─────────────────────────────────────────────────────────────
        const endpoint = isRegister
            ? `${API_BASE_URL}/api/auth/register`
            : `${API_BASE_URL}/api/auth/login`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Authentication failed');
            }

            console.log('✅ Authentication successful:', data);

            // ─────────────────────────────────────────────────────────────
            // TOKEN STORAGE
            // ─────────────────────────────────────────────────────────────
            const token = data.token;
            const user = data.user || { username, id: data.userId };

            tokenManager.setAuth(token, user);

            console.log('🔑 Token stored securely');
            console.log('👤 User profile cached');

            // ─────────────────────────────────────────────────────────────
            // ARC REACTOR INITIALIZATION ANIMATION
            // ─────────────────────────────────────────────────────────────
            setIsLoading(false);
            await runInitializationSequence(user);

        } catch (err) {
            console.error('❌ Authentication error:', err);
            setError(err.message || 'Connection to Stark servers failed');
            setIsLoading(false);
        }
    };

    const toggleMode = () => {
        setIsLoginMode(!isLoginMode);
        setError('');
        setConfirmPassword('');
    };

    // ═══════════════════════════════════════════════════════════════
    // ARC REACTOR INITIALIZATION OVERLAY
    // ═══════════════════════════════════════════════════════════════
    if (showInitAnimation) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center font-mono overflow-hidden">
                {/* Background pulse */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.1)_0%,transparent_50%)] animate-pulse" />

                {/* Scanning lines */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent animate-initScan" />
                </div>

                <div className="relative z-10 text-center">
                    {/* Arc Reactor */}
                    <div className="w-40 h-40 mx-auto mb-8 relative">
                        {/* Expanding rings */}
                        <div className={`absolute inset-0 rounded-full border-2 border-cyan-400/30 transition-all duration-500 ${initPhase >= 1 ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} />
                        <div className={`absolute inset-4 rounded-full border-2 border-cyan-400/50 transition-all duration-500 delay-100 ${initPhase >= 2 ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} />
                        <div className={`absolute inset-8 rounded-full bg-gradient-to-br from-cyan-400/20 to-blue-600/20 border-2 border-cyan-400 transition-all duration-500 delay-200 ${initPhase >= 3 ? 'scale-100 opacity-100' : 'scale-50 opacity-0'} ${initPhase >= 4 ? 'shadow-[0_0_60px_rgba(34,211,238,0.8)]' : ''}`} />
                        <div className={`absolute inset-12 rounded-full bg-gray-900 border border-cyan-500 transition-all duration-500 delay-300 ${initPhase >= 4 ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} />

                        {/* Core */}
                        <div className={`absolute inset-16 rounded-full bg-gradient-to-br from-cyan-300 to-cyan-500 transition-all duration-700 ${initPhase >= 5 ? 'scale-100 opacity-100 shadow-[0_0_40px_rgba(34,211,238,1)]' : 'scale-0 opacity-0'}`}>
                            <div className="absolute inset-2 rounded-full bg-white/80 shadow-[0_0_20px_#fff]" />
                        </div>
                    </div>

                    {/* Status Messages */}
                    <div className="space-y-2 max-w-md mx-auto">
                        {initMessages.map((msg, index) => (
                            <div
                                key={index}
                                className={`text-sm tracking-[0.15em] animate-fadeIn ${index === initMessages.length - 1 ? 'text-cyan-400' : 'text-cyan-600/60'}`}
                            >
                                {msg}
                            </div>
                        ))}
                    </div>

                    {/* Progress bar */}
                    <div className="mt-8 w-64 mx-auto h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500 shadow-[0_0_10px_rgba(34,211,238,0.5)]"
                            style={{ width: `${(initPhase / 6) * 100}%` }}
                        />
                    </div>
                </div>

                <style>{`
                    @keyframes initScan {
                        0% { top: 0; opacity: 0; }
                        10% { opacity: 1; }
                        90% { opacity: 1; }
                        100% { top: 100%; opacity: 0; }
                    }
                    .animate-initScan {
                        animation: initScan 2s linear infinite;
                    }
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(10px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .animate-fadeIn {
                        animation: fadeIn 0.4s ease-out forwards;
                    }
                `}</style>
            </div>
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // MAIN AUTH FORM RENDER
    // ═══════════════════════════════════════════════════════════════
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex items-center justify-center p-4 font-mono">
            {/* Background Effects */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(34,211,238,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.02)_1px,transparent_1px)] bg-[size:50px_50px] pointer-events-none" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.08)_0%,transparent_60%)] pointer-events-none" />
            <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,0,0,0.1)_2px,rgba(0,0,0,0.1)_4px)] pointer-events-none opacity-30" />

            {/* Main Auth Container */}
            <div className="relative w-full max-w-md z-10">
                <div className="absolute -inset-1 bg-gradient-to-r from-cyan-500 via-blue-500 to-cyan-500 rounded-2xl blur-md opacity-40 animate-pulse" />

                <div className="relative bg-gray-900/95 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-8 shadow-[0_0_15px_rgba(34,211,238,0.3)]">

                    {/* Header */}
                    <div className="text-center mb-8">
                        <div className="w-20 h-20 mx-auto mb-6 relative">
                            <div className="absolute inset-0 rounded-full bg-cyan-400/20 animate-ping" style={{ animationDuration: '2s' }} />
                            <div className="absolute inset-0 rounded-full border-2 border-cyan-400/50 shadow-[0_0_20px_rgba(34,211,238,0.5)]" />
                            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_30px_rgba(34,211,238,0.6)]" />
                            <div className="absolute inset-4 rounded-full bg-gray-900 border border-cyan-400/30" />
                            <div className="absolute inset-6 rounded-full bg-gradient-to-br from-cyan-300 to-cyan-500 shadow-[0_0_15px_rgba(34,211,238,0.8)] flex items-center justify-center">
                                <div className="w-3 h-3 rounded-full bg-white shadow-[0_0_10px_#fff]" />
                            </div>
                        </div>

                        <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-cyan-300 to-blue-500 tracking-widest uppercase">
                            {isLoginMode ? 'Access Interface' : 'Create Profile'}
                        </h1>
                        <p className="text-cyan-500/60 text-xs mt-3 tracking-[0.2em] uppercase">
                            Stark Industries Security Protocol v9.0
                        </p>
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/40 rounded-lg shadow-[0_0_10px_rgba(239,68,68,0.2)] animate-shake">
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                <p className="text-red-400 text-sm tracking-wide">
                                    ⚠ {error}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Form */}
                    <form onSubmit={(e) => { e.preventDefault(); handleAuthSubmit(!isLoginMode); }}>

                        {/* Username */}
                        <div className="mb-5 group">
                            <label className="block text-cyan-400/70 text-xs uppercase tracking-[0.15em] mb-2 flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                                Username
                            </label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                disabled={isLoading}
                                placeholder="stark_user"
                                autoComplete="username"
                                className="w-full bg-gray-800/60 border border-cyan-500/30 rounded-lg px-4 py-3.5 text-cyan-100 placeholder-gray-500 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 tracking-wide disabled:opacity-40"
                            />
                        </div>

                        {/* Password */}
                        <div className="mb-5 group">
                            <label className="block text-cyan-400/70 text-xs uppercase tracking-[0.15em] mb-2 flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                                Password
                            </label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={isLoading}
                                placeholder="••••••••"
                                autoComplete={isLoginMode ? "current-password" : "new-password"}
                                className="w-full bg-gray-800/60 border border-cyan-500/30 rounded-lg px-4 py-3.5 text-cyan-100 placeholder-gray-500 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 tracking-wide disabled:opacity-40"
                            />
                            <p className="text-gray-500 text-xs mt-2 tracking-wide">Minimum 6 characters</p>
                        </div>

                        {/* Confirm Password (Register) */}
                        <div className={`overflow-hidden transition-all duration-500 ease-out ${!isLoginMode ? 'max-h-32 opacity-100 mb-5' : 'max-h-0 opacity-0 mb-0'}`}>
                            <div className="group">
                                <label className="block text-cyan-400/70 text-xs uppercase tracking-[0.15em] mb-2 flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                                    Confirm Password
                                </label>
                                <input
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    disabled={isLoading || isLoginMode}
                                    placeholder="••••••••"
                                    autoComplete="new-password"
                                    className="w-full bg-gray-800/60 border border-cyan-500/30 rounded-lg px-4 py-3.5 text-cyan-100 placeholder-gray-500 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 tracking-wide disabled:opacity-40"
                                />
                            </div>
                        </div>

                        {/* Submit Button */}
                        <button
                            type="submit"
                            disabled={isLoading}
                            className="w-full relative group mt-4"
                        >
                            <div className="absolute -inset-0.5 bg-gradient-to-r from-cyan-500 to-blue-500 rounded-lg blur opacity-50 group-hover:opacity-80 transition duration-300" />

                            <div className="relative bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold py-4 px-6 rounded-lg transition-all duration-300 flex items-center justify-center gap-3 shadow-[0_0_15px_rgba(34,211,238,0.3)] disabled:opacity-50 uppercase tracking-widest text-sm">
                                {isLoading ? (
                                    <>
                                        <div className="relative w-5 h-5">
                                            <div className="absolute inset-0 rounded-full border-2 border-cyan-300/30" />
                                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-white animate-spin" />
                                        </div>
                                        <span className="tracking-[0.2em]">Authenticating...</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-lg">▶</span>
                                        <span className="tracking-[0.2em]">
                                            {isLoginMode ? 'Initialize Login' : 'Create Account'}
                                        </span>
                                    </>
                                )}
                            </div>
                        </button>
                    </form>

                    {/* Toggle Mode */}
                    <div className="mt-6 text-center">
                        <button
                            type="button"
                            onClick={toggleMode}
                            disabled={isLoading}
                            className="text-gray-400 hover:text-cyan-400 text-sm transition-colors duration-300 disabled:opacity-40 tracking-wide"
                        >
                            {isLoginMode ? (
                                <>New operative? <span className="text-cyan-400 underline underline-offset-4">Create Profile</span></>
                            ) : (
                                <>Existing clearance? <span className="text-cyan-400 underline underline-offset-4">Access Interface</span></>
                            )}
                        </button>
                    </div>

                    {/* Footer */}
                    <div className="mt-8 pt-6 border-t border-cyan-500/20">
                        <p className="text-center text-cyan-500/40 text-xs tracking-[0.25em] uppercase">
                            Connected to Cloud Run • Live Mode
                        </p>
                        <div className="flex justify-center items-center gap-6 mt-4">
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)] animate-pulse" />
                                <span className="text-green-400/60 text-[10px] uppercase tracking-wider">Online</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse" style={{ animationDelay: '0.3s' }} />
                                <span className="text-cyan-400/60 text-[10px] uppercase tracking-wider">Secure</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)] animate-pulse" style={{ animationDelay: '0.6s' }} />
                                <span className="text-blue-400/60 text-[10px] uppercase tracking-wider">v9.0</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <style>{`
                @keyframes shake {
                    0%, 100% { transform: translateX(0); }
                    10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
                    20%, 40%, 60%, 80% { transform: translateX(5px); }
                }
                .animate-shake {
                    animation: shake 0.5s ease-in-out;
                }
            `}</style>
        </div>
    );
};

export default Auth;
