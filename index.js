const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Liam relay is running.");
});

app.get("/launch-action", async (req, res) => {
  const { cmd } = req.query;
  if (!cmd) return res.status(400).send("Missing 'cmd' parameter.");

  try {
    const parts = cmd.split(":");
    const [action, ...args] = parts;

    // === 1. Email a document ===
    if (action === "email-doc") {
      const [to, filename, subject, ...bodyArr] = args;
      const body = decodeURIComponent(bodyArr.join(":"));
      const filepath = path.join(__dirname, filename);
      if (!fs.existsSync(filepath)) return res.status(404).send("File not found.");

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASS
        }
      });

      const mailOptions = {
        from: process.env.GMAIL_USER,
        to,
        subject: decodeURIComponent(subject),
        text: body,
        attachments: [{ filename, path: filepath }]
      };

      await transporter.sendMail(mailOptions);
      return res.status(200).send(`Email sent to ${to}`);
    }

    // === 2. Upload any file to Google Drive (no conversion) ===
    if (action === "upload-doc") {
      const [filename] = args;
      const filepath = path.join(__dirname, filename);
      if (!fs.existsSync(filepath)) return res.status(404).send("File not found.");
      if (filename.endsWith(".exe")) return res.status(403).send("Executable files are not allowed.");

      const mimeTypeMap = {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".mp4": "video/mp4",
        ".zip": "application/zip",
        ".txt": "text/plain"
      };

      const ext = path.extname(filename).toLowerCase();
      const mimeType = mimeTypeMap[ext] || "application/octet-stream";

      const auth = new google.auth.GoogleAuth({
        keyFile: "/etc/secrets/credentials.json",
        scopes: ["https://www.googleapis.com/auth/drive"]
      });

      const driveService = google.drive({ version: "v3", auth: await auth.getClient() });
      const fileMetadata = { name: filename };
      const media = { mimeType, body: fs.createReadStream(filepath) };

      const file = await driveService.files.create({
        resource: fileMetadata,
        media,
        fields: "id, webViewLink"
      });

      await driveService.permissions.create({
        fileId: file.data.id,
        requestBody: { type: "anyone", role: "reader" }
      });

      await driveService.permissions.create({
        fileId: file.data.id,
        requestBody: { type: "user", role: "writer", emailAddress: "kapil@crossconnexions.com" }
      });

      return res.status(200).send(`Uploaded successfully. View: ${file.data.webViewLink}`);
    }

    // === 3. Create a new Google Doc with content ===
    if (action === "create-doc") {
      const [title, ...contentArr] = args;
      const content = decodeURIComponent(contentArr.join(":"));

      const auth = new google.auth.GoogleAuth({
        keyFile: "/etc/secrets/credentials.json",
        scopes: ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive"]
      });

      const docs = google.docs({ version: "v1", auth: await auth.getClient() });
      const drive = google.drive({ version: "v3", auth: await auth.getClient() });

      const doc = await docs.documents.create({ requestBody: { title } });
      const docId = doc.data.documentId;

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: content
              }
            }
          ]
        }
      });

      await drive.permissions.create({
        fileId: docId,
        requestBody: { type: "anyone", role: "reader" }
      });

      await drive.permissions.create({
        fileId: docId,
        requestBody: { type: "user", role: "writer", emailAddress: "kapil@crossconnexions.com" }
      });

      return res.status(200).send(`Google Doc created: https://docs.google.com/document/d/${docId}/edit`);
    }

    res.status(400).send("Unknown command.");
  } catch (err) {
    console.error("Launch-action error:", err.message);
    res.status(500).send("Failed to execute action.");
  }
});

// === Optional: Still useful for file debug ===
app.get("/debug-file", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send("Missing 'name' query param.");
  const filepath = path.join(__dirname, name);
  if (!fs.existsSync(filepath)) return res.status(404).send("File not found.");
  const fileBuffer = fs.readFileSync(filepath);
  const preview = fileBuffer.toString("base64").substring(0, 600);
  res.send(`<pre style="white-space: pre-wrap;">Preview of ${name}:\n\n${preview}...[truncated]</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
