const mongoose = require('mongoose');

/**
 * Message sub-schema for conversation history entries
 * Stores individual messages in a conversation
 */
const MessageSchema = new mongoose.Schema({
    role: {
        type: String,
        required: [true, 'Message role is required'],
        enum: {
            values: ['user', 'assistant', 'system'],
            message: 'Role must be either user, assistant, or system'
        }
    },
    content: {
        type: String,
        required: [true, 'Message content is required'],
        trim: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, { _id: false }); // Disable _id for subdocuments to save space

/**
 * Conversation Schema for persistent per-user memory
 * Stores conversation history with type classification
 */
const ConversationSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User ID is required'],
        index: true
    },
    type: {
        type: String,
        required: [true, 'Conversation type is required'],
        enum: {
            values: ['text', 'voice'],
            message: 'Type must be either text or voice'
        },
        default: 'text'
    },
    history: {
        type: [MessageSchema],
        default: [],
        validate: {
            validator: function (v) {
                // Limit history to 1000 messages to prevent unbounded growth
                return v.length <= 1000;
            },
            message: 'Conversation history cannot exceed 1000 messages'
        }
    },
    created_at: {
        type: Date,
        default: Date.now
    },
    updated_at: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: false, // Using custom timestamp fields
    collection: 'conversations'
});

// Compound index for efficient user-based queries
ConversationSchema.index({ user_id: 1, type: 1 });
ConversationSchema.index({ user_id: 1, updated_at: -1 });

/**
 * Pre-save middleware to update the updated_at timestamp
 */
ConversationSchema.pre('save', function (next) {
    this.updated_at = new Date();
    next();
});

/**
 * Instance method to add a message to the conversation history
 * @param {string} role - The role (user, assistant, system)
 * @param {string} content - The message content
 * @returns {Object} - The added message object
 */
ConversationSchema.methods.addMessage = function (role, content) {
    const message = {
        role,
        content,
        timestamp: new Date()
    };
    this.history.push(message);
    return message;
};

/**
 * Instance method to get recent messages
 * @param {number} limit - Number of recent messages to retrieve
 * @returns {Array} - Array of recent messages
 */
ConversationSchema.methods.getRecentMessages = function (limit = 10) {
    return this.history.slice(-limit);
};

/**
 * Instance method to clear conversation history
 */
ConversationSchema.methods.clearHistory = function () {
    this.history = [];
};

/**
 * Static method to find or create a conversation for a user (Promise-based)
 * @param {ObjectId} userId - The user's ID
 * @param {string} type - The conversation type (text or voice)
 * @returns {Promise<Conversation>} - The conversation document
 */
ConversationSchema.statics.findOrCreate = async function (userId, type = 'text') {
    try {
        let conversation = await this.findOne({ user_id: userId, type }).exec();

        if (!conversation) {
            conversation = new this({
                user_id: userId,
                type,
                history: []
            });
            await conversation.save();
        }

        return conversation;
    } catch (error) {
        throw error;
    }
};

/**
 * Static method to get all conversations for a user (Promise-based)
 * @param {ObjectId} userId - The user's ID
 * @returns {Promise<Conversation[]>} - Array of conversation documents
 */
ConversationSchema.statics.findByUser = async function (userId) {
    const conversations = await this.find({ user_id: userId }).sort({ updated_at: -1 }).exec();
    return conversations;
};

/**
 * Transform output to clean up the response
 */
ConversationSchema.methods.toJSON = function () {
    const conversation = this.toObject();
    delete conversation.__v;
    return conversation;
};

const Conversation = mongoose.model('Conversation', ConversationSchema);

module.exports = Conversation;
