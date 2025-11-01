import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
    projectName: {
        type: String,
        required: [true, 'Project name is required'],
        trim: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User ID is required'],
        index: true
    },
    userEmail: {
        type: String,
        required: true,
        lowercase: true,
        index: true
    },
    description: {
        type: String,
        default: ''
    },
    fileCount: {
        type: Number,
        default: 0
    },
    files: [{
        fileName: String,
        filePath: String,
        fileSize: Number,
        contentType: String
    }],
    storageProvider: {
        type: String,
        enum: ['supabase', 'local'],
        default: 'supabase'
    },
    deploymentUrl: {
        type: String,
        default: null
    },
    isDeployed: {
        type: Boolean,
        default: false
    },
    tags: [String],
    status: {
        type: String,
        enum: ['active', 'archived', 'deleted'],
        default: 'active'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Compound index for efficient user-specific queries
projectSchema.index({ userId: 1, projectName: 1 }, { unique: true });
projectSchema.index({ userEmail: 1, createdAt: -1 });

// Pre-save hook to update the updatedAt timestamp
projectSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Static method to find user's projects
projectSchema.statics.findByUser = function(userId) {
    return this.find({ userId, status: 'active' }).sort({ createdAt: -1 });
};

// Static method to find user's projects by email
projectSchema.statics.findByUserEmail = function(userEmail) {
    return this.find({ userEmail: userEmail.toLowerCase(), status: 'active' }).sort({ createdAt: -1 });
};

// Instance method to check if user owns this project
projectSchema.methods.isOwnedBy = function(userId) {
    return this.userId.toString() === userId.toString();
};

const Project = mongoose.model('Project', projectSchema, 'nexo-projects');

export default Project;
