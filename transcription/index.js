/**
 * STT Provider Orchestrator (Sprint 13.1)
 * 
 * Manages failover between transcription providers.
 * Primary: OpenAI Whisper
 * Fallback: ElevenLabs STT
 * 
 * Failover triggers:
 * - 429 (rate limit) - always if STT_FAILOVER_ON_429=true
 * - 5xx (server error) - if STT_FAILOVER_ON_5XX=true
 * 
 * Never failover on 401/403 (auth errors).
 */

const openaiProvider = require('./openai');
const elevenlabsProvider = require('./elevenlabs');

// Configuration
const STT_FAILOVER_ON_429 = process.env.STT_FAILOVER_ON_429 !== 'false'; // Default true
const STT_FAILOVER_ON_5XX = process.env.STT_FAILOVER_ON_5XX === 'true';  // Default false
const STT_FORCE_429_TEST = process.env.STT_FORCE_429_TEST === 'true';    // Deterministic test mode

/**
 * Check if error status should trigger failover
 * @param {number} status - HTTP status code
 * @returns {boolean}
 */
function shouldFailover(status) {
    // Never failover on auth errors
    if (status === 401 || status === 403) {
        return false;
    }

    // Failover on 429 if enabled
    if (status === 429 && STT_FAILOVER_ON_429) {
        return true;
    }

    // Failover on 5xx if enabled
    if (status >= 500 && status < 600 && STT_FAILOVER_ON_5XX) {
        return true;
    }

    return false;
}

/**
 * Transcribe audio with automatic failover
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} format - Audio format (webm, wav, mp3)
 * @param {Function} logFn - Logging function (connId, event, data)
 * @returns {Promise<{text: string, provider: string, failover?: boolean}>}
 */
async function transcribe(audioBuffer, format, logFn = () => { }) {
    // Deterministic test mode: simulate 429 from OpenAI
    if (STT_FORCE_429_TEST) {
        logFn('STT_FORCE_429_TEST', { enabled: true });
        const mockError = new Error('Simulated 429 for testing');
        mockError.status = 429;
        mockError.provider = 'openai';

        // Skip directly to fallback
        logFn('STT_FAILOVER_TRIGGERED', {
            reason: 'simulated_429',
            from: 'openai',
            to: 'elevenlabs'
        });

        const fallbackResult = await elevenlabsProvider.transcribe(audioBuffer, format);
        return {
            ...fallbackResult,
            failover: true,
            failoverReason: 'simulated_429'
        };
    }

    // Try primary provider (OpenAI)
    try {
        logFn('STT_PROVIDER_ATTEMPT', { provider: 'openai' });
        const result = await openaiProvider.transcribe(audioBuffer, format);
        logFn('STT_PROVIDER_SUCCESS', { provider: 'openai', textLength: result.text.length });
        return result;
    } catch (primaryError) {
        logFn('STT_PROVIDER_ERROR', {
            provider: 'openai',
            status: primaryError.status,
            message: primaryError.message
        });

        // Check if we should failover
        if (!shouldFailover(primaryError.status)) {
            throw primaryError;
        }

        // Failover to ElevenLabs
        logFn('STT_FAILOVER_TRIGGERED', {
            reason: primaryError.status,
            from: 'openai',
            to: 'elevenlabs'
        });

        try {
            const fallbackResult = await elevenlabsProvider.transcribe(audioBuffer, format);
            logFn('STT_PROVIDER_SUCCESS', {
                provider: 'elevenlabs',
                textLength: fallbackResult.text.length,
                failover: true
            });
            return {
                ...fallbackResult,
                failover: true,
                failoverReason: primaryError.status
            };
        } catch (fallbackError) {
            logFn('STT_FALLBACK_FAILED', {
                provider: 'elevenlabs',
                status: fallbackError.status,
                message: fallbackError.message
            });

            // Create combined error
            const combinedError = new Error(
                `Both providers failed. OpenAI: ${primaryError.status}, ElevenLabs: ${fallbackError.status}`
            );
            combinedError.status = fallbackError.status;
            combinedError.primaryError = primaryError;
            combinedError.fallbackError = fallbackError;
            throw combinedError;
        }
    }
}

module.exports = {
    transcribe,
    shouldFailover,
    STT_FAILOVER_ON_429,
    STT_FAILOVER_ON_5XX,
    STT_FORCE_429_TEST
};
