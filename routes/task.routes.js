const express = require('express');
const router = express.Router();
const taskController = require('../controllers/task.controller');
const { protect, authorize, requireActivePlan } = require('../middleware/auth.middleware');

router.use(protect);

router.post('/', authorize('admin', 'hr', 'manager', 'employee'), requireActivePlan, taskController.createTask);
router.get('/all', authorize('admin', 'hr', 'manager'), taskController.getAllTasks);
router.put('/:id', authorize('admin', 'hr', 'manager'), requireActivePlan, taskController.updateTask);

router.get('/my', authorize('employee'), taskController.getMyTasks);
router.patch('/:id/status', authorize('employee', 'admin', 'hr', 'manager'), taskController.updateTaskStatus);

router.delete('/:id', authorize('admin', 'hr', 'manager'), requireActivePlan, taskController.deleteTask);
module.exports = router;
