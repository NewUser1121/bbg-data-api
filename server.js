const express = require('express');
const cors = require('cors');
const { json } = require('body-parser');
const https = require('https');
const pool = require('./db');
const multer = require('multer');
const upload = multer();
const cron = require('node-cron');

const app = express();

// Middleware
app.use(cors());
app.use(json({ limit: '10mb' })); // Increase limit for large data.json files
app.use(express.static('public'));

// Upload data (now saves to PostgreSQL)
app.post('/api/v1/data/upload', upload.none(), async (req, res) => {
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

        // Save to PostgreSQL with all metadata fields
        const { name, description, category, uploaderName, data, pointCount, configName, version } = req.body;
        const result = await pool.query(
            `INSERT INTO uploaded_files (filename, mimetype, data, description, category, uploader_name, point_count, config_name, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, uploaded_at` ,
            [
                name?.trim() || '',
                'application/json',
                Buffer.from(data),
                description?.trim() || '',
                category?.trim() || '',
                uploaderName?.trim() || '',
                pointCount ? parseInt(pointCount) : 0,
                configName?.trim() || '',
                version?.trim() || ''
            ]
        );
        const newId = result.rows[0].id;
        const uploadedAt = result.rows[0].uploaded_at;

        res.json({ 
            success: true, 
            dataId: newId.toString().padStart(16, '0'),
            uploadedAt,
            message: 'Data uploaded and saved to database!'
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Download data by ID (from PostgreSQL)
app.get('/api/v1/data/download/:id', async (req, res) => {
    try {
        // Remove leading zeros from the ID for database lookup
        const rawId = req.params.id.replace(/^0+/, '');
        // Validate that rawId is a valid integer
        if (!rawId || isNaN(rawId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid ID format'
            });
        }
        const result = await pool.query('SELECT * FROM uploaded_files WHERE id = $1', [rawId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Data not found' 
            });
        }
        const entry = result.rows[0];
        // If data is missing or empty, return error
        if (!entry.data || entry.data.length === 0) {
            console.error('File data is missing or corrupted in the database:', entry);
            return res.status(500).json({
                success: false,
                error: 'File data is missing or corrupted in the database.',
                debug: {
                    typeofData: typeof entry.data,
                    isArray: Array.isArray(entry.data),
                    constructor: entry.data && entry.data.constructor && entry.data.constructor.name,
                    length: entry.data && entry.data.length,
                    preview: entry.data && entry.data.slice && entry.data.slice(0, 32)
                }
            });
        }
        // If data is a Buffer, send as is. If not, try to convert.
        let fileBuffer = entry.data;
        // Add debug logging for type and preview
        console.log('Download: entry.data type:', typeof fileBuffer, Array.isArray(fileBuffer), fileBuffer && fileBuffer.constructor && fileBuffer.constructor.name, fileBuffer && fileBuffer.length, fileBuffer && fileBuffer.slice && fileBuffer.slice(0, 32));
        // If it's a Buffer, just send it
        if (Buffer.isBuffer(fileBuffer)) {
            res.set('Content-Type', entry.mimetype || 'application/octet-stream');
            res.set('Content-Disposition', `attachment; filename="${entry.filename || 'file.json'}"`);
            return res.send(fileBuffer);
        }
        // If it's { type: 'Buffer', data: [...] }
        if (fileBuffer && fileBuffer.type === 'Buffer' && Array.isArray(fileBuffer.data)) {
            fileBuffer = Buffer.from(fileBuffer.data);
            res.set('Content-Type', entry.mimetype || 'application/octet-stream');
            res.set('Content-Disposition', `attachment; filename="${entry.filename || 'file.json'}"`);
            return res.send(fileBuffer);
        }
        // If it's an array (byte array)
        if (Array.isArray(fileBuffer)) {
            fileBuffer = Buffer.from(fileBuffer);
            res.set('Content-Type', entry.mimetype || 'application/octet-stream');
            res.set('Content-Disposition', `attachment; filename="${entry.filename || 'file.json'}"`);
            return res.send(fileBuffer);
        }
        // If it's a string, try base64 then utf8
        if (typeof fileBuffer === 'string') {
            try {
                let b = Buffer.from(fileBuffer, 'base64');
                if (b.length > 0) {
                    fileBuffer = b;
                } else {
                    fileBuffer = Buffer.from(fileBuffer, 'utf8');
                }
            } catch (e) {
                fileBuffer = Buffer.from(fileBuffer, 'utf8');
            }
            res.set('Content-Type', entry.mimetype || 'application/octet-stream');
            res.set('Content-Disposition', `attachment; filename="${entry.filename || 'file.json'}"`);
            return res.send(fileBuffer);
        }
        // If we get here, we don't know how to handle it
        console.error('Download: Unhandled fileBuffer type', typeof fileBuffer, fileBuffer);
        return res.status(500).json({
            success: false,
            error: 'Unhandled file data type in database.'
        });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({         error: 'Internal server error' 
        });
    }
});

// List data with pagination and filtering (from PostgreSQL)
app.get('/api/v1/data/list', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 per page
        const category = req.query.category;
        let query = 'SELECT id, filename, mimetype, uploaded_at, description, category, uploader_name, point_count, config_name, version FROM uploaded_files';
        let params = [];
        if (category && category !== 'All') {
            query += ' WHERE LOWER(category) = $1';
            params.push(category.toLowerCase());
            query += ' ORDER BY uploaded_at DESC LIMIT $2 OFFSET $3';
            params.push(limit, (page - 1) * limit);
        } else {
            query += ' ORDER BY uploaded_at DESC LIMIT $1 OFFSET $2';
            params.push(limit, (page - 1) * limit);
        }
        const result = await pool.query(query, params);
        // Get total count
        let countQuery = 'SELECT COUNT(*) FROM uploaded_files';
        let countParams = [];
        if (category && category !== 'All') {
            countQuery += ' WHERE LOWER(category) = $1';
            countParams.push(category.toLowerCase());
        }
        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(total / limit);
        // Map to expected output, use string for id and pad to 16 chars for bigger look
        const data = result.rows.map(row => ({
            id: row.id.toString().padStart(16, '0'),
            name: row.filename || '',
            description: row.description || '',
            category: row.category || '',
            uploaderName: row.uploader_name || '',
            pointCount: row.point_count || 0,
            configName: row.config_name || '',
            version: row.version || '',
            uploadedAt: row.uploaded_at
        }));
        res.json({
            success: true,
            data,
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

// Search data (from PostgreSQL)
app.get('/api/v1/data/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query || query.trim().length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Search query required' 
            });
        }
        const searchTerm = `%${query.toLowerCase().trim()}%`;
        const result = await pool.query(
            `SELECT id, filename, mimetype, uploaded_at FROM uploaded_files WHERE LOWER(filename) LIKE $1 OR LOWER(mimetype) LIKE $1 ORDER BY uploaded_at DESC LIMIT 50`,
            [searchTerm]
        );
        res.json({ 
            success: true, 
            data: result.rows,
            query: query,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Get statistics (from PostgreSQL)
app.get('/api/v1/stats', async (req, res) => {
    try {
        const totalResult = await pool.query('SELECT COUNT(*) FROM uploaded_files');
        const totalEntries = parseInt(totalResult.rows[0].count, 10);
        const recentResult = await pool.query('SELECT id, filename, mimetype, uploaded_at FROM uploaded_files ORDER BY uploaded_at DESC LIMIT 5');
        res.json({ 
            success: true, 
            data: {
                totalEntries,
                recentUploads: recentResult.rows
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Add validateEntry function
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

// Self-ping function to keep the server alive on Render
function selfPing() {
    const url = 'https://bbg-data-api.onrender.com';
    
    https.get(url, (res) => {
        console.log(`Self-ping successful: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error('Self-ping failed:', err.message);
    });
}

app.listen(PORT, () => {
    console.log(`BBG Data API Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
    // Schedule self-ping every 60 seconds (only in production)
    if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
        cron.schedule('*/1 * * * *', selfPing); // Every minute
        console.log('Self-ping scheduler activated - pinging every 60 seconds');
    }
});
