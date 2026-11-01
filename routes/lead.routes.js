const express = require('express');
const router = express.Router();
const { createLead, getLeads, updateLead, deleteLead } = require('../controllers/lead.controller');
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');

router.use(protect, requireActivePlan);

router.route('/')
  .post(authorize('admin', 'hr'), createLead)
  .get(getLeads);

router.route('/:id')
  .put(updateLead)
  .delete(authorize('admin', 'hr'), deleteLead);

module.exports = router;
