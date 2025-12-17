/**
 * Models Index
 * Central export point for all Mongoose models
 */
const User = require('./User');
const Conversation = require('./Conversation');

module.exports = {
    User,
    Conversation
};
