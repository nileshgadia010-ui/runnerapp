require('dotenv').config();
const path = require('path');
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
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/trips', require('./routes/trips'));
app.use('/api/runner', require('./routes/runner'));
app.use('/api/reports', require('./routes/reports'));

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
