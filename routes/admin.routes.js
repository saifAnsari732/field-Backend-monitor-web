// admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
const rc = require('../controllers/report.controller');

// Read organization settings (accessible during renewal)
router.get('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getOrganizationSettings);

// Operational routes requiring active paid subscription
router.get('/dashboard', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.getDashboardStats);
router.get('/employees', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.getAllEmployees);
router.get('/managers', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.getManagers);
router.put('/employees/:id/approve', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.approveEmployee);
router.put('/employees/:id/block', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.toggleBlock);
router.get('/attendance', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.getAttendanceReport);
router.get('/tracking-history', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.getTrackingHistory);
router.put('/tracking/adjust-distance', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.adjustDistance);
router.put('/employees/:id', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.updateEmployee);
router.get('/reports/consolidated', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, rc.getConsolidatedReport);
router.put('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.updateOrganizationSettings);

module.exports = router;
