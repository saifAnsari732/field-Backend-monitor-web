const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');

router.use(protect, requireActivePlan);

router.post('/', ac.createMeeting);
router.get('/my', ac.getMyMeetings);
router.put('/:id', ac.updateMeeting);
router.get('/all', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAllMeetings);

module.exports = router;
