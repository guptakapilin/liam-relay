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

// --- ENV VARS ---
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
const PANEL_SECRET = process.env.PANEL_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- LOGGING (in-memory) ---
const logs = [];
function logEvent(event) {
  const time = new Date().toISOString();
  const entry = `[${time}] ${event}`;
  logs.push(entry);
  console.log(entry);
  if (logs.length > 1000) logs.shift(); // Trim old logs
}

// --- MEMORY FOLDER SETUP ---
const upload = multer({ dest: 'uploads/' });
const memoryFolder = path.join(__dirname, 'memories');
if (!fs.existsSync(memoryFolder)) fs.mkdirSync(memoryFolder);

// --- AUTH MIDDLEWARE ---
const isAuthenticated = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token === PANEL_SECRET) next();
  else {
    logEvent('❌ Unauthorized access attempt.');
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// --- LOGIN ROUTE ---
app.post('/auth', (req, res) => {
  const { username, password } = req.body;
  if (username === PANEL_USER && password === PANEL_PASS) {
    logEvent(`🔐 Successful login for user: ${username}`);
    return res.json({ token: PANEL_SECRET });
  } else {
    logEvent(`❌ Failed login attempt for user: ${username}`);
    return res.status(403).json({ error: 'Invalid credentials' });
  }
});

// --- PING ---
app.get('/ping', (req, res) => {
  logEvent(`🛰️ Ping check`);
  res.status(200).send('pong');
});

// --- HEALTH CHECK ---
app.get('/health', isAuthenticated, (req, res) => {
  const payload = {
    status: 'Online',
    uptimeMinutes: Math.floor(process.uptime() / 60),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    ping: 'pong'
  };
  logEvent(`🩺 Health check requested`);
  res.json(payload);
});

// --- UPLOAD MEMORY ZIP ---
app.post('/upload-memory', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const extractPath = path.join(memoryFolder, Date.now().toString());
    fs.mkdirSync(extractPath);

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', () => {
        fs.unlinkSync(zipPath);
        logEvent(`📦 Memory file extracted to ${extractPath}`);
        res.json({ status: 'Success', extractedTo: extractPath });
      });
  } catch (err) {
    logEvent(`❌ Memory upload failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to process memory file', details: err.message });
  }
});

// --- LIST MEMORY FILES ---
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

// --- SEND EMAIL ---
app.post('/send-email', isAuthenticated, async (req, res) => {
  const { to, subject, body, includeLink } = req.body;
  const emailBody = includeLink ? `${body}\n\n[View Link](https://example.com)` : body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_PASS
    }
  });

  try {
    const info = await transporter.sendMail({
      from: `"Liam AI" <${GMAIL_USER}>`,
      to,
      subject,
      text: emailBody
    });

    logEvent(`📧 Email sent to ${to} | Subject: ${subject} | MessageID: ${info.messageId}`);
    res.json({ status: 'Email sent', info });
  } catch (err) {
    logEvent(`❌ Email sending failed: ${err.message}`);
    res.status(500).json({ error: 'Email failed', details: err.message });
  }
});

// --- CLI LOGS (LIVE MEMORY) ---
app.get('/cli-logs', isAuthenticated, (req, res) => {
  logEvent(`📜 Logs requested`);
  res.json({ logs: logs.slice(-100) });
});

// --- LAUNCH ACTION ROUTE ---
app.post('/launch-action', isAuthenticated, async (req, res) => {
  const { action, data } = req.body;
  logEvent(`🚀 launch-action triggered: ${action}`);

  try {
    switch (action) {
      case 'ping':
        return res.json({ pong: true, status: 'Liam is online' });

      case 'send-email': {
        const { to, subject, body, includeLink } = data;
        const emailBody = includeLink ? `${body}\n\n[View Link](https://example.com)` : body;

        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: GMAIL_USER,
            pass: GMAIL_PASS
          }
        });

        const info = await transporter.sendMail({
          from: `"Liam AI" <${GMAIL_USER}>`,
          to,
          subject,
          text: emailBody
        });

        logEvent(`📧 (launch-action) Email sent to ${to} | Subject: ${subject}`);
        return res.json({ status: 'Email sent via launch-action', info });
      }

      default:
        logEvent(`⚠️ Unknown launch-action: ${action}`);
        return res.status(400).json({ error: 'Unknown action type' });
    }
  } catch (err) {
    logEvent(`❌ launch-action failed: ${err.message}`);
    return res.status(500).json({ error: 'Action failed', details: err.message });
  }
});

// --- SERVE DASHBOARD.HTML ON ROOT ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- START SERVER ---
app.listen(PORT, () => {
  logEvent(`✅ Liam backend running at http://localhost:${PORT}`);
});
