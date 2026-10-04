// ─── Meeting Controller ───────────────────────────────────────────────────────
const { Meeting, Expense, Attendance, ActivityLog, Notification, LiveLocation, Lead, Leave, Task } = require('../models/index');
const User = require('../models/User.model');
const { liveCache } = require('../services/cache.service');

// Meeting CRUD
exports.createMeeting = async (req, res) => {
  try {
    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;
    const meeting = await Meeting.create({ ...req.body, organizationId: orgId, employee: req.user._id });
    await ActivityLog.create({ organizationId: orgId, employee: req.user._id, action: 'MEETING_CREATED', description: `Meeting with ${meeting.clientName}` });
    const io = req.app.get('io');
    io.to('admins').emit('new_meeting', { meeting, employeeName: req.user.name });
    res.status(201).json({ success: true, meeting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getMyMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, date } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;
    if (date) { const d = new Date(date); filter.date = { $gte: d, $lt: new Date(d.getTime() + 86400000) }; }
    const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, employee: req.user._id }, req.body, { new: true }
    );
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });
    res.json({ success: true, meeting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Expense Controller ───────────────────────────────────────────────────────
exports.createExpense = async (req, res) => {
  try {
    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;
    const expense = await Expense.create({ ...req.body, organizationId: orgId, employee: req.user._id });
    await ActivityLog.create({ organizationId: orgId, employee: req.user._id, action: 'EXPENSE_SUBMITTED', description: `₹${expense.amount} - ${expense.category}` });
    const io = req.app.get('io');
    io.to('admins').emit('new_expense', { expense, employeeName: req.user.name });
    res.status(201).json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getMyExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, category } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;
    if (category) filter.category = category;
    const expenses = await Expense.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Expense.countDocuments(filter);
    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Admin Controller ─────────────────────────────────────────────────────────

exports.getAllEmployees = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const orgObjId = rawOrgId
      ? (mongoose.Types.ObjectId.isValid(rawOrgId) ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId)
      : null;
    const { page = 1, limit = 50, search, department, isActive, role } = req.query;
    const filter = {};
    if (orgObjId) filter.organizationId = orgObjId;

    if (role === 'all' || !role) {
      filter.role = { $in: ['employee', 'EMPLOYEE', 'manager', 'MANAGER', 'FIELD_EXECUTIVE', 'field_executive', 'ORG_ADMIN', 'org_admin'], $nin: ['SUPER_ADMIN', 'super_admin', 'SUPERADMIN', 'superadmin'] };
    } else {
      filter.role = role;
    }
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { employeeId: { $regex: search, $options: 'i' } }];
    if (department) filter.department = department;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const employees = await User.find(filter)
      .populate('manager', 'name email department')
      .populate('managers', 'name email department')
      .sort({ isTracking: -1, isOnline: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);
    const total = await User.countDocuments(filter);
    res.json({ success: true, employees, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.approveEmployee = async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id);
    if (!targetUser) return res.status(404).json({ success: false, message: 'Employee not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && targetUser.organizationId && userOrgId !== targetUser.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Target employee belongs to another organization.' });
      }
    }

    targetUser.isApproved = true;
    await targetUser.save();

    const io = req.app.get('io');
    if (targetUser.socketId) io.to(targetUser.socketId).emit('account_approved', { message: 'Your account has been approved!' });
    res.json({ success: true, employee: targetUser });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.toggleBlock = async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && employee.organizationId && userOrgId !== employee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Target employee belongs to another organization.' });
      }
    }

    employee.isBlocked = !employee.isBlocked;
    if (employee.isBlocked) {
      employee.isActive = false;
      employee.isOnline = false;
      employee.isTracking = false;
    }
    await employee.save();
    res.json({ success: true, isBlocked: employee.isBlocked });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateEmployee = async (req, res) => {
  try {
    const oldEmployee = await User.findById(req.params.id);
    if (!oldEmployee) return res.status(404).json({ success: false, message: 'Employee not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && oldEmployee.organizationId && userOrgId !== oldEmployee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Target employee belongs to another organization.' });
      }
    }

    // Sanitize update body (prevent updating organizationId or escalating to SUPER_ADMIN)
    const updateData = { ...req.body };
    delete updateData.organizationId;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (updateData.role && ['SUPER_ADMIN', 'SUPERADMIN'].includes(updateData.role.toUpperCase())) {
        delete updateData.role;
      }
    }

    // Secure Password Hashing on Update
    if (updateData.password && String(updateData.password).trim() !== '') {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(12);
      updateData.password = await bcrypt.hash(String(updateData.password), salt);
    } else {
      delete updateData.password;
    }

    const employee = await User.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .select('-password')
      .populate('manager', 'name email department')
      .populate('managers', 'name email department');

    // Handle Manager Assignment Logic
    if (req.body.manager && (!oldEmployee.manager || oldEmployee.manager.toString() !== req.body.manager.toString())) {
      await User.findByIdAndUpdate(req.body.manager, {
        $addToSet: {
          assignedEmployees: {
            _id: employee._id,
            name: employee.name
          }
        }
      });
      await User.findByIdAndUpdate(employee._id, {
        $addToSet: { managers: req.body.manager }
      });
    }

    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getManagers = async (req, res) => {
  try {
    const orgFilter = req.user?.organizationId ? { organizationId: req.user.organizationId } : {};
    const managers = await User.find({ ...orgFilter, role: { $in: ['MANAGER', 'manager'] } })
      .select('-password')
      .lean();

    // Populate assigned employees dynamically from User model (supports Multi-Manager)
    const managersWithEmps = await Promise.all(
      managers.map(async (mgr) => {
        const directEmps = (mgr.assignedEmployees || []).map((e) => e._id || e);
        const assigned = await User.find({
          ...orgFilter,
          $or: [
            { manager: mgr._id },
            { managerId: mgr._id },
            { managers: mgr._id },
            { _id: { $in: directEmps } },
          ],
        }).select('_id name email phone employeeId department designation isActive isOnline isTracking avatar');

        return {
          ...mgr,
          assignedEmployees: assigned.length > 0 ? assigned : (mgr.assignedEmployees || []),
        };
      })
    );

    res.json({ success: true, managers: managersWithEmps });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createManager = async (req, res) => {
  try {
    const { name, email, password, phone, department, designation, salary } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User with this email already exists.' });
    }

    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;
    const userRole = (req.user?.role || '').toUpperCase();

    // Verify Active Subscription Plan and Quota
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      const Organization = require('../models/Organization.model');
      if (!orgId) {
        return res.status(403).json({ success: false, planRequired: true, message: 'No organization account found.' });
      }

      const org = await Organization.findById(orgId);
      if (!org || org.status !== 'active' || !org.plan?.expiresAt || new Date(org.plan.expiresAt) <= new Date()) {
        return res.status(402).json({
          success: false,
          planRequired: true,
          planExpired: true,
          message: 'Active subscription required. Please purchase or activate a plan in Billing to add managers.',
        });
      }

      let maxManagers = org.plan?.maxManagers || 3;
      const Plan = require('../models/Plan.model');
      const planNameOrId = org.plan?.planId || org.plan?.planName || '';
      const livePlan = await Plan.findOne({
        $or: [
          { planId: planNameOrId.toLowerCase() },
          { name: { $regex: new RegExp(planNameOrId, 'i') } },
          { planId: planNameOrId.toLowerCase().includes('starter') ? 'starter' : planNameOrId.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro' }
        ],
        isActive: true,
      });
      if (livePlan && livePlan.maxManagers) {
        maxManagers = livePlan.maxManagers;
      }

      const currentManagersCount = await User.countDocuments({
        organizationId: orgId,
        role: { $in: ['MANAGER', 'manager'] },
        isActive: true,
      });

      if (currentManagersCount >= maxManagers) {
        return res.status(403).json({
          success: false,
          limitReached: true,
          currentCount: currentManagersCount,
          maxLimit: maxManagers,
          message: `⚠️ Manager quota full! You have used ${currentManagersCount}/${maxManagers} manager seats in your current plan. Please upgrade your subscription plan in Billing to add more managers.`,
        });
      }
    }

    const employeeId = 'MGR' + Math.floor(1000 + Math.random() * 9000);

    const newManager = await User.create({
      organizationId: orgId,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: password || '111111',
      phone: phone || '',
      role: 'MANAGER',
      employeeId,
      department: department || 'Field Services',
      designation: designation || 'Area Manager',
      salary: salary ? Number(salary) : 25000,
      isActive: true,
      isBlocked: false,
    });

    res.status(201).json({
      success: true,
      message: 'Manager created successfully!',
      manager: newManager,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.approveExpense = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const expense = await Expense.findById(req.params.id).populate('employee', 'name socketId organizationId');
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    const expOrgId = expense.organizationId?.toString() || expense.employee?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && expOrgId && userOrgId !== expOrgId) {
        return res.status(403).json({ success: false, message: 'Access denied. Expense belongs to another organization.' });
      }
    }

    expense.status = status;
    expense.approvedBy = req.user._id;
    expense.approvedAt = new Date();
    if (rejectionReason) expense.rejectionReason = rejectionReason;
    await expense.save();
    
    const io = req.app.get('io');
    if (expense.employee && expense.employee.socketId) {
      io.to(expense.employee.socketId).emit('expense_status_update', { expenseId: expense._id, status });
    }
    res.json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, employeeId, status } = req.query;
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
    }

    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;

    const meetings = await Meeting.find(filter)
      .populate('employee', 'name employeeId department avatar')
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId, category } = req.query;
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const userRole = (req.user?.role || '').toUpperCase();

    let filter = {};
    let orgFilter = {};
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN' && rawOrgId) {
      orgFilter = { organizationId: rawOrgId };
      const orgUsers = await User.find({ organizationId: rawOrgId }).select('_id');
      const orgEmpIds = orgUsers.map((u) => u._id);
      if (orgEmpIds.length > 0) {
        filter.$or = [{ organizationId: rawOrgId }, { employee: { $in: orgEmpIds } }];
      } else {
        filter.organizationId = rawOrgId;
      }
    }

    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    if (category) filter.category = category;

    const [expenses, total, allOrgExpenses] = await Promise.all([
      Expense.find(filter)
        .populate('employee', 'name employeeId department designation avatar phone')
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(+limit),
      Expense.countDocuments(filter),
      Expense.find(filter).select('amount status')
    ]);

    const stats = {
      totalAmount: allOrgExpenses.reduce((acc, curr) => acc + (curr.amount || 0), 0),
      totalCount: allOrgExpenses.length,
      pendingCount: allOrgExpenses.filter(e => e.status === 'pending').length,
      pendingAmount: allOrgExpenses.filter(e => e.status === 'pending').reduce((acc, curr) => acc + (curr.amount || 0), 0),
      approvedCount: allOrgExpenses.filter(e => e.status === 'approved').length,
      approvedAmount: allOrgExpenses.filter(e => e.status === 'approved').reduce((acc, curr) => acc + (curr.amount || 0), 0),
      rejectedCount: allOrgExpenses.filter(e => e.status === 'rejected').length,
      rejectedAmount: allOrgExpenses.filter(e => e.status === 'rejected').reduce((acc, curr) => acc + (curr.amount || 0), 0)
    };

    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit), stats });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAttendanceReport = async (req, res) => {
  try {
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const { date, employeeId } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let orgEmpIds = [];
    if (rawOrgId) {
      const orgUsers = await User.find({ organizationId: rawOrgId }).select('_id');
      orgEmpIds = orgUsers.map((u) => u._id);
    }

    let filter = {};
    if (rawOrgId) {
      if (orgEmpIds.length > 0) {
        filter.$or = [{ organizationId: rawOrgId }, { employee: { $in: orgEmpIds } }];
      } else {
        filter.organizationId = rawOrgId;
      }
    }

    if (date) filter.date = date;
    if (employeeId) filter.employee = employeeId;

    const todayFilter = { ...filter, date: today };

    const [records, todayRecords, totalEmps] = await Promise.all([
      Attendance.find(filter)
        .populate('employee', 'name employeeId department avatar phone')
        .sort({ date: -1, createdAt: -1 }),
      Attendance.find(todayFilter),
      User.countDocuments(rawOrgId ? { organizationId: rawOrgId, role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] } } : { role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] } }),
    ]);

    const presentToday = todayRecords.filter((r) => r.status === 'present').length;
    const absentToday = Math.max(0, totalEmps - presentToday);
    const lateToday = todayRecords.filter((r) => r.status === 'half-day' || r.isLate).length;

    res.json({
      success: true,
      count: records.length,
      stats: {
        totalEmployees: totalEmps,
        presentToday,
        absentToday,
        lateToday,
        halfDayToday: todayRecords.filter((r) => r.status === 'half-day').length,
      },
      records,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.adjustTrackingDistance = async (req, res) => {
  try {
    const { sessionId, employeeId, date, distanceToAdd, newTotalDistance, mode = 'add', reason } = req.body;
    
    let session = null;
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    // 1. Flexible session locator (supports Mongo _id or custom sessionId string)
    if (sessionId) {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(sessionId)) {
        session = await LiveLocation.findById(sessionId);
      }
      if (!session) {
        session = await LiveLocation.findOne({ sessionId: sessionId });
      }
    } else if (employeeId && date) {
      session = await LiveLocation.findOne({ employee: employeeId, date: date }).sort({ createdAt: -1 });
      if (!session) {
        // Create manual credited tracking session for this employee & date
        const empUser = await User.findById(employeeId);
        if (!empUser) return res.status(404).json({ success: false, message: 'Employee not found' });
        
        session = new LiveLocation({
          organizationId: empUser.organizationId || userOrgId,
          employee: employeeId,
          sessionId: `manual_adj_${Date.now()}`,
          date: date,
          startTime: new Date(`${date}T09:00:00.000Z`),
          endTime: new Date(`${date}T18:00:00.000Z`),
          startAddress: 'Manual KM Credit (Admin Adjustment)',
          endAddress: 'Manual KM Credit (Admin Adjustment)',
          totalDistance: 0,
          officialDistance: 0,
          manualDistanceAdded: 0,
          isActive: false,
          coordinates: [],
        });
      }
    }

    if (!session) return res.status(404).json({ success: false, message: 'Tracking session or employee record not found' });

    // Multi-tenant authorization check
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && session.organizationId && userOrgId !== session.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    // 2. Strict Mathematical Bounds & Sanity Validation
    const previousDistance = Number(session.totalDistance) || 0;
    let finalDistance = previousDistance;
    let addedKm = 0;

    if (mode === 'set') {
      const parsedSet = Number(newTotalDistance);
      if (!Number.isFinite(parsedSet) || parsedSet < 0) {
        return res.status(400).json({ success: false, message: 'Please enter a valid non-negative KM value.' });
      }
      if (parsedSet > 1000) {
        return res.status(400).json({ success: false, message: 'Total distance cannot exceed 1,000 KM per shift.' });
      }
      finalDistance = parsedSet;
      addedKm = finalDistance - previousDistance;
    } else {
      const parsedAdd = Number(distanceToAdd);
      if (!Number.isFinite(parsedAdd) || parsedAdd < 0) {
        return res.status(400).json({ success: false, message: 'Please enter a valid KM number to add.' });
      }
      if (parsedAdd > 500) {
        return res.status(400).json({ success: false, message: 'Cannot add more than 500 KM in a single adjustment.' });
      }
      addedKm = parsedAdd;
      finalDistance = Math.max(0, previousDistance + addedKm);
      if (finalDistance > 1000) {
        return res.status(400).json({ success: false, message: 'Total accumulated distance exceeds safety limit (1,000 KM).' });
      }
    }

    session.totalDistance = Number(finalDistance.toFixed(2));
    session.officialDistance = Number(finalDistance.toFixed(2));
    session.manualDistanceAdded = Number(((session.manualDistanceAdded || 0) + addedKm).toFixed(2));
    session.manualAdjustmentReason = reason || 'Admin manual KM adjustment';
    
    await session.save();

    // 3. Reconcile Attendance day total
    try {
      const allDaySessions = await LiveLocation.find({
        employee: session.employee,
        date: session.date,
      });
      const dayTotalKm = allDaySessions.reduce((acc, s) => acc + (Number(s.totalDistance) || 0), 0);
      
      await Attendance.findOneAndUpdate(
        { employee: session.employee, date: session.date },
        { $set: { totalDistanceTraveled: Number(dayTotalKm.toFixed(2)) } }
      );
    } catch (attErr) {
      console.warn('Attendance distance sync warning:', attErr.message);
    }

    // 4. Audit Log for Full Regulatory Compliance & Anti-Fraud Traceability
    try {
      const AuditLog = require('../models/AuditLog.model');
      await AuditLog.create({
        organizationId: session.organizationId,
        actorUserId: req.user?._id,
        actorName: req.user?.name || req.user?.email || 'Admin',
        actorRole: userRole,
        action: 'ADJUST_DISTANCE',
        targetType: 'LiveLocation',
        targetId: session._id.toString(),
        resource: 'tracking',
        details: {
          employeeId: session.employee,
          sessionId: session.sessionId,
          date: session.date,
          previousDistance,
          finalDistance,
          addedKm,
          mode,
          reason: session.manualAdjustmentReason,
        },
      });
    } catch (logErr) {
      console.warn('AuditLog creation warning:', logErr.message);
    }

    // 5. Real-Time Socket Broadcast to Monitor Web & Mobile App
    try {
      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('distance_adjusted', {
          sessionId: session.sessionId,
          employeeId: session.employee,
          totalDistance: session.totalDistance,
          manualDistanceAdded: session.manualDistanceAdded,
          date: session.date,
        });
        io.to(`emp_${session.employee}`).emit('distance_adjusted', {
          sessionId: session.sessionId,
          totalDistance: session.totalDistance,
          manualDistanceAdded: session.manualDistanceAdded,
          date: session.date,
        });
      }
    } catch (_) {}

    const populatedSession = await LiveLocation.findById(session._id).populate('employee', 'name email employeeId avatar department designation TA DA');

    res.json({
      success: true,
      message: `Successfully adjusted distance to ${finalDistance.toFixed(2)} KM`,
      session: populatedSession,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getTrackingHistory = async (req, res) => {
  try {
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const userRole = (req.user?.role || '').toUpperCase();
    const { employeeId, date, startDate, endDate, page = 1, limit = 100 } = req.query;
    
    let filter = {};
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN' && rawOrgId) {
      const orgUsers = await User.find({ organizationId: rawOrgId }).select('_id');
      const orgEmpIds = orgUsers.map((u) => u._id);
      if (orgEmpIds.length > 0) {
        filter.$or = [{ organizationId: rawOrgId }, { employee: { $in: orgEmpIds } }];
      } else {
        filter.organizationId = rawOrgId;
      }
    }
    if (employeeId) filter.employee = employeeId;
    if (startDate && endDate) {
      filter.date = { $gte: startDate, $lte: endDate };
    } else if (date) {
      filter.date = date;
    }

    const history = await LiveLocation.find(filter, { 
      coordinates: { $slice: -1 }
    })
      .populate('employee', 'name employeeId department avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const total = await LiveLocation.countDocuments(filter);

    res.json({
      success: true,
      history,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete meeting
exports.deleteMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && meeting.organizationId && userOrgId !== meeting.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await Meeting.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Meeting deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// @desc Delete expense
exports.deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });

    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && expense.organizationId && userOrgId !== expense.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await Expense.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// @desc Get real dashboard analytics from MongoDB
exports.getDashboardStats = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;
    const orgObjId = rawOrgId
      ? (mongoose.Types.ObjectId.isValid(rawOrgId) ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId)
      : null;
    const today = new Date().toISOString().slice(0, 10);
    const orgFilter = orgObjId ? { organizationId: orgObjId } : {};

    let orgEmpIds = [];
    if (orgObjId) {
      const orgUsers = await User.find(orgFilter).select('_id');
      orgEmpIds = orgUsers.map((u) => u._id);
    }

    const relFilter = orgObjId
      ? (orgEmpIds.length > 0 ? { $or: [{ organizationId: orgObjId }, { employee: { $in: orgEmpIds } }] } : { organizationId: orgObjId })
      : {};

    const [
      totalEmployees,
      totalManagers,
      currentlyOnline,
      currentlyTracking,
      todayPresent,
      totalKmAggregation,
      leavesList,
      recentEmployeesList,
      recentLiveLocs,
      departmentsAgg,
    ] = await Promise.all([
      User.countDocuments({ ...orgFilter, role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] } }),
      User.countDocuments({ ...orgFilter, role: { $in: ['MANAGER', 'manager'] } }),
      User.countDocuments({ ...orgFilter, isOnline: true }),
      User.countDocuments({ ...orgFilter, isTracking: true }),
      Attendance.countDocuments({ ...relFilter, date: today, status: 'present' }),
      LiveLocation.aggregate([
        { $match: relFilter },
        { $group: { _id: null, totalKm: { $sum: '$totalDistance' } } },
      ]),
      Leave.find(relFilter).sort({ createdAt: -1 }).limit(5).populate('employee', 'name avatar department'),
      User.find({ ...orgFilter, role: { $in: ['EMPLOYEE', 'employee', 'MANAGER', 'manager'] } })
        .sort({ isTracking: -1, isOnline: -1, updatedAt: -1 })
        .limit(10)
        .populate('manager', 'name')
        .select('name avatar employeeId department manager isOnline isTracking lastSeen phone email role'),
      LiveLocation.find({ ...relFilter, isActive: true })
        .populate('employee', 'name employeeId department avatar')
        .sort({ updatedAt: -1 })
        .limit(6),
      User.aggregate([
        { $match: orgObjId ? { organizationId: orgObjId, role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] } } : { role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] } } },
        { $group: { _id: '$department', count: { $sum: 1 } } },
      ]),
    ]);

    const totalKm = totalKmAggregation[0]?.totalKm || 0;
    const absentToday = Math.max(0, totalEmployees - todayPresent);

    // Compute 7-day attendance trend
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentAttendance = await Attendance.find({
      ...relFilter,
      date: { $gte: sevenDaysAgo.toISOString().slice(0, 10) },
    });

    const attendanceTrendMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dStr = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      attendanceTrendMap[dStr] = { day: label, Present: 0, Absent: 0, Late: 0 };
    }

    recentAttendance.forEach((att) => {
      if (attendanceTrendMap[att.date]) {
        if (att.status === 'present') attendanceTrendMap[att.date].Present++;
        else if (att.status === 'absent') attendanceTrendMap[att.date].Absent++;
        else if (att.status === 'half-day') attendanceTrendMap[att.date].Late++;
      }
    });

    const attendanceOverview = Object.values(attendanceTrendMap);

    const deptColors = ['#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
    const departmentWise = departmentsAgg.map((d, idx) => ({
      name: d._id && d._id.trim() !== '' ? d._id : 'Field Operations',
      value: d.count,
      color: deptColors[idx % deptColors.length],
    }));

    // Fetch recent activity logs from DB
    const recentActivities = await ActivityLog.find(relFilter)
      .sort({ createdAt: -1 })
      .limit(6)
      .populate('employee', 'name department');

    res.json({
      success: true,
      stats: {
        totalEmployees: totalEmployees || 0,
        totalManagers: totalManagers || 0,
        presentToday: todayPresent || 0,
        absentToday: absentToday || 0,
        currentlyOnline: currentlyOnline || 0,
        currentlyTracking: currentlyTracking || 0,
        totalKm: parseFloat(totalKm.toFixed(2)),
      },
      attendanceOverview,
      departmentWise: departmentWise.length > 0 ? departmentWise : [{ name: 'Field Operations', value: totalEmployees || 1, color: '#3b82f6' }],
      recentEmployees: recentEmployeesList,
      upcomingLeaves: leavesList,
      liveLocations: recentLiveLocs,
      recentActivities: recentActivities.length > 0 ? recentActivities : [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get departments list with dynamic employee counts and manager details
exports.getDepartments = async (req, res) => {
  try {
    const Department = require('../models/Department.model');
    const orgFilter = req.user?.organizationId ? { organizationId: req.user.organizationId } : {};

    let depts = await Department.find(orgFilter).populate('manager', 'name email phone').lean();
    const userDepts = await User.distinct('department', orgFilter);
    const existingNames = new Set(depts.map((d) => d.name));

    for (const dName of userDepts) {
      if (dName && !existingNames.has(dName)) {
        const mgr = await User.findOne({ ...orgFilter, department: dName, role: { $in: ['MANAGER', 'manager'] } });
        let created;
        try {
          created = await Department.create({
            organizationId: req.user.organizationId,
            name: dName,
            description: `${dName} Division`,
            manager: mgr?._id || null,
            status: 'active',
          });
        } catch (_) {}
        depts.push({
          _id: created?._id || dName,
          name: dName,
          description: `${dName} Division`,
          manager: mgr ? { _id: mgr._id, name: mgr.name } : null,
          status: 'active',
        });
      }
    }

    const deptColors = ['#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
    const enriched = await Promise.all(
      depts.map(async (d, idx) => {
        const count = await User.countDocuments({ ...orgFilter, department: d.name });
        const mgr = d.manager?.name
          ? d.manager
          : await User.findOne({ ...orgFilter, department: d.name, role: { $in: ['MANAGER', 'manager'] } }).select('name email phone');
        return {
          _id: d._id,
          id: String(d._id),
          name: d.name,
          description: d.description || `${d.name} Operations`,
          iconColor: 'bg-blue-50 text-blue-600',
          color: deptColors[idx % deptColors.length],
          manager: mgr ? { name: mgr.name, title: `${d.name} Manager` } : null,
          teamCount: 1,
          empCount: count,
          status: d.status || 'Active',
        };
      })
    );

    res.json({ success: true, departments: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Create a new department
exports.createDepartment = async (req, res) => {
  try {
    const Department = require('../models/Department.model');
    const { name, description, managerId } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Department name is required' });

    const dept = await Department.create({
      organizationId: req.user.organizationId,
      name,
      description: description || '',
      manager: managerId || null,
      status: 'active',
    });

    res.status(201).json({ success: true, department: dept });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get teams list with dynamic manager & member details
exports.getTeams = async (req, res) => {
  try {
    const Team = require('../models/Team.model');
    const Department = require('../models/Department.model');
    const orgFilter = req.user?.organizationId ? { organizationId: req.user.organizationId } : {};

    let teams = await Team.find(orgFilter)
      .populate('manager', 'name email phone avatar')
      .populate('departmentId', 'name')
      .lean();

    // Auto-bootstrap default teams from managers if none exist
    if (teams.length === 0) {
      const managers = await User.find({ ...orgFilter, role: { $in: ['MANAGER', 'manager'] } });
      for (const mgr of managers) {
        const teamName = `${mgr.name}'s Field Squad`;
        const dept = await Department.findOne({ ...orgFilter, name: mgr.department });
        try {
          const created = await Team.create({
            organizationId: req.user.organizationId,
            departmentId: dept?._id || null,
            name: teamName,
            description: `Field operations squad led by ${mgr.name}`,
            manager: mgr._id,
            status: 'active',
          });
          const populated = await Team.findById(created._id)
            .populate('manager', 'name email phone avatar')
            .populate('departmentId', 'name')
            .lean();
          teams.push(populated);
        } catch (_) {}
      }
    }

    // Enrich teams with real live members count and member list
    const enriched = await Promise.all(
      teams.map(async (t) => {
        const mgrId = t.manager?._id || t.manager;
        const members = await User.find({
          ...orgFilter,
          role: { $in: ['EMPLOYEE', 'employee'] },
          $or: [
            { teamId: t._id },
            { teamName: t.name },
            ...(mgrId ? [{ manager: mgrId }, { managerId: mgrId }] : []),
          ],
        }).select('name email phone designation isOnline lastSeen employeeId avatar');

        const activeCount = members.filter((m) => m.isOnline).length;

        return {
          ...t,
          membersCount: members.length,
          activeCount,
          members,
        };
      })
    );

    res.json({ success: true, count: enriched.length, teams: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Create a new team
exports.createTeam = async (req, res) => {
  try {
    const Team = require('../models/Team.model');
    const { name, description, departmentId, managerId } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Team name is required' });

    const team = await Team.create({
      organizationId: req.user.organizationId,
      name,
      description: description || '',
      departmentId: departmentId || null,
      manager: managerId || null,
      status: 'active',
    });

    const populated = await Team.findById(team._id)
      .populate('manager', 'name email phone avatar')
      .populate('departmentId', 'name')
      .lean();

    res.status(201).json({ success: true, team: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get organization profile & settings
exports.getOrganizationSettings = async (req, res) => {
  try {
    const Organization = require('../models/Organization.model');
    const orgId = req.organizationId || req.user?.organizationId;
    if (!orgId) return res.status(404).json({ success: false, message: 'Organization not found' });
    const organization = await Organization.findById(orgId);
    if (!organization) return res.status(404).json({ success: false, message: 'Organization record not found' });
    res.json({ success: true, organization });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update organization profile & settings
exports.updateOrganizationSettings = async (req, res) => {
  try {
    const Organization = require('../models/Organization.model');
    const orgId = req.organizationId || req.user?.organizationId;
    if (!orgId) return res.status(404).json({ success: false, message: 'Organization not found' });
    const { name, phone, email, address, settings, logo } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (email) updateData.email = email;
    if (address) updateData.address = address;
    if (settings) updateData.settings = settings;
    if (logo !== undefined) updateData.logo = logo;

    const organization = await Organization.findByIdAndUpdate(
      orgId,
      { $set: updateData },
      { new: true }
    );
    res.json({ success: true, organization, message: 'Organization settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
