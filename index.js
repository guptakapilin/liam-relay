const express = require('express');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === /send-email ===
app.get('/send-email', async (req, res) => {
  const to = req.query.to;
  const driveLink = req.query.link || 'https://drive.google.com/';

  if (!to) {
    return res.status(400).send('Missing "to" query param.');
  }

  let messageTemplate;
  try {
    messageTemplate = fs.readFileSync(path.join(__dirname, 'templates', 'email_template.txt'), 'utf8');
  } catch (err) {
    return res.status(500).send('Email template read failed.');
  }

  const emailBody = messageTemplate.replace('{{link}}', driveLink);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"Radhika | Liam-Mailer" <${process.env.MAIL_USER}>`,
    to,
    subject: 'Your file is ready – from Liam',
    text: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    return res.status(200).send('Email sent successfully.');
  } catch (error) {
    console.error('Email error:', error.message);
    return res.status(500).send('Failed to send email.');
  }
});

// === /create-doc ===
app.get('/create-doc', async (req, res) => {
  const file = req.query.template;
  if (!file) return res.status(400).send('Missing "template" query param');

  const filePath = path.join(__dirname, 'templates', file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Template not found.');

  const content = fs.readFileSync(filePath, 'utf8');

  try {
    const auth = new GoogleAuth({
      keyFile: '/etc/secrets/credentials.json',
      scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive'],
    });

    const client = await auth.getClient();
    const docs = google.docs({ version: 'v1', auth: client });
    const drive = google.drive({ version: 'v3', auth: client });

    const doc = await docs.documents.create({
      requestBody: {
        title: `Liam Generated - ${file}`,
      },
    });

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
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const link = `https://docs.google.com/document/d/${documentId}/edit?usp=sharing`;
    return res.status(200).json({ status: 'created', link });
  } catch (err) {
    console.error('Doc creation error:', err.message);
    return res.status(500).send('Failed to create document.');
  }
});

// === /list-memories ===
app.get('/list-memories', async (req, res) => {
  try {
    const auth = new GoogleAuth({
      keyFile: '/etc/secrets/credentials.json',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const client = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: client });

    const folderId = process.env.LIAM_MEMORIES_FOLDER_ID;
    console.log('Using Folder ID:', folderId);

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });

    return res.status(200).json({ files: response.data.files });
  } catch (err) {
    console.error('🔥 Detailed list error:', err);
    return res.status(500).send('Failed to list memory files.');
  }
});

// === /upload-drive ===
app.post('/upload-drive', async (req, res) => {
  const { fileName, filePath, mimeType } = req.body;

  if (!fileName || !filePath || !mimeType) {
    return res.status(400).json({ error: 'Missing fileName, filePath, or mimeType' });
  }

  try {
    const auth = new GoogleAuth({
      keyFile: '/etc/secrets/credentials.json',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const client = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: client });

    const fileMetadata = {
      name: fileName,
      parents: [process.env.LIAM_MEMORIES_FOLDER_ID],
    };

    const media = {
      mimeType,
      body: fs.createReadStream(filePath),
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink',
    });

    return res.status(200).json({
      message: 'File uploaded successfully',
      fileId: file.data.id,
      viewLink: file.data.webViewLink,
    });
  } catch (err) {
    console.error('Drive upload error:', err.message);
    return res.status(500).json({ error: 'Drive upload failed', details: err.message });
  }
});

// === Health Routes ===
app.get('/ping', (req, res) => {
  return res.status(200).send('Liam is alive. 🧠');
});

app.get('/', (req, res) => {
  res.send('✅ Liam-Mailer v4.6 is Live. Use /ping to test uptime.');
});

app.listen(PORT, () => {
  console.log(`Liam-Mailer v4.6 running on port ${PORT}`);
});

const panelHtmlPath = path.join(__dirname, 'panel.html');

app.get('/panel', (req, res) => {
  res.sendFile(panelHtmlPath);
});

