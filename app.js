// 📦 Abhängigkeiten
const QRCode      = require('qrcode');
const express     = require('express');
const mongoose    = require('mongoose');
const session     = require('express-session');
const bcrypt      = require('bcrypt');
const bodyParser  = require('body-parser');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
require('dotenv').config();

// 📡 Express App Setup
const app = express();
const PORT = process.env.PORT || 3000;

// 📦 MongoDB Verbindung
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ Verbunden mit MongoDB'))
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
  subject: String,
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

// ─── Routen ────────────────────────────────────────────────────────────

// 🌐 Startseite
app.get('/', (req, res) => {
  res.render('startseite', { user: req.session.user || null });
});

// 🔐 Registrierung & Login
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  const { username, password, role, schoolType } = req.body;
  if (await User.findOne({ username })) {
    return res.render('register', { error: 'Benutzername bereits vergeben.' });
  }
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
  req.session.user   = user;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// 📊 Dashboard
app.get('/dashboard', ensureAuth, async (req, res) => {
  const { sort, subject } = req.query;
  const filter = { userId: req.session.userId };
  if (subject) filter.subject = subject;

  let sortOption = {};
  if      (sort === 'date_asc')   sortOption = { createdAt:  1 };
  else if (sort === 'date_desc')  sortOption = { createdAt: -1 };
  else if (sort === 'title_asc')  sortOption = { title:      1 };
  else if (sort === 'title_desc') sortOption = { title:     -1 };

  const allUserHilfen = await Hilfe.find({ userId: req.session.userId });
  const allSubjects   = [...new Set(allUserHilfen.map(h => h.subject).filter(Boolean))];
  const hilfen        = await Hilfe.find(filter).sort(sortOption);

  res.render('dashboard', {
    user:        req.session.user,
    hilfen,
    sort,
    subject,
    allSubjects,
    req
  });
});

// 📥 Neue Hilfe erstellen
app.get('/lernhilfeerstellen', ensureAuth, (req, res) => {
  res.render('lernhilfeerstellen');
});
app.post('/create', ensureAuth, upload.any(), async (req, res) => {
  const { title } = req.body;
  const subject = req.body.subject === 'Sonstiges'
    ? req.body.customSubject?.trim()
    : req.body.subject;

  const hilfenArray = [];
  const files       = req.files || [];
  const hilfenInput = req.body.hilfen || {};
  Object.keys(hilfenInput).forEach(i => {
    const h      = hilfenInput[i];
    const locked = h.locked === 'on';
    hilfenArray.push({
      name:    h.name || `Hilfe ${+i+1}`,
      content: h.content || '',
      locked,
      lockCode: locked ? h.lockCode : null,
      files:   files
        .filter(f => f.fieldname === `hilfen[${i}][file]`)
        .map(f => ({ path: `uploads/${f.filename}`, original: f.originalname }))
    });
  });

  const hilfeDoc = new Hilfe({
    title,
    subject,
    hilfen: hilfenArray,
    userId: req.session.userId
  });
  await hilfeDoc.save();

  const fullUrl = `${req.protocol}://${req.get('host')}/hilfe/${hilfeDoc._id}`;
  const qrImage = await QRCode.toDataURL(fullUrl, { width:300, margin:2 });
  res.render('qrcode', { url: fullUrl, qrImage });
});

// 🛠 Bearbeiten-Routen müssen vor Anzeige-Route stehen
app.get('/hilfe/:id/bearbeiten', ensureAuth, async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe || !hilfe.userId.equals(req.session.userId)) {
    return res.status(403).send('Nicht erlaubt');
  }
  res.render('hilfe-bearbeiten', { hilfe });
});
app.post('/hilfe/:id/bearbeiten', ensureAuth, upload.any(), async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe || !hilfe.userId.equals(req.session.userId)) {
    return res.status(403).send('Nicht erlaubt');
  }

  hilfe.title = req.body.title;
  const updated = [];
  const files   = req.files || [];
  const input   = req.body.hilfen || {};
  Object.keys(input).forEach(i => {
    const h      = input[i];
    const locked = h.locked === 'on';
    updated.push({
      name:     h.name  || `Hilfe ${+i+1}`,
      content:  h.content || '',
      locked,
      lockCode: locked ? h.lockCode : null,
      files:    files
        .filter(f => f.fieldname === `hilfen[${i}][file]`)
        .map(f => ({ path: `uploads/${f.filename}`, original: f.originalname }))
    });
  });
  hilfe.hilfen = updated;
  await hilfe.save();
  res.redirect('/dashboard');
});

// 📖 Hilfe anzeigen (immer neu gesperrt starten)
app.get('/hilfe/:id', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe) return res.status(404).send('Nicht gefunden');

  // alten Unlock-Status löschen, damit beim Neuladen alles wieder gesperrt ist
  if (req.session.unlocked && req.session.unlocked[hilfe.id]) {
    delete req.session.unlocked[hilfe.id];
  }

  // neu initialisieren: alle gesperrt
  req.session.unlocked       = req.session.unlocked || {};
  req.session.unlocked[hilfe.id] = {};
  const unlocked = hilfe.hilfen.map(() => false);

  res.render('hilfe', {
    hilfe,
    unlocked,
    errors: {},
    user: req.session.user || null
  });
});

// 🔓 AJAX Entsperren
app.post('/hilfe/:id/unlock/:index', async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  const idx   = +req.params.index;
  if (!hilfe || !hilfe.hilfen[idx]) {
    return res.json({ success:false, error:'Nicht gefunden' });
  }

  const code = (req.body.code||'').trim();
  if (!hilfe.hilfen[idx].lockCode) {
    return res.json({ success:true, unlockedIndices:[] });
  }

  req.session.unlocked       = req.session.unlocked || {};
  req.session.unlocked[hilfe.id] = req.session.unlocked[hilfe.id] || {};

  if (code === hilfe.hilfen[idx].lockCode) {
    const unlockedNow = [];
    hilfe.hilfen.forEach((h,i) => {
      if (h.lockCode === code) {
        req.session.unlocked[hilfe.id][i] = true;
        unlockedNow.push(i);
      }
    });
    return res.json({ success:true, unlockedIndices:unlockedNow });
  } else {
    return res.json({ success:false, error:'Falscher Code' });
  }
});

// 🗑️ Löschen
app.post('/hilfe/:id/loeschen', ensureAuth, async (req, res) => {
  const hilfe = await Hilfe.findById(req.params.id);
  if (!hilfe || !hilfe.userId.equals(req.session.userId)) {
    return res.status(403).send('Nicht erlaubt');
  }
  await Hilfe.deleteOne({ _id:req.params.id });
  res.redirect('/dashboard');
});

// ▶ Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});