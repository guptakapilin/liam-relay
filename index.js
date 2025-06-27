const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
const PANEL_SECRET = process.env.PANEL_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DRIVE_FOLDER_ID = process.env.LIAM_MEMORIES_FOLDER_ID;

const memoryFolder = path.join(__dirname, 'memories');
if (!fs.existsSync(memoryFolder)) fs.mkdirSync(memoryFolder);

const upload = multer({ dest: 'uploads/' });

const logs = [];
function logEvent(e) {
  const time = new Date().toISOString();
  const entry = `[${time}] ${e}`;
  logs.push(entry);
  console.log(entry);
  if (logs.length > 1000) logs.shift();
}

// ENV Checker
function checkEnv() {
  const keys = ['PANEL_USER', 'PANEL_PASS', 'PANEL_SECRET', 'GMAIL_USER', 'GMAIL_PASS', 'OPENAI_API_KEY'];
  return Object.fromEntries(keys.map(k => [k, !!process.env[k]]));
}

// Auth middleware
const isAuthenticated = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, PANEL_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Routes
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Ping
app.get('/ping', (_req, res) => {
  res.status(200).send('🧠 Brain is live');
  logEvent(`🧠 Ping received`);
});

// Login
app.post('/auth', (req, res) => {
  const { user, pass } = req.body;
  if (user === PANEL_USER && pass === PANEL_PASS) {
    const token = jwt.sign({ user }, PANEL_SECRET, { expiresIn: '7d' });
    logEvent(`🔓 Login success for user ${user}`);
    return res.json({ token });
  } else {
    logEvent(`❌ Login failed for user ${user}`);
    return res.status(403).json({ error: 'Invalid credentials' });
  }
});

// Health
app.get('/health', isAuthenticated, (req, res) => {
  const payload = {
    status: 'Online',
    uptimeMinutes: Math.floor(process.uptime() / 60),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    env: checkEnv()
  };
  logEvent(`🩺 Health check requested`);
  res.json(payload);
});

// Upload memory ZIP and extract
app.post('/upload-memory', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const originalName = req.file.originalname;
    const logFile = path.join(memoryFolder, 'sync-log.json');

    const alreadySeen =
      fs.existsSync(logFile) &&
      JSON.parse(fs.readFileSync(logFile)).some(e => e.original === originalName);

    if (alreadySeen) {
      fs.unlinkSync(zipPath);
      logEvent(`🔁 ZIP ${originalName} already ingested`);
      return res.json({ status: 'already_ingested', zip: originalName });
    }

    const extractPath = path.join(memoryFolder, Date.now().toString());
    fs.mkdirSync(extractPath);

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', async () => {
        fs.unlinkSync(zipPath);
        const now = new Date().toISOString();
        const arr = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : [];
        arr.push({ folder: extractPath, original: originalName, uploadedAt: now });
        fs.writeFileSync(logFile, JSON.stringify(arr, null, 2));
        await generateVectorIndex();
        logEvent(`📦 Memory extracted and indexed → ${extractPath}`);
        res.json({ status: 'Success', extractedTo: extractPath });
      });
  } catch (err) {
    logEvent(`❌ Upload failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// List memories
app.get('/list-memories', isAuthenticated, (req, res) => {
  const results = [];
  fs.readdirSync(memoryFolder).forEach(dir => {
    const dirPath = path.join(memoryFolder, dir);
    if (fs.statSync(dirPath).isDirectory()) {
      const files = fs.readdirSync(dirPath);
      files.forEach(file => {
        results.push({
          date: new Date(Number(dir)).toISOString().split('T')[0],
          name: file,
          path: `/memories/${dir}/${file}`,
          status: 'Parsed'
        });
      });
    }
  });
  logEvent(`📂 Listed ${results.length} memory files`);
  res.json(results);
});

// CLI logs
app.get('/cli-logs', isAuthenticated, (req, res) => {
  res.json({ logs: logs.slice(-100) });
});

// Ask-Liam (vector recall)
app.post('/ask-liam', isAuthenticated, async (req, res) => {
  const { query, top_k = 3 } = req.body;
  try {
    const results = await recallFromVector(query, top_k);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recall link generator
function hmac(q) {
  return crypto.createHmac('sha256', PANEL_SECRET).update(q).digest('hex');
}
app.post('/generate-recall-link', isAuthenticated, (req, res) => {
  const { query, ttlMin = 30 } = req.body;
  const expires = Date.now() + ttlMin * 60 * 1000;
  const payload = `${query}|${expires}`;
  const sig = hmac(payload);
  const encoded = encodeURIComponent(query);
  const link = `${req.protocol}://${req.get('host')}/recall?query=${encoded}&exp=${expires}&sig=${sig}`;
  res.json({ link, expires });
});
app.get('/recall', async (req, res) => {
  const { query, exp, sig, top_k = 3 } = req.query;
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'Link expired' });
  const isValid = hmac(`${query}|${exp}`) === sig;
  if (!isValid) return res.status(403).json({ error: 'Bad signature' });

  const results = await recallFromVector(query, Number(top_k) || 3);
  res.json(results);
});

// Email
app.post('/send-email', isAuthenticated, async (req, res) => {
  const { to, subject, body, includeLink, link } = req.body;
  const emailBody = includeLink && link ? `${body}\n\nLink: ${link}` : body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });

  try {
    const info = await transporter.sendMail({
      from: `"Liam AI" <${GMAIL_USER}>`,
      to,
      subject,
      text: emailBody
    });
    logEvent(`📧 Email sent to ${to}`);
    res.json({ status: 'Email sent', info });
  } catch (err) {
    logEvent(`❌ Email failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Vector helpers
async function generateVectorIndex() {
  const allTexts = [];
  const folders = fs.readdirSync(memoryFolder);
  for (const f of folders) {
    const folderPath = path.join(memoryFolder, f);
    if (fs.statSync(folderPath).isDirectory()) {
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const content = fs.readFileSync(filePath, 'utf8');
        allTexts.push({ content, file });
      }
    }
  }

  const vectors = [];
  for (const item of allTexts) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: item.content.slice(0, 2000),
        model: 'text-embedding-ada-002'
      })
    });
    const json = await response.json();
    vectors.push({ embedding: json.data[0].embedding, content: item.content });
  }

  fs.writeFileSync(path.join(memoryFolder, 'vector.index'), JSON.stringify(vectors));
  logEvent(`🧠 Vector index generated (${vectors.length} entries)`);
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}

async function recallFromVector(query, top_k = 3) {
  const vectorFile = path.join(memoryFolder, 'vector.index');
  if (!fs.existsSync(vectorFile)) throw new Error('No vector index found');
  const index = JSON.parse(fs.readFileSync(vectorFile));
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: query, model: 'text-embedding-ada-002' })
  });
  const qVec = response.ok ? (await response.json()).data[0].embedding : null;
  if (!qVec) throw new Error('Failed to embed query');

  const scored = index.map(entry => ({
    score: cosineSimilarity(qVec, entry.embedding),
    text: entry.content
  })).sort((a, b) => b.score - a.score);

  return scored.slice(0, top_k);
}

// Start server
app.listen(PORT, () => {
  logEvent(`✅ Liam backend running at http://localhost:${PORT}`);
});
