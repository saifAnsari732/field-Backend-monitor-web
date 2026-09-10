const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const { executeAgent } = require('../agent.engine');

// ─── Agent Execute (Full Admin Power) ──────────────────────────────────────
router.post('/execute', protect, authorize('admin', 'hr', 'agent'), async (req, res) => {
  try {
    const { command = '', history = [] } = req.body || {};

    if (!command.trim()) {
      return res.status(400).json({ success: false, message: 'No command provided' });
    }

    const result = await executeAgent(command, history);

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Agent execute error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─── Agent Health ──────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'agent-online',
    engine: 'openclaw-agent',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    capabilities: [
      'dashboard', 'employees', 'live-tracking', 'attendance',
      'tasks', 'meetings', 'expenses', 'leaves', 'leads',
      'approve/reject', 'block/unblock', 'notifications',
      'natural-language', 'hindi-support',
    ],
  });
});

module.exports = router;
