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

    // === 1. Bootstrap doc from base64 ===
    if (action === "bootstrap-doc") {
      const [filename] = args;
      const base64Data = `...base64 string here...`; // REDACTED for brevity
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(path.join(__dirname, filename), buffer);
      return res.status(200).send(`File '${filename}' created on server.`);
    }

    // === 2. Email doc as attachment ===
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

    // === 3. Upload doc to Google Drive (Native Google Doc + Shared) ===
if (action === "upload-doc") {
  const [filename] = args;
  const filepath = path.join(__dirname, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send("File not found.");

  const auth = new google.auth.GoogleAuth({
    keyFile: "/etc/secrets/credentials.json",
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  const driveService = google.drive({ version: "v3", auth: await auth.getClient() });

  const fileMetadata = {
    name: filename.replace(".docx", ""),
    mimeType: "application/vnd.google-apps.document"
  };

  const media = {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: fs.createReadStream(filepath)
  };

  const file = await driveService.files.create({
    resource: fileMetadata,
    media,
    fields: "id, webViewLink"
  });

  await driveService.permissions.create({
    fileId: file.data.id,
    requestBody: {
      type: "anyone",
      role: "reader"
    }
  });

  await driveService.permissions.create({
    fileId: file.data.id,
    requestBody: {
      type: "user",
      role: "writer",
      emailAddress: "kapil@crossconnexions.com"
    }
  });

  return res.status(200).send(`Uploaded. View: ${file.data.webViewLink}`);
}

    res.status(400).send("Unknown command.");
  } catch (err) {
    console.error("Launch-action error:", err.message);
    res.status(500).send("Failed to execute action.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
