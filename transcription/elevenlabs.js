/**
 * ElevenLabs STT Provider (Sprint 13.1)
 * 
 * Fallback transcription provider using ElevenLabs Speech-to-Text API.
 * Uses file upload endpoint for simplicity.
 * 
 * API Endpoint: POST https://api.elevenlabs.io/v1/speech-to-text
 * Required fields: file, model_id
 */

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY?.trim();
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';

/**
 * Transcribe audio using ElevenLabs STT API
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} format - Audio format (webm, wav, mp3)
 * @returns {Promise<{text: string, provider: string}>}
 * @throws {Error} with status property for HTTP errors
 */
async function transcribe(audioBuffer, format) {
    if (!ELEVENLABS_API_KEY) {
        const error = new Error('ElevenLabs API key not configured');
        error.status = 500;
        error.provider = 'elevenlabs';
        throw error;
    }

    const FORMAT_MIME_MAP = {
        'webm': { ext: 'webm', mime: 'audio/webm' },
        'wav': { ext: 'wav', mime: 'audio/wav' },
        'mp3': { ext: 'mp3', mime: 'audio/mpeg' }
    };
    const formatInfo = FORMAT_MIME_MAP[format] || FORMAT_MIME_MAP['webm'];

    // Create FormData with native APIs (Node 18+)
    const form = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: formatInfo.mime });

    // FIXED: Field name must be 'file' (not 'audio')
    form.append('file', audioBlob, `audio.${formatInfo.ext}`);

    // FIXED: model_id is REQUIRED - use scribe_v1 (stable STT model)
    form.append('model_id', ELEVENLABS_STT_MODEL);

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY
            // Let fetch set Content-Type with boundary automatically
        },
        body: form
    });

    if (!response.ok) {
        let errorBody = '';
        try {
            const errorJson = await response.json();
            errorBody = JSON.stringify(errorJson);
        } catch {
            errorBody = await response.text();
        }

        // Log error details (redact any potential secrets)
        console.error(`ELEVENLABS_STT_ERROR: status=${response.status}, body=${errorBody.substring(0, 300)}`);

        const error = new Error(`ElevenLabs STT failed: ${response.status}`);
        error.status = response.status;
        error.body = errorBody.substring(0, 200);
        error.provider = 'elevenlabs';
        throw error;
    }

    const result = await response.json();

    // ElevenLabs returns { text: "..." } for transcription
    return {
        text: result.text || '',
        provider: 'elevenlabs'
    };
}

module.exports = { transcribe };
