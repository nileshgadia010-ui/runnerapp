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

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR));
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
