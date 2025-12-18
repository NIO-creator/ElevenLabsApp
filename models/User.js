const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * User Schema for authentication
 * Stores user credentials with secure password hashing
 */
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, 'Username is required'],
        unique: true,
        trim: true,
        minlength: [3, 'Username must be at least 3 characters'],
        maxlength: [30, 'Username cannot exceed 30 characters'],
        lowercase: true
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters']
    },
    created_at: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: false, // Using custom created_at field
    collection: 'users'
});

// Note: username index is created automatically by unique:true constraint

/**
 * Pre-save middleware to hash password before storing
 * Only hashes if password is new or modified
 */
UserSchema.pre('save', async function (next) {
    // Only hash if password is modified (or new)
    if (!this.isModified('password')) {
        return next();
    }

    try {
        // Generate salt with 12 rounds (recommended for bcrypt)
        const salt = await bcrypt.genSalt(12);
        // Hash the password
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

/**
 * Instance method to verify password
 * @param {string} candidatePassword - The password to verify
 * @returns {Promise<boolean>} - True if password matches
 */
UserSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Static method to find user by username (Promise-based)
 * @param {string} username - The username to search for
 * @returns {Promise<User|null>} - The user document or null
 */
UserSchema.statics.findByUsername = async function (username) {
    const normalizedUsername = username.toLowerCase().trim();
    const user = await this.findOne({ username: normalizedUsername });
    return user;
};

/**
 * Static method to find or create a user by username (Promise-based)
 * @param {string} username - The username to find or create
 * @param {string} password - The password for new users
 * @returns {Promise<User>} - The user document
 */
UserSchema.statics.findOrCreate = async function (username, password) {
    const normalizedUsername = username.toLowerCase().trim();

    let user = await this.findOne({ username: normalizedUsername });

    if (!user) {
        user = new this({
            username: normalizedUsername,
            password: password
        });
        await user.save();
    }

    return user;
};

/**
 * Transform output to hide sensitive fields
 */
UserSchema.methods.toJSON = function () {
    const user = this.toObject();
    delete user.password;
    delete user.__v;
    return user;
};

const User = mongoose.model('User', UserSchema);

module.exports = User;
