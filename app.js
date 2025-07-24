const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// BASE_URL für QR-Codes – lokal localhost, online Render-URL
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Pfad zur JSON-Datenbank
const DATA_FILE = path.join(__dirname, 'data.json');

// Multer Setup für Datei-Uploads (Speicherung in /public/uploads)
const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(session({
  secret: 'geheimnisvoller-session-key',
  resave: false,
  saveUninitialized: true
}));

// Initiale data.json Datei sicherstellen
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Startseite ---
app.get('/', (req, res) => {
  res.render('index'); // index.ejs
});

// --- Lernhilfe erstellen ---
app.post('/create', upload.any(), (req, res) => {
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
      .map(f => `uploads/${f.filename}`);

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

  const id = Date.now().toString();
  const data = loadData();
  data[id] = { id, title, hilfen: hilfenArray };
  saveData(data);

  // ✅ Korrekte URL je nach Umgebung (lokal/online)
  const url = `${BASE_URL}/hilfe/${id}`;

  // ✅ QR-Code erzeugen
  QRCode.toDataURL(url).then(qrImage => {
    res.render('success', { url, qrImage }); // success.ejs anzeigen
  }).catch(err => {
    res.send('QR-Code Fehler: ' + err.message);
  });
});

// --- Lernhilfe anzeigen ---
app.get('/hilfe/:id', (req, res) => {
  const data = loadData();
  const hilfe = data[req.params.id];

  if (!hilfe) {
    return res.status(404).send('Lernhilfe nicht gefunden');
  }

  // Session speichern, welche Hilfen schon freigeschaltet sind
  if (!req.session.unlocked) req.session.unlocked = {};
  if (!req.session.unlocked[hilfe.id]) req.session.unlocked[hilfe.id] = {};

  // Für EJS: array von booleans, ob Hilfen freigeschaltet sind
  const unlocked = hilfe.hilfen.map((_, idx) => !!req.session.unlocked[hilfe.id][idx]);

  res.render('hilfe', { hilfe, unlocked, errors: {} });
});

// --- Entsperrcode prüfen ---
app.post('/hilfe/:id/unlock/:index', (req, res) => {
  const data = loadData();
  const hilfe = data[req.params.id];
  const idx = parseInt(req.params.index);

  if (!hilfe || !hilfe.hilfen[idx]) {
    return res.status(404).send('Lernhilfe oder Hilfe nicht gefunden');
  }

  const enteredCode = (req.body.code || '').trim();
  const neededCode = hilfe.hilfen[idx].lockCode;

  if (!neededCode) {
    return res.redirect(`/hilfe/${hilfe.id}`); // nicht gesperrt
  }

  // Session vorbereiten
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

// --- Server starten ---
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf ${BASE_URL}`);
});