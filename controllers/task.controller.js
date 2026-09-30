const { Task, Notification, ActivityLog } = require('../models/index');
const User = require('../models/User.model');

// @desc Create a new task (admin / manager)
exports.createTask = async (req, res) => {
  try {
    const { title, description, employeeId, dueDate, priority, location, duration } = req.body;
    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;

    const targetEmployeeId = employeeId || (req.user.role === 'employee' ? req.user._id : null);
    if (!targetEmployeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    const task = await Task.create({
      organizationId: orgId,
      title,
      description,
      employee: targetEmployeeId,
      assignedBy: req.user._id,
      dueDate: dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000),
      priority: priority || 'medium',
      location: location || { address: '' },
      duration: duration || '1 day'
    });

    const populatedTask = await Task.findById(task._id)
      .populate('employee', 'name employeeId department designation avatar')
      .populate('assignedBy', 'name role avatar');

    const employee = await User.findById(targetEmployeeId);
    if (employee) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user_${targetEmployeeId}`).emit('new_task', { task: populatedTask });
      }

      await Notification.create({
        organizationId: orgId,
        recipient: targetEmployeeId,
        sender: req.user._id,
        type: 'task',
        title: 'New Task Assigned',
        message: `You have been assigned a new task: ${title}`
      });
    }

    res.status(201).json({ success: true, task: populatedTask });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get my tasks (employee)
exports.getMyTasks = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;

    const tasks = await Task.find(filter).sort({ dueDate: 1 });
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update task status (employee)
exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, employee: req.user._id },
      { 
        status, 
        ...(status === 'completed' && { completedAt: new Date() }) 
      },
      { new: true }
    ).populate('assignedBy', 'name socketId');

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('task_status_update', {
        taskId: task._id,
        status,
        employeeName: req.user.name
      });
    }

    await ActivityLog.create({
      organizationId: req.user?.organizationId,
      employee: req.user._id,
      action: 'TASK_UPDATE',
      description: `Task "${task.title}" updated to ${status}`
    });

    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get all tasks (admin / manager)
exports.getAllTasks = async (req, res) => {
  try {
    const { status, employeeId, priority, department } = req.query;
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const userRole = (req.user?.role || '').toUpperCase();

    let filter = {};
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN' && rawOrgId) {
      const orgUsers = await User.find({ organizationId: rawOrgId }).select('_id');
      const orgEmpIds = orgUsers.map((u) => u._id);
      if (orgEmpIds.length > 0) {
        filter.$or = [{ organizationId: rawOrgId }, { employee: { $in: orgEmpIds } }];
      } else {
        filter.organizationId = rawOrgId;
      }
      if (userRole === 'MANAGER') {
        const mgrUsers = await User.find({
          organizationId: rawOrgId,
          $or: [{ manager: req.user._id }, { managerId: req.user._id }],
        }).select('_id');
        const assignedIds = mgrUsers.map((u) => u._id);
        filter.employee = { $in: assignedIds };
      }
    }

    if (status && status !== 'all') filter.status = status;
    if (employeeId && employeeId !== 'all') filter.employee = employeeId;
    if (priority && priority !== 'all') filter.priority = priority;

    let tasks = await Task.find(filter)
      .populate('employee', 'name employeeId department designation avatar role email')
      .populate('assignedBy', 'name role avatar')
      .sort({ createdAt: -1 });

    if (department && department !== 'all') {
      tasks = tasks.filter((t) => (t.employee?.department || '').toLowerCase() === department.toLowerCase());
    }

    res.json({ success: true, count: tasks.length, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update task (admin / manager)
exports.updateTask = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && task.organizationId && userOrgId !== task.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Task belongs to another organization.' });
      }
    }

    const updatedTask = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true })
      .populate('employee', 'name employeeId department designation avatar')
      .populate('assignedBy', 'name role avatar');

    res.json({ success: true, task: updatedTask });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete task
exports.deleteTask = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && task.organizationId && userOrgId !== task.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await Task.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Task deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
