// 📦 Abhängigkeiten
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// 📡 Express App Setup
const app = express();
const PORT = process.env.PORT || 3000;

// 📦 MongoDB Verbindung
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ Verbunden mit MongoDB'))
  .catch(err => console.error('❌ MongoDB Fehler:', err));

// 📁 Mongoose Models
const userSchema = new mongoose.Schema({
  username: String,
  password: String,
  role: String,
  schoolType: String,
  emailVerified: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const hilfeSchema = new mongoose.Schema({
  title: String,
  hilfen: [
    {
      name: String,
      content: String,
      locked: Boolean,
      lockCode: String,
      files: [{ path: String, original: String }]
    }
  ],
  userId: mongoose.Schema.Types.ObjectId
}, { timestamps: true });
const Hilfe = mongoose.model('Hilfe', hilfeSchema);

// 📂 Upload-Ordner
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 📁 Multer Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

// ⚙️ Middleware
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'super-secret-key',
  resave: false,
  saveUninitialized: false
}));
app.set('view engine', 'ejs');

// 🔐 Auth Middleware
function ensureAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// 🌐 Startseite
app.get('/', (req, res) => res.render('startseite'));

// 🔐 Registrierung & Login
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  const { username, password, role, schoolType } = req.body;
  const existing = await User.findOne({ username });
  if (existing) return res.render('register', { error: 'Benutzername bereits vergeben.' });

  const hashed = await bcrypt.hash(password, 10);
  await new User({ username, password: hashed, role, schoolType }).save();
  res.redirect('/login');
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('login', { error: 'Ungültige Anmeldedaten.' });
  }

  req.session.userId = user._id;
  req.session.user = user;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// 📊 Dashboard
app.get('/dashboard', ensureAuth, async (req, res) => {
  const { sort } = req.query;
  let sortOption = {};

  if (sort === 'date_asc') sortOption = { createdAt: 1 };
  else if (sort === 'date_desc') sortOption = { createdAt: -1 };
  else if (sort === 'title_asc') sortOption = { title: 1 };
  else if (sort === 'title_desc') sortOption = { title: -1 };

  const hilfen = await Hilfe.find({ userId: req.session.userId }).sort(sortOption);

  res.render('dashboard', {
    user: req.session.user,
    hilfen,
    sort,
    req // Für QR-Code
  });
});

// 📥 Neue Hilfe erstellen
app.get('/lernhilfeerstellen', ensureAuth, (req, res) => {
  res.render('lernhilfeerstellen');
});

app.post('/create', ensureAuth, upload.any(), async (req, res) => {
  const { title } = req.body;
  const hilfenInput = req.body.hilfen || {};
  const files = req.files || [];
  const hilfenArray = [];

  Object.keys(hilfenInput).forEach(index => {
    const h = hilfenInput[index];
    const locked = h.locked === 'on';
    const lockCode = locked ? h.lockCode?.trim() || null : null;
    const filesForHelp = files
      .filter(f => f.fieldname === `hilfen[${index}][file]`)
      .map(f => ({ path: `uploads/${f.filename}`, original: f.originalname }));

    hilfenArray.push({
      name: h.name || `Hilfe ${parseInt(index) + 1}`,
      content: h.content || '',
      locked,
      lockCode,
      files: filesForHelp
    });
  });

  const hilfeDoc = new Hilfe({ title, hilfen: hilfenArray, userId: req.session.userId });
  await hilfeDoc.save();

  const fullUrl = `${req.protocol}://${req.get('host')}/hilfe/${hilfeDoc._id}`;
  const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(fullUrl)}`;

  res.render('qrcode', { url: fullUrl, qrImage });
});

// 📖 Hilfe anzeigen
app.get('/hilfe/:id', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe) return res.status(404).send('Nicht gefunden');

  if (!req.session.unlocked) req.session.unlocked = {};
  if (!req.session.unlocked[hilfe.id]) req.session.unlocked[hilfe.id] = {};
  const unlocked = hilfe.hilfen.map((_, i) => !!req.session.unlocked[hilfe.id][i]);

res.render('hilfe', { hilfe, unlocked, errors: {}, user: req.session.user || null });
});

// 🔓 Hilfe entsperren – AJAX-kompatibel
app.post('/hilfe/:id/unlock/:index', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  const idx = parseInt(req.params.index);
  if (!hilfe || !hilfe.hilfen[idx]) return res.json({ success: false, error: 'Nicht gefunden' });

  const enteredCode = (req.body.code || '').trim();
  const neededCode = hilfe.hilfen[idx].lockCode;

  if (!neededCode) return res.json({ success: true, unlockedIndices: [] });

  if (!req.session.unlocked) req.session.unlocked = {};
  if (!req.session.unlocked[hilfe.id]) req.session.unlocked[hilfe.id] = {};

  if (enteredCode === neededCode) {
    const unlockedNow = [];
    hilfe.hilfen.forEach((h, i) => {
      if (h.lockCode === enteredCode) {
        req.session.unlocked[hilfe.id][i] = true;
        unlockedNow.push(i);
      }
    });
    return res.json({ success: true, unlockedIndices: unlockedNow });
  } else {
    return res.json({ success: false, error: 'Falscher Code' });
  }
});

// 🛠 Hilfe bearbeiten (Formular)
app.get('/hilfe/bearbeiten/:id', ensureAuth, async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe || !hilfe.userId.equals(req.session.userId)) {
    return res.status(403).send('Nicht erlaubt');
  }

  res.render('hilfe-bearbeiten', { hilfe });
});

app.post('/hilfe/bearbeiten/:id', ensureAuth, upload.any(), async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe || !hilfe.userId.equals(req.session.userId)) {
    return res.status(403).send('Nicht erlaubt');
  }

  const { title } = req.body;
  const hilfenInput = req.body.hilfen || {};
  const files = req.files || [];
  const updatedHilfen = [];

  Object.keys(hilfenInput).forEach(index => {
    const h = hilfenInput[index];
    const locked = h.locked === 'on';
    const lockCode = locked ? h.lockCode?.trim() || null : null;

    const filesForHelp = files
      .filter(f => f.fieldname === `hilfen[${index}][file]`)
      .map(f => ({
        path: `uploads/${f.filename}`,
        original: f.originalname
      }));

    updatedHilfen.push({
      name: h.name || `Hilfe ${parseInt(index) + 1}`,
      content: h.content || '',
      locked,
      lockCode,
      files: filesForHelp
    });
  });

  hilfe.title = title;
  hilfe.hilfen = updatedHilfen;
  await hilfe.save();

  res.redirect('/dashboard');
});

// ▶ Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});