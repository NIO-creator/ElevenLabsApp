# ElevenLabs TTS API Proxy

A secure Node.js/Express backend that proxies text-to-speech requests to the ElevenLabs API.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file from the template:
   ```bash
   cp .env.example .env
   ```

3. Add your ElevenLabs API key to `.env`:
   ```
   ELEVENLABS_API_KEY=your_actual_api_key
   ```

4. Start the server:
   ```bash
   npm start
   ```

## API Endpoints

### POST /generate-audio

Generates speech audio from text.

**Request:**
```json
{
  "text": "Hello, this is a test message."
}
```

**Response:** Audio stream (audio/mpeg)

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-15T22:00:00.000Z"
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key (required) |
| `PORT` | Server port (default: 3000) |
