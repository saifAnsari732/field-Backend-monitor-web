const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');

router.post('/', protect, requireActivePlan, ac.createMeeting);
router.get('/my', protect, ac.getMyMeetings);
router.put('/:id', protect, requireActivePlan, ac.updateMeeting);
router.get('/all', protect, authorize('admin', 'hr', 'manager'), ac.getAllMeetings);
router.delete('/:id', protect, authorize('admin', 'hr'), requireActivePlan, ac.deleteMeeting);

module.exports = router;
