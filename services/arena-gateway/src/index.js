// services/arena-gateway/src/index.js
// FightClawb Arena Gateway Service — main entry point

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { healthCheck } = require('./database');
const leaderboardRouter = require('./routes/leaderboard');
const battlesRouter     = require('./routes/battles');

const app = express();

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const dbOk = await healthCheck();
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    service:   'arena-gateway',
    db:        dbOk ? 'connected' : 'unavailable',
    timestamp: new Date().toISOString(),
    version:   '1.0.0',
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/battles',     battlesRouter);

// Root
app.get('/', (_req, res) => {
  res.json({
    name:        'FightClawb Arena Gateway',
    version:     '1.0.0',
    description: 'Battle orchestration, voting, and leaderboards',
    endpoints: {
      health:      'GET  /health',
      battles:     'GET  /api/battles',
      battle:      'GET  /api/battles/:matchId',
      leaderboard: 'GET  /api/leaderboard',
    },
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎮 Arena Gateway running on port ${PORT}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   Leaderboard: http://localhost:${PORT}/api/leaderboard`);
  console.log(`   Battles:     http://localhost:${PORT}/api/battles`);
});

module.exports = app;
