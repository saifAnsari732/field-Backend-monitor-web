const express = require('express');
const router = express.Router();
const managerController = require('../controllers/manager.controller');
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');

router.use(protect, requireActivePlan);
router.use(authorize('manager', 'admin', 'org_admin', 'super_admin'));

router.get('/dashboard-stats', managerController.getDashboardStats);
router.get('/team', managerController.getMyTeam);
router.get('/meetings', managerController.getTeamMeetings);
router.get('/expenses', managerController.getTeamExpenses);
router.get('/attendance', managerController.getTeamAttendance);
router.get('/tracking-history', managerController.getTeamTrackingHistory);

module.exports = router;
