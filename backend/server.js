require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./config/db');
const realtime = require('./services/realtime');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// Photos live in MongoDB (see models/Photo.js). This route streams one back by its id and
// lets the browser cache it hard, because a stored photo never changes.
//
// Files uploaded before the move to database storage are still served from disk if they
// happen to be there - on a host with an ephemeral filesystem they will not be, and the
// 404 handler below says so plainly instead of leaving a broken image icon.
const Photo = require('./models/Photo');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

app.get('/uploads/:id', async (req, res, next) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return next();          // not an id - try the disk below
  try {
    const photo = await Photo.findById(id).lean();
    if (!photo || !photo.data) return next();
    res.set('Content-Type', photo.contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(photo.data.buffer ? Buffer.from(photo.data.buffer) : photo.data);
  } catch (e) {
    return next(e);
  }
});

app.use('/uploads', express.static(UPLOAD_DIR));

app.use('/uploads', (req, res) => {
  res.status(404).json({
    error: 'This photo is no longer available. Photos taken before the move to database ' +
           'storage were kept on the server disk, which the host clears on every deploy.'
  });
});
/*
 * Cache busting.
 *
 * A browser holds on to css/app.css and js/*.js, so a deploy could land on the server while
 * every desk kept running yesterday's code - which is indistinguishable from the fix not
 * working, and cost real time to diagnose more than once. Telling people to press Ctrl+F5
 * is not a fix; it is a rule they will forget.
 *
 * So the two HTML pages are served through here with a build stamp appended to every local
 * asset. The stamp is set once when the process starts, which means every deploy produces
 * new URLs and every browser fetches fresh files on its own. Nothing else changes: the
 * assets themselves are still plain static files.
 */
const BUILD = String(Date.now());
const DASHBOARD = path.join(__dirname, '..', 'dashboard');

function sendPage(file, res, next) {
  fs.readFile(path.join(DASHBOARD, file), 'utf8', (err, html) => {
    if (err) return next();
    res.type('html').send(
      html.replace(/(href|src)="((?:css|js)\/[^"?]+)"/g, '$1="$2?v=' + BUILD + '"')
    );
  });
}

app.get(['/', '/index.html'], (req, res, next) => sendPage('index.html', res, next));
app.get('/app.html', (req, res, next) => sendPage('app.html', res, next));

// Lets anyone confirm what is actually running, without guessing from behaviour.
app.get('/api/version', (req, res) => res.json({ build: BUILD, startedAt: new Date(Number(BUILD)) }));

app.use(express.static(DASHBOARD));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/trips', require('./routes/trips'));
app.use('/api/runner', require('./routes/runner'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/runner-board', require('./routes/runnerboard'));
app.use('/api/danger', require('./routes/danger'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    realtime.attach(server);
    server.listen(PORT, () => console.log('[ibs] control room running on port ' + PORT));
  })
  .catch(e => {
    console.error('[db] connection failed:', e.message);
    process.exit(1);
  });
