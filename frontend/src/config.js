/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STARK INDUSTRIES - PRODUCTION CONFIGURATION (v11.0)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Centralized configuration for the Iron Man HUD frontend.
 * All API endpoints and environment settings are managed here.
 */

// ═══════════════════════════════════════════════════════════════════════════
// ENVIRONMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════
const ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = ENV === 'production';

// ═══════════════════════════════════════════════════════════════════════════
// API CONFIGURATION - HARDENED BACKEND v11.0
// ═══════════════════════════════════════════════════════════════════════════
export const API_CONFIG = {
    // Production backend URL - GCP Project 794024916030 (v11.2)
    BASE_URL: 'https://ai-vibe-coder-proxy-794024916030.europe-west1.run.app',

    // API Endpoints
    ENDPOINTS: {
        // Authentication
        LOGIN: '/api/auth/login',
        REGISTER: '/api/auth/register',
        ME: '/api/auth/me',

        // Chat (requires Authorization header)
        CHAT: '/chat',
    },

    // Request timeout (ms) - Increased for v11.3 failover support
    TIMEOUT: 60000,
};

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ═══════════════════════════════════════════════════════════════════════════
export const STORAGE_KEYS = {
    AUTH_TOKEN: 'starkAuthToken',
    USER_DATA: 'starkUser',
    PREFERENCES: 'starkPreferences',
};

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN MANAGER - JWT HANDLING
// ═══════════════════════════════════════════════════════════════════════════
export const tokenManager = {
    /**
     * Get the stored JWT token
     * @returns {string|null} The JWT token or null if not authenticated
     */
    getToken: () => localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN),

    /**
     * Get the stored user data
     * @returns {Object|null} The user object or null if not authenticated
     */
    getUser: () => {
        const user = localStorage.getItem(STORAGE_KEYS.USER_DATA);
        try {
            return user ? JSON.parse(user) : null;
        } catch {
            return null;
        }
    },

    /**
     * Store authentication data
     * @param {string} token - The JWT token
     * @param {Object} user - The user object
     */
    setAuth: (token, user) => {
        localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
        localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(user));
    },

    /**
     * Clear all authentication data (logout)
     */
    clearAuth: () => {
        localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER_DATA);
    },

    /**
     * Check if user is authenticated
     * @returns {boolean} True if a valid token exists
     */
    isAuthenticated: () => {
        const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
        if (!token) return false;

        // Optional: Check token expiration (JWT decode)
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            if (payload.exp && Date.now() >= payload.exp * 1000) {
                // Token expired, clear auth
                tokenManager.clearAuth();
                return false;
            }
            return true;
        } catch {
            return !!token; // Fallback to simple check
        }
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATED FETCH WRAPPER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Fetch wrapper that automatically includes JWT Authorization header
 * Handles 401 responses by clearing auth and forcing re-login
 * 
 * @param {string} endpoint - The API endpoint (relative to BASE_URL)
 * @param {Object} options - Fetch options (method, body, etc.)
 * @returns {Promise<Response>} The fetch response
 */
export const authFetch = async (endpoint, options = {}) => {
    const token = tokenManager.getToken();
    const url = endpoint.startsWith('http')
        ? endpoint
        : `${API_CONFIG.BASE_URL}${endpoint}`;

    const headers = {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle authentication errors
        if (response.status === 401) {
            console.warn('🔐 Session expired or invalid token');
            tokenManager.clearAuth();
            window.location.reload(); // Force re-authentication
            throw new Error('Authentication required');
        }

        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO CONTEXT MANAGER (Web Audio API)
// ═══════════════════════════════════════════════════════════════════════════
let audioContext = null;

export const audioManager = {
    /**
     * Get or create AudioContext (must be called from user interaction)
     * @returns {AudioContext} The audio context
     */
    getContext: () => {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioContext;
    },

    /**
     * Resume AudioContext (required after browser security policy)
     * Call this on first user interaction (login button, etc.)
     */
    resumeContext: async () => {
        const ctx = audioManager.getContext();
        if (ctx.state === 'suspended') {
            await ctx.resume();
            console.log('🔊 AudioContext resumed');
        }
        return ctx;
    },

    /**
     * Check if AudioContext is active
     * @returns {boolean} True if context is running
     */
    isActive: () => audioContext && audioContext.state === 'running',
};

// ═══════════════════════════════════════════════════════════════════════════
// APP CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
export const APP_CONFIG = {
    VERSION: '11.0.0',
    NAME: 'Stark Industries HUD',
    ENVIRONMENT: ENV,
    IS_PRODUCTION,

    // Feature flags
    FEATURES: {
        VOICE_COMMANDS: true,
        WEB_AUDIO_VISUALIZER: true,
        ARC_REACTOR_ANIMATION: true,
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// DEVELOPMENT LOGGING
// ═══════════════════════════════════════════════════════════════════════════
if (!IS_PRODUCTION) {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`🚀 ${APP_CONFIG.NAME} v${APP_CONFIG.VERSION}`);
    console.log(`📡 API: ${API_CONFIG.BASE_URL}`);
    console.log(`🌍 Environment: ${ENV}`);
    console.log('═══════════════════════════════════════════════════════');
}

export default {
    API_CONFIG,
    STORAGE_KEYS,
    tokenManager,
    authFetch,
    audioManager,
    APP_CONFIG,
};
