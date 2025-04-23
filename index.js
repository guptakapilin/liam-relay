const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Liam relay is running.");
});

app.post("/liam-test", async (req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASS
      }
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: "kapil@crossconnexions.com",
      subject: "Liam Test Relay",
      text: "This is a test email from Liam's Render relay. If you're reading this, the connection is live."
    };

    await transporter.sendMail(mailOptions);
    console.log("Email sent!");
    res.status(200).send("Email sent!");
  } catch (error) {
    console.error("Error sending email:", error.message);
    res.status(500).send("Failed to send email.");
  }
});

app.get("/launch-action", async (req, res) => {
  const { cmd } = req.query;

  if (!cmd) return res.status(400).send("Missing 'cmd' parameter.");

  try {
    const parts = cmd.split(":");

    // === Bootstrap a file ===
    if (parts[0] === "bootstrap-doc") {
      const [, filename] = parts;

      if (!filename) return res.status(400).send("Filename missing.");

      const base64Data = `UEsDBBQAAAAIADl+l1qtUqWRlQEAAMoGAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLWVTU/bQBCG7/0Vli8+IHtDDxWq4nAocCyRGkSvm/U4Wdgv7UwC+ffMOolVCHBi6RnJn3fR7bsj2+fLYmW0NE7V1dnFejIgOnfKPdoi7uZjflRZEhSddI4x3UxQawuJx8Gc82...[TRUNCATED]...`;

      const buffer = Buffer.from(base64Data, "base64");
      const filePath = path.join(__dirname, filename);
      fs.writeFileSync(filePath, buffer);

      console.log(`Document bootstrapped: ${filename}`);
      return res.status(200).send(`File '${filename}' created on server.`);
    }

    // === Email a file ===
    if (parts[0] === "email-doc") {
      const [, to, filename, subject, ...bodyArr] = parts;
      const body = decodeURIComponent(bodyArr.join(":"));

      const filepath = path.join(__dirname, filename || "");
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
        attachments: [
          {
            filename: filename,
            path: filepath
          }
        ]
      };

      await transporter.sendMail(mailOptions);
      console.log(`Email with doc sent to: ${to}`);
      return res.status(200).send(`Email sent to ${to}`);
    }

    res.status(400).send("Unknown command or invalid format.");
  } catch (err) {
    console.error("Launch-action error:", err.message);
    res.status(500).send("Failed to execute action.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
