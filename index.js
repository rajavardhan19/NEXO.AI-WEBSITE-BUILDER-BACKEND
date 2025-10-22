import { GoogleGenAI } from "@google/genai";
import express from 'express';
import { exec } from "child_process";
import { promisify } from "util";
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import multer from 'multer';

// Load environment variables FIRST
dotenv.config();

// Import routes
// Note: `authRoutes` are imported dynamically later after dotenv has loaded

// Storage service will be imported dynamically after env vars are loaded
let storage;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const platform = os.platform();
const asyncExecute = promisify(exec);
const app = express();

// Validate required environment variables
const requiredEnvVars = [
    'GEMINI_API_KEY',
    'MONGODB_URI',
    'SESSION_SECRET',
    'PORT'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error('❌ ERROR: Missing required environment variables:');
    missingEnvVars.forEach(varName => {
        console.error(`   - ${varName}`);
    });
    console.error('\nPlease add these variables to your .env file');
    process.exit(1);
}

// Environment variables (all from .env file)
const PORT = process.env.PORT;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
});

// Helper: convert project files to Vercel format (now uses storage service)
async function folderToVercelFiles(projectName) {
  try {
    const files = [];
    const projectFiles = await storage.readAllProjectFiles(projectName);
    
    for (const [fileName, content] of Object.entries(projectFiles)) {
      files.push({ file: fileName, data: content });
    }
    
    return files;
  } catch (error) {
    console.error('Error reading project files:', error);
    return [];
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads (store in memory temporarily)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max file size
        files: 100 // Max 100 files
    },
    fileFilter: (req, file, cb) => {
        // Allow common web file types
        const allowedTypes = /html|htm|css|js|json|jpg|jpeg|png|gif|svg|webp|ico|txt|md|xml/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        
        if (extname) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only web files are allowed.'));
        }
    }
});

// Session configuration
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGODB_URI,
        collectionName: 'nexo-sessions',
        touchAfter: 24 * 3600 // Lazy session update (seconds)
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        sameSite: 'lax'
    }
}));

// Dynamically import auth routes after environment variables are loaded
// This ensures `auth.js` runs its JWT_SECRET check after dotenv has initialized
let storageReady = false;

(async () => {
    try {
        const authModule = await import('./routes/auth.js');
        const authRoutes = authModule.default;
        app.use('/api/auth', authRoutes);
        
        // Import storage service AFTER environment variables are loaded
        const storageModule = await import('./services/supabaseStorage.js');
        storage = storageModule.default;
        storageReady = true;
        console.log('📦 Storage service loaded and ready!');
    } catch (e) {
        console.error('Failed to load modules:', e);
        process.exit(1);
    }
})();

// Enhanced History Management with Project Context
const ProjectHistory = new Map(); // Store history per project
const ChatHistory = new Map(); // Store chat history per session
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Enhanced tool to execute shell commands
async function executeCommand({ command }) {
    try {
        const { stdout, stderr } = await asyncExecute(command);
        if (stderr) return `Error: ${stderr}`;
        return `Success: ${stdout || 'Task executed completely'}`;
    } catch (error) {
        return `Error: ${error}`;
    }
}

// Enhanced tool to write content to a file (now uses storage service)
async function writeToFile({ filePath, content }) {
    try {
        // Wait for storage to be initialized
        if (!storage || !storageReady) {
            console.log('⚠️ Storage not ready, waiting...');
            // Wait up to 5 seconds for storage to be ready
            for (let i = 0; i < 50; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (storage && storageReady) break;
            }
            
            if (!storage || !storageReady) {
                throw new Error('Storage service not initialized. Please restart the server.');
            }
        }

        // Extract project name and file name from path
        // Expected format: projects/projectName/fileName
        const pathParts = filePath.split(/[\\/]/);
        const projectsIndex = pathParts.findIndex(part => part === 'projects');
        
        if (projectsIndex === -1 || projectsIndex >= pathParts.length - 2) {
            throw new Error('Invalid file path. Expected format: projects/projectName/fileName');
        }

        const projectName = pathParts[projectsIndex + 1];
        const fileName = pathParts[projectsIndex + 2];

        console.log(`📝 Writing file: ${projectName}/${fileName}`);

        // Use storage service (Supabase only)
        const result = await storage.saveFile(projectName, fileName, content);
        console.log(`✅ File saved to Supabase: ${projectName}/${fileName}`);
        return `Success: Content written to ${fileName} in project ${projectName}`;
    } catch (error) {
        console.error('❌ Error in writeToFile:', error);
        return `Error: ${error.message}`;
    }
}

// New tool to list projects (now uses storage service)
async function listProjects() {
    try {
        const projects = await storage.listProjects();
        return projects;
    } catch (error) {
        console.error('Error listing projects:', error);
        return `Error: ${error.message}`;
    }
}

// Enhanced tool to read project files (now uses storage service)
async function readProjectFiles({ projectName }) {
    try {
        const files = await storage.readAllProjectFiles(projectName);
        
        if (Object.keys(files).length === 0) {
            return `Error: Project ${projectName} not found or has no files`;
        }

        return files;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// New tool to update existing project files (now uses storage service)
async function updateProjectFiles({ projectName, updates }) {
    try {
        // Check if project exists
        const exists = await storage.projectExists(projectName);
        if (!exists) {
            return `Error: Project ${projectName} not found`;
        }

        const results = {};
        for (const [fileType, content] of Object.entries(updates)) {
            try {
                await storage.saveFile(projectName, fileType, content);
                results[fileType] = 'Updated successfully';
            } catch (err) {
                results[fileType] = `Failed: ${err.message}`;
            }
        }

        return results;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// New tool to deploy project to Vercel (now uses storage service)
async function deployProject({ projectName, siteName = null }) {
    try {
        // Check if project exists in storage
        const exists = await storage.projectExists(projectName);
        if (!exists) {
            return `Error: Project ${projectName} not found`;
        }

        // Check if Vercel token is available
        if (!VERCEL_TOKEN) {
            return `Error: VERCEL_TOKEN environment variable is required for deployment. Please set your Vercel token.`;
        }

        // Deploy project using Vercel API
        const files = await folderToVercelFiles(projectName);
        
        if (files.length === 0) {
            return `Error: No files found in project ${projectName}`;
        }

        const response = await fetch("https://api.vercel.com/v13/deployments", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${VERCEL_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: `${projectName}-${Date.now()}`,
                files,
                projectSettings: {
                    framework: null,
                    devCommand: null,
                    buildCommand: null,
                    outputDirectory: null
                }
            })
        });

        const result = await response.json();
        if (result.error) {
            return `Error: ${result.error.message}`;
        }

        // Create a README with Vercel deployment instructions
        const deploymentReadme = `# 🚀 Vercel Deployment Guide

## Your website "${projectName}" has been deployed to Vercel!

### 🌐 Live URL: https://${result.url}

### 📁 Project Files:
- ✅ index.html (main page)
- ✅ style.css (styling)
- ✅ script.js (functionality)
- ✅ README.md (this file)

### 🔧 How to Update Your Site:
1. Edit files in the "${projectName}" folder
2. Use the update feature in the website builder
3. Changes will be automatically deployed

### 📱 Features:
- ✅ Responsive design
- ✅ Modern animations
- ✅ SEO optimized
- ✅ Fast loading
- ✅ Mobile-friendly
- ✅ Global CDN
- ✅ Automatic HTTPS

### 🎯 Vercel Benefits:
- **Lightning Fast**: Global CDN for instant loading
- **Automatic Deployments**: Every update goes live instantly
- **Zero Configuration**: Works out of the box
- **Custom Domains**: Add your own domain anytime
- **Analytics**: Built-in performance monitoring

### 🚀 Next Steps:
1. Your site is already live at the URL above
2. Bookmark the URL to access your site anytime
3. Share the URL with others
4. Add a custom domain in Vercel dashboard if desired

Happy deploying! 🎉
`;

        // Save README to storage
        await storage.saveFile(projectName, 'README.md', deploymentReadme);

        return `Success: Project "${projectName}" deployed to Vercel!

🌐 Live URL: https://${result.url}

📁 Files created:
- README.md (deployment guide with live URL)

🚀 Your website is now live and accessible worldwide!
- Global CDN for fast loading
- Automatic HTTPS
- Zero configuration required
- Ready for custom domains

Your website is live in seconds! 🌐`;

    } catch (error) {
        return `Error: ${error}`;
    }
}

// Multi-language Translation Tool for Indian Languages
async function translateContent({ text, targetLanguage, context = 'website' }) {
    try {
        // Supported Indian languages
        const supportedLanguages = {
            'hindi': 'Hindi (हिन्दी)',
            'bengali': 'Bengali (বাংলা)',
            'telugu': 'Telugu (తెలుగు)',
            'marathi': 'Marathi (मराठी)',
            'tamil': 'Tamil (தமிழ்)',
            'gujarati': 'Gujarati (ગુજરાતી)',
            'kannada': 'Kannada (ಕನ್ನಡ)',
            'english': 'English'
        };

        const langKey = targetLanguage.toLowerCase();
        if (!supportedLanguages[langKey]) {
            return `Error: Language '${targetLanguage}' is not supported. Supported languages: ${Object.keys(supportedLanguages).join(', ')}`;
        }

        // Use Gemini AI to translate with cultural context
        const translationPrompt = `Translate the following ${context} content to ${supportedLanguages[langKey]}.

IMPORTANT INSTRUCTIONS:
1. Provide natural, culturally appropriate translations
2. Maintain the tone and style appropriate for a ${context}
3. Keep technical terms when appropriate (e.g., "Email", "Submit", "Login" can stay in English if commonly used)
4. For UI elements, use common terms that native speakers would expect
5. Preserve HTML structure if present (don't translate HTML tags)
6. Keep special characters, emojis, and formatting intact
7. For brand names and proper nouns, keep them in original form
8. Return ONLY the translated text, no explanations

Text to translate:
${text}

Translated ${supportedLanguages[langKey]} text:`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: 'user', parts: [{ text: translationPrompt }] }]
        });

        const translatedText = extractResponseText(response);
        
        return {
            success: true,
            originalLanguage: 'English',
            targetLanguage: supportedLanguages[langKey],
            translatedText: translatedText.trim(),
            message: `Successfully translated to ${supportedLanguages[langKey]}`
        };

    } catch (error) {
        console.error('Translation error:', error);
        return {
            success: false,
            error: error.message,
            message: `Translation failed: ${error.message}`
        };
    }
}

// Tool declarations
const executeCommandDeclaration = {
    name: "executeCommand",
    description: "Execute a single terminal/shell command",
    parameters: {
        type: 'OBJECT',
        properties: {
            command: {
                type: 'STRING',
                description: 'Terminal command to execute'
            },
        },
        required: ['command']
    }
};

const writeToFileDeclaration = {
    name: "writeToFile",
    description: "Write content into a file",
    parameters: {
        type: 'OBJECT',
        properties: {
            filePath: { type: 'STRING', description: 'Path of the file' },
            content: { type: 'STRING', description: 'Content to write in the file' },
        },
        required: ['filePath', 'content']
    }
};

const listProjectsDeclaration = {
    name: "listProjects",
    description: "List all available projects",
    parameters: {
        type: 'OBJECT',
        properties: {},
        required: []
    }
};

const readProjectFilesDeclaration = {
    name: "readProjectFiles",
    description: "Read files from a specific project",
    parameters: {
        type: 'OBJECT',
        properties: {
            projectName: { type: 'STRING', description: 'Name of the project to read' }
        },
        required: ['projectName']
    }
};

const updateProjectFilesDeclaration = {
    name: "updateProjectFiles",
    description: "Update existing project files with new content",
    parameters: {
        type: 'OBJECT',
        properties: {
            projectName: { type: 'STRING', description: 'Name of the project to update' },
            updates: {
                type: 'OBJECT',
                description: 'Object with file types as keys and new content as values (e.g., {"index.html": "new content", "style.css": "new styles"})'
            }
        },
        required: ['projectName', 'updates']
    }
};

const deployProjectDeclaration = {
    name: "deployProject",
    description: "Deploy a project to Vercel with automatic configuration",
    parameters: {
        type: 'OBJECT',
        properties: {
            projectName: { type: 'STRING', description: 'Name of the project to deploy' },
            siteName: { type: 'STRING', description: 'Optional custom site name for Vercel (will generate unique name if not provided)' }
        },
        required: ['projectName']
    }
};

const translateContentDeclaration = {
    name: "translateContent",
    description: "Translate website content to Indian languages (Hindi, Bengali, Telugu, Marathi, Tamil, Gujarati, Kannada). Use this when user requests a website in a specific Indian language.",
    parameters: {
        type: 'OBJECT',
        properties: {
            text: { type: 'STRING', description: 'The text content to translate (can be HTML, headings, paragraphs, or any text)' },
            targetLanguage: { type: 'STRING', description: 'Target language: hindi, bengali, telugu, marathi, tamil, gujarati, or kannada' },
            context: { type: 'STRING', description: 'Context for translation (e.g., "website", "heading", "button", "paragraph") for better cultural adaptation' }
        },
        required: ['text', 'targetLanguage']
    }
};

const availableTools = { executeCommand, writeToFile, listProjects, readProjectFiles, updateProjectFiles, deployProject, translateContent };

// Helper function to extract text from Gemini API response
function extractResponseText(response) {
    if (response.text) {
        return response.text;
    } else if (response.candidates && response.candidates[0]) {
        const candidate = response.candidates[0];
        
        if (candidate.content && candidate.content.parts && candidate.content.parts[0]) {
            return candidate.content.parts[0].text;
        } else if (candidate.text) {
            return candidate.text;
        } else if (candidate.content && !candidate.content.parts) {
            // Handle case where content exists but parts is missing (e.g., MAX_TOKENS with no output)
            console.warn('Response hit MAX_TOKENS or has no parts, returning empty string');
            return '';
        } else {
            console.error('Unexpected candidate structure:');
            console.error('Candidate:', JSON.stringify(candidate, null, 2));
            console.error('Has content:', !!candidate.content);
            console.error('Has content.parts:', !!(candidate.content && candidate.content.parts));
            console.error('Parts length:', candidate.content?.parts?.length);
            
            // Try to extract text from any available structure
            if (candidate.content?.parts?.[0]?.text) {
                return candidate.content.parts[0].text;
            }
            
            throw new Error('Unexpected candidate structure from AI');
        }
    } else {
        console.error('Unexpected response format from AI');
        console.error('Response keys:', Object.keys(response));
        throw new Error('Unexpected response format from AI');
    }
}

// Retry function with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            
            // Check if it's a 503 error (model overloaded)
            if (error.message && error.message.includes('503')) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.log(`Attempt ${attempt} failed with 503 error. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error; // Don't retry for other errors
            }
        }
    }
}

// Enhanced AI agent function with better context management
async function runAgent(userProblem, projectName = null, isUpdate = false) {
    // Get or create project history
    if (!ProjectHistory.has(projectName)) {
        ProjectHistory.set(projectName, []);
    }

    const projectHistory = ProjectHistory.get(projectName);
    const currentHistory = [...projectHistory];

    // If this is an update, read existing project files first
    if (isUpdate && projectName) {
        try {
            const existingFiles = await readProjectFiles({ projectName });
            if (typeof existingFiles === 'object' && !existingFiles.error) {
                // Add context about existing files to help AI understand what to update
                currentHistory.push({
                    role: 'user',
                    parts: [{
                        text: `🚨 UPDATE CONTEXT: I want to update the existing project "${projectName}". Here are the current files:\n\nHTML: ${existingFiles['index.html'] ? 'Present' : 'Missing'}\nCSS: ${existingFiles['style.css'] ? 'Present' : 'Missing'}\nJavaScript: ${existingFiles['script.js'] ? 'Present' : 'Missing'}\n\nIMPORTANT: You MUST use the updateProjectFiles tool to modify these existing files. DO NOT use writeToFile. Make ONLY the requested changes while preserving everything else.`
                    }]
                });

                // Also add the actual file contents for better context
                if (existingFiles['style.css']) {
                    currentHistory.push({
                        role: 'user',
                        parts: [{
                            text: `CURRENT CSS CONTENT:\n${existingFiles['style.css']}\n\nPlease analyze this CSS and make ONLY the requested changes (like color changes from red to black) while keeping everything else exactly the same.`
                        }]
                    });
                }
            }
        } catch (error) {
            console.error('Error reading existing project files for update:', error);
        }
    }

    // Add user request to history
    currentHistory.push({ role: 'user', parts: [{ text: userProblem }] });

    while (true) {
        const response = await retryWithBackoff(async () => {
            // Try gemini-2.5-flash first, fallback to gemini-1.5-flash if needed
            try {
                return await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: currentHistory,
                config: {
                    systemInstruction: `🎯 YOU ARE AN ELITE FULL-STACK WEB DEVELOPER - WORLD-CLASS EXPERT

Your websites MUST be PRODUCTION-READY, PIXEL-PERFECT, and look like they cost $10,000+ to build.

═══════════════════════════════════════════════════════════════════
🚨 CRITICAL SUCCESS CRITERIA - EVERY WEBSITE MUST HAVE ALL OF THESE:
═══════════════════════════════════════════════════════════════════

✅ IMPLEMENT EVERY REQUESTED FEATURE - No shortcuts, no skipping features
✅ MODERN 2025 DESIGN - Use latest design trends (glassmorphism, gradients, shadows)
✅ FULLY FUNCTIONAL - All buttons, forms, interactions must work perfectly
✅ STUNNING VISUALS - Beautiful color schemes, premium typography, perfect spacing
✅ SMOOTH ANIMATIONS - Fade-ins, slide-ups, hover effects, smooth transitions
✅ MOBILE-FIRST RESPONSIVE - Perfect on all screen sizes (mobile, tablet, desktop)
✅ PRODUCTION-READY CODE - Clean, organized, commented, professional quality
✅ NO GENERIC TEMPLATES - Every website should feel unique and custom-built

═══════════════════════════════════════════════════════════════════
🎨 MANDATORY DESIGN STANDARDS (2025):
═══════════════════════════════════════════════════════════════════

VISUAL STYLE:
• Modern gradients (linear, radial) - NOT solid colors
• Soft shadows and depth (box-shadow, drop-shadow)
• Glassmorphism effects (backdrop-filter: blur)
• Rounded corners (border-radius: 12px-24px)
• Neumorphism for buttons and cards
• Smooth color transitions
• Modern color palettes (purple-blue, orange-pink, green-teal gradients)

TYPOGRAPHY:
• Use Google Fonts: Inter, Poppins, Manrope, Space Grotesk, or Outfit
• Font sizes: 3-5rem for hero titles, 1.5-2rem for headings
• Line-height: 1.6-1.8 for readability
• Font-weight variations (300, 400, 600, 700, 900)
• Letter-spacing for headings

SPACING & LAYOUT:
• Generous whitespace (padding: 4rem-8rem for sections)
• Consistent spacing system (8px, 16px, 24px, 32px, 48px, 64px)
• CSS Grid for complex layouts
• Flexbox for component alignment
• Max-width: 1200px-1400px for content containers

ANIMATIONS (MANDATORY):
• Fade-in on scroll (Intersection Observer API)
• Smooth hover effects (transform: translateY, scale)
• Page load animations
• Button ripple effects
• Parallax scrolling for hero sections
• Smooth scroll behavior
• Loading animations for interactive elements

UI COMPONENTS:
• Modern navigation (sticky, transparent-to-solid on scroll)
• Hero sections with large imagery or gradients
• Card-based layouts with hover effects
• Custom-styled buttons (gradient backgrounds, shadows)
• Modern form inputs with focus states
• Icon integration (use Unicode symbols or CSS-only icons)
• Footer with social links and contact info

═══════════════════════════════════════════════════════════════════
💻 TECHNICAL REQUIREMENTS (MANDATORY):
═══════════════════════════════════════════════════════════════════

HTML STRUCTURE:
• Semantic HTML5 (header, nav, main, section, article, footer)
• Proper meta tags (viewport, description, keywords, og:tags)
• Accessibility (ARIA labels, alt text, semantic structure)
• SEO optimization (proper heading hierarchy, meta descriptions)

CSS ARCHITECTURE:
• CSS Custom Properties (--primary-color, --spacing-unit, etc.)
• Mobile-first media queries
• CSS Grid and Flexbox
• Modern units (rem, vh, vw, clamp())
• CSS animations and transitions
• Organized structure (variables → reset → layout → components → utilities)

JAVASCRIPT FUNCTIONALITY:
• Smooth scroll navigation
• Intersection Observer for scroll animations
• Form validation with real-time feedback
• Mobile menu toggle with smooth animations
• Dynamic content loading
• Interactive elements (tabs, accordions, modals if needed)
• Event listeners for all interactive elements
• ES6+ modern syntax (arrow functions, const/let, template literals)

RESPONSIVE BREAKPOINTS:
• Mobile: 320px-768px
• Tablet: 768px-1024px
• Desktop: 1024px+
• Use clamp() for fluid typography

═══════════════════════════════════════════════════════════════════
🎯 FEATURE IMPLEMENTATION - NEVER SKIP REQUESTED FEATURES:
═══════════════════════════════════════════════════════════════════

When user requests:
• "Contact form" → Build fully functional form with validation and success message
• "Portfolio gallery" → Create grid/masonry layout with lightbox/modal functionality
• "Pricing table" → Build comparison table with hover effects and feature highlights
• "Testimonials" → Create carousel/slider with smooth transitions
• "Hero section" → Large, eye-catching section with CTA buttons
• "About section" → Include image, text, and visual interest elements
• "Services cards" → Grid of cards with icons, descriptions, hover effects
• "FAQ section" → Accordion-style with smooth expand/collapse
• "Newsletter signup" → Form with email validation
• ANY feature → IMPLEMENT IT FULLY, DON'T SKIP OR MAKE PLACEHOLDER

═══════════════════════════════════════════════════════════════════
🏗️ WORKFLOW - FOLLOW THIS EXACTLY:
═══════════════════════════════════════════════════════════════════

Current OS: ${platform}
                
                ${isUpdate ? `🚨 CRITICAL UPDATE MODE: This is an UPDATE operation for existing project "${projectName}". You MUST use the updateProjectFiles tool to modify existing files. DO NOT use writeToFile.` : ''}
                
                CORE REQUIREMENTS FOR PROFESSIONAL WEBSITES:
                1. MODERN DESIGN: Use contemporary design trends, beautiful gradients, shadows, and animations
                2. RESPONSIVE LAYOUT: Mobile-first approach with perfect breakpoints
                3. VISUAL HIERARCHY: Clear content structure with proper spacing and typography
                4. INTERACTIVE ELEMENTS: Hover effects, smooth transitions, micro-animations
                5. PERFORMANCE: Optimized CSS and JavaScript for fast loading
                6. ACCESSIBILITY: Semantic HTML, proper ARIA labels, keyboard navigation
                7. SEO OPTIMIZATION: Meta tags, structured data, semantic markup
                
                DESIGN STANDARDS:
                - Use modern color palettes with gradients and subtle shadows
                - Implement smooth animations (CSS transitions, keyframes, transforms)
                - Create engaging hover effects and interactive elements
                - Use professional typography with proper font hierarchies
                - Include modern UI components (cards, buttons, forms, navigation)
                - Implement dark/light themes or sophisticated color schemes
                - Add loading states, skeleton screens, and smooth page transitions
                - IMAGE DESIGN: Create visually appealing layouts that showcase provided images effectively
                
                TECHNICAL REQUIREMENTS:
                - HTML5 semantic structure with proper meta tags
                - CSS3 with CSS Grid, Flexbox, CSS Variables, and modern properties
                - ES6+ JavaScript with modern APIs and smooth interactions
                - Responsive images and optimized assets with proper alt text
                - Cross-browser compatibility
                - Performance optimization (lazy loading, efficient CSS)
                - IMAGE INTEGRATION: Use provided image URLs with proper <img> tags, responsive sizing, and accessibility
                
                PROJECT STRUCTURE:
                projects/
                └── [projectName]/
                    ├── index.html (main page with semantic structure)
                    ├── style.css (modern, responsive styles with animations)
                    └── script.js (interactive functionality and smooth UX)
                
                ${isUpdate ? `🚨 UPDATE OPERATION RULES (CRITICAL):
                - This is an UPDATE operation for existing project "${projectName}"
                - You MUST use updateProjectFiles tool to modify existing files
                - DO NOT use writeToFile tool for updates
                - Read the existing files first to understand current structure
                - Make ONLY the requested changes while preserving everything else
                - If user asks to change colors, ONLY modify the CSS color values
                - If user asks to change text, ONLY modify the specific text content
                - Maintain all existing functionality, layout, and design patterns
                - Preserve existing design patterns, colors, and layout structure unless specifically requested to change
                - For color changes: Find the specific CSS rules and change ONLY the color values
                - For text changes: Find the specific HTML elements and change ONLY the text content
                - NEVER rewrite entire files - only modify the specific parts that need to change
                - EXAMPLE: If user says "change red to black", find CSS rules with red colors and change ONLY those values to black
                - EXAMPLE: If user says "change title text", find the specific title element and change ONLY that text` : `CONTEXT AWARENESS:
                - If updating an existing project, analyze current files and maintain consistency
                - Build upon previous design decisions and user preferences
                - Suggest improvements while preserving the established style
                - Maintain brand consistency across updates
                - IMPORTANT: When updating, use updateProjectFiles tool instead of writeToFile to modify existing files
                - Preserve existing design patterns, colors, and layout structure unless specifically requested to change`}
                
                AVAILABLE TOOLS:
                - executeCommand: Run shell commands
                - writeToFile: Write content to files ${isUpdate ? '(FORBIDDEN for updates)' : '(use for NEW projects only)'}
                - listProjects: List existing projects
                - readProjectFiles: Read current project files
                - updateProjectFiles: Update existing project files ${isUpdate ? '(MANDATORY for updates)' : '(use for UPDATES only)'}
                - deployProject: Deploy projects to Vercel with automatic configuration
                - translateContent: Translate website content to Indian languages (Hindi, Bengali, Telugu, Marathi, Tamil, Gujarati, Kannada)
                
                MULTI-LANGUAGE SUPPORT:
                - When user requests website "in Hindi", "in Kannada", "in Tamil", etc., use translateContent tool
                - Supported languages: Hindi (हिन्दी), Bengali (বাংলा), Telugu (తెలుగు), Marathi (मराठी), Tamil (தமிழ்), Gujarati (ગુજરാತી), Kannada (ಕನ್ನಡ)
                - Translate ALL user-facing text (headings, paragraphs, buttons, labels) while keeping HTML structure intact
                - Keep technical terms, brand names, and code in English
                - Example: "Create a portfolio website in Hindi" → create website structure, then translate all text content to Hindi
                - For multi-section websites, translate each section's content separately for better context
                
                TOOL SELECTION RULES:
                ${isUpdate ? `- For UPDATES: ALWAYS use updateProjectFiles tool
                - For UPDATES: NEVER use writeToFile tool
                - First read existing files with readProjectFiles
                - Then update specific parts with updateProjectFiles` : `- For NEW projects: Use writeToFile to create files in projects/[projectName]/
                - For UPDATES: Use updateProjectFiles to modify existing files in projects/[projectName]/
                - For DEPLOYMENT: Use deployProject to deploy projects to Vercel
                - Always check if project exists before deciding which tool to use`}
                
                ${isUpdate ? `🚨 IMPORTANT: This is an UPDATE operation. You must modify existing files, not create new ones. Use updateProjectFiles tool only.` : 'IMPORTANT: Always create websites that are visually stunning, professionally designed, and engaging. Focus on user experience, modern aesthetics, and technical excellence.'}`,
                tools: [{
                    functionDeclarations: [
                        executeCommandDeclaration,
                        writeToFileDeclaration,
                        listProjectsDeclaration,
                        readProjectFilesDeclaration,
                        updateProjectFilesDeclaration,
                        deployProjectDeclaration,
                        translateContentDeclaration
                    ]
                }],
                temperature: 0.9,
                maxOutputTokens: 8000,
            },
        });
            } catch (primaryError) {
                // If gemini-2.5-flash fails, try gemini-1.5-flash as fallback
                if (primaryError.message && primaryError.message.includes('503')) {
                    console.log('Primary model overloaded, trying fallback model...');
                    return await ai.models.generateContent({
                        model: "gemini-1.5-flash",
                        contents: currentHistory,
                        config: {
                            systemInstruction: `You are an EXPERT Website Builder AI specializing in creating PROFESSIONAL, HIGH-QUALITY, and ENGAGING websites. Your goal is to exceed industry standards and create websites that look like they were built by top-tier web development agencies.
                                    You are an Elite Website Builder AI, a world-class expert in creating professional, high-quality, and visually stunning websites.

                                    Your mission is to deliver websites that rival or surpass those built by top-tier web development agencies. Every project must embody:

                                    Aesthetic Excellence : pixel-perfect, modern, and premium designs.

                                    User-Centered Design : seamless navigation, intuitive layouts, and engaging interactions.

                                    Performance Optimization : fast loading, responsive design across devices, accessibility compliance, and SEO best practices.

                                    Innovation & Trends : integration of the latest technologies, creative layouts, and advanced features.

                                    Flawless Execution : code that is clean, efficient, scalable, and production-ready.

                                    Your standard is perfection. Every website you create should look and perform like a finished product from a world-class web agency.
                                    Visual Excellence :clean, modern, pixel-perfect layouts with attention to typography, spacing, color balance, and hierarchy.

                                    User Experience First : intuitive navigation, clear information architecture, and designs that reduce cognitive load.

                                    Consistency & Branding : cohesive visual systems that align with brand identity, style guides, and accessibility standards.

                                    Interactive Elegance : smooth animations, micro-interactions, and engaging UI elements that enhance usability.

                                     Adaptability : fully responsive designs that scale perfectly across mobile, tablet, and desktop.'

                Current OS: ${platform}
                
${isUpdate ? `🚨 CRITICAL UPDATE MODE: This is an UPDATE operation for existing project "${projectName}". You MUST use the updateProjectFiles tool to modify existing files. DO NOT use writeToFile.` : ''}

STEP 1: ANALYZE THE REQUEST
• Read the user's description carefully
• List ALL requested features and sections
• Note design preferences (colors, style, theme)
• Identify the website type (portfolio, business, blog, etc.)

STEP 2: PLAN THE STRUCTURE
• Plan HTML structure with all requested sections
• Design color scheme and visual style
• Plan all interactive features
• Ensure mobile-responsive layout

STEP 3: BUILD HTML (index.html)
• Create semantic HTML structure
• Include ALL requested sections
• Add proper meta tags and SEO elements
• Use modern HTML5 elements
• Add data attributes for JS functionality

STEP 4: BUILD CSS (style.css)
• Define CSS variables for colors, spacing, fonts
• Write mobile-first responsive styles
• Add smooth animations and transitions
• Create hover effects and interactions
• Make it visually stunning with gradients, shadows, effects
• IMPORTANT: Use modern design - gradients, glassmorphism, smooth animations

STEP 5: BUILD JAVASCRIPT (script.js)
• Implement ALL interactive features
• Add smooth scroll animations
• Create mobile menu functionality
• Add form validation if forms exist
• Implement any requested dynamic features
• Add scroll animations with Intersection Observer

STEP 6: VERIFY COMPLETENESS
• Check ALL requested features are implemented
• Verify responsive design works
• Ensure all interactions function
• Confirm modern, professional appearance

═══════════════════════════════════════════════════════════════════
📁 PROJECT STRUCTURE:
═══════════════════════════════════════════════════════════════════

projects/
└── [projectName]/
    ├── index.html (Complete HTML with ALL sections)
    ├── style.css (Modern, responsive styles with animations)
    └── script.js (All interactive functionality)

═══════════════════════════════════════════════════════════════════
🛠️ AVAILABLE TOOLS:
═══════════════════════════════════════════════════════════════════

• executeCommand: Run shell commands
• writeToFile: Create new project files ${isUpdate ? '(FORBIDDEN for updates)' : '(use for NEW projects)'}
• listProjects: List existing projects
• readProjectFiles: Read current project files
• updateProjectFiles: Modify existing files ${isUpdate ? '(MANDATORY for updates)' : '(use for UPDATES only)'}
• deployProject: Deploy to Vercel with auto-configuration
• translateContent: Translate to Indian languages (Hindi, Bengali, Telugu, Marathi, Tamil, Gujarati, Kannada)

${isUpdate ? `
═══════════════════════════════════════════════════════════════════
🔄 UPDATE MODE - SPECIAL RULES:
═══════════════════════════════════════════════════════════════════

• This is an UPDATE for existing project "${projectName}"
• MUST use updateProjectFiles (NOT writeToFile)
• Read existing files first with readProjectFiles
• Make ONLY requested changes, preserve everything else
• For color changes: Update only specific CSS color values
• For text changes: Update only specific HTML text content
• Maintain existing design patterns unless asked to change
• Keep all existing functionality intact
• NEVER rewrite entire files - modify specific parts only
` : `
═══════════════════════════════════════════════════════════════════
🎨 EXAMPLES OF PRODUCTION-READY WEBSITES:
═══════════════════════════════════════════════════════════════════

PORTFOLIO EXAMPLE:
✅ Hero with gradient background, large name/title, animated text
✅ About section with profile image, bio, skills with progress bars
✅ Projects grid with hover effects, project cards with images
✅ Contact form with validation and success message
✅ Smooth scroll animations, fade-ins, hover effects
✅ Modern color scheme (purple-blue gradient)
✅ Fully responsive mobile navigation

E-COMMERCE EXAMPLE:
✅ Hero with product showcase, CTA buttons
✅ Product grid with hover zoom effects
✅ Product cards with pricing, ratings, add-to-cart buttons
✅ Shopping cart functionality with localStorage
✅ Modern gradient buttons, card shadows
✅ Fully functional interactions

BUSINESS WEBSITE EXAMPLE:
✅ Hero with call-to-action, background video or gradient
✅ Services section with icon cards and hover effects
✅ Testimonials slider with smooth transitions
✅ Pricing tables with feature comparison
✅ Contact form with validation
✅ Smooth animations throughout
`}

═══════════════════════════════════════════════════════════════════
🚨 NEVER DO THESE (COMMON MISTAKES):
═══════════════════════════════════════════════════════════════════

❌ Skip requested features ("will add later", placeholders)
❌ Use plain colors without gradients or shadows
❌ Create static, boring designs without animations
❌ Make non-responsive layouts
❌ Use outdated design patterns (flat, boring colors)
❌ Create broken functionality
❌ Write incomplete JavaScript
❌ Use generic, template-like designs
❌ Forget mobile responsiveness
❌ Skip form validation or interactive features

═══════════════════════════════════════════════════════════════════
✨ YOUR STANDARD: PERFECTION
═══════════════════════════════════════════════════════════════════

Every website you create should make the user say "WOW!"
Build like you're charging $10,000 per website.
Make it production-ready, launch-ready, client-ready.
Modern. Beautiful. Functional. Complete.`,
                tools: [{
                    functionDeclarations: [
                        executeCommandDeclaration,
                        writeToFileDeclaration,
                        listProjectsDeclaration,
                        readProjectFilesDeclaration,
                        updateProjectFilesDeclaration,
                        deployProjectDeclaration,
                        translateContentDeclaration
                    ]
                }],
            },
        });
                } else {
                    throw primaryError; // Re-throw if it's not a 503 error
                }
            }
        });

        if (response.functionCalls && response.functionCalls.length > 0) {
            const { name, args } = response.functionCalls[0];

            // Prevent using writeToFile for updates
            if (isUpdate && name === 'writeToFile') {
                const errorMessage = `🚨 ERROR: You cannot use writeToFile tool for updates. You MUST use updateProjectFiles tool to modify existing files in project "${projectName}". Please try again with the correct tool.`;
                currentHistory.push({ role: "user", parts: [{ text: errorMessage }] });
                continue;
            }

            // Ensure updates use updateProjectFiles tool
            if (isUpdate && name !== 'updateProjectFiles' && name !== 'readProjectFiles' && name !== 'listProjects') {
                const errorMessage = `🚨 ERROR: For updates, you should use updateProjectFiles tool to modify files. You used ${name} which is not appropriate for updates. Please use updateProjectFiles to make the requested changes.`;
                currentHistory.push({ role: "user", parts: [{ text: errorMessage }] });
                continue;
            }

            const funCall = availableTools[name];
            const result = await funCall(args);

            const functionResponsePart = { name, response: { result } };
            currentHistory.push({ role: "model", parts: [{ functionCall: response.functionCalls[0] }] });
            currentHistory.push({ role: "user", parts: [{ functionResponse: functionResponsePart }] });
        } else {
            const responseText = extractResponseText(response);
            
            currentHistory.push({ role: 'model', parts: [{ text: responseText }] });

            // Update project history for future context
            ProjectHistory.set(projectName, currentHistory);

            return responseText;
        }
    }
}

// Helper function to extract project name from user message
function extractProjectName(message, availableProjects) {
    const lowerMessage = message.toLowerCase();

    // Check if any available project is mentioned in the message
    for (const project of availableProjects) {
        if (lowerMessage.includes(project.toLowerCase())) {
            return project;
        }
    }

    // Check for common patterns like "update [project]" or "modify [project]"
    const updatePatterns = [
        /update\s+([a-zA-Z0-9-_]+)/i,
        /modify\s+([a-zA-Z0-9-_]+)/i,
        /change\s+([a-zA-Z0-9-_]+)/i,
        /edit\s+([a-zA-Z0-9-_]+)/i,
        /improve\s+([a-zA-Z0-9-_]+)/i,
        /fix\s+([a-zA-Z0-9-_]+)/i
    ];

    for (const pattern of updatePatterns) {
        const match = message.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

// Function to enhance user prompts to professional level
async function enhanceUserPrompt(prompt, type = 'build') {
    try {
        const systemInstruction = `You are a prompt enhancement specialist. Your ONLY job is to rewrite website requests in a natural, first-person conversational style.

STRICT RULES - DO NOT BREAK THESE:
❌ NO headings like "Design & Content:" or "**Functionality:**"
❌ NO bullet points or structured formatting
❌ NO third-person language ("The website should...")
✅ ONLY write in first person: "I want...", "my website should...", "I need..."
✅ Write as ONE flowing, conversational paragraph
✅ Make it sound natural, like someone talking about their dream website

EXAMPLE INPUT: "portfolio"
CORRECT OUTPUT: "I want a professional and visually engaging personal portfolio website that reflects creativity, technical skill, and individuality. The design should be modern, minimal, and responsive across all devices. The homepage should include my name, title, and a short tagline that captures my personality, along with a clean background and subtle animation. The About section should tell my story briefly and naturally, covering my background, education, and what inspires my work. A Skills section should clearly present my technical and creative strengths, using icons or progress visuals where appropriate. The Projects section needs to showcase my best work with images, short descriptions, the technologies used, and links to GitHub or live demos."

WRONG OUTPUT: "**Design & Content:** The portfolio website should adopt a clean, modern design..."`;

        const userPrompt = `Rewrite this in first person, conversational style: "${prompt}"

Remember: First person only ("I want..."). No headings. One flowing paragraph. Natural and conversational.`;

        console.log('🔍 Enhancing prompt:', prompt);
        
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: [
                { role: 'user', parts: [{ text: systemInstruction + "\n\n" + userPrompt }] }
            ],
            config: {
                temperature: 0.9,
                maxOutputTokens: 600,
            },
        });
        
        console.log('📦 Raw AI response:', JSON.stringify(response, null, 2));
        
        const responseText = extractResponseText(response);
        
        console.log('✨ Extracted response text:', responseText);
        
        if (!responseText || responseText.trim() === '') {
            console.warn('⚠️ Enhancement returned empty, using original prompt');
            return prompt;
        }
        
        console.log('✅ Returning enhanced prompt');
        return responseText;
    } catch (error) {
        console.error('❌ Error enhancing prompt:', error.message);
        console.error('Full error:', error);
        console.warn('⚠️ Using original prompt due to enhancement error');
        return prompt;
    }
}

// Chat API endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message, chatHistory, currentProject } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                error: 'Message is required'
            });
        }

        // Get or create chat history for this session
        const sessionId = req.ip || 'default';
        let sessionHistory = ChatHistory.get(sessionId) || [];

        // Add current message to history
        sessionHistory.push({ role: 'user', content: message });

        // Get available projects for context
        let availableProjects = [];
        try {
            availableProjects = await listProjects();
        } catch (error) {
            console.error('Error getting projects:', error);
        }

        // Check if user mentioned a specific project name
        const mentionedProject = extractProjectName(message, availableProjects);

        // Prepare context for AI
        const context = {
            message,
            chatHistory: sessionHistory,
            currentProject: mentionedProject || currentProject,
            availableProjects,
            projectFiles: null
        };

        // Get current project files if available
        if (context.currentProject && availableProjects.includes(context.currentProject)) {
            try {
                context.projectFiles = await readProjectFiles({ projectName: context.currentProject });
            } catch (error) {
                console.error('Error reading project files:', error);
            }
        } else if (mentionedProject && !availableProjects.includes(mentionedProject)) {
            // User mentioned a project that doesn't exist
            return res.json({
                success: true,
                response: `I couldn't find a project named "${mentionedProject}". Your available projects are: ${availableProjects.length > 0 ? availableProjects.join(', ') : 'none yet'}. Would you like me to show you your projects or help you create a new one?`,
                action: 'show_projects',
                projectName: null,
                description: null
            });
        }

        const response = await handleChatMessage(context);

        // Add AI response to history
        sessionHistory.push({ role: 'model', content: response.text });

        // Keep only last 20 messages to prevent context overflow
        if (sessionHistory.length > 20) {
            sessionHistory = sessionHistory.slice(-20);
        }

        ChatHistory.set(sessionId, sessionHistory);

        res.json({
            success: true,
            response: response.text,
            action: response.action,
            projectName: response.projectName,
            description: response.description
        });

    } catch (error) {
        console.error('Chat error:', error);

        // Provide a more helpful error message
        let errorMessage = "I'm sorry, I encountered an error. Please try again or let me know if you need help with something specific.";

        if (error.message.includes('INVALID_ARGUMENT')) {
            errorMessage = "I'm having trouble processing your request. Please try rephrasing your question or ask me something else.";
        } else if (error.message.includes('not found')) {
            errorMessage = "I couldn't find that project. Please check the project name or ask me to show your available projects.";
        }

        res.status(500).json({
            success: false,
            error: error.message,
            response: errorMessage
        });
    }
});

// Handle chat messages with context awareness
async function handleChatMessage(context) {
    const { message, chatHistory, currentProject, availableProjects, projectFiles } = context;

    // Convert chat history to AI format with correct roles
    const aiHistory = chatHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : msg.role, // Map 'assistant' to 'model' for Gemini API
        parts: [{ text: msg.content }]
    }));

    // Add system instruction
    const systemInstruction = `You are an expert AI assistant specializing in web development, full-stack development, and software engineering. You're integrated into Nexo.ai, an AI-powered website builder.

**Your Expertise Areas:**
- **Frontend Development**: HTML, CSS, JavaScript, React, Vue, Angular, TypeScript
- **Backend Development**: Node.js, Python, PHP, Java, databases, APIs, server architecture
- **Full-Stack Development**: Complete web application development, deployment, DevOps
- **Web Technologies**: Modern frameworks, libraries, tools, best practices
- **Software Engineering**: Programming concepts, algorithms, design patterns, architecture
- **General Tech**: Basic computer science, development workflows, industry trends

**Your Personality:**
- Expert but approachable web developer
- Natural, conversational, and engaging
- Provide detailed technical explanations
- Share practical development insights
- Enthusiastic about helping with coding and web projects

**Current Context:**
- Current Project: ${currentProject || 'None'}
- Available Projects: ${availableProjects.length > 0 ? availableProjects.join(', ') : 'No projects yet'}

**How to Respond:**
- **Web/Development Questions**: Provide thorough, expert-level explanations with examples, best practices, and practical insights
- **General Tech Questions**: Answer naturally with technical depth when appropriate
- **Basic General Questions**: Provide brief, helpful answers then gently guide back to tech topics
- **Website Building**: Enthusiastically help them use Nexo.ai features
- **Non-Tech Topics**: Politely redirect: "I'm focused on web development topics, but I'd love to help with any coding or website questions!"

**Examples:**
- JavaScript question → Detailed explanation with code examples, best practices, framework recommendations
- "How to center a div?" → Multiple solutions with explanations and modern approaches
- Random non-tech question → Brief acknowledgment + redirect to web development

You're a web development expert who happens to have access to an amazing AI website builder!`;

    const currentHistory = [
        { role: 'user', parts: [{ text: systemInstruction }] },
        ...aiHistory
    ];

    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: currentHistory,
            config: {
                temperature: 0.9, // Higher for more creative, natural responses
                maxOutputTokens: 1500, // Allow for fuller responses like a normal LLM
            },
        });

        const responseText = extractResponseText(response);

        // Parse response for actions with better intent detection
        let action = 'general_response';
        let projectName = null;
        let description = null;

        // Check for specific intents - only very explicit website building requests
        const lowerMessage = message.toLowerCase();

        // Only trigger website building for very explicit requests
        if (lowerMessage.includes('build website') || lowerMessage.includes('create website') || 
            lowerMessage.includes('new website') || lowerMessage.includes('start a website') ||
            lowerMessage.includes('make a website') || lowerMessage.includes('build a site') ||
            lowerMessage.includes('create a site')) {
            action = 'create_project';

            // Extract project name from response or generate one
            const projectMatch = responseText.match(/project[:\s]+([a-zA-Z0-9-_]+)/i) ||
                responseText.match(/suggest[:\s]+([a-zA-Z0-9-_]+)/i) ||
                responseText.match(/name[:\s]+([a-zA-Z0-9-_]+)/i);
            if (projectMatch) {
                projectName = projectMatch[1];
            }
        }
        // Project viewing intents
        else if (lowerMessage.includes('show') || lowerMessage.includes('my projects') ||
            lowerMessage.includes('list projects') || lowerMessage.includes('see my websites') ||
            lowerMessage.includes('what projects') || lowerMessage.includes('display projects')) {
            action = 'show_projects';
        }
        // Project update intents
        else if (lowerMessage.includes('update') || lowerMessage.includes('modify') ||
            lowerMessage.includes('change') || lowerMessage.includes('edit') ||
            lowerMessage.includes('improve') || lowerMessage.includes('fix')) {
            action = 'update_project';
        }
        // Deployment intents
        else if (lowerMessage.includes('deploy') || lowerMessage.includes('publish') ||
            lowerMessage.includes('go live') || lowerMessage.includes('put online') ||
            lowerMessage.includes('vercel') || lowerMessage.includes('host') ||
            lowerMessage.includes('upload') || lowerMessage.includes('make live')) {
            action = 'deploy_project';
        }
        // Greetings
        else if (lowerMessage.includes('hi') || lowerMessage.includes('hello') ||
            lowerMessage.includes('hey') || lowerMessage.includes('good morning') ||
            lowerMessage.includes('good afternoon') || lowerMessage.includes('good evening')) {
            action = 'general_response';
        }
        // Thanks and farewells
        else if (lowerMessage.includes('thanks') || lowerMessage.includes('thank you') ||
            lowerMessage.includes('bye') || lowerMessage.includes('goodbye') ||
            lowerMessage.includes('see you') || lowerMessage.includes('appreciate')) {
            action = 'general_response';
        }

        return {
            text: responseText,
            action,
            projectName,
            description
        };
    } catch (error) {
        console.error('AI response error:', error);
        return {
            text: "I'm sorry, I'm having trouble processing your request right now. Please try again or let me know if you need help with something specific.",
            action: 'general_response',
            projectName: null,
            description: null
        };
    }
}

// API Routes
app.get('/api/projects', async (req, res) => {
    try {
        //console.log('API: /api/projects called');
        const projects = await listProjects();
        //console.log('API: Projects result:', projects);
        
        // Check if projects is an error string
        if (typeof projects === 'string' && projects.startsWith('Error:')) {
            throw new Error(projects);
        }
        
        res.json({ success: true, projects });
    } catch (error) {
        console.error('API: /api/projects error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete project endpoint
app.delete('/api/projects/:projectName', async (req, res) => {
    try {
        const { projectName } = req.params;
        
        if (!projectName) {
            return res.status(400).json({
                success: false,
                error: 'Project name is required'
            });
        }

        console.log(`🗑️ Deleting project: ${projectName}`);
        
        // Wait for storage to be initialized
        if (!storage || !storageReady) {
            return res.status(503).json({
                success: false,
                error: 'Storage service not ready. Please try again.'
            });
        }
        
        // Delete project using storage service
        const result = await storage.deleteProject(projectName);
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to delete project');
        }
        
        console.log(`✅ Deleted project from storage: ${projectName}`);
        
        // Clear project history from memory
        if (ProjectHistory.has(projectName)) {
            ProjectHistory.delete(projectName);
            console.log(`✅ Cleared project history for: ${projectName}`);
        }
        
        res.json({ 
            success: true, 
            message: `Project "${projectName}" deleted successfully` 
        });
        
    } catch (error) {
        console.error('Delete project error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to delete project' 
        });
    }
});

// Get project files from local filesystem (for loading generated projects)
app.get('/api/files/:projectName', async (req, res) => {
    try {
        const { projectName } = req.params;
        const files = await readProjectFiles({ projectName });
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/build', async (req, res) => {
    try {
        const { description, projectName, images } = req.body;
        if (!description || !projectName) {
            return res.status(400).json({
                success: false,
                error: 'Description and project name are required'
            });
        }

        // Enhanced description with image context
        let enhancedDescription = description;
        if (images && Object.keys(images).length > 0) {
            const imageContext = `\n\nIMPORTANT: Include these high-quality images in the website:\n`;
            const imageInstructions = Object.entries(images).map(([section, imageData]) => {
                return `- ${section} section: Use image from ${imageData.url} (${imageData.width}x${imageData.height}) with alt text "${imageData.alt}"`;
            }).join('\n');
            
            enhancedDescription += imageContext + imageInstructions + '\n\nMake sure to include proper <img> tags with the provided URLs and optimize them for responsive design.';
        }

        const result = await runAgent(enhancedDescription, projectName, false);
        res.json({ success: true, result });
    } catch (error) {
        console.error('Build error:', error);
        
        // Handle specific error types
        let errorMessage = error.message;
        let statusCode = 500;
        
        if (error.message.includes('503') || error.message.includes('UNAVAILABLE')) {
            errorMessage = 'The AI model is currently overloaded. Please try again in a few moments.';
            statusCode = 503;
        } else if (error.message.includes('INVALID_ARGUMENT')) {
            errorMessage = 'Invalid request. Please check your input and try again.';
            statusCode = 400;
        } else if (error.message.includes('QUOTA_EXCEEDED')) {
            errorMessage = 'API quota exceeded. Please try again later.';
            statusCode = 429;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            error: errorMessage,
            details: error.message
        });
    }
});

app.post('/api/update', async (req, res) => {
    try {
        const { description, projectName } = req.body;
        if (!description || !projectName) {
            return res.status(400).json({
                success: false,
                error: 'Description and project name are required'
            });
        }

        const result = await runAgent(description, projectName, true);
        res.json({ success: true, result });
    } catch (error) {
        console.error('Update error:', error);
        
        // Handle specific error types
        let errorMessage = error.message;
        let statusCode = 500;
        
        if (error.message.includes('503') || error.message.includes('UNAVAILABLE')) {
            errorMessage = 'The AI model is currently overloaded. Please try again in a few moments.';
            statusCode = 503;
        } else if (error.message.includes('INVALID_ARGUMENT')) {
            errorMessage = 'Invalid request. Please check your input and try again.';
            statusCode = 400;
        } else if (error.message.includes('QUOTA_EXCEEDED')) {
            errorMessage = 'API quota exceeded. Please try again later.';
            statusCode = 429;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            error: errorMessage,
            details: error.message
        });
    }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const { projectName, siteName } = req.body;
        if (!projectName) {
            return res.status(400).json({
                success: false,
                error: 'Project name is required'
            });
        }

        const result = await deployProject({ projectName, siteName });
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Projects API endpoint
app.get('/api/projects', async (req, res) => {
    try {
        const projects = await listProjects();
        
        // listProjects returns an array of project names directly
        res.json({ success: true, projects });
    } catch (error) {
        console.error('Projects API error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to load projects' 
        });
    }
});

// Enhance Prompt API endpoint
app.post('/api/enhance-prompt', async (req, res) => {
    try {
        const { prompt, type } = req.body;
        
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({
                success: false,
                error: 'Prompt is required'
            });
        }

        const enhancedPrompt = await enhanceUserPrompt(prompt, type);
        
        if (!enhancedPrompt || enhancedPrompt.trim() === '') {
            throw new Error('AI returned empty enhanced prompt');
        }
        
        res.json({ success: true, enhancedPrompt });
    } catch (error) {
        console.error('Enhance prompt error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to enhance prompt' 
        });
    }
});

// Reliable image search function with proven working sources
async function searchUnsplashImages(query, orientation = 'landscape', count = 1) {
    const width = orientation === 'portrait' ? 600 : 1200;
    const height = orientation === 'portrait' ? 800 : 600;
    
    try {
        const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
        console.log(`🔍 Searching for images: "${cleanQuery}"`);
        
        // Step 1: Try Unsplash API if available
        if (UNSPLASH_ACCESS_KEY && UNSPLASH_ACCESS_KEY !== 'demo' && UNSPLASH_ACCESS_KEY !== 'your_unsplash_access_key_here') {
            try {
                const apiUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(cleanQuery)}&per_page=10&orientation=${orientation}&content_filter=high&order_by=relevant`;
                
                const response = await fetch(apiUrl, {
                    headers: {
                        'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
                        'Accept-Version': 'v1'
                    },
                    timeout: 5000
                });
                
                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ API found ${data.results?.length || 0} results for "${cleanQuery}"`);
                    
                    if (data.results && data.results.length > 0) {
                        return data.results.slice(0, count).map((photo, index) => ({
                            url: photo.urls.regular,
                            width: width,
                            height: height,
                            alt: photo.alt_description || `${query} - Professional image`,
                            description: photo.description || `High-quality ${query} image`,
                            photographer: photo.user.name
                        }));
                    }
                }
            } catch (apiError) {
                console.log(`⚠️ API Error: ${apiError.message}`);
            }
        }
        
        // Step 2: Use multiple reliable image sources (NO placeholders as primary)
        console.log(`🔄 Using reliable image sources for: "${cleanQuery}"`);
        
        // Curated Unsplash collection IDs for different themes (more specific)
        const collections = {
            // Retail & Shopping (HIGH PRIORITY - check before tech)
            'kirana': '3178572',        // Food & Products
            'grocery': '3178572',       // Food & Products
            'store': '3178572',         // Shopping & Products
            'shop': '3178572',          // Shopping & Products
            'retail': '3178572',        // Shopping & Products
            'supermarket': '3178572',   // Shopping & Products
            'mart': '3178572',          // Shopping & Products
            'boutique': '3178572',      // Shopping & Products
            'ecommerce': '3178572',     // E-commerce
            'shopping': '3178572',      // Shopping & Products
            'product': '3178572',       // Products & Items
            
            // Tech & Development (high priority - check after retail)
            'developer': '1319040',     // Technology
            'coding': '1319040',        // Technology
            'programming': '1319040',   // Technology
            'web': '1319040',           // Technology
            'software': '1319040',      // Technology
            'computer': '1319040',      // Technology
            'tech': '1319040',          // Technology
            'technology': '1319040',    // Technology
            'laptop': '1319040',        // Technology
            'code': '1319040',          // Technology
            'workspace': '1319040',     // Technology
            
            // Creative & Design
            'portfolio': '3356014',     // Creative Work
            'creative': '3356014',      // Creative Work
            'design': '3356014',        // Creative Work
            'designer': '3356014',      // Creative Work
            'ui': '3356014',            // Creative Work
            'ux': '3356014',            // Creative Work
            
            // Food & Restaurant
            'restaurant': '3178572',    // Food & Drink
            'food': '3178572',          // Food & Drink
            'cafe': '3178572',          // Food & Drink
            'dining': '3178572',        // Food & Drink
            'kitchen': '3178572',       // Food & Drink
            'chef': '3178572',          // Food & Drink
            'bakery': '3178572',        // Food & Drink
            
            // Fitness & Health
            'fitness': '375719',        // Health & Fitness
            'gym': '375719',            // Health & Fitness
            'workout': '375719',        // Health & Fitness
            'exercise': '375719',       // Health & Fitness
            'medical': '9816922',       // Health & Medicine
            'healthcare': '9816922',    // Health & Medicine
            'hospital': '9816922',      // Health & Medicine
            'pharmacy': '9816922',      // Health & Medicine
            
            // Business & Office
            'business': '1065976',      // Business & Work
            'office': '1065976',        // Business & Work  
            'team': '1065976',          // Business & Work
            'professional': '1065976',  // Business & Work
            'corporate': '1065976',     // Business & Work
            
            // Architecture & Interior
            'modern': '8892527',        // Architecture & Interior
            'interior': '8892527',      // Architecture & Interior
            'architecture': '8892527',  // Architecture & Interior
            'building': '8892527'       // Architecture & Interior
        };
        
        // Find best matching collection (check retail/store keywords FIRST)
        let collectionId = '1065976'; // Default to business (general fallback)
        let matchedKeyword = '';
        
        // Prioritize retail/store keywords FIRST
        const retailKeywords = ['kirana', 'grocery', 'store', 'shop', 'retail', 'supermarket', 'mart', 'boutique', 'ecommerce', 'shopping', 'product'];
        
        for (const keyword of retailKeywords) {
            if (cleanQuery.includes(keyword)) {
                collectionId = collections[keyword];
                matchedKeyword = keyword;
                console.log(`🎯 Matched retail keyword: "${keyword}" → Collection ${collectionId}`);
                break;
            }
        }
        
        // Then check tech/developer keywords
        if (!matchedKeyword) {
            const techKeywords = ['developer', 'coding', 'programming', 'web', 'software', 'tech', 'portfolio', 'workspace', 'laptop', 'computer', 'code'];
            
            for (const keyword of techKeywords) {
                if (cleanQuery.includes(keyword)) {
                    collectionId = collections[keyword];
                    matchedKeyword = keyword;
                    console.log(`🎯 Matched tech keyword: "${keyword}" → Collection ${collectionId}`);
                    break;
                }
            }
        }
        
        // If no tech keyword matched, check other categories
        if (!matchedKeyword) {
            for (const [keyword, id] of Object.entries(collections)) {
                if (cleanQuery.includes(keyword)) {
                    collectionId = id;
                    matchedKeyword = keyword;
                    console.log(`🎯 Matched keyword: "${keyword}" → Collection ${collectionId}`);
                    break;
                }
            }
        }
        
        // If still no match, use the search query directly for maximum flexibility
        if (!matchedKeyword) {
            console.log(`🔍 No keyword match found, using direct search for: "${cleanQuery}"`);
            // Use business collection as fallback, but the search query will be more specific
        }
        
        // Generate reliable images from collections - ONLY real images, NO placeholders
        const images = [];
        for (let i = 0; i < count; i++) {
            const timestamp = Date.now() + (i * 1000); // Ensure unique timestamps
            
            // Create multiple REAL image sources (no placeholders)
            const realImageSources = [
                // Primary: Direct search with query (most relevant)
                `https://source.unsplash.com/featured/${width}x${height}/?${encodeURIComponent(cleanQuery)}&v=${timestamp}`,
                // Secondary: Collection-based Unsplash (guaranteed real images)
                `https://source.unsplash.com/collection/${collectionId}/${width}x${height}?sig=${timestamp}`,
                // Tertiary: Featured Unsplash with search term
                `https://source.unsplash.com/featured/${width}x${height}/?${encodeURIComponent(cleanQuery)}&v=${timestamp}`,
                // Tertiary: Picsum with random seed
                `https://picsum.photos/${width}/${height}?random=${timestamp}`,
                // Quaternary: Alternative Unsplash collection
                `https://source.unsplash.com/collection/1065976/${width}x${height}?sig=${timestamp + 500}`,
                // Final: Lorem Picsum with different seed
                `https://picsum.photos/seed/${timestamp}/${width}/${height}`
            ];
            
            images.push({
                url: realImageSources[0], // Primary source (collection)
                fallbackUrls: realImageSources.slice(1), // All other real image sources
                width: width,
                height: height,
                alt: `${query} - Professional image`,
                description: `High-quality ${query} image from curated collection ${collectionId}`
            });
        }
        
        console.log(`✅ Generated ${images.length} REAL images from collection ${collectionId}`);
        return images;
        
    } catch (error) {
        console.error('❌ Image search failed:', error);
        
        // Final fallback: ONLY real image sources (NO placeholders)
        const timestamp = Date.now();
        const fallbackRealImages = [
            `https://picsum.photos/${width}/${height}?random=${timestamp}`,
            `https://picsum.photos/seed/business${timestamp}/${width}/${height}`,
            `https://source.unsplash.com/collection/1065976/${width}x${height}?sig=${timestamp}`,
            `https://picsum.photos/seed/professional${timestamp}/${width}/${height}`,
            `https://source.unsplash.com/featured/${width}x${height}/?business&v=${timestamp}`
        ];
        
        return [{
            url: fallbackRealImages[0],
            fallbackUrls: fallbackRealImages.slice(1),
            width: width,
            height: height,
            alt: `${query} - Professional image`,
            description: `Professional ${query} image (fallback)`
        }];
    }
}

// Enhanced image generation API endpoint
app.post('/api/generate-images', async (req, res) => {
    try {
        const { description, websiteType, sections } = req.body;
        
        if (!description) {
            return res.status(400).json({
                success: false,
                error: 'Description is required'
            });
        }
        
        // Generate contextual images based on description and website type
        const images = {};
        const sectionList = sections || ['hero', 'about', 'services'];
        
        for (const section of sectionList) {
            let searchQuery = '';
            let orientation = 'landscape';
            
            // Create contextual search queries based on section and website type
            switch (section) {
                case 'hero':
                    searchQuery = getHeroSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                case 'about':
                    searchQuery = getAboutSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                case 'services':
                    searchQuery = getServicesSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                case 'portfolio':
                    searchQuery = getPortfolioSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                case 'team':
                    searchQuery = getTeamSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                case 'contact':
                    searchQuery = getContactSearchQuery(description, websiteType);
                    orientation = 'landscape';
                    break;
                default:
                    searchQuery = getGenericSearchQuery(description, websiteType, section);
                    orientation = 'landscape';
            }
            
            const imageResults = await searchUnsplashImages(searchQuery, orientation, 1);
            if (imageResults && imageResults.length > 0) {
                images[section] = imageResults[0];
            }
        }
        
        res.json({ success: true, images });
        
    } catch (error) {
        console.error('Image generation error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to generate images' 
        });
    }
});

// Enhanced helper functions for generating highly contextual search queries
function getHeroSearchQuery(description, websiteType) {
    const words = description.toLowerCase();
    
    // Extract specific keywords from description for better matching
    const specificTerms = [];
    
    // Industry-specific mappings with PRIORITY ORDER (most specific first)
    const industryQueries = {
        // Retail & Shopping (CHECK FIRST for kirana, store, shop)
        'kirana': ['grocery store interior', 'small shop retail', 'local store shelves', 'convenience store products'],
        'general store': ['grocery store shelves', 'retail shop interior', 'convenience store layout', 'small business shop'],
        'grocery': ['grocery store aisle', 'supermarket interior', 'fresh produce display', 'grocery shop shelves'],
        'shop': ['retail store interior', 'shop display shelves', 'small business storefront', 'local shop products'],
        'store': ['retail store modern', 'shop interior clean', 'store shelves organized', 'retail business display'],
        'retail': ['retail store interior', 'shop products display', 'retail business modern', 'store shelves neat'],
        'supermarket': ['supermarket aisle', 'grocery store large', 'retail shopping center', 'supermarket interior modern'],
        'convenience': ['convenience store interior', 'small shop retail', '24-hour store', 'quick mart shelves'],
        'mart': ['retail mart interior', 'shopping mart aisles', 'grocery mart shelves', 'mart store products'],
        'boutique': ['boutique store elegant', 'fashion retail interior', 'luxury shop display', 'boutique products modern'],
        
        // E-commerce & Online Shopping
        'ecommerce': ['online shopping website', 'e-commerce platform', 'shopping cart digital', 'online store modern'],
        'online store': ['e-commerce website', 'online shopping platform', 'digital store interface', 'web shop modern'],
        'shopping': ['shopping experience modern', 'retail store interior', 'shopping bags products', 'online shopping'],
        
        // Tech & Development
        'developer': ['laptop coding workspace', 'software developer desk', 'programming computer setup', 'developer workspace clean'],
        'web developer': ['laptop coding workspace', 'web development setup', 'programming desk modern', 'developer computer workspace'],
        'programmer': ['laptop coding workspace', 'programming setup clean', 'software developer desk', 'computer programming workspace'],
        'coding': ['laptop coding workspace', 'programming computer setup', 'developer desk clean', 'coding workspace modern'],
        'software': ['laptop workspace modern', 'software development office', 'computer programming desk', 'tech workspace clean'],
        'portfolio': ['laptop workspace minimal', 'creative desk setup', 'modern workspace clean', 'professional desk laptop'],
        'tech': ['modern tech workspace', 'laptop computer desk', 'technology office clean', 'software development setup'],
        'technology': ['modern tech workspace', 'laptop computer desk', 'technology office clean', 'digital workspace'],
        
        // Food & Dining
        'restaurant': ['elegant restaurant interior', 'fine dining atmosphere', 'restaurant dining room', 'gourmet food plating'],
        'cafe': ['cozy cafe interior', 'coffee shop atmosphere', 'barista coffee making', 'cafe seating area'],
        'bakery': ['bakery display fresh', 'artisan bread shop', 'pastry store interior', 'bakery products delicious'],
        'bar': ['bar interior modern', 'pub atmosphere cozy', 'cocktail bar elegant', 'bar counter drinks'],
        
        // Health & Fitness
        'fitness': ['modern gym equipment', 'fitness training session', 'gym interior design', 'workout equipment'],
        'yoga': ['yoga studio peaceful', 'meditation room serene', 'yoga class stretching', 'wellness center'],
        'medical': ['modern medical clinic', 'healthcare professional', 'medical examination room', 'hospital interior'],
        'dental': ['dental office modern', 'dental treatment room', 'dentist office clean', 'dental care professional'],
        'pharmacy': ['pharmacy store modern', 'medicine shop interior', 'drugstore professional', 'pharmacy counter clean'],
        
        // Business & Professional
        'startup': ['modern startup office', 'creative workspace design', 'tech company interior', 'innovation lab'],
        'consulting': ['professional meeting room', 'business consultation', 'corporate office modern', 'strategy planning'],
        'finance': ['financial office professional', 'banking consultation', 'investment meeting', 'finance professional'],
        'law': ['law office professional', 'legal consultation room', 'attorney office modern', 'courtroom professional'],
        
        // Creative & Design
        'fashion': ['fashion studio elegant', 'clothing boutique interior', 'fashion design workspace', 'luxury retail store'],
        'beauty': ['beauty salon modern', 'spa treatment room', 'cosmetics studio professional', 'beauty therapy'],
        'photography': ['photography studio professional', 'camera equipment setup', 'photo shoot lighting', 'photographer workspace'],
        'design': ['creative studio workspace', 'design agency office', 'designer workspace modern', 'creative office'],
        
        // Education
        'education': ['modern classroom design', 'university lecture hall', 'learning environment bright', 'school interior'],
        'online-learning': ['home office study', 'online education setup', 'digital learning workspace', 'student studying'],
        
        // Real Estate & Construction
        'real-estate': ['luxury home interior', 'modern house architecture', 'real estate property', 'elegant home design'],
        'construction': ['construction site professional', 'building development', 'architecture planning', 'construction team'],
        
        // Travel & Hospitality
        'travel': ['travel destination beautiful', 'vacation resort luxury', 'travel agency office', 'adventure landscape'],
        'hotel': ['luxury hotel lobby', 'hotel room elegant', 'hospitality service', 'resort accommodation'],
        
        // Automotive
        'automotive': ['car dealership showroom', 'automotive service garage', 'luxury car interior', 'mechanic workshop'],
        'food-delivery': ['food delivery service', 'restaurant kitchen busy', 'food packaging professional', 'delivery driver'],
        'e-commerce': ['online store warehouse', 'product photography setup', 'shipping center organized', 'retail fulfillment'],
        'nonprofit': ['community center volunteers', 'charity work helping', 'nonprofit office warm', 'social impact'],
        'pet': ['veterinary clinic modern', 'pet grooming salon', 'animal care professional', 'pet store friendly'],
        'agriculture': ['farm landscape green', 'agricultural field sunset', 'farming equipment modern', 'organic produce'],
        'music': ['recording studio professional', 'music lesson room', 'concert hall elegant', 'musician workspace']
    };
    
    // Match website type and description content
    let selectedQueries = [];
    
    for (const [industry, queries] of Object.entries(industryQueries)) {
        if (websiteType === industry || words.includes(industry) || 
            words.includes(industry.replace('-', ' '))) {
            selectedQueries = queries;
            break;
        }
    }
    
    // If no specific match, try partial matching
    if (selectedQueries.length === 0) {
        for (const [industry, queries] of Object.entries(industryQueries)) {
            const industryWords = industry.split('-');
            if (industryWords.some(word => words.includes(word))) {
                selectedQueries = queries;
                break;
            }
        }
    }
    
    // Fallback: Extract meaningful keywords from description for dynamic search
    if (selectedQueries.length === 0) {
        console.log('📝 No predefined match, extracting keywords from description...');
        
        // Extract main subject words (nouns, business types)
        const meaningfulWords = description.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => 
                word.length > 3 && 
                !['website', 'create', 'build', 'make', 'need', 'want', 'with', 'have', 'that', 'this', 'about', 'from', 'will', 'should', 'would'].includes(word)
            )
            .slice(0, 3); // Take first 3 meaningful words
        
        if (meaningfulWords.length > 0) {
            const dynamicQuery = meaningfulWords.join(' ') + ' professional business';
            console.log(`✨ Dynamic query generated: "${dynamicQuery}"`);
            selectedQueries = [dynamicQuery, meaningfulWords[0] + ' modern professional', meaningfulWords[0] + ' business interior'];
        } else {
            // Ultimate fallback
            selectedQueries = ['professional business office', 'corporate meeting room', 'modern workplace', 'business professional'];
        }
    }
    
    // Return a random query from the selected ones for variety
    return selectedQueries[Math.floor(Math.random() * selectedQueries.length)];
}

function getAboutSearchQuery(description, websiteType) {
    const aboutQueries = {
        'restaurant': ['professional chef portrait', 'restaurant team kitchen', 'culinary team professional', 'chef cooking action'],
        'fitness': ['fitness trainer professional', 'gym instructor training', 'personal trainer session', 'fitness coach'],
        'medical': ['medical doctor professional', 'healthcare team hospital', 'medical staff consultation', 'doctor patient care'],
        'tech': ['software developer team', 'tech team meeting', 'programmers working together', 'startup team office'],
        'education': ['teacher classroom professional', 'educators team portrait', 'academic staff university', 'learning facilitator'],
        'portfolio': ['creative professional portrait', 'designer workspace', 'artist studio natural', 'freelancer working'],
        'business': ['business team professional', 'corporate team meeting', 'professional portrait', 'office team collaboration']
    };
    
    const queries = aboutQueries[websiteType] || aboutQueries['business'];
    return queries[Math.floor(Math.random() * queries.length)];
}

function getServicesSearchQuery(description, websiteType) {
    const serviceQueries = {
        'restaurant': ['food service professional', 'dining experience elegant', 'culinary service quality', 'restaurant hospitality'],
        'fitness': ['personal training session', 'fitness coaching professional', 'gym services equipment', 'workout training'],
        'medical': ['medical consultation room', 'healthcare services professional', 'medical treatment modern', 'patient care quality'],
        'tech': ['software development process', 'technology solutions modern', 'digital services professional', 'tech consultation'],
        'education': ['educational services modern', 'learning programs quality', 'training services professional', 'academic consultation'],
        'business': ['business consulting professional', 'corporate services quality', 'professional consultation', 'business solutions']
    };
    
    const queries = serviceQueries[websiteType] || serviceQueries['business'];
    return queries[Math.floor(Math.random() * queries.length)];
}

function getPortfolioSearchQuery(description, websiteType) {
    const words = description.toLowerCase();
    
    // Tech & Development portfolios (check first)
    if (words.includes('developer') || words.includes('programming') || words.includes('coding') || words.includes('web')) {
        return 'laptop coding workspace modern';
    }
    if (words.includes('software') || words.includes('tech')) {
        return 'computer programming desk setup';
    }
    
    // Creative portfolios
    if (words.includes('creative') || words.includes('design')) return 'creative design portfolio work';
    if (words.includes('photography')) return 'photography portfolio professional photos';
    if (words.includes('architecture')) return 'architecture portfolio building design';
    if (words.includes('ui') || words.includes('ux')) return 'ui design workspace modern';
    
    // Default to tech/workspace
    return 'modern workspace laptop desk';
}

function getTeamSearchQuery(description, websiteType) {
    return 'professional diverse team collaboration';
}

function getContactSearchQuery(description, websiteType) {
    return 'modern office building contact location';
}

function getGenericSearchQuery(description, websiteType, section) {
    return `professional ${section} ${websiteType || 'business'}`;
}

// Upload project endpoint - handles folder uploads
app.post('/api/upload-project', upload.array('files', 100), async (req, res) => {
    try {
        // Check if storage is ready
        if (!storageReady || !storage) {
            return res.status(503).json({
                success: false,
                error: 'Storage service is not ready yet. Please try again in a few seconds.'
            });
        }

        const { projectName, userId } = req.body;
        const files = req.files;
        const paths = req.body; // Contains paths[0], paths[1], etc.

        // Validate inputs
        if (!projectName) {
            return res.status(400).json({
                success: false,
                error: 'Project name is required'
            });
        }

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No files uploaded'
            });
        }

        console.log(`📤 Uploading project "${projectName}" with ${files.length} files...`);

        // Check if project already exists
        const existingProjects = await storage.listProjects();
        if (existingProjects.includes(projectName)) {
            return res.status(400).json({
                success: false,
                error: `Project "${projectName}" already exists. Please use a different name.`
            });
        }

        // Process and upload each file
        let uploadedCount = 0;
        const fileMap = {}; // Store file contents by path

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const filePath = paths[`paths[${i}]`] || file.originalname;
            
            // Convert buffer to string (for text files) or keep as buffer (for images)
            const isTextFile = /\.(html|htm|css|js|json|txt|md|xml)$/i.test(filePath);
            const content = isTextFile ? file.buffer.toString('utf-8') : file.buffer;

            // Extract just the filename from path (remove folder structure if present)
            const fileName = path.basename(filePath);
            
            fileMap[fileName] = content;
            uploadedCount++;
        }

        // Ensure we have the required files (index.html is mandatory)
        if (!fileMap['index.html']) {
            return res.status(400).json({
                success: false,
                error: 'index.html is required. Please ensure your project has an index.html file.'
            });
        }

        // Add default files if missing
        if (!fileMap['style.css']) {
            fileMap['style.css'] = '/* Add your styles here */\n';
        }

        if (!fileMap['script.js']) {
            fileMap['script.js'] = '// Add your JavaScript here\n';
        }

        // Save all files to Supabase storage
        for (const [fileName, content] of Object.entries(fileMap)) {
            await storage.saveFile(projectName, fileName, content);
            console.log(`  ✓ Uploaded: ${fileName}`);
        }

        console.log(`✅ Project "${projectName}" uploaded successfully! (${uploadedCount} files)`);

        res.json({
            success: true,
            message: `Project "${projectName}" uploaded successfully`,
            projectName: projectName,
            filesUploaded: uploadedCount
        });

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to upload project'
        });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/public', 'index.html'));
});

// Test endpoint to verify Supabase storage
app.get('/api/test-storage', async (req, res) => {
    try {
        if (!storage) {
            return res.json({ 
                error: 'Storage not initialized yet',
                message: 'Wait a few seconds and try again'
            });
        }

        const info = storage.getInfo();
        const projects = await storage.listProjects();
        
        res.json({
            success: true,
            storage: info,
            projectCount: projects.length,
            projects: projects,
            message: 'Supabase storage is working!'
        });
    } catch (error) {
        res.json({
            error: error.message,
            message: 'Storage test failed'
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Nexo.ai running on http://localhost:${PORT}`);
    console.log(`📁 Projects will be created in: ${path.join(__dirname, 'projects')}`);
    console.log(`🧠 AI Context Management: Enabled with project history tracking`);
});
