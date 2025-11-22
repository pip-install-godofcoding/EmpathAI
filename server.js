require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
 

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// POST /api/chat - proxy to configured LLM provider (e.g., Gemini) or fallback to local mock matching
app.post('/api/chat', async (req, res) => {
  try {
    const { user, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const provider = process.env.LLM_PROVIDER || process.env.GEMINI_API_URL ? 'gemini' : 'mock';

    if (provider === 'gemini' && process.env.GEMINI_API_URL && (process.env.GEMINI_API_KEY || process.env.GEMINI_BEARER_TOKEN)) {
      // Proxy generic request to user-configured Gemini URL. We intentionally keep the request body generic
      // so you can set GEMINI_API_URL to the exact endpoint your account expects.
      const url = process.env.GEMINI_API_URL;
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.GEMINI_BEARER_TOKEN) headers['Authorization'] = `Bearer ${process.env.GEMINI_BEARER_TOKEN}`;
      else if (process.env.GEMINI_API_KEY) headers['x-api-key'] = process.env.GEMINI_API_KEY;

      // Build a minimal request payload; you can change this by setting GEMINI_API_PAYLOAD_TEMPLATE in env
      const payload = process.env.GEMINI_API_PAYLOAD_TEMPLATE ? JSON.parse(process.env.GEMINI_API_PAYLOAD_TEMPLATE) : { prompt: message };

      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      const json = await resp.json();
      // Return provider response as-is under `providerResponse`; downstream UI can interpret accordingly.
      return res.json({ provider: 'gemini', providerResponse: json });
    }

    // Fallback: local keyword matching using mock data (same logic client used)
    const mockPath = path.join(__dirname, 'data', 'mock_data.json');
    let entries = [];
    if (fs.existsSync(mockPath)) entries = JSON.parse(fs.readFileSync(mockPath, 'utf8'));
    const t = message.toLowerCase();
    for (const item of entries) {
      for (const kw of item.keywords || []) {
        if (t.includes(kw)) return res.json({ provider: 'mock', response: item.response, item });
      }
    }
    const fallback = "I hear you. Can you tell me a bit more about how you feel? If you'd like, I can suggest breathing exercises or a simple yoga pose.";
    return res.json({ provider: 'mock', response: fallback });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
});

// Whisper proxy endpoint: accepts multipart/form-data with field 'audio' (Blob)
const multer = require('multer');
const upload = multer();
app.post('/api/whisper', upload.single('audio'), async (req, res) => {
  try {
    // If configured, proxy to external Whisper-like endpoint
    if (process.env.WHISPER_API_URL && (process.env.WHISPER_API_KEY || process.env.WHISPER_BEARER_TOKEN)) {
      const url = process.env.WHISPER_API_URL;
      const headers = {};
      if (process.env.WHISPER_BEARER_TOKEN) headers['Authorization'] = `Bearer ${process.env.WHISPER_BEARER_TOKEN}`;
      else if (process.env.WHISPER_API_KEY) headers['x-api-key'] = process.env.WHISPER_API_KEY;

      // Forward the received audio buffer as the request body (content-type: application/octet-stream)
      const audioBuffer = req.file && req.file.buffer;
      if (!audioBuffer) return res.status(400).json({ error: 'no audio attached' });

      const resp = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: audioBuffer });
      const json = await resp.json();
      return res.json({ ok: true, provider: 'whisper', providerResponse: json });
    }

    // No whisper configured: indicate to client to fallback to browser STT
    return res.status(501).json({ error: 'WHISPER_API not configured on server' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
});

// Simple JSON file-backed session store with token support
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
function ensureSessionsFile(){
  const dir = path.dirname(SESSIONS_FILE);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if(!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ users: {}, tokens: {} }, null, 2));
}
function readSessions(){ ensureSessionsFile(); return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
function writeSessions(obj){ fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2)); }

// POST /api/login - create or return a token for a user (passwordless prototype)
app.post('/api/login', (req, res) => {
  try{
    const { user } = req.body;
    if(!user) return res.status(400).json({ error: 'user required' });
    const data = readSessions();
    // create token
    const token = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : require('crypto').randomBytes(16).toString('hex');
    data.tokens[token] = { user, createdAt: new Date().toISOString() };
    writeSessions(data);
    return res.json({ ok:true, token, user });
  }catch(e){ console.error(e); return res.status(500).json({ error: 'server error' }); }
});

// POST /api/session - save a session report for a user (requires token)
app.post('/api/session', (req, res) => {
  try{
    const { token, report } = req.body;
    if(!token || !report) return res.status(400).json({ error: 'token and report required' });
    const data = readSessions();
    const info = data.tokens[token];
    if(!info) return res.status(403).json({ error: 'invalid token' });
    const user = info.user;
    data.users[user] = data.users[user] || [];
    data.users[user].unshift(report);
    if(data.users[user].length > 100) data.users[user] = data.users[user].slice(0,100);
    writeSessions(data);
    return res.json({ ok:true });
  }catch(e){ console.error(e); return res.status(500).json({ error: 'server error' }); }
});

// GET /api/history/:user - retrieve session history; token optional but checked when provided
app.get('/api/history/:user', (req, res) => {
  try{
    const user = req.params.user;
    const token = req.headers['x-session-token'] || req.query.token;
    const data = readSessions();
    if(token){
      const info = data.tokens[token];
      if(!info || info.user !== user) return res.status(403).json({ error: 'invalid token' });
    }
    const hist = data.users[user] || [];
    return res.json({ history: hist });
  }catch(e){ console.error(e); return res.status(500).json({ error: 'server error' }); }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
