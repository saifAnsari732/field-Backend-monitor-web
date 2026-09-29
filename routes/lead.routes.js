const express = require('express');
const router = express.Router();
const { createLead, getLeads, updateLead, deleteLead } = require('../controllers/lead.controller');
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');

router.route('/')
  .post(protect, authorize('admin', 'hr'), requireActivePlan, createLead)
  .get(protect, getLeads);

router.route('/:id')
  .put(protect, requireActivePlan, updateLead)
  .delete(protect, authorize('admin', 'hr'), requireActivePlan, deleteLead);

module.exports = router;
