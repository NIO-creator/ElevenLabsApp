/**
 * OpenAI Whisper STT Provider (Sprint 13.1)
 * 
 * Primary transcription provider using OpenAI Whisper API.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'whisper-1';

/**
 * Transcribe audio using OpenAI Whisper API
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {string} format - Audio format (webm, wav, mp3)
 * @returns {Promise<{text: string, provider: string}>}
 * @throws {Error} with status property for HTTP errors
 */
async function transcribe(audioBuffer, format) {
    const FORMAT_MIME_MAP = {
        'webm': { ext: 'webm', mime: 'audio/webm' },
        'wav': { ext: 'wav', mime: 'audio/wav' },
        'mp3': { ext: 'mp3', mime: 'audio/mpeg' }
    };
    const formatInfo = FORMAT_MIME_MAP[format] || FORMAT_MIME_MAP['webm'];

    // Create FormData with native APIs (Node 18+)
    const form = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: formatInfo.mime });
    form.append('file', audioBlob, `audio.${formatInfo.ext}`);
    form.append('model', TRANSCRIPTION_MODEL);
    form.append('response_format', 'json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: form
    });

    if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI STT failed: ${response.status}`);
        error.status = response.status;
        error.body = errorText.substring(0, 200);
        error.provider = 'openai';
        throw error;
    }

    const result = await response.json();
    return {
        text: result.text || '',
        provider: 'openai'
    };
}

module.exports = { transcribe };
