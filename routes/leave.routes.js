const express = require('express');
const router = express.Router();
const leaveController = require('../controllers/leave.controller');
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');

router.use(protect);

router.post('/apply', requireActivePlan, leaveController.applyLeave);
router.get('/my', leaveController.getMyLeaves);

router.get('/all', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), leaveController.getAllLeaves);
router.patch('/:id/status', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), requireActivePlan, leaveController.updateLeaveStatus);

module.exports = router;
