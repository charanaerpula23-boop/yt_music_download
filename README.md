# YouTube Music Downloader

A modern YouTube music downloader with real-time progress tracking and console-style UI.

## Features

- 🔍 Search YouTube music
- ⬇️ Download high-quality audio (WebM format)
- 📊 Real-time colored progress tracking
- 🎯 Console-style dark interface
- 📱 Mobile-responsive design
- ⚡ WebSocket-based live updates

## Technology Stack

- **Backend**: Node.js, Express, WebSocket
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **YouTube Integration**: youtube-sr for search, yt-dlp for downloads
- **Real-time Communication**: WebSocket for progress updates

## Progress Phases

- 🔴 **Red**: Extracting video information
- 🟠 **Orange**: Loading webpage
- 🟡 **Yellow**: Fetching API data  
- 🔵 **Blue**: Getting stream information
- 🟢 **Green**: Downloading audio file

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Install yt-dlp:
```bash
# Windows (via pip)
pip install yt-dlp

# Or download executable from: https://github.com/yt-dlp/yt-dlp/releases
```

3. Start the server:
```bash
npm start
```

4. Open http://localhost:3000

## Deployment to Render

### Prerequisites
- GitHub account
- Render account (free tier available)

### Steps

1. **Push to GitHub**:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/yourusername/your-repo.git
git push -u origin main
```

2. **Deploy on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Configure:
     - **Name**: `youtube-music-downloader`
     - **Environment**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`

3. **Environment Variables** (if needed):
   - `NODE_ENV=production`

### Important Notes for Render Deployment

⚠️ **yt-dlp Installation**: Render may not have yt-dlp pre-installed. You might need to:

1. Add a `render.yaml` build script, or
2. Use Docker deployment with yt-dlp included, or  
3. Consider alternative hosting that supports Python packages

### Alternative Deployment Options

- **Railway**: Better Python/yt-dlp support
- **Heroku**: With buildpacks for yt-dlp
- **DigitalOcean**: Full control over environment
- **VPS**: Complete customization

## Production Considerations

1. **Rate Limiting**: Implement to prevent YouTube blocking
2. **File Cleanup**: Auto-delete downloaded files after serving
3. **Error Handling**: Robust error responses
4. **Security**: Input validation and sanitization
5. **Caching**: Cache search results to reduce API calls

## License

ISC License