require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Voice ID for ElevenLabs TTS
const VOICE_ID = 'a28103d2593659957ee0f43113facede01355abb55068b27ef589701f994d850';

// Initialize Gemini client
const geminiApiKey = process.env.GEMINI_API_KEY;
let genAI = null;

if (geminiApiKey) {
    genAI = new GoogleGenAI({ apiKey: geminiApiKey });
    console.log('✅ Gemini AI client initialized');
} else {
    console.warn('⚠️  GEMINI_API_KEY not set - /chat endpoint will not work');
}

// Middleware
app.use(cors());
app.use(express.json());

/**
 * POST /chat
 * Accepts JSON body with { text: string }
 * 1. Sends text to Gemini for conversational response
 * 2. Sends Gemini response to ElevenLabs TTS
 * 3. Streams audio back to client
 */
app.post('/chat', async (req, res) => {
    try {
        const { text } = req.body;

        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Request body must contain a non-empty "text" field'
            });
        }

        // Validate Gemini is configured
        if (!genAI) {
            return res.status(500).json({
                error: 'Server Configuration Error',
                message: 'Gemini AI is not properly configured'
            });
        }

        // Validate ElevenLabs API key
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return res.status(500).json({
                error: 'Server Configuration Error',
                message: 'TTS service is not properly configured'
            });
        }

        console.log(`📨 Received chat request: "${text.substring(0, 50)}..."`);

        // Step 1: Get response from Gemini
        console.log('🤖 Calling Gemini API...');
        const geminiResponse = await genAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: text.trim(),
        });

        const responseText = geminiResponse.text;

        if (!responseText) {
            return res.status(500).json({
                error: 'LLM Error',
                message: 'Gemini returned an empty response'
            });
        }

        console.log(`💬 Gemini response: "${responseText.substring(0, 100)}..."`);

        // Step 2: Send Gemini response to ElevenLabs TTS
        console.log('🎤 Calling ElevenLabs TTS API...');
        const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

        const ttsResponse = await fetch(elevenLabsUrl, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': elevenLabsApiKey
            },
            body: JSON.stringify({
                text: responseText,
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.5
                }
            })
        });

        // Handle ElevenLabs API errors
        if (!ttsResponse.ok) {
            const errorText = await ttsResponse.text();
            console.error(`ElevenLabs API error: ${ttsResponse.status} - ${errorText}`);
            return res.status(ttsResponse.status).json({
                error: 'TTS API Error',
                message: `ElevenLabs API returned status ${ttsResponse.status}`,
                details: errorText
            });
        }

        // Step 3: Stream the audio response directly to client
        console.log('🔊 Streaming audio response...');
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'X-Gemini-Response': Buffer.from(responseText.substring(0, 200)).toString('base64')
        });

        ttsResponse.body.pipe(res);

    } catch (error) {
        console.error('Error in /chat:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'Failed to process chat request'
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            gemini: !!genAI,
            elevenlabs: !!process.env.ELEVENLABS_API_KEY
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Chat-to-Voice Server running on port ${PORT}`);
    console.log(`📍 POST /chat - Send text, receive AI voice response`);
    console.log(`❤️  GET /health - Health check\n`);
});
