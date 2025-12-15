require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Voice ID provided in requirements
const VOICE_ID = 'a28103d2593659957ee0f43113facede01355abb55068b27ef589701f994d850';

// Middleware
app.use(cors());
app.use(express.json());

/**
 * POST /generate-audio
 * Accepts JSON body with { text: string }
 * Returns audio stream from ElevenLabs TTS API
 */
app.post('/generate-audio', async (req, res) => {
    try {
        const { text } = req.body;

        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Request body must contain a non-empty "text" field'
            });
        }

        // Validate API key is configured
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            console.error('ELEVENLABS_API_KEY environment variable is not set');
            return res.status(500).json({
                error: 'Server Configuration Error',
                message: 'TTS service is not properly configured'
            });
        }

        // Call ElevenLabs TTS API
        const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

        const response = await fetch(elevenLabsUrl, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': apiKey
            },
            body: JSON.stringify({
                text: text.trim(),
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.5
                }
            })
        });

        // Handle ElevenLabs API errors
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`ElevenLabs API error: ${response.status} - ${errorText}`);
            return res.status(response.status).json({
                error: 'TTS API Error',
                message: `ElevenLabs API returned status ${response.status}`,
                details: errorText
            });
        }

        // Set response headers for audio streaming
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache'
        });

        // Stream the audio response directly to client
        response.body.pipe(res);

    } catch (error) {
        console.error('Error generating audio:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to generate audio'
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`🎤 ElevenLabs TTS Proxy Server running on port ${PORT}`);
    console.log(`📍 POST /generate-audio - Generate speech from text`);
    console.log(`❤️  GET /health - Health check`);
});
