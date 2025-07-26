const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const session = require('express-session');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Mit MongoDB Atlas verbinden
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ Mit MongoDB Atlas verbunden'))
  .catch(err => console.error('❌ MongoDB Fehler:', err));

// ✅ Schema für Lernhilfe
const HilfeSchema = new mongoose.Schema({
  title: String,
  hilfen: [
    {
      name: String,
      content: String,
      locked: Boolean,
      lockCode: String,
      files: [{ path: String, original: String }]
    }
  ]
});
const Hilfe = mongoose.model('Hilfe', HilfeSchema);

// ✅ Sicherstellen, dass Upload-Ordner existiert
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('✅ Upload-Ordner wurde erstellt:', uploadDir);
}

// ✅ Multer für Uploads (temporär)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage: storage });

// ✅ Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(session({
  secret: 'geheimnisvoller-session-key',
  resave: false,
  saveUninitialized: true
}));

// ✅ Keep-Alive Ping Route
app.get('/ping', (req, res) => {
  const randomId = Math.floor(Math.random() * 1000000);
  res.send(`
    <html>
      <head><title>Keep Alive</title></head>
      <body>
        <h1>✅ App ist wach!</h1>
        <p>Zeit: ${new Date().toISOString()}</p>
        <p>Random: ${randomId}</p>
      </body>
    </html>
  `);
});

// ✅ Startseite
app.get('/', (req, res) => {
  res.render('index');
});

// ✅ Lernhilfe erstellen und in MongoDB speichern
app.post('/create', upload.any(), async (req, res) => {
  console.log('📂 Hochgeladene Dateien:', req.files);

  const { title } = req.body;
  const hilfenInput = req.body.hilfen || {};
  const files = req.files || [];
  const hilfenArray = [];

  Object.keys(hilfenInput).forEach(index => {
    const h = hilfenInput[index];
    const locked = h.locked === 'on' || h.locked === true || h.locked === 'true';
    const lockCode = locked ? h.lockCode?.trim() || null : null;

    const filesForHelp = files
      .filter(f => f.fieldname === `hilfen[${index}][file]`)
      .map(f => ({
        path: `uploads/${f.filename}`,
        original: f.originalname
      }));

    hilfenArray.push({
      name: h.name || `Hilfe ${parseInt(index) + 1}`,
      content: h.content || '',
      locked,
      lockCode,
      files: filesForHelp
    });
  });

  if (hilfenArray.length === 0) {
    return res.send('Bitte mindestens eine Hilfe ausfüllen.');
  }

  // ✅ Speichern in MongoDB
  const hilfeDoc = new Hilfe({
    title,
    hilfen: hilfenArray
  });
  await hilfeDoc.save();

  const id = hilfeDoc._id; // MongoDB ID

  const url = `${req.protocol}://${req.get('host')}/hilfe/${id}`;

  QRCode.toDataURL(url, { width: 500, margin: 2 }).then(qrImage => {
    res.render('success', { url, qrImage });
  }).catch(err => {
    res.send('QR-Code Fehler: ' + err.message);
  });
});

// ✅ Lernhilfe anzeigen (aus MongoDB holen)
app.get('/hilfe/:id', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);

  if (!hilfe) {
    return res.status(404).send('Lernhilfe nicht gefunden');
  }

  if (!req.session.unlocked) req.session.unlocked = {};
  if (!req.session.unlocked[hilfe.id]) req.session.unlocked[hilfe.id] = {};

  const unlocked = hilfe.hilfen.map((_, idx) => !!req.session.unlocked[hilfe.id][idx]);

  res.render('hilfe', { hilfe, unlocked, errors: {} });
});

// ✅ Entsperrcode prüfen
app.post('/hilfe/:id/unlock/:index', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  const idx = parseInt(req.params.index);

  if (!hilfe || !hilfe.hilfen[idx]) {
    return res.status(404).send('Lernhilfe oder Hilfe nicht gefunden');
  }

  const enteredCode = (req.body.code || '').trim();
  const neededCode = hilfe.hilfen[idx].lockCode;

  if (!neededCode) {
    return res.redirect(`/hilfe/${hilfe.id}`);
  }

  if (!req.session.unlocked) req.session.unlocked = {};
  if (!req.session.unlocked[hilfe.id]) req.session.unlocked[hilfe.id] = {};

  const errors = {};
  if (enteredCode === neededCode) {
    req.session.unlocked[hilfe.id][idx] = true;
    return res.redirect(`/hilfe/${hilfe.id}`);
  } else {
    errors[idx] = 'Falscher Code. Bitte erneut versuchen.';
    const unlocked = hilfe.hilfen.map((_, i) => !!req.session.unlocked[hilfe.id][i]);
    return res.status(403).render('hilfe', { hilfe, unlocked, errors });
  }
});

// ✅ Server starten
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf http://localhost:${PORT}`);
});