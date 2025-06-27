const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// --- App setup ---
const app = express();
const PORT = process.env.PORT || 3000;
const MEMORY_ROOT = path.join(__dirname, 'memories');
if (!fs.existsSync(MEMORY_ROOT)) fs.mkdirSync(MEMORY_ROOT);

// --- Multer for uploads ---
const upload = multer({ dest: 'uploads/' });

// --- Env vars ---
const {
  PANEL_USER, PANEL_PASS, PANEL_SECRET,
  GMAIL_USER, GMAIL_PASS,
  OPENAI_API_KEY, LIAM_MEMORIES_FOLDER_ID
} = process.env;

// --- Helpers ---
function logEvent(ev) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${ev}`);
}
function isAuthenticated(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token === PANEL_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}
function hmac(q) {
  return require('crypto').createHmac('sha256', PANEL_SECRET).update(q).digest('hex');
}
async function listDriveZips() {
  const { google } = require('googleapis');
  const auth = await require('@google-cloud/local-auth').getClient({
    scopes: ['https://www.googleapis.com/drive.readonly']
  });
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q      : `'${LIAM_MEMORIES_FOLDER_ID}' in parents and mimeType='application/zip' and trashed=false`,
    fields : 'files(id,name,modifiedTime)'
  });
  return res.data.files;
}

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- Public routes ---
app.get('/ping', (_req, res) => res.send('🧠 Brain is live'));

// --- Auth route (optional) ---
app.post('/auth', (req, res) => {
  const { user, pass } = req.body;
  if (user === PANEL_USER && pass === PANEL_PASS) {
    const token = jwt.sign({ user }, PANEL_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  return res.status(403).json({ error: 'Invalid credentials' });
});

// --- Health Check ---
app.get('/health', isAuthenticated, (req, res) => {
  const payload = {
    status: 'Online',
    uptime: process.uptime(),
    memUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  };
  logEvent('Health check');
  res.json(payload);
});

// --- Instant ChatGPT proxy (/ask-liam) ---
app.post('/ask-liam', isAuthenticated, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const { Configuration, OpenAIApi } = require('openai');
    const client = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));
    const comp = await client.createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    const reply = comp.data.choices[0].message.content;
    logEvent(`ask-liam → "${prompt}"`);
    res.json({ reply });
  } catch (e) {
    logEvent(`ask-liam error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Memory retrieval (/memory/:persona) ---
app.get('/memory/:persona', isAuthenticated, (req, res) => {
  const dir = path.join(MEMORY_ROOT, req.params.persona);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No such persona' });
  const files = fs.readdirSync(dir).map(f => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, modified: st.mtime.toISOString() };
  });
  res.json({ persona: req.params.persona, files });
});

// --- ZIP ingestion (/ingest/:persona) ---
app.post('/ingest/:persona', isAuthenticated, upload.single('file'), (req, res) => {
  const personaDir = path.join(MEMORY_ROOT, req.params.persona);
  if (!fs.existsSync(personaDir)) fs.mkdirSync(personaDir, { recursive: true });
  fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: personaDir }))
    .on('close', () => {
      fs.unlinkSync(req.file.path);
      logEvent(`ingest → ${req.params.persona}`);
      res.json({ status: 'ok', persona: req.params.persona });
    });
});

// --- List local memories (/list-memories) ---
app.get('/list-memories', isAuthenticated, (req, res) => {
  const out = [];
  fs.readdirSync(MEMORY_ROOT).forEach(d => {
    const p = path.join(MEMORY_ROOT, d);
    if (fs.statSync(p).isDirectory()) {
      fs.readdirSync(p).forEach(f => out.push({ persona: d, file: f }));
    }
  });
  res.json(out);
});

// --- Drive sync (/sync-drive) & status (/drive-status) ---
app.get('/drive-status', isAuthenticated, async (_req, res) => {
  const zips = await listDriveZips();
  res.json({ pending: zips });
});
app.post('/sync-drive', isAuthenticated, async (_req, res) => {
  const zips = await listDriveZips();
  let imported = 0;
  for (const z of zips) {
    const tmp = path.join('uploads', `${z.id}.zip`);
    const dl = await require('googleapis').google.drive({ version:'v3',
      auth: await require('@google-cloud/local-auth').getClient({ scopes:['https://www.googleapis.com/drive.readonly'] })
    }).files.get({ fileId: z.id, alt: 'media' }, { responseType: 'stream' });
    await new Promise((r, j) => {
      dl.data.pipe(fs.createWriteStream(tmp))
        .on('finish', r).on('error', j);
    });
    const outDir = path.join(MEMORY_ROOT, z.id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.createReadStream(tmp)
      .pipe(unzipper.Extract({ path: outDir }));
    fs.unlinkSync(tmp);
    imported++;
  }
  res.json({ status: 'done', imported });
});

// --- Signed recall link (/generate-recall-link & /recall) ---
app.post('/generate-recall-link', isAuthenticated, (req, res) => {
  const { query, ttlMin=30 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  const exp = Date.now() + ttlMin*60000;
  const payload = `${query}|${exp}`;
  const sig = hmac(payload);
  const link = `${req.protocol}://${req.get('host')}/recall?query=${encodeURIComponent(query)}&exp=${exp}&sig=${sig}`;
  res.json({ link, expires: exp });
});
app.get('/recall', async (req, res) => {
  const { query, exp, sig } = req.query;
  if (!query||!exp||!sig) return res.status(400).json({ error:'bad params' });
  if (Date.now()>Number(exp)) return res.status(403).json({ error:'expired' });
  if (hmac(`${query}|${exp}`)!==sig) return res.status(403).json({ error:'invalid sig' });
  // Placeholder: replace with actual recall logic
  res.json({ recall: `You asked for "${query}"` });
});

// --- Email sending (/send-email) ---
app.post('/send-email', isAuthenticated, async (req, res) => {
  const { to, subject, body } = req.body;
  try {
    const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:GMAIL_USER, pass:GMAIL_PASS }});
    await transporter.sendMail({ from:GMAIL_USER, to, subject, html:body });
    logEvent(`Email → ${to}`);
    res.json({ status:'sent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Backup memory (/backup-memory) ---
app.post('/backup-memory', isAuthenticated, async (_req, res) => {
  const dirs = fs.readdirSync(MEMORY_ROOT).filter(d=>fs.statSync(path.join(MEMORY_ROOT,d)).isDirectory());
  if (!dirs.length) return res.status(400).json({ error:'no memories' });
  const latest = path.join(MEMORY_ROOT, dirs.sort().pop());
  const outZip = `/tmp/backup_${Date.now()}.zip`;
  const arch = require('archiver')('zip'), out=fs.createWriteStream(outZip);
  arch.pipe(out); arch.directory(latest,false);
  await arch.finalize();
  // (upload to Drive omitted for brevity)
  res.json({ status:'zipped', file: outZip });
});

// --- Logs, CLI & dashboard ---
app.get('/cli-logs', isAuthenticated, (_r,res)=> res.json({ logs: [] }));
app.post('/launch-action', isAuthenticated, (_r,res)=> res.json({ status:'launched' }));
app.get('/', (_r,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));

// --- Start ---
app.listen(PORT,()=> logEvent(`✅ Running at http://localhost:${PORT}`));
