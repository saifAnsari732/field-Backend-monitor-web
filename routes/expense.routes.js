const express = require('express');
const router = express.Router();
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');

router.use(protect, requireActivePlan);

router.post('/', ac.createExpense);
router.get('/my', ac.getMyExpenses);
router.get('/all', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAllExpenses);
router.put('/:id/approve', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.approveExpense);

module.exports = router;
