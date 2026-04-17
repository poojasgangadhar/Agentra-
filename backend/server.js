// backend/server.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [APP_URL, /\.vercel\.app$/]
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Agentra MailSense', timestamp: new Date().toISOString() });
});

// ── Global error handler — always JSON ────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : (err.message || 'Unknown error'),
  });
});

// ── Start ─────────────────────────────────────────────────────
const { initDb } = require('./db');

initDb().then(() => {
  const authRoutes  = require('./routes/auth');
  const gmailRoutes = require('./routes/gmail');
  const { startScheduler } = require('./scheduler');

  app.use('/api', authRoutes);
  app.use('/api', gmailRoutes);

  // ── API 404 — always JSON, never HTML ─────────────────────────
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
  });

  // ── SPA routes ────────────────────────────────────────────────
  app.get(['/dashboard', '/dashboard.html'], (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`\n  Agentra MailSense → http://localhost:${PORT}\n`);
      startScheduler();
    });
  }
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});

module.exports = app;