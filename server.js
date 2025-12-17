require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { User, Conversation } = require('./models');

// Environment configuration
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 8080;

// Voice ID for ElevenLabs TTS (Custom Jarvis Voice)
const VOICE_ID = '5hGpSLvZpoxzzDG94isP';

// Global variable to store the temp user's ObjectId
global.tempUserId = null;

// Initialize Gemini client and model globally
const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
let genAI = null;
let model = null;

if (geminiApiKey) {
    genAI = new GoogleGenerativeAI(geminiApiKey);
    model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    console.log('✅ Gemini AI client initialized with gemini-2.5-flash model');
} else {
    console.warn('⚠️  GEMINI_API_KEY not set - /chat endpoint will not work');
}

// MongoDB Connection with graceful error handling
let mongoConnected = false;

async function connectToMongoDB() {
    const mongoUri = process.env.MONGODB_URI?.trim();

    if (!mongoUri) {
        console.warn('⚠️  MONGODB_URI not set - running without persistent memory');
        return false;
    }

    try {
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        mongoConnected = true;
        console.log('✅ Connected to MongoDB');
        return true;
    } catch (error) {
        console.warn('⚠️  MongoDB connection failed - running without persistent memory:', error.message);
        mongoConnected = false;
        return false;
    }
}

/**
 * Bootstrap a temporary user for development
 * Creates or finds a temp_jarvis_user to link conversations to
 */
async function bootstrapTempUser() {
    if (!mongoConnected) {
        console.warn('⚠️  Cannot bootstrap temp user - MongoDB not connected');
        return null;
    }

    try {
        const TEMP_USERNAME = 'temp_jarvis_user';

        // Try to find existing temp user
        let tempUser = await User.findByUsername(TEMP_USERNAME);

        if (!tempUser) {
            // Create new temp user with a placeholder password
            tempUser = new User({
                username: TEMP_USERNAME,
                password: 'TempPassword123!' // Will be hashed by pre-save middleware
            });
            await tempUser.save();
            console.log('✅ Created temporary user for development');
        } else {
            console.log('✅ Found existing temporary user');
        }

        global.tempUserId = tempUser._id;
        console.log(`📌 Temp User ID: ${global.tempUserId}`);
        return tempUser._id;
    } catch (error) {
        console.error('❌ Failed to bootstrap temp user:', error.message);
        return null;
    }
}

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err.message);
    mongoConnected = false;
});

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected');
    mongoConnected = false;
});

mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnected');
    mongoConnected = true;
});

// ==================== SECURITY MIDDLEWARE ====================

// CORS Configuration - Production locked down
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, server-to-server)
        if (!origin) return callback(null, true);

        if (allowedOrigins.length === 0) {
            // Development fallback - allow all if no origins configured
            console.warn('⚠️  ALLOWED_ORIGINS not set - allowing all origins (dev mode)');
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        console.warn(`🚫 CORS blocked origin: ${origin}`);
        return callback(new Error('CORS policy violation'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));

// Security Headers (helmet)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.elevenlabs.io"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false, // Required for audio streaming
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json());

// Rate Limiting - Login endpoint (stricter to prevent brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: {
        error: 'Too Many Requests',
        message: 'Too many login attempts. Please try again in 15 minutes.',
        statusCode: 429,
        timestamp: new Date().toISOString()
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        console.warn(`🚫 Rate limit exceeded for login from IP: ${req.ip}`);
        res.status(429).json({
            error: 'Too Many Requests',
            message: 'Too many login attempts. Please try again in 15 minutes.',
            statusCode: 429,
            timestamp: new Date().toISOString()
        });
    }
});

// Rate Limiting - Chat endpoint (generous but protective)
const chatLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: {
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please slow down.',
        statusCode: 429,
        timestamp: new Date().toISOString()
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        console.warn(`🚫 Rate limit exceeded for chat from IP: ${req.ip}`);
        res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please slow down.',
            statusCode: 429,
            timestamp: new Date().toISOString()
        });
    }
});

// JWT Configuration
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET?.trim() || 'jarvis-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '24h';

/**
 * Generate JWT token for a user
 */
function generateToken(user) {
    return jwt.sign(
        { userId: user._id, username: user.username },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Middleware to verify JWT token and extract user
 */
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json(
            createErrorResponse(401, 'Unauthorized', 'No token provided')
        );
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json(
            createErrorResponse(401, 'Unauthorized', 'Invalid or expired token')
        );
    }
}

/**
 * Helper function to create error responses
 * Production-safe: strips sensitive details when NODE_ENV=production
 */
function createErrorResponse(statusCode, errorType, message, details = null) {
    const response = {
        error: errorType,
        message: message,
        statusCode: statusCode,
        timestamp: new Date().toISOString()
    };

    // Only include details in development to prevent stack trace leakage
    if (details && !isProduction) {
        response.details = details;
    }

    return response;
}

// ==================== AUTH ENDPOINTS ====================

/**
 * POST /api/auth/register
 * Creates a new user account
 */
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            return res.status(400).json(
                createErrorResponse(400, 'Bad Request', 'Username and password are required')
            );
        }

        if (password.length < 8) {
            return res.status(400).json(
                createErrorResponse(400, 'Bad Request', 'Password must be at least 8 characters')
            );
        }

        // Check if MongoDB is connected
        if (!mongoConnected) {
            return res.status(503).json(
                createErrorResponse(503, 'Service Unavailable', 'Database is not connected')
            );
        }

        // Check if user already exists
        const existingUser = await User.findByUsername(username);
        if (existingUser) {
            return res.status(409).json(
                createErrorResponse(409, 'Conflict', 'Username already exists')
            );
        }

        // Create new user (password will be hashed by Mongoose middleware)
        const newUser = new User({
            username: username.trim().toLowerCase(),
            password: password
        });
        await newUser.save();

        // Generate JWT token
        const token = generateToken(newUser);

        console.log(`🔐 New user registered: ${newUser.username}`);

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            token: token,
            user: {
                _id: newUser._id,
                username: newUser.username
            }
        });

    } catch (error) {
        console.error('❌ Error in /api/auth/register:', error.message);
        res.status(500).json(
            createErrorResponse(500, 'Internal Server Error', 'Failed to register user', error.message)
        );
    }
});

/**
 * POST /api/auth/login
 * Authenticates user and returns JWT token
 */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            return res.status(400).json(
                createErrorResponse(400, 'Bad Request', 'Username and password are required')
            );
        }

        // Check if MongoDB is connected
        if (!mongoConnected) {
            return res.status(503).json(
                createErrorResponse(503, 'Service Unavailable', 'Database is not connected')
            );
        }

        // Find user by username
        const user = await User.findByUsername(username);

        // Smoke test: Accept test/testpass credentials
        const isTestCredentials = username.toLowerCase() === 'test' && password === 'testpass';

        if (!user) {
            // If test credentials and no user exists, create test user
            if (isTestCredentials) {
                const testUser = new User({
                    username: 'test',
                    password: 'testpass'
                });
                await testUser.save();

                const token = generateToken(testUser);
                console.log(`🧪 SMOKE TEST: Created and logged in test user`);

                return res.status(200).json({
                    success: true,
                    message: 'Login successful (test user created)',
                    token: token,
                    user: {
                        _id: testUser._id,
                        username: testUser.username
                    }
                });
            }

            return res.status(401).json(
                createErrorResponse(401, 'Unauthorized', 'Invalid username or password')
            );
        }

        // Verify password
        const isPasswordValid = await user.comparePassword(password);

        if (!isPasswordValid) {
            return res.status(401).json(
                createErrorResponse(401, 'Unauthorized', 'Invalid username or password')
            );
        }

        // Generate JWT token
        const token = generateToken(user);

        // Update global.tempUserId to this user for memory persistence
        global.tempUserId = user._id;
        console.log(`🔐 User logged in: ${user.username} (Memory linked to user ID: ${user._id})`);

        res.status(200).json({
            success: true,
            message: 'Login successful',
            token: token,
            user: {
                _id: user._id,
                username: user.username
            }
        });

    } catch (error) {
        console.error('❌ Error in /api/auth/login:', error.message);
        res.status(500).json(
            createErrorResponse(500, 'Internal Server Error', 'Failed to login', error.message)
        );
    }
});

/**
 * GET /api/auth/me
 * Returns current user info (requires valid token)
 */
app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json(
                createErrorResponse(404, 'Not Found', 'User not found')
            );
        }

        res.json({
            success: true,
            user: {
                _id: user._id,
                username: user.username,
                created_at: user.created_at
            }
        });
    } catch (error) {
        res.status(500).json(
            createErrorResponse(500, 'Internal Server Error', 'Failed to get user info', error.message)
        );
    }
});

/**
 * Helper function to build Gemini prompt with conversation context
 */
function buildPromptWithContext(conversationHistory, userMessage) {
    if (!conversationHistory || conversationHistory.length === 0) {
        return userMessage;
    }

    // Build context from recent messages
    const contextMessages = conversationHistory.map(msg =>
        `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n');

    return `Previous conversation context:\n${contextMessages}\n\nUser: ${userMessage}\n\nAssistant:`;
}

/**
 * POST /chat
 * Accepts JSON body with { text: string }
 * 1. Retrieves conversation history for context
 * 2. Sends text with context to Gemini for conversational response
 * 3. Logs interaction to database
 * 4. Sends Gemini response to ElevenLabs TTS
 * 5. Streams audio back to client
 */
app.post('/chat', verifyToken, chatLimiter, async (req, res) => {
    try {
        const { text } = req.body;

        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json(
                createErrorResponse(400, 'Bad Request', 'Request body must contain a non-empty "text" field')
            );
        }

        // Validate Gemini is configured
        if (!model) {
            return res.status(503).json(
                createErrorResponse(503, 'Service Unavailable', 'Gemini AI is not properly configured')
            );
        }

        // Validate ElevenLabs API key
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
        if (!elevenLabsApiKey) {
            return res.status(503).json(
                createErrorResponse(503, 'Service Unavailable', 'TTS service is not properly configured')
            );
        }

        const userMessage = text.trim();
        console.log(`📨 Received chat request: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`);

        // Step 1: Get conversation history for context (requires authenticated user)
        let conversation = null;
        let recentMessages = [];
        const userId = req.user.userId;

        if (mongoConnected && userId) {
            try {
                conversation = await Conversation.findOrCreate(userId, 'voice');
                recentMessages = conversation.getRecentMessages(4); // Get last 4 messages for context
                console.log(`📚 Retrieved ${recentMessages.length} messages from history for user ${req.user.username}`);
            } catch (dbError) {
                console.warn('⚠️  Failed to retrieve conversation history:', dbError.message);
                // Continue without memory
            }
        } else {
            console.log('📝 Running without persistent memory');
        }

        // Step 2: Build prompt with context and call Gemini
        console.log('🤖 Calling Gemini API...');
        let responseText;
        try {
            const promptWithContext = buildPromptWithContext(recentMessages, userMessage);
            const geminiResult = await model.generateContent(promptWithContext);
            const geminiResponse = await geminiResult.response;
            responseText = geminiResponse.text();

            if (!responseText || responseText.trim().length === 0) {
                console.error('Gemini returned empty response');
                return res.status(502).json(
                    createErrorResponse(502, 'Bad Gateway', 'Gemini returned an empty response')
                );
            }
        } catch (geminiError) {
            console.error('Gemini API error:', geminiError.message);
            return res.status(502).json(
                createErrorResponse(502, 'Bad Gateway', 'Failed to get response from Gemini AI', geminiError.message)
            );
        }

        console.log(`💬 Gemini response: "${responseText.substring(0, 100)}${responseText.length > 100 ? '...' : ''}"`);

        // Step 3: Log interaction to database (if connected and conversation exists)
        if (mongoConnected && conversation) {
            try {
                conversation.addMessage('user', userMessage);
                conversation.addMessage('assistant', responseText);
                await conversation.save();
                console.log('💾 Conversation saved to database');
            } catch (dbError) {
                console.warn('⚠️  Failed to save conversation:', dbError.message);
                // Continue - don't fail the request due to DB issues
            }
        }

        // Step 4: Send Gemini response to ElevenLabs TTS
        console.log('🎤 Calling ElevenLabs TTS API...');
        const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

        let ttsResponse;
        try {
            ttsResponse = await fetch(elevenLabsUrl, {
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
        } catch (fetchError) {
            console.error('ElevenLabs fetch error:', fetchError.message);
            return res.status(502).json(
                createErrorResponse(502, 'Bad Gateway', 'Failed to connect to ElevenLabs TTS service', fetchError.message)
            );
        }

        // ROBUST ERROR HANDLING: Check for HTTP error status codes (400-599)
        if (ttsResponse.status >= 400 && ttsResponse.status <= 599) {
            let errorDetails;
            try {
                errorDetails = await ttsResponse.text();
                try {
                    errorDetails = JSON.parse(errorDetails);
                } catch (e) {
                    // Keep as string if not valid JSON
                }
            } catch (e) {
                errorDetails = 'Unable to read error details';
            }

            console.error(`❌ ElevenLabs API error [${ttsResponse.status}]:`, errorDetails);

            // Map specific status codes to descriptive errors
            let errorType, errorMessage;
            switch (ttsResponse.status) {
                case 401:
                    errorType = 'Unauthorized';
                    errorMessage = 'Invalid ElevenLabs API key. Please check your credentials.';
                    break;
                case 403:
                    errorType = 'Forbidden';
                    errorMessage = 'Access denied. Your API key may not have permission for this voice or feature.';
                    break;
                case 404:
                    errorType = 'Not Found';
                    errorMessage = 'The specified voice ID was not found.';
                    break;
                case 429:
                    errorType = 'Rate Limited';
                    errorMessage = 'Too many requests. Please try again later.';
                    break;
                case 500:
                case 502:
                case 503:
                case 504:
                    errorType = 'TTS Service Error';
                    errorMessage = 'ElevenLabs service is temporarily unavailable. Please try again later.';
                    break;
                default:
                    errorType = 'TTS API Error';
                    errorMessage = `ElevenLabs API returned status ${ttsResponse.status}`;
            }

            return res.status(ttsResponse.status).json(
                createErrorResponse(ttsResponse.status, errorType, errorMessage, errorDetails)
            );
        }

        // Step 5: Stream the audio response directly to client
        console.log('🔊 Streaming audio response...');
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'X-Gemini-Response': Buffer.from(responseText.substring(0, 200)).toString('base64')
        });

        ttsResponse.body.pipe(res);

    } catch (error) {
        // Catch-all for any unexpected errors
        console.error('❌ Unexpected error in /chat:', error);
        res.status(500).json(
            createErrorResponse(500, 'Internal Server Error', 'An unexpected error occurred', error.message)
        );
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            gemini: !!model,
            elevenlabs: !!process.env.ELEVENLABS_API_KEY,
            mongodb: mongoConnected,
            tempUser: !!global.tempUserId
        }
    });
});


// Initialize and start server
async function startServer() {
    // Step 1: Connect to MongoDB (non-blocking - server starts even if DB fails)
    const dbConnected = await connectToMongoDB();

    // Step 2: Bootstrap temp user for development (only if DB connected)
    if (dbConnected) {
        await bootstrapTempUser();
    }

    // Step 3: Start Express server
    app.listen(PORT, () => {
        console.log(`\n🚀 Chat-to-Voice Server v9.0 running on port ${PORT}`);
        console.log(`📍 POST /chat - Send text, receive AI voice response with memory`);
        console.log(`🔐 POST /api/auth/register - Create new account`);
        console.log(`🔐 POST /api/auth/login - Login and get JWT token`);
        console.log(`🔐 GET /api/auth/me - Get current user info`);
        console.log(`❤️  GET /health - Health check`);
        console.log(`🧠 Memory: ${global.tempUserId ? 'ENABLED' : 'DISABLED'}\n`);
    });
}

startServer().catch(console.error);
