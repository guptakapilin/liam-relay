// index.js
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- SIMPLE TOKEN AUTH ---
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'liam-secret';

// --- MEMORY UPLOAD STORAGE SETUP ---
const upload = multer({ dest: 'uploads/' });
const memoryFolder = path.join(__dirname, 'memories');
if (!fs.existsSync(memoryFolder)) fs.mkdirSync(memoryFolder);

// --- UTILITY ---
const generateToken = () => `${Date.now()}-${Math.random().toString(36).substring(2)}`;
const isAuthenticated = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token === TOKEN_SECRET) next();
  else res.status(401).json({ error: 'Unauthorized' });
};

// --- LOGIN ---
app.post('/auth', (req, res) => {
  const { username, password } = req.body;
  if (username === PANEL_USER && password === PANEL_PASS) {
    return res.json({ token: TOKEN_SECRET });
  } else {
    return res.status(403).json({ error: 'Invalid credentials' });
  }
});

// --- MEMORY FILE UPLOAD ---
app.post('/upload-memory', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const extractPath = path.join(memoryFolder, Date.now().toString());
    fs.mkdirSync(extractPath);

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', () => {
        fs.unlinkSync(zipPath);
        res.json({ status: 'Success', extractedTo: extractPath });
      });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process memory file', details: err.message });
  }
});

// --- MEMORY FILE LISTING ---
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
          status: 'Parsed',
        });
      });
    }
  });
  res.json(results);
});

// --- SEND EMAIL (Gmail API or SMTP Setup) ---
app.post('/send-email', isAuthenticated, async (req, res) => {
  const { to, subject, body, includeLink } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, // e.g. liam@crossconnexions.com
      pass: process.env.EMAIL_PASS, // App password
    },
  });

  const emailBody = includeLink ? `${body}\n\n[View Link](https://example.com)` : body;

  try {
    await transporter.sendMail({
      from: `"Liam AI" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text: emailBody,
    });
    res.json({ status: 'Email sent' });
  } catch (err) {
    res.status(500).json({ error: 'Email failed', details: err.message });
  }
});

// --- HEALTH STATUS ---
app.get('/health', isAuthenticated, (req, res) => {
  res.json({
    status: 'Online',
    uptime: `${Math.floor(process.uptime() / 60)} min`,
    memory: process.memoryUsage().rss,
  });
});

// --- CLI LOGS (Dummy) ---
app.get('/cli-logs', isAuthenticated, (req, res) => {
  res.json({
    logs: [
      '[2025-06-11 16:00] Liam Core started.',
      '[2025-06-11 16:01] Email module loaded.',
      '[2025-06-11 16:03] Memory ZIP parsed.',
    ],
  });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Liam backend running on http://localhost:${PORT}`);
});
