// run: node server.js

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { YouTube } from "youtube-sr";
import { WebSocketServer } from "ws";
import http from "http";
import { existsSync } from "fs";
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Determine yt-dlp command based on environment
const YT_DLP_CMD = existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';

// Setup cookies on startup
function setupCookies() {
    const cookiesPath = process.env.NODE_ENV === 'production' ? '/tmp/cookies.txt' : path.join(__dirname, 'cookies.txt');
    
    // If you have cookies in env variable (for production)
    if (process.env.YOUTUBE_COOKIES) {
        fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
        console.log('✅ Cookies loaded from environment variable');
    } 
    // Or if cookies.txt is in your project (for development)
    else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
        if (process.env.NODE_ENV === 'production') {
            fs.copyFileSync(path.join(__dirname, 'cookies.txt'), cookiesPath);
            console.log('✅ Cookies copied to production location');
        } else {
            console.log('✅ Cookies found in project directory');
        }
    } else {
        console.warn('⚠️ No cookies found! Downloads may fail due to YouTube bot detection.');
    }
    
    return cookiesPath;
}

const cookiesPath = setupCookies();

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
        // Desktop browsers
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        // Mobile/Android browsers (often bypass bot detection better)
        "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getExtractorArgs() {
    // Try different player clients - Android and iOS often work better
    const extractorOptions = [
        "youtube:player_client=android,web",
        "youtube:player_client=ios,web", 
        "youtube:player_client=web,android",
        "youtube:skip=hls,dash;player_client=android"
    ];
    return extractorOptions[Math.floor(Math.random() * extractorOptions.length)];
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

// Retry mechanism for failed downloads with cookies
async function tryDownloadWithFallbacks(id, res, attempt = 1) {
    const maxAttempts = 3;
    
    console.log(`Attempt ${attempt}/${maxAttempts} for video ${id}`);
    
    // Different strategies for each attempt with cookies
    let args;
    if (attempt === 1) {
        // First attempt: Android client with cookies
        args = [
            "--cookies", cookiesPath,
            "-f", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
            "--no-warnings", "--progress", "--newline",
            "--extractor-args", "youtube:player_client=android,web",
            "--user-agent", "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
            "--geo-bypass", "--socket-timeout", "30",
            "--no-playlist", `https://www.youtube.com/watch?v=${id}`, "-o", "-"
        ];
    } else if (attempt === 2) {
        // Second attempt: iOS client with cookies
        args = [
            "--cookies", cookiesPath,
            "-f", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
            "--no-warnings", "--progress", "--newline",
            "--extractor-args", "youtube:player_client=ios,web",
            "--user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
            "--geo-bypass", "--socket-timeout", "30",
            "--no-playlist", `https://www.youtube.com/watch?v=${id}`, "-o", "-"
        ];
    } else {
        // Third attempt: Web client with cookies (fallback)
        args = [
            "--cookies", cookiesPath,
            "-f", "bestaudio", "--no-warnings", "--progress", "--newline",
            "--extractor-args", "youtube:player_client=web",
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "--no-playlist", `https://www.youtube.com/watch?v=${id}`, "-o", "-"
        ];
    }
    
    return new Promise((resolve, reject) => {
        const ytdlp = spawn(YT_DLP_CMD, args);
        let hasData = false;
        let errorOutput = "";
        
        // Store this download
        activeDownloads.set(id, { process: ytdlp, progress: 0, attempt });

        res.setHeader("Content-Type", "audio/webm");
        res.setHeader("Content-Disposition", `attachment; filename="${id}.webm"`);
        
        ytdlp.stdout.on('data', (data) => {
            hasData = true;
            if (!res.headersSent) {
                res.write(data);
            }
        });
        
        ytdlp.stderr.on("data", d => {
            const output = d.toString();
            errorOutput += output;
            
            // Track progress phases (existing code)
            let phase = 'preparing';
            let color = '#ff6b6b';
            let stepNumber = 0;
            let totalSteps = 5;
            let message = '0/5 Preparing...';
            
            if (output.includes('Extracting URL')) {
                phase = 'extracting'; color = '#ff6b6b'; stepNumber = 1;
                message = `${stepNumber}/${totalSteps} Extracting...`;
            } else if (output.includes('Downloading webpage')) {
                phase = 'webpage'; color = '#ffa500'; stepNumber = 2;
                message = `${stepNumber}/${totalSteps} Getting webpage...`;
            } else if (output.includes('Downloading android') || output.includes('player API')) {
                phase = 'api'; color = '#ffff00'; stepNumber = 3;
                message = `${stepNumber}/${totalSteps} Getting API...`;
            } else if (output.includes('Downloading m3u8') || output.includes('information')) {
                phase = 'info'; color = '#87ceeb'; stepNumber = 4;
                message = `${stepNumber}/${totalSteps} Getting stream info...`;
            } else if (output.includes('[download]') && output.includes('%')) {
                phase = 'downloading'; color = '#00ff00'; stepNumber = 5;
                const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
                if (progressMatch) {
                    const progress = parseFloat(progressMatch[1]);
                    message = `${stepNumber}/${totalSteps} Downloading ${progress.toFixed(1)}%`;
                    
                    activeDownloads.get(id).progress = progress;
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'progress',
                                videoId: id,
                                phase: phase,
                                percent: progress
                            }));
                        }
                    });
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
                        message: `Attempt ${attempt}: ${message}`
                    }));
                }
            });
            
            console.log(`YT-DLP (Attempt ${attempt}):`, output.trim());
        });
        
        ytdlp.on("close", (code) => {
            activeDownloads.delete(id);
            
            if (code === 0 && hasData) {
                console.log(`Download completed for ${id} on attempt ${attempt}`);
                
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: 'complete',
                            id: id,
                            message: `Download completed! (Attempt ${attempt})`
                        }));
                    }
                });
                
                if (!res.headersSent) {
                    res.end();
                }
                resolve();
            } else {
                console.error(`YT-DLP attempt ${attempt} failed with code ${code}`);
                
                // Check if we should retry
                if (attempt < maxAttempts && 
                    (errorOutput.includes("Sign in to confirm") || 
                     errorOutput.includes("bot") || 
                     code === 1)) {
                    
                    console.log(`Retrying with different strategy (${attempt + 1}/${maxAttempts})`);
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'phase',
                                id: id,
                                phase: 'retrying',
                                color: '#ffa500',
                                message: `Attempt ${attempt} failed, trying different method...`
                            }));
                        }
                    });
                    
                    // Wait 2 seconds before retry
                    setTimeout(() => {
                        tryDownloadWithFallbacks(id, res, attempt + 1)
                            .then(resolve)
                            .catch(reject);
                    }, 2000);
                } else {
                    // All attempts failed
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'error',
                                id: id,
                                message: `Download failed after ${maxAttempts} attempts. YouTube may be blocking requests.`,
                                error: 'all_attempts_failed'
                            }));
                        }
                    });
                    
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: "Download failed",
                            message: `All ${maxAttempts} attempts failed. YouTube may be temporarily blocking requests.`,
                            attempts: maxAttempts
                        });
                    }
                    reject(new Error(`All attempts failed`));
                }
            }
        });
        
        ytdlp.on("error", (err) => {
            console.error(`YT-DLP Error (Attempt ${attempt}):`, err);
            activeDownloads.delete(id);
            
            if (attempt < maxAttempts) {
                setTimeout(() => {
                    tryDownloadWithFallbacks(id, res, attempt + 1)
                        .then(resolve)
                        .catch(reject);
                }, 2000);
            } else {
                if (!res.headersSent) {
                    res.status(500).json({ error: "Download failed", message: err.message });
                }
                reject(err);
            }
        });
    });
}

// ------------------- DOWNLOAD WEBM -------------------
app.get("/download", async (req, res) => {
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

    // Use the new retry mechanism
    try {
        await tryDownloadWithFallbacks(id, res);
    } catch (error) {
        console.error("All download attempts failed:", error);
    }
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
    console.log(`Using cookies from: ${cookiesPath}`);
    
    // Verify cookies exist
    if (fs.existsSync(cookiesPath)) {
        console.log(`✅ Cookies file found (${fs.statSync(cookiesPath).size} bytes)`);
    } else {
        console.log('❌ Cookies file not found - downloads may fail');
    }
    
    checkYtDlp();
});
