const express = require('express');
const router = express.Router();
const { authenticate, resolveTenant, checkRole, checkQuota, requireActivePlan } = require('../middleware/tenantMiddleware');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const {
  LiveLocation,
  Meeting,
  Expense,
  Attendance,
  ActivityLog,
  Notification,
  Leave,
  Task,
  Lead,
  TravelLog,
} = require('../models/index');

// List Employees for the Organization (or assigned to Manager)
router.get('/', authenticate, resolveTenant, async (req, res) => {
  try {
    let query = {};

    // Multi-tenant Isolation
    if (req.user.role !== 'SUPER_ADMIN') {
      query.organizationId = req.organizationId;
    }

    // Always exclude Super Admin accounts from regular employee lists
    query.role = { $nin: ['SUPER_ADMIN', 'super_admin', 'SUPERADMIN', 'superadmin'] };

    // Role-based scope restriction
    const isManager = ['MANAGER', 'manager'].includes(req.user.role);
    if (isManager) {
      query.$or = [{ manager: req.user._id }, { managerId: req.user._id }];
    }

    // Filters
    if (req.query.role) query.role = { $regex: new RegExp(`^${req.query.role}$`, 'i'), $nin: ['SUPER_ADMIN', 'super_admin', 'SUPERADMIN', 'superadmin'] };
    if (req.query.department) query.department = req.query.department;
    if (req.query.managerId) query.$or = [{ manager: req.query.managerId }, { managerId: req.query.managerId }];
    if (req.query.status) query.isActive = req.query.status === 'active';
    if (req.query.search) {
      query.$and = [
        {
          $or: [
            { name: { $regex: req.query.search, $options: 'i' } },
            { email: { $regex: req.query.search, $options: 'i' } },
            { phone: { $regex: req.query.search, $options: 'i' } },
            { employeeId: { $regex: req.query.search, $options: 'i' } },
          ],
        },
      ];
    }

    const employees = await User.find(query)
      .select('-password')
      .populate('manager', 'name email phone')
      .populate('managerId', 'name email phone')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: employees.length, employees });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get Single Employee Details & Stats
router.get('/:id', authenticate, resolveTenant, async (req, res) => {
  try {
    const employee = await User.findById(req.params.id)
      .select('-password')
      .populate('manager', 'name email phone department')
      .populate('managerId', 'name email phone department');

    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    // Verify Tenant Isolation
    if (req.user.role !== 'SUPER_ADMIN' && String(employee.organizationId) !== String(req.organizationId)) {
      return res.status(403).json({ success: false, message: 'Access denied to this employee record.' });
    }

    // Aggregate Employee specific stats
    const [trackingStats, attendanceCount, meetingsCount, expensesCount, tasksCount, leavesCount] = await Promise.all([
      LiveLocation.aggregate([
        { $match: { employee: employee._id } },
        { $group: { _id: null, totalKm: { $sum: '$totalDistance' }, sessionsCount: { $sum: 1 } } },
      ]),
      Attendance.countDocuments({ employee: employee._id }),
      Meeting.countDocuments({ employee: employee._id }),
      Expense.countDocuments({ employee: employee._id }),
      Task.countDocuments({ $or: [{ employeeId: employee._id }, { employee: employee._id }, { assignedTo: employee._id }] }),
      Leave.countDocuments({ employee: employee._id }),
    ]);

    const stats = {
      totalKm: trackingStats[0]?.totalKm ? parseFloat(trackingStats[0].totalKm.toFixed(2)) : 0,
      totalSessions: trackingStats[0]?.sessionsCount || 0,
      totalAttendance: attendanceCount,
      totalMeetings: meetingsCount,
      totalExpenses: expensesCount,
      totalTasks: tasksCount,
      totalLeaves: leavesCount,
    };

    res.json({ success: true, employee, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create Employee Account (with SaaS Quota Check and Active Plan Check)
router.post('/', authenticate, resolveTenant, checkRole('ORG_ADMIN', 'ADMIN', 'HR'), requireActivePlan, checkQuota('EMPLOYEE'), async (req, res) => {
  try {
    const { name, email, password, phone, role, department, designation, managerId, salary, TA, DA, allocatedArea } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User with this email already exists.' });
    }

    const employeeId = 'EMP' + Math.floor(1000 + Math.random() * 9000);

    const newUser = await User.create({
      organizationId: req.organizationId,
      name,
      email,
      password: password || 'Welcome@123',
      phone,
      role: role || 'EMPLOYEE',
      employeeId,
      department: department || 'General',
      designation: designation || 'Field Staff',
      manager: managerId || null,
      managerId: managerId || null,
      salary: salary || 12000,
      TA: TA || 2.5,
      DA: DA || 0,
      allocatedArea: allocatedArea || 'Default Zone',
      isActive: true,
    });

    if (managerId) {
      await User.findByIdAndUpdate(managerId, {
        $addToSet: { assignedEmployees: { _id: newUser._id, name: newUser.name } },
      });
    }

    res.status(201).json({
      success: true,
      message: 'Employee created successfully!',
      employee: newUser,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update Employee Details & Manager Assignment
router.put('/:id', authenticate, resolveTenant, checkRole('ORG_ADMIN', 'ADMIN', 'HR'), requireActivePlan, async (req, res) => {
  try {
    const oldEmployee = await User.findById(req.params.id);
    if (!oldEmployee) return res.status(404).json({ success: false, message: 'Employee not found' });

    if (req.user.role !== 'SUPER_ADMIN' && String(oldEmployee.organizationId) !== String(req.organizationId)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const newManagerId = req.body.managerId || req.body.manager;
    if (newManagerId !== undefined) {
      req.body.manager = newManagerId || null;
      req.body.managerId = newManagerId || null;
    }

    const updatedEmployee = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');

    // Handle Manager Assignment/Removal
    if (newManagerId && (!oldEmployee.manager || String(oldEmployee.manager) !== String(newManagerId))) {
      await User.findByIdAndUpdate(newManagerId, {
        $addToSet: { assignedEmployees: { _id: updatedEmployee._id, name: updatedEmployee.name } },
      });
      if (oldEmployee.manager) {
        await User.findByIdAndUpdate(oldEmployee.manager, {
          $pull: { assignedEmployees: { _id: updatedEmployee._id } },
        });
      }
    } else if (newManagerId === null || newManagerId === '') {
      if (oldEmployee.manager) {
        await User.findByIdAndUpdate(oldEmployee.manager, {
          $pull: { assignedEmployees: { _id: updatedEmployee._id } },
        });
      }
    }

    res.json({ success: true, message: 'Employee updated successfully!', employee: updatedEmployee });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Bulk Assign Employees to Manager
router.post('/assign-manager', authenticate, resolveTenant, checkRole('ORG_ADMIN', 'ADMIN', 'HR'), requireActivePlan, async (req, res) => {
  try {
    const { employeeIds, managerId } = req.body;

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one employee.' });
    }

    const manager = await User.findById(managerId);
    if (!manager) return res.status(404).json({ success: false, message: 'Manager not found.' });

    // Update employees
    await User.updateMany(
      { _id: { $in: employeeIds }, organizationId: req.organizationId },
      { manager: managerId, managerId: managerId, managerName: manager.name }
    );

    // Update manager's assignedEmployees list
    const employees = await User.find({ _id: { $in: employeeIds } }).select('_id name');
    const assignedObjects = employees.map((e) => ({ _id: e._id, name: e.name }));

    await User.findByIdAndUpdate(managerId, {
      $addToSet: { assignedEmployees: { $each: assignedObjects } },
    });

    res.json({
      success: true,
      message: `Successfully assigned ${employeeIds.length} employee(s) to Manager ${manager.name}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle Block / Unblock Employee
router.put('/:id/block', authenticate, resolveTenant, checkRole('ORG_ADMIN', 'ADMIN'), requireActivePlan, async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    if (req.user.role !== 'SUPER_ADMIN' && String(employee.organizationId) !== String(req.organizationId)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    employee.isBlocked = !employee.isBlocked;
    if (employee.isBlocked) {
      employee.isActive = false;
      employee.isOnline = false;
      employee.isTracking = false;
    } else {
      employee.isActive = true;
    }

    await employee.save();

    await AuditLog.create({
      organizationId: req.organizationId,
      userId: req.user._id,
      userRole: req.user.role,
      action: employee.isBlocked ? 'EMPLOYEE_BLOCKED' : 'EMPLOYEE_UNBLOCKED',
      resource: 'Employee',
      resourceId: employee._id,
      details: { employeeName: employee.name, isBlocked: employee.isBlocked },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: employee.isBlocked ? `Employee ${employee.name} has been BLOCKED.` : `Employee ${employee.name} has been UNBLOCKED.`,
      isBlocked: employee.isBlocked,
      isActive: employee.isActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Permanent Cascade Delete Employee & All Associated Records
router.delete('/:id', authenticate, resolveTenant, checkRole('ORG_ADMIN', 'ADMIN', 'SUPER_ADMIN'), requireActivePlan, async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    if (req.user.role !== 'SUPER_ADMIN' && String(employee.organizationId) !== String(req.organizationId)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const empId = employee._id;

    // 1. Cascade delete all operational records belonging to this employee
    const [delLoc, delAtt, delMeet, delExp, delTasks, delLeaves, delAct, delNotif, delTrav] = await Promise.all([
      LiveLocation.deleteMany({ employee: empId }),
      Attendance.deleteMany({ employee: empId }),
      Meeting.deleteMany({ employee: empId }),
      Expense.deleteMany({ employee: empId }),
      Task.deleteMany({ $or: [{ employeeId: empId }, { employee: empId }, { assignedTo: empId }] }),
      Leave.deleteMany({ employee: empId }),
      ActivityLog.deleteMany({ employee: empId }),
      Notification.deleteMany({ employee: empId }),
      TravelLog.deleteMany({ employee: empId }),
    ]);

    // 2. Unassign from Leads
    await Lead.updateMany({ assignedTo: empId }, { $unset: { assignedTo: 1 } });

    // 3. Clean up Manager references
    if (employee.manager) {
      await User.findByIdAndUpdate(employee.manager, {
        $pull: { assignedEmployees: { _id: empId } },
      });
    }

    // 4. If this user was a manager, unset manager from their assigned subordinates
    await User.updateMany(
      { $or: [{ manager: empId }, { managerId: empId }] },
      { $unset: { manager: 1, managerId: 1, managerName: 1 } }
    );

    // 5. Delete the User record itself
    await User.findByIdAndDelete(empId);

    // 6. Log in AuditLog
    await AuditLog.create({
      organizationId: req.organizationId,
      userId: req.user._id,
      userRole: req.user.role,
      action: 'EMPLOYEE_DELETED',
      resource: 'Employee',
      resourceId: empId,
      details: {
        employeeName: employee.name,
        employeeEmail: employee.email,
        deletedRecords: {
          trackingSessions: delLoc.deletedCount,
          attendances: delAtt.deletedCount,
          meetings: delMeet.deletedCount,
          expenses: delExp.deletedCount,
          tasks: delTasks.deletedCount,
          leaves: delLeaves.deletedCount,
        },
      },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: `Employee "${employee.name}" and all associated data permanently deleted.`,
      deletedCount: {
        trackingSessions: delLoc.deletedCount,
        attendances: delAtt.deletedCount,
        meetings: delMeet.deletedCount,
        expenses: delExp.deletedCount,
        tasks: delTasks.deletedCount,
        leaves: delLeaves.deletedCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
