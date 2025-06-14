# BBG Data Sharing API

A free JSON-based API for sharing BBG (byebyegoldor) data.json files between users.

## Quick Start

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Server runs at `http://localhost:3000`

### Free Deployment on Render

1. Push code to GitHub repository
2. Connect to Render.com
3. Deploy as Web Service
4. Use the provided `render.yaml` configuration

## API Endpoints

### Health Check
- `GET /api/v1/health` - Check if API is running

### Data Management
- `POST /api/v1/data/upload` - Upload data.json
- `GET /api/v1/data/download/:id` - Download data by ID
- `GET /api/v1/data/list?page=1&category=General` - List available data
- `GET /api/v1/data/search?q=query` - Search data

### Statistics
- `GET /api/v1/stats` - Get API statistics

## Storage

Data is stored in `storage/database.json` as a simple JSON file. No database required!

## Categories
- General
- P3
- P5
- Speed
- Consistency
- Experimental
#   b b g - d a t a - a p i  
 