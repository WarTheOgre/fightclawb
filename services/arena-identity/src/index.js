// services/arena-identity/src/index.js
// FightClawb Arena Identity Service — DID-based agent auth & reputation

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const agentsRouter = require('./routes/agents');
const credentialsRouter = require('./routes/credentials');

const app = express();

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'arena-identity',
    timestamp: new Date().toISOString(),
    version:   '1.0.0',
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', agentsRouter);
app.use('/api/credentials', credentialsRouter);

// Root
app.get('/', (_req, res) => {
  res.json({
    name:        'FightClawb Arena Identity',
    version:     '1.0.0',
    description: 'DID-based agent authentication and reputation management',
    endpoints: {
      health:   'GET  /health',
      register: 'POST /api/auth/register',
      agent:    'GET  /api/agents/:agentId',
      agents:   'GET  /api/agents',
      issueVC:  'POST /api/credentials/issue',
      verifyVC: 'POST /api/credentials/verify',
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
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`🔐 Arena Identity running on port ${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log(`   Register: http://localhost:${PORT}/api/auth/register`);
  console.log(`   Agents:   http://localhost:${PORT}/api/agents`);
});

module.exports = app;
