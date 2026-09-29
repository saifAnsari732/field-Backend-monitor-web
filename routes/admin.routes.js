// admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
const rc = require('../controllers/report.controller');

router.get('/dashboard', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getDashboardStats);
router.get('/employees', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAllEmployees);
router.get('/managers', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getManagers);
router.post('/managers', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.createManager);
router.put('/employees/:id/approve', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.approveEmployee);
router.put('/employees/:id/block', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.toggleBlock);
router.get('/attendance', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAttendanceReport);
router.get('/tracking-history', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getTrackingHistory);
router.put('/tracking/adjust-distance', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.adjustTrackingDistance);
router.put('/employees/:id', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.updateEmployee);
router.get('/departments', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getDepartments);
router.post('/departments', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.createDepartment);
router.get('/teams', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getTeams);
router.post('/teams', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, ac.createTeam);
router.get('/reports/consolidated', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), rc.getConsolidatedReport);
router.get('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getOrganizationSettings);
router.put('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.updateOrganizationSettings);

module.exports = router;
