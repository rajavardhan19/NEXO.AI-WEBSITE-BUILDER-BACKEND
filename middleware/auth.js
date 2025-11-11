import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Don't cache JWT_SECRET at module load time - read it when needed
// const JWT_SECRET = process.env.JWT_SECRET;

// Middleware to check if user is authenticated (via session or JWT)
export const authenticate = async (req, res, next) => {
    try {
        // Method 1: Check session authentication (primary)
        if (req.session && req.session.userId) {
            const user = await User.findById(req.session.userId);
            if (user) {
                req.user = user;
                req.userId = user._id;
                req.userEmail = user.email;
                return next();
            }
        }

        // Method 2: Check JWT token authentication (fallback)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            
            try {
                // Read JWT_SECRET directly from process.env (not cached)
                const JWT_SECRET = process.env.JWT_SECRET;
                if (!JWT_SECRET) {
                    throw new Error('JWT_SECRET not configured');
                }
                
                const decoded = jwt.verify(token, JWT_SECRET);
                const user = await User.findById(decoded.userId);
                
                if (user) {
                    req.user = user;
                    req.userId = user._id;
                    req.userEmail = user.email;
                    return next();
                }
            } catch (jwtError) {
                console.log('JWT verification failed:', jwtError.message);
            }
        }

        // No valid authentication found
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please sign in.',
            message: 'You must be logged in to perform this action.'
        });

    } catch (error) {
        console.error('Authentication error:', error);
        return res.status(500).json({
            success: false,
            error: 'Authentication error',
            message: error.message
        });
    }
};

// Optional authentication (doesn't fail if not authenticated)
export const optionalAuth = async (req, res, next) => {
    try {
        // Check session
        if (req.session && req.session.userId) {
            const user = await User.findById(req.session.userId);
            if (user) {
                req.user = user;
                req.userId = user._id;
                req.userEmail = user.email;
            }
        }

        // Check JWT if no session
        if (!req.user) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                
                try {
                    // Read JWT_SECRET directly from process.env (not cached)
                    const JWT_SECRET = process.env.JWT_SECRET;
                    if (!JWT_SECRET) {
                        throw new Error('JWT_SECRET not configured');
                    }
                    
                    const decoded = jwt.verify(token, JWT_SECRET);
                    const user = await User.findById(decoded.userId);
                    
                    if (user) {
                        req.user = user;
                        req.userId = user._id;
                        req.userEmail = user.email;
                    }
                } catch (jwtError) {
                    // Silent fail for optional auth
                }
            }
        }

        next();
    } catch (error) {
        console.error('Optional auth error:', error);
        next(); // Continue even if error
    }
};

export default {
    authenticate,
    optionalAuth
};
