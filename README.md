# Chat-to-Voice API

A Node.js/Express backend that combines Gemini AI for conversational responses with ElevenLabs TTS for voice output.

## Flow

```
User Text → Gemini AI → Response Text → ElevenLabs TTS → Audio Stream
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Add your API keys to `.env`:
   ```
   GEMINI_API_KEY=your_gemini_key
   ELEVENLABS_API_KEY=your_elevenlabs_key
   ```

4. Start the server:
   ```bash
   npm start
   ```

## API Endpoints

### POST /chat

Send text, receive AI-generated voice response.

**Request:**
```json
{
  "text": "Tell me a joke"
}
```

**Response:** Audio stream (audio/mpeg)

The Gemini text response is included in the `X-Gemini-Response` header (base64 encoded).

### GET /health

Health check with service status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-16T18:00:00.000Z",
  "services": {
    "gemini": true,
    "elevenlabs": true
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key (required) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (required) |
| `PORT` | Server port (default: 3000) |

## Test

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, how are you?"}' \
  --output response.mp3
```
