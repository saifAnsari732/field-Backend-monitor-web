// tracking.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const tc = require('../controllers/tracking.controller');

// Tracking session management (Blocked if organization plan is expired)
router.post('/start', protect, requireActivePlan, tc.startTracking);
router.post('/update', protect, requireActivePlan, tc.updateLocation);
router.post('/stop', protect, requireActivePlan, tc.stopTracking);
router.post('/heartbeat', protect, requireActivePlan, tc.heartbeat);

// Get data
router.get('/today', protect, requireActivePlan, tc.getTodaySessions);
router.get('/live', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, tc.getLiveEmployees);
router.get('/live-locations', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, tc.getLiveLocations);
router.get('/session/:id', protect, requireActivePlan, tc.getSessionRoute);
router.get('/geocode', protect, requireActivePlan, tc.geocode);
router.get('/diagnostic', protect, requireActivePlan, tc.getSessionDiagnostic);

// Reconcile distance from DistanceLedger
router.post('/reconcile', protect, requireActivePlan, tc.reconcileSession);
router.get('/session/:id/reconcile', protect, requireActivePlan, tc.reconcileSession);

// Reports
router.get('/report/employee/:employeeId', protect, requireActivePlan, tc.getEmployeeReport);

// Delete history
router.delete('/history/employee/:employeeId', protect, authorize('admin', 'org_admin', 'super_admin'), requireActivePlan, tc.deleteEmployeeHistory);

module.exports = router;
