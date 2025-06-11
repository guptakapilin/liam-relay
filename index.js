const express = require('express');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

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
    const auth = await authenticate({
      keyfilePath: path.join(__dirname, 'credentials.json'),
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
    });

    const docs = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

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

// === /upload-drive ===
app.post('/upload-drive', async (req, res) => {
  const { fileName, filePath, mimeType } = req.body;

  if (!fileName || !filePath || !mimeType) {
    return res.status(400).json({ error: 'Missing fileName, filePath, or mimeType' });
  }

  try {
    const auth = await authenticate({
      keyfilePath: path.join(__dirname, 'credentials.json'),
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: fileName,
      parents: [process.env.LIAM_MEMORIES_FOLDER_ID], // 🟢 USE MEMORY FOLDER
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

app.listen(PORT, () => {
  console.log(`Liam-Mailer v4.6 running on port ${PORT}`);
});
