const express = require('express');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');

// Utility: Generate random token
const generateToken = () => crypto.randomBytes(16).toString('hex');

// In-memory token store (simple)
let sessionTokens = new Set();

// === /auth ===
app.post('/auth', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.PANEL_USER &&
    password === process.env.PANEL_PASS
  ) {
    const token = generateToken();
    sessionTokens.add(token);
    res.status(200).json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to protect private routes
const requireAuth = (req, res, next) => {
  const token = req.headers['authorization'];
  if (sessionTokens.has(token)) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};


dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve panel.html and other static files

const PORT = process.env.PORT || 3000;

// 🔐 Google Auth using service account
const getAuthClient = async (scopes = []) => {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/etc/secrets/credentials.json',
    scopes,
  });
  return await auth.getClient();
};

// ✅ ENV Check Route
app.get('/check-env', (req, res) => {
  res.json({
    GMAIL_USER: process.env.GMAIL_USER || 'undefined',
    GMAIL_APP_PASS: process.env.GMAIL_APP_PASS ? '✓ exists' : 'undefined',
    LIAM_MEMORIES_FOLDER_ID: process.env.LIAM_MEMORIES_FOLDER_ID || 'undefined',
  });
});

// ✅ Ping & Root
app.get('/ping', (req, res) => {
  return res.status(200).send('Liam is alive. 🧠');
});
app.get('/', (req, res) => {
  return res.send('✅ Liam-Mailer v4.6 is Live. Use /ping to test uptime.');
});

// ✅ /send-email
app.get('/send-email', async (req, res) => {
  const to = req.query.to;
  const driveLink = req.query.link || 'https://drive.google.com/';
  const mailUser = process.env.GMAIL_USER;
  const mailPass = process.env.GMAIL_APP_PASS;

  if (!to) return res.status(400).send('Missing "to" query param.');
  if (!mailUser || !mailPass) {
    console.error('[ENV] GMAIL_USER or GMAIL_APP_PASS missing');
    return res.status(500).send('Missing email credentials.');
  }

  let template;
  try {
    template = fs.readFileSync(path.join(__dirname, 'templates/email_template.txt'), 'utf8');
  } catch {
    return res.status(500).send('Email template missing.');
  }

  const emailBody = template.replace('{{link}}', driveLink);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: mailUser, pass: mailPass },
  });

  const mailOptions = {
    from: `"Radhika | Liam-Mailer" <${mailUser}>`,
    to,
    subject: 'Your file is ready – from Liam',
    text: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    return res.status(200).send('Email sent successfully.');
  } catch (err) {
    console.error('Email error:', err.message);
    return res.status(500).send('Failed to send email.');
  }
});

// ✅ /create-doc
app.get('/create-doc', async (req, res) => {
  const file = req.query.template;
  if (!file) return res.status(400).send('Missing "template" query param');

  const filePath = path.join(__dirname, 'templates', file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Template not found.');

  const content = fs.readFileSync(filePath, 'utf8');

  try {
    const auth = await getAuthClient([
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ]);

    const docs = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const doc = await docs.documents.create({ requestBody: { title: `Liam Generated - ${file}` } });
    const documentId = doc.data.documentId;

    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: content,
          },
        }],
      },
    });

    await drive.permissions.create({
      fileId: documentId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const link = `https://docs.google.com/document/d/${documentId}/edit?usp=sharing`;
    return res.status(200).json({ status: 'created', link });
  } catch (err) {
    console.error('Doc error:', err.message);
    return res.status(500).send('Failed to create document.');
  }
});

// ✅ /list-memories
app.get('/list-memories', async (req, res) => {
  try {
    const folderId = process.env.LIAM_MEMORIES_FOLDER_ID;
    if (!folderId) return res.status(500).send('Memory folder ID not set.');

    const auth = await getAuthClient(['https://www.googleapis.com/auth/drive.readonly']);
    const drive = google.drive({ version: 'v3', auth });

    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });

    return res.status(200).json({ files: result.data.files });
  } catch (err) {
    console.error('Memory list error:', err.message);
    return res.status(500).send('Failed to list memory files.');
  }
});

// ✅ /upload-drive
app.post('/upload-drive', async (req, res) => {
  const { fileName, filePath, mimeType } = req.body;
  if (!fileName || !filePath || !mimeType) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const auth = await getAuthClient(['https://www.googleapis.com/auth/drive.file']);
    const drive = google.drive({ version: 'v3', auth });

    const metadata = {
      name: fileName,
      parents: [process.env.LIAM_MEMORIES_FOLDER_ID],
    };

    const media = {
      mimeType,
      body: fs.createReadStream(filePath),
    };

    const uploaded = await drive.files.create({
      resource: metadata,
      media,
      fields: 'id, webViewLink',
    });

    return res.status(200).json({
      message: 'Upload successful',
      fileId: uploaded.data.id,
      viewLink: uploaded.data.webViewLink,
    });
  } catch (err) {
    console.error('Drive upload error:', err.message);
    return res.status(500).json({ error: 'Drive upload failed' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Liam-Mailer v4.6 running on port ${PORT}`);
});

// ========== Archive Sync Routine ==========
const SYNC_LOG_PATH = path.join(__dirname, 'data', 'sync-log.json');
let syncLog = {};

const loadSyncLog = () => {
  try {
    syncLog = JSON.parse(fs.readFileSync(SYNC_LOG_PATH, 'utf8'));
    console.log('✅ Sync log loaded');
  } catch (e) {
    console.warn('⚠️ Failed to load sync-log.json. Creating new structure.');
    syncLog = {
      Liam: { archiveFolder: '', unifiedFolder: '', lastSynced: '', syncedFiles: [] },
      Eva: { archiveFolder: '', unifiedFolder: '', lastSynced: '', syncedFiles: [] },
      Radhika: { archiveFolder: '', unifiedFolder: '', lastSynced: '', syncedFiles: [] },
    };
  }
};

const saveSyncLog = () => {
  fs.writeFileSync(SYNC_LOG_PATH, JSON.stringify(syncLog, null, 2));
};

loadSyncLog();

app.get('/sync-archives', async (req, res) => {
  const auth = await getAuthClient(['https://www.googleapis.com/auth/drive']);
  const drive = google.drive({ version: 'v3', auth });

  const syncResults = {};

  for (const persona of ['Liam', 'Eva', 'Radhika']) {
    const personaLog = syncLog[persona];
    const archiveId = personaLog.archiveFolder;
    const unifiedId = personaLog.unifiedFolder;
    const alreadySynced = new Set(personaLog.syncedFiles || []);
    const newSynced = [];

    if (!archiveId || !unifiedId) continue;

    const files = await drive.files.list({
      q: `'${archiveId}' in parents and trashed = false`,
      fields: 'files(id, name)',
    });

    for (const file of files.data.files) {
      if (alreadySynced.has(file.id)) continue;

      try {
        await drive.files.copy({
          fileId: file.id,
          requestBody: {
            name: file.name,
            parents: [unifiedId],
          },
        });

        newSynced.push(file.id);
        console.log(`✅ Copied ${file.name} to ${persona} Unified`);
      } catch (err) {
        console.warn(`⚠️ Failed to copy ${file.name}: ${err.message}`);
      }
    }

    // Update sync log
    personaLog.syncedFiles.push(...newSynced);
    personaLog.lastSynced = new Date().toISOString();
    syncResults[persona] = { copied: newSynced.length };
  }

  saveSyncLog();

  return res.status(200).json({
    status: 'completed',
    result: syncResults,
    timestamp: new Date().toISOString(),
  });
});
