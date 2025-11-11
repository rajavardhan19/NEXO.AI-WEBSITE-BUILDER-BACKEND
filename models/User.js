import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Please provide your name'],
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Please provide your email'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
    },
    password: {
        type: String,
        required: [true, 'Please provide a password'],
        minlength: [6, 'Password must be at least 6 characters'],
        select: false // Don't return password by default
    },
    profilePicture: {
        type: String,
        default: null
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastLogin: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        console.log('🔒 Hashing password before save...');
        console.log('Original password length:', this.password?.length);
        
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        
        console.log('✅ Password hashed successfully');
        console.log('Hashed password:', this.password.substring(0, 20) + '...');
        next();
    } catch (error) {
        console.error('❌ Password hashing error:', error);
        next(error);
    }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
    try {
        console.log('🔐 Comparing passwords...');
        console.log('Candidate password length:', candidatePassword?.length);
        console.log('Stored password hash:', this.password?.substring(0, 20) + '...');
        
        const result = await bcrypt.compare(candidatePassword, this.password);
        console.log('Comparison result:', result);
        return result;
    } catch (error) {
        console.error('❌ Password comparison error:', error.message);
        console.error('Stored password value:', this.password);
        throw new Error('Password comparison failed: ' + error.message);
    }
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
    const obj = this.toObject();
    delete obj.password;
    return obj;
};

// Force the collection name to `nexo-users` to avoid colliding with other projects
const User = mongoose.model('User', userSchema, 'nexo-users');

export default User;
