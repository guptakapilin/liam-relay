const express = require('express');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

dotenv.config();

const app = express(); // ✅ Declared first before use

app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ✅ Google Auth with service account
const getAuthClient = async (scopes = []) => {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/etc/secrets/credentials.json',
    scopes,
  });
  return await auth.getClient();
};

// ✅ ENV Check
app.get('/check-env', (req, res) => {
  res.json({
    GMAIL_USER: process.env.GMAIL_USER || 'undefined',
    GMAIL_PASS: process.env.GMAIL_PASS ? '✓ exists' : 'undefined',
    LIAM_MEMORIES_FOLDER_ID: process.env.LIAM_MEMORIES_FOLDER_ID || 'undefined',
  });
});

// ✅ Ping
app.get('/ping', (req, res) => {
  return res.status(200).send('Liam is alive. 🧠');
});
app.get('/', (req, res) => {
  return res.send('✅ Liam-Mailer v4.7 running.');
});

// ✅ /send-email
app.get('/send-email', async (req, res) => {
  const to = req.query.to;
  const driveLink = req.query.link || 'https://drive.google.com/';
  const mailUser = process.env.GMAIL_USER;
  const mailPass = process.env.GMAIL_PASS;

  if (!to) return res.status(400).send('Missing "to" param.');
  if (!mailUser || !mailPass) return res.status(500).send('[ENV] GMAIL_USER or GMAIL_PASS missing');

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
const loadSyncLog = require('./utils/load-sync-log');

app.get('/sync-memories', async (req, res) => {
  const auth = await getAuthClient([
    'https://www.googleapis.com/auth/drive',
  ]);
  const drive = google.drive({ version: 'v3', auth });

  const syncLog = loadSyncLog();
  const updatedLog = { ...syncLog };
  let synced = [];

  for (const [agent, config] of Object.entries(syncLog.agents)) {
    const archivesFolderId = config.archivesFolderId;
    const unifiedFolderId = config.unifiedFolderId;
    const alreadySyncedIds = new Set(config.archives || []);

    const files = await drive.files.list({
      q: `'${archivesFolderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
    });

    for (const file of files.data.files) {
      if (alreadySyncedIds.has(file.id)) continue;

      // Copy file to Unified folder
      await drive.files.copy({
        fileId: file.id,
        requestBody: {
          name: file.name,
          parents: [unifiedFolderId],
        },
      });

      synced.push({ agent, file: file.name });
      updatedLog.agents[agent].archives.push(file.id);
    }
  }

  // Update log file
  updatedLog.lastUpdated = new Date().toISOString();
  const logPath = path.join(__dirname, 'data/sync-log.json');
  fs.writeFileSync(logPath, JSON.stringify(updatedLog, null, 2));

  res.status(200).json({ status: 'sync-complete', synced });
});

app.listen(PORT, () => {
  console.log(`✅ Liam-Mailer v4.7 running on port ${PORT}`);
});
