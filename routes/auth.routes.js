// ─── routes/auth.routes.js ───────────────────────────────────────────────────
const express = require('express');
module.exports = (() => {
  const r = express.Router();
  const c = require('../controllers/auth.controller');
  const { protect } = require('../middleware/auth.middleware');
  r.post('/register', c.register);
  r.post('/register-organization', c.registerOrganization);
  r.post('/login', c.login);
  r.post('/verify-reset-email', c.verifyResetEmail);
  r.post('/reset-password-direct', c.resetPasswordDirect);
  r.post('/refresh-token', c.refreshToken);
  r.post('/logout', protect, c.logout);
  r.get('/me', protect, c.getMe);
  r.put('/profile', protect, c.updateProfile);
  r.put('/change-password', protect, c.changePassword);
  return r;
})();
