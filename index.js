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

/* ---- ENV sanity helper ---- */
const REQUIRED_ENV = [
  'PANEL_USER','PANEL_PASS','PANEL_SECRET',
  'GMAIL_USER','GMAIL_PASS'
];
function checkEnv(){
  const report = {};
  REQUIRED_ENV.forEach(k => report[k] = !!process.env[k]);
  return report;
}

const express  = require('express');
const bodyParser = require('body-parser');
...
/* your other require lines */

/* ------------- existing helpers (detectPersona, checkEnv, etc.) ------------- */

/* ---- Google Drive helper: list ZIPs sitting in Liam Memories master folder ---- */
const DRIVE_FOLDER_ID = process.env.LIAM_MEMORIES_FOLDER_ID;   // existing env var

async function listDriveZips () {
  const { google } = require('googleapis');
  const auth = await require('@google-cloud/local-auth').getClient({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q      : `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/zip' and trashed=false`,
    fields : 'files(id,name,modifiedTime)'
  });
  return res.data.files;   // [{ id, name, modifiedTime }]
}

/* --------- all your route definitions start below this point --------- */

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
app.get('/ping', (_req, res) => {
  res.status(200).send('🧠 Brain is live');
  logEvent('🧠 Ping → Brain is live');
});

// --- HEALTH CHECK ---
app.get('/health', isAuthenticated, (req, res) => {
  const payload = {
    status: 'Online',
    uptimeMinutes: Math.floor(process.uptime() / 60),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    ping          : 'pong',
    env           : checkEnv()         
  };
  logEvent(`🩺 Health check requested`);
  res.json(payload);
});

// --- UPLOAD MEMORY ZIP (with duplicate check) ---
app.post('/upload-memory', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const zipPath      = req.file.path;          // temp upload
    const originalName = req.file.originalname;  // e.g. chat-history.zip
    const logFile      = path.join(memoryFolder, 'sync-log.json');

    // --- Duplicate-ZIP detection ────────────────── ---
    const alreadySeen =
      fs.existsSync(logFile) &&
      JSON.parse(fs.readFileSync(logFile))
        .some(e => e.original === originalName);

    if (alreadySeen) {
      fs.unlinkSync(zipPath);                    // remove temp
      logEvent(`🔁 ZIP ${originalName} already ingested`);
      return res.json({ status: 'already_ingested', zip: originalName });
    }
    /* ───────────────────────────────────────────── */

    /* ── Unzip into a new timestamp folder ─────── */
    const extractPath = path.join(memoryFolder, Date.now().toString());
    fs.mkdirSync(extractPath);

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', () => {
        fs.unlinkSync(zipPath);

        // append to sync-log
        const now  = new Date().toISOString();
        const arr  = fs.existsSync(logFile)
          ? JSON.parse(fs.readFileSync(logFile))
          : [];
        arr.push({ folder: extractPath, original: originalName, uploadedAt: now });
        fs.writeFileSync(logFile, JSON.stringify(arr, null, 2));

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
  const { to, subject, body, includeLink, link } = req.body;
const emailBody = includeLink && link
  ? `${body}\n\nLink: ${link}`
  : body;
  
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

/* ---------- crypto & helpers ---------- */
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

function hmac(query) {
  return crypto.createHmac('sha256', PANEL_SECRET).update(query).digest('hex');
}

/* ---- Google Drive helper: list ZIPs in Liam Memories folder ---- */
const DRIVE_FOLDER_ID = process.env.DRIVE_LIAM_MEMORIES;  // add in .env
async function listDriveZips() {
  const { google } = require('googleapis');
  const auth = await require('@google-cloud/local-auth').getClient({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q   : `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/zip' and trashed=false`,
    fields: 'files(id,name,modifiedTime)'
  });
  return res.data.files;        // [{id,name,modifiedTime}]
}

/* ---------- /fetch-zip  (POST) ----------
   body: { "url": "<public gdrive url>" }
----------------------------------------- */
app.post('/fetch-zip', isAuthenticated, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const tmpZip = path.join('uploads', `remote_${Date.now()}.zip`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('download failed');
    await new Promise((r, j) => {
      const file = fs.createWriteStream(tmpZip);
      resp.body.pipe(file);
      resp.body.on('error', j);
      file.on('finish', r);
    });

    // re-use unzip logic
    const extractPath = path.join(memoryFolder, Date.now().toString());
    fs.mkdirSync(extractPath);
    fs.createReadStream(tmpZip)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', () => {
        fs.unlinkSync(tmpZip);
        logEvent(`📦 Remote ZIP ingested → ${extractPath}`);

        // sync-log append
        const sync = path.join(memoryFolder, 'sync-log.json');
        const arr = fs.existsSync(sync) ? JSON.parse(fs.readFileSync(sync)) : [];
        arr.push({ folder: extractPath, uploadedAt: new Date().toISOString() });
        fs.writeFileSync(sync, JSON.stringify(arr, null, 2));

        res.json({ status: 'Success', extractedTo: extractPath });
      });
  } catch (e) {
    logEvent(`❌ fetch-zip error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- /generate-recall-link  (POST) ----------
   body: { "query": "text", "ttlMin": 30 }
--------------------------------------------------- */
app.post('/generate-recall-link', isAuthenticated, (req, res) => {
  const { query, ttlMin = 30 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const expires = Date.now() + ttlMin * 60 * 1000;
  const payload = `${query}|${expires}`;
  const sig = hmac(payload);

  const encodedQ = encodeURIComponent(query);
  const link = `${req.protocol}://${req.get('host')}/recall?query=${encodedQ}&exp=${expires}&sig=${sig}`;
  res.json({ link, expires });
});

/* ---------- /recall GET (signed) ----------
   existing /recall POST will remain for internal calls
------------------------------------------- */
app.get('/recall', async (req, res) => {
  const { query, exp, sig, top_k = 3 } = req.query;
  if (!query || !exp || !sig) return res.status(400).json({ error: 'bad params' });
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'link expired' });

  const isValid = hmac(`${query}|${exp}`) === sig;
  if (!isValid) return res.status(403).json({ error: 'bad signature' });

  // we’ll reuse your existing recall logic:
  const recallRes = await recallFromVector(query, Number(top_k) || 3);
  res.json(recallRes);
});

/* ---------- /backup-memory  (POST) ----------
   Zips latest memory folder + vector.index and uploads to Drive
-------------------------------------------------------------- */
app.post('/backup-memory', isAuthenticated, async (_req, res) => {
  try {
    const folders = fs.readdirSync(memoryFolder)
      .filter(f => fs.statSync(path.join(memoryFolder, f)).isDirectory())
      .sort((a,b) => Number(b)-Number(a));
    if (!folders.length) throw new Error('No memory folder');

    const latest = path.join(memoryFolder, folders[0]);
    const zipOut = `/tmp/backup_${folders[0]}.zip`;
    const arch = require('archiver')('zip');
    const output = fs.createWriteStream(zipOut);
    arch.pipe(output);
    arch.directory(latest, false);
    if (fs.existsSync(path.join(memoryFolder, 'vector.index')))
      arch.file(path.join(memoryFolder, 'vector.index'), { name: 'vector.index' });
    await arch.finalize();

    // upload to Drive
    const { google } = require('googleapis');
    const auth = await require('@google-cloud/local-auth')
      .getClient({ scopes: ['https://www.googleapis.com/auth/drive.file'] });
    const drive = google.drive({ version: 'v3', auth });
    const fileMeta = {
      name: path.basename(zipOut),
      parents: ['Liam Memories Backups'] // <-- Drive folder name; adjust if needed
    };
    await drive.files.create({
      requestBody: fileMeta,
      media: { mimeType: 'application/zip', body: fs.createReadStream(zipOut) }
    });

    logEvent(`💾 Backup uploaded to Drive: ${fileMeta.name}`);
    res.json({ status: 'Backup complete', file: fileMeta.name });
  } catch (e) {
    logEvent(`❌ backup-memory error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});


app.get('/drive-status', isAuthenticated, async (_req, res) => {
  try {
    const driveZips = await listDriveZips();               // all ZIPs on Drive

    const log     = fs.existsSync(path.join(memoryFolder,'sync-log.json'))
                  ? JSON.parse(fs.readFileSync(path.join(memoryFolder,'sync-log.json')))
                  : [];
    const ingestedIds = new Set(log.filter(e=>e.driveId).map(e=>e.driveId));

    const pending = driveZips.filter(f => !ingestedIds.has(f.id));
    const done    = driveZips.filter(f =>  ingestedIds.has(f.id));

    res.json({ pending, done });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

const streamToFile = (stream,tmp) => new Promise((res,rej)=>{
  const file = fs.createWriteStream(tmp);
  stream.pipe(file);
  stream.on('error',rej); file.on('finish',res);
});

app.post('/sync-drive', isAuthenticated, async (_req, res) => {
  try {
    const driveZips = await listDriveZips();
    const logPath   = path.join(memoryFolder,'sync-log.json');
    const logArr    = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath)) : [];
    const ingested  = new Set(logArr.filter(e=>e.driveId).map(e=>e.driveId));

    let imported = 0;
    const { google } = require('googleapis');
    const auth  = await require('@google-cloud/local-auth').getClient({
      scopes:['https://www.googleapis.com/auth/drive.readonly']
    });
    const drive = google.drive({version:'v3',auth});

    for (const f of driveZips){
      if (ingested.has(f.id)) continue;              // already done
      const tmp = path.join('uploads',`${f.id}.zip`);
      const dl  = await drive.files.get({fileId:f.id,alt:'media'},{responseType:'stream'});
      await streamToFile(dl.data,tmp);

      /* reuse upload-memory logic: */
      await new Promise((resolve, reject) =>{
        const extractPath = path.join(memoryFolder, Date.now().toString());
        fs.mkdirSync(extractPath);
        fs.createReadStream(tmp)
          .pipe(unzipper.Extract({ path: extractPath }))
          .on('close', ()=> {
            fs.unlinkSync(tmp);
            logArr.push({ folder: extractPath, original:f.name, driveId:f.id, uploadedAt:new Date().toISOString() });
            imported++; resolve();
          })
          .on('error', reject);
      });
    }
    fs.writeFileSync(logPath, JSON.stringify(logArr,null,2));
    res.json({ status:'done', imported });
  } catch(e){
    res.status(500).json({ error:e.message });
  }
});

// --- START SERVER ---
app.listen(PORT, () => {
  logEvent(`✅ Liam backend running at http://localhost:${PORT}`);
});
