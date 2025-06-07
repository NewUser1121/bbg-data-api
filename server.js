const express = require('express');
const cors = require('cors');
const { json } = require('body-parser');
const fs = require('fs').promises;
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(json({ limit: '10mb' })); // Increase limit for large data.json files
app.use(express.static('public'));

// Create data directory if it doesn't exist
const DATA_DIR = path.join(__dirname, 'storage');
const DATABASE_FILE = path.join(DATA_DIR, 'database.json');

// Initialize database
async function initializeDatabase() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Check if database exists
        try {
            await fs.access(DATABASE_FILE);
            console.log('Database file exists');
        } catch {
            // Create empty database
            const emptyDb = {
                entries: [],
                metadata: {
                    created: new Date().toISOString(),
                    version: "1.0.0"
                }
            };
            await fs.writeFile(DATABASE_FILE, JSON.stringify(emptyDb, null, 2));
            console.log('Created new database file');
        }
    } catch (error) {
        console.error('Failed to initialize database:', error);
        process.exit(1);
    }
}

// Database operations
async function readDatabase() {
    try {
        const data = await fs.readFile(DATABASE_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        throw error;
    }
}

async function writeDatabase(data) {
    try {
        await fs.writeFile(DATABASE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing database:', error);
        throw error;
    }
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Validate data entry
function validateEntry(entry) {
    const required = ['name', 'description', 'data', 'uploaderName'];
    for (const field of required) {
        if (!entry[field] || entry[field].toString().trim().length === 0) {
            return `Missing required field: ${field}`;
        }
    }
    
    // Validate JSON data
    try {
        JSON.parse(entry.data);
    } catch (e) {
        return 'Invalid JSON data';
    }
    
    // Check name length
    if (entry.name.length > 100) {
        return 'Name too long (max 100 characters)';
    }
    
    // Check description length
    if (entry.description.length > 500) {
        return 'Description too long (max 500 characters)';
    }
    
    return null;
}

// Routes

// Health check
app.get('/api/v1/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'BBG Data API is running',
        timestamp: new Date().toISOString()
    });
});

// Upload data
app.post('/api/v1/data/upload', async (req, res) => {
    try {
        console.log('Upload request received:', {
            name: req.body.name,
            uploader: req.body.uploaderName,
            category: req.body.category
        });

        // Validate request
        const validationError = validateEntry(req.body);
        if (validationError) {
            return res.status(400).json({ 
                success: false, 
                error: validationError 
            });
        }

        const db = await readDatabase();
        
        // Create new entry
        const newEntry = {
            id: generateId(),
            name: req.body.name.trim(),
            description: req.body.description.trim(),
            category: req.body.category || 'General',
            uploaderName: req.body.uploaderName.trim(),
            uploadDate: new Date().toISOString(),
            dataSize: req.body.data.length,
            pointCount: req.body.pointCount || 0,
            configName: req.body.configName || 'Unknown',
            version: req.body.version || '0.3.5',
            data: req.body.data
        };
        
        // Add to database
        db.entries.push(newEntry);
        await writeDatabase(db);
        
        console.log(`Successfully uploaded data: ${newEntry.name} (ID: ${newEntry.id})`);
        
        res.json({ 
            success: true, 
            dataId: newEntry.id,
            message: 'Data uploaded successfully'
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Download data by ID
app.get('/api/v1/data/download/:id', async (req, res) => {
    try {
        const db = await readDatabase();
        const entry = db.entries.find(e => e.id === req.params.id);
        
        if (!entry) {
            return res.status(404).json({ 
                success: false, 
                error: 'Data not found' 
            });
        }
        
        console.log(`Data downloaded: ${entry.name} (ID: ${entry.id})`);
        
        res.json({ 
            success: true, 
            data: entry 
        });
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// List data with pagination and filtering
app.get('/api/v1/data/list', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 per page
        const category = req.query.category;
        
        const db = await readDatabase();
        let filteredEntries = db.entries;
        
        // Filter by category if provided
        if (category && category !== 'All') {
            filteredEntries = filteredEntries.filter(e => 
                e.category.toLowerCase() === category.toLowerCase()
            );
        }
        
        // Sort by upload date (newest first)
        filteredEntries.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));
        
        // Calculate pagination
        const total = filteredEntries.length;
        const totalPages = Math.ceil(total / limit);
        const start = (page - 1) * limit;
        const end = start + limit;
        
        // Get page data (exclude the actual data field to reduce response size)
        const paginatedEntries = filteredEntries
            .slice(start, end)
            .map(({ data, ...entry }) => entry);
        
        res.json({
            success: true,
            data: paginatedEntries,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        });
        
    } catch (error) {
        console.error('List error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Search data
app.get('/api/v1/data/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query || query.trim().length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Search query required' 
            });
        }
        
        const searchTerm = query.toLowerCase().trim();
        const db = await readDatabase();
        
        // Search in name, description, uploader, and category
        const results = db.entries
            .filter(entry => 
                entry.name.toLowerCase().includes(searchTerm) ||
                entry.description.toLowerCase().includes(searchTerm) ||
                entry.uploaderName.toLowerCase().includes(searchTerm) ||
                entry.category.toLowerCase().includes(searchTerm)
            )
            .sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate))
            .slice(0, 50) // Limit search results
            .map(({ data, ...entry }) => entry); // Exclude data field
        
        res.json({ 
            success: true, 
            data: results,
            query: searchTerm,
            count: results.length
        });
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Get statistics
app.get('/api/v1/stats', async (req, res) => {
    try {
        const db = await readDatabase();
        
        const stats = {
            totalEntries: db.entries.length,
            categories: {},
            topUploaders: {},
            recentUploads: db.entries
                .sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate))
                .slice(0, 5)
                .map(({ data, ...entry }) => entry)
        };
        
        // Count by category
        db.entries.forEach(entry => {
            stats.categories[entry.category] = (stats.categories[entry.category] || 0) + 1;
        });
        
        // Count by uploader
        db.entries.forEach(entry => {
            stats.topUploaders[entry.uploaderName] = (stats.topUploaders[entry.uploaderName] || 0) + 1;
        });
        
        res.json({ 
            success: true, 
            data: stats 
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found' 
    });
});

// Start server
const PORT = process.env.PORT || 3000;

initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`BBG Data API Server running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
