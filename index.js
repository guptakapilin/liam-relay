const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT;

app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const sheets = google.sheets({ version: "v4", auth: oauth2Client });

// Resolve contact email from Google Sheet
async function resolveEmail(name) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = "Sheet1!A:B";
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = response.data.values;
  if (!rows || rows.length === 0) return null;

  for (let row of rows) {
    if (row[0]?.toLowerCase() === name.toLowerCase()) return row[1];
  }
  return null;
}

app.post("/ask-liam", async (req, res) => {
  const { prompt, sendTo } = req.body;
  if (!prompt || !sendTo) return res.status(400).send({ error: "Missing prompt or sendTo" });

  try {
    const gptRes = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }]
    });

    const gptReply = gptRes.choices[0].message.content;
    const recipientEmail = await resolveEmail(sendTo);
    if (!recipientEmail) return res.status(404).send({ error: "Recipient not found in contacts sheet." });

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASS
      }
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: recipientEmail,
      subject: "Liam’s GPT Email Delivery",
      text: gptReply
    };

    await transporter.sendMail(mailOptions);

    res.status(200).send({
      to: recipientEmail,
      sent: true,
      response: gptReply
    });

  } catch (error) {
    console.error("Liam Error:", error.message);
    res.status(500).send({ error: "Internal processing error." });
  }
});

app.get("/", (req, res) => {
  res.send("Liam Phase 3 is live with GPT, Gmail, and Google Sheets integration!");
});

app.post("/send-email", async (req, res) => {
  const { subject, body, to } = req.body;
  if (!subject || !body || !to) {
    return res.status(400).send({ error: "Missing subject, body, or to" });
  }

  try {
    const recipientEmail = await resolveEmail(to);
    if (!recipientEmail) return res.status(404).send({ error: "Recipient not found in contact sheet." });

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASS
      }
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: recipientEmail,
      subject,
      text: body
    };

    await transporter.sendMail(mailOptions);
    res.status(200).send({
      sent: true,
      to: recipientEmail,
      subject
    });

  } catch (err) {
    console.error("Email error:", err.message);
    res.status(500).send({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
