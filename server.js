// run: node server.js

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { YouTube } from "youtube-sr";
import { WebSocketServer } from "ws";
import http from "http";
import { existsSync } from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Determine yt-dlp command based on environment
const YT_DLP_CMD = existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Store active downloads
const activeDownloads = new Map();

// Rate limiting - track requests per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 3; // 3 downloads per minute per IP

function getRandomUserAgent() {
    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function checkRateLimit(ip) {
    const now = Date.now();
    const userRequests = rateLimitMap.get(ip) || [];
    
    // Remove old requests
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT_MAX) {
        return false; // Rate limited
    }
    
    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);
    return true; // OK to proceed
}

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// ------------------- HEALTH CHECK -------------------
app.get("/", (req, res) => {
    res.json({ 
        status: "OK", 
        service: "YouTube Music Downloader",
        timestamp: new Date().toISOString()
    });
});

app.get("/health", (req, res) => {
    res.json({ 
        status: "healthy", 
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ------------------- SEARCH SONGS -------------------
app.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);

    try {
        const results = await YouTube.search(q, { limit: 10, type: "video" });

        const simplified = results.map(v => ({
            id: v.id,
            title: v.title,
            duration: Math.floor(v.duration / 1000), // ms to seconds
            thumbnail: v.thumbnail?.url
        }));

        res.json(simplified);
    } catch (e) {
        console.error("Search failed:", e);
        res.status(500).json({ error: "search_failed" });
    }
});


// Store metadata cache to avoid re-extraction
const metadataCache = new Map();

// ------------------- DOWNLOAD WEBM -------------------
app.get("/download", (req, res) => {
    const id = req.query.id;
    if (!id) return res.send("video id required");

    // Rate limiting
    const clientIP = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIP)) {
        return res.status(429).json({ 
            error: "Rate limit exceeded. Please wait before downloading again.",
            retryAfter: 60 
        });
    }

    // Start metadata extraction in parallel (don't wait)
    if (!metadataCache.has(id)) {
        const metadataArgs = [
            "--print", "%(title)s|||%(duration)s|||%(uploader)s", 
            "--no-warnings", 
            "--no-playlist",
            "--add-header", `User-Agent:${getRandomUserAgent()}`,
            "--geo-bypass",
            "--socket-timeout", "30",
            `https://www.youtube.com/watch?v=${id}`
        ];
        const metadataProcess = spawn(YT_DLP_CMD, metadataArgs);
        let metadata = "";
        
        metadataProcess.stdout.on("data", d => metadata += d.toString());
        metadataProcess.on("close", (code) => {
            if (code === 0 && metadata.trim()) {
                const [title, duration, uploader] = metadata.trim().split("|||");
                metadataCache.set(id, { title, duration: parseInt(duration) || 0, uploader });
                setTimeout(() => metadataCache.delete(id), 3600000);
            }
        });
    }

    // Start download immediately (parallel to metadata)
    const args = [
        "-f", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "--no-warnings",
        "--progress",
        "--newline",
        "--no-check-certificate",
        "--prefer-free-formats",
        "--add-header", `User-Agent:${getRandomUserAgent()}`,
        "--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "--add-header", "Accept-Language:en-US,en;q=0.5",
        "--add-header", "Accept-Encoding:gzip, deflate",
        "--add-header", "Connection:keep-alive",
        "--add-header", "Upgrade-Insecure-Requests:1",
        "--extractor-args", "youtube:skip=hls,dash",
        "--concurrent-fragments", "1",
        "--limit-rate", "5M",
        "--no-playlist",
        "--geo-bypass",
        "--socket-timeout", "30",
        `https://www.youtube.com/watch?v=${id}`,
        "-o", "-"
    ];

    const ytdlp = spawn(YT_DLP_CMD, args);
    
    // Store this download
    activeDownloads.set(id, { process: ytdlp, progress: 0 });

    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.webm"`);
    
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on("data", d => {
        const output = d.toString();
        
        // Track different phases with colors and step numbers
        let phase = 'preparing';
        let color = '#ff6b6b'; // red
        let stepNumber = 0;
        let totalSteps = 5;
        let message = '0/5 Preparing...';
        
        if (output.includes('Extracting URL')) {
            phase = 'extracting';
            color = '#ff6b6b'; // red
            stepNumber = 1;
            message = `${stepNumber}/${totalSteps} Extracting...`;
        } else if (output.includes('Downloading webpage')) {
            phase = 'webpage';
            color = '#ffa500'; // orange
            stepNumber = 2;
            message = `${stepNumber}/${totalSteps} Getting webpage...`;
        } else if (output.includes('Downloading android') || output.includes('player API')) {
            phase = 'api';
            color = '#ffff00'; // yellow
            stepNumber = 3;
            message = `${stepNumber}/${totalSteps} Getting API...`;
        } else if (output.includes('Downloading m3u8') || output.includes('information')) {
            phase = 'info';
            color = '#87ceeb'; // light blue
            stepNumber = 4;
            message = `${stepNumber}/${totalSteps} Getting stream info...`;
        } else if (output.includes('[download]') && output.includes('%')) {
            phase = 'downloading';
            color = '#00ff00'; // green
            stepNumber = 5;
            
            // Parse actual download progress
            const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
            if (progressMatch) {
                const progress = parseFloat(progressMatch[1]);
                message = `Downloading: ${progress.toFixed(1)}%`;
                
                // Broadcast download progress
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: 'progress',
                            id: id,
                            progress: progress,
                            phase: phase,
                            color: color,
                            message: message
                        }));
                    }
                });
                
                if (activeDownloads.has(id)) {
                    activeDownloads.get(id).progress = progress;
                }
                return;
            }
        }
        
        // Broadcast phase updates
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'phase',
                    id: id,
                    phase: phase,
                    color: color,
                    message: message
                }));
            }
        });
        
        console.log("YT-DLP:", output.trim());
        
        // Check for bot detection error
        if (output.includes("Sign in to confirm you're not a bot") || output.includes("cookies")) {
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'error',
                        id: id,
                        message: 'YouTube blocked request - try again later',
                        error: 'bot_detection'
                    }));
                }
            });
        }
    });

    ytdlp.on("error", (err) => {
        console.error("YT-DLP Error:", err);
        activeDownloads.delete(id);
        
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'error',
                    id: id,
                    message: 'Download failed'
                }));
            }
        });
        
        if (!res.headersSent) {
            res.status(500).send("Download failed");
        }
    });

    ytdlp.on("close", (code) => {
        activeDownloads.delete(id);
        
        if (code === 0) {
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'complete',
                        id: id,
                        message: 'Download complete!'
                    }));
                }
            });
        } else {
            console.error(`YT-DLP exited with code ${code}`);
            
            // Send error message to clients
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'error',
                        id: id,
                        message: code === 1 ? 
                            'YouTube blocked the request. Please try again in a few minutes.' : 
                            'Download failed. Please try a different video.',
                        error: 'download_failed',
                        code: code
                    }));
                }
            });
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: "Download failed",
                    message: code === 1 ? 
                        "YouTube is temporarily blocking requests. Please try again later." : 
                        "Download failed. Please try a different video.",
                    code: code
                });
            }
        }
    });
});


// ------------------- START -------------------

// Check yt-dlp availability on startup
function checkYtDlp() {
    console.log(`Checking yt-dlp availability: ${YT_DLP_CMD}`);
    const testProcess = spawn(YT_DLP_CMD, ['--version']);
    
    testProcess.on('close', (code) => {
        if (code === 0) {
            console.log('✅ yt-dlp is available and working');
        } else {
            console.log('❌ yt-dlp test failed with code:', code);
        }
    });
    
    testProcess.on('error', (err) => {
        console.log('❌ yt-dlp not found or not executable:', err.message);
        console.log('📍 Available files in current directory:');
        try {
            import('fs').then(fs => {
                const files = fs.readdirSync('.');
                console.log(files.filter(f => f.includes('yt-dlp')));
            });
        } catch(e) {
            console.log('Could not list files');
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Simple YT Service > http://localhost:${PORT}`);
    console.log(`Using yt-dlp command: ${YT_DLP_CMD}`);
    checkYtDlp();
});
