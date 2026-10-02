// ─── routes/auth.routes.js ───────────────────────────────────────────────────
const express = require('express');
module.exports = (() => {
  const r = express.Router();
  const c = require('../controllers/auth.controller');
  const { protect } = require('../middleware/auth.middleware');
  r.post('/register', c.register);
  r.post('/register-organization', c.registerOrganization);
  r.post('/login', c.login);
  r.post('/forgot-password', c.forgotPassword);
  r.post('/reset-password', c.resetPassword);
  r.post('/refresh-token', c.refreshToken);
  r.post('/logout', protect, c.logout);
  r.get('/me', protect, c.getMe);
  r.put('/profile', protect, c.updateProfile);
  r.put('/change-password', protect, c.changePassword);
  return r;
})();
