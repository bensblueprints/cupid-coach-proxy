const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
if (!SUPABASE_JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET is not set');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(rateLimit({ windowMs: 60_000, max: 60 })); // 60 req/min/IP — generous for one user's chat+STT traffic

// This service is a stateless relay: it never writes prompts, transcripts, or
// responses to disk/DB/logs. Auth is required (a Supabase-issued JWT) purely to
// keep the Groq key from being abused by strangers who find this URL — the token
// itself proves nothing about, and carries no access to, any dating content,
// which never leaves the user's device.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    jwt.verify(token, SUPABASE_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

app.post('/v1/chat', requireAuth, async (req, res) => {
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch {
    res.status(502).json({ error: 'upstream request failed' });
  }
});

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // Groq's own cap
app.post('/v1/transcribe', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing file field' });
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer]), req.file.originalname || 'audio.webm');
    form.append('model', req.body.model || 'whisper-large-v3-turbo');
    if (req.body.language) form.append('language', req.body.language);
    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch {
    res.status(502).json({ error: 'upstream request failed' });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`cupid-coach-proxy listening on ${PORT}`));
