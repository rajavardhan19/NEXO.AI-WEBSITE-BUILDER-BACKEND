import { createClient } from '@supabase/supabase-js';

// Storage configuration - SUPABASE ONLY
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET_NAME = process.env.SUPABASE_BUCKET || 'nexo-projects';

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    console.error('Please set these in your .env file');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
console.log(`✅ Supabase Storage initialized (bucket: ${BUCKET_NAME})`);

/**
 * Supabase Storage Service - Cloud storage only
 */
class SupabaseStorageService {
    constructor() {
        this.bucket = BUCKET_NAME;
    }

    /**
     * Save file to Supabase Storage
     */
    async saveFile(projectName, fileName, content) {
        try {
            const filePath = `${projectName}/${fileName}`;
            
            console.log(`📤 Uploading to Supabase: ${filePath}`);
            
            // Upload to Supabase Storage
            const { data, error } = await supabase.storage
                .from(this.bucket)
                .upload(filePath, content, {
                    contentType: this.getContentType(fileName),
                    upsert: true // Overwrite if exists
                });

            if (error) {
                console.error(`❌ Upload failed for ${filePath}:`, error);
                throw new Error(`Supabase upload error: ${error.message}`);
            }

            // Get public URL
            const { data: urlData } = supabase.storage
                .from(this.bucket)
                .getPublicUrl(filePath);

            console.log(`✅ Uploaded successfully: ${filePath}`);

            return {
                success: true,
                url: urlData.publicUrl,
                path: filePath,
                storage: 'supabase'
            };
        } catch (error) {
            console.error('Error saving to Supabase:', error);
            throw error;
        }
    }

    /**
     * Read file from Supabase Storage
     */
    async readFile(projectName, fileName) {
        try {
            const filePath = `${projectName}/${fileName}`;
            
            const { data, error } = await supabase.storage
                .from(this.bucket)
                .download(filePath);

            if (error) {
                throw new Error(`Supabase download error: ${error.message}`);
            }

            // Convert blob to text
            const content = await data.text();
            return content;
        } catch (error) {
            console.error('Error reading from Supabase:', error);
            throw error;
        }
    }

    /**
     * List all projects from Supabase Storage
     */
    async listProjects() {
        try {
            const { data, error } = await supabase.storage
                .from(this.bucket)
                .list('', {
                    limit: 1000,
                    offset: 0,
                    sortBy: { column: 'name', order: 'asc' }
                });

            if (error) {
                throw new Error(`Supabase list error: ${error.message}`);
            }

            // Filter for folders only (projects)
            // In Supabase, folders have null id
            const projects = data
                .filter(item => item.id === null)
                .map(item => item.name);

            return projects;
        } catch (error) {
            console.error('Error listing projects from Supabase:', error);
            return [];
        }
    }

    /**
     * Read all files from a project
     */
    async readAllProjectFiles(projectName) {
        const files = {};
        const fileTypes = ['index.html', 'style.css', 'script.js', 'README.md'];
        
        for (const fileName of fileTypes) {
            try {
                const content = await this.readFile(projectName, fileName);
                files[fileName] = content;
            } catch (error) {
                // File doesn't exist, skip it
                console.log(`File ${fileName} not found in ${projectName}`);
            }
        }
        
        return files;
    }

    /**
     * Delete project from Supabase Storage
     */
    async deleteProject(projectName) {
        try {
            // List all files in project folder
            const { data: files, error: listError } = await supabase.storage
                .from(this.bucket)
                .list(projectName);

            if (listError) {
                throw new Error(`Supabase list error: ${listError.message}`);
            }

            if (!files || files.length === 0) {
                return { success: true, message: 'Project not found or already deleted' };
            }

            // Delete all files in the folder
            const filePaths = files.map(file => `${projectName}/${file.name}`);
            
            const { error: deleteError } = await supabase.storage
                .from(this.bucket)
                .remove(filePaths);

            if (deleteError) {
                throw new Error(`Supabase delete error: ${deleteError.message}`);
            }

            return { success: true, message: 'Project deleted successfully from Supabase' };
        } catch (error) {
            console.error('Error deleting from Supabase:', error);
            throw error;
        }
    }

    /**
     * Get public URL for a file
     */
    async getPublicUrl(projectName, fileName) {
        const filePath = `${projectName}/${fileName}`;
        const { data } = supabase.storage
            .from(this.bucket)
            .getPublicUrl(filePath);
        
        return data.publicUrl;
    }

    /**
     * Check if project exists
     */
    async projectExists(projectName) {
        try {
            const { data, error } = await supabase.storage
                .from(this.bucket)
                .list(projectName, { limit: 1 });
            
            return !error && data && data.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get content type based on file extension
     */
    getContentType(fileName) {
        const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
        const contentTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.txt': 'text/plain',
            '.md': 'text/markdown',
        };
        return contentTypes[ext] || 'application/octet-stream';
    }

    /**
     * Get storage info
     */
    getInfo() {
        return {
            mode: 'supabase',
            bucket: this.bucket,
            url: supabaseUrl,
        };
    }
}

// Export singleton instance
const storage = new SupabaseStorageService();

export default storage;
