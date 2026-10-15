// ─── Meeting Controller ───────────────────────────────────────────────────────
const { Meeting, Expense, Attendance, ActivityLog, Notification, LiveLocation, Lead, Leave, Task } = require('../models/index');
const User = require('../models/User.model');
const { liveCache } = require('../services/cache.service');

// Meeting CRUD
exports.createMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.create({ ...req.body, employee: req.user._id });
    await ActivityLog.create({ employee: req.user._id, action: 'MEETING_CREATED', description: `Meeting with ${meeting.clientName}` });
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

exports.getAllMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, date, employeeId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    if (date) { const d = new Date(date); filter.date = { $gte: d, $lt: new Date(d.getTime() + 86400000) }; }
    const meetings = await Meeting.find(filter).populate('employee', 'name email employeeId').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findByIdAndDelete(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });
    res.json({ success: true, message: 'Meeting deleted successfully' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Expense Controller ───────────────────────────────────────────────────────
exports.createExpense = async (req, res) => {
  try {
    const expense = await Expense.create({ ...req.body, employee: req.user._id });
    await ActivityLog.create({ employee: req.user._id, action: 'EXPENSE_SUBMITTED', description: `₹${expense.amount} - ${expense.category}` });
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
exports.getDashboardStats = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const today = new Date().toISOString().slice(0, 10);
    const userFilter = isSuperAdmin ? {} : { organizationId: orgId };

    if (userRole === 'MANAGER') {
      let assignedIds = (req.user?.assignedEmployees || []).map(e => e?._id || e).filter(Boolean);
      if (assignedIds.length === 0) {
        const uDoc = await User.findById(req.user._id).select('assignedEmployees').lean();
        if (uDoc?.assignedEmployees?.length) {
          assignedIds = uDoc.assignedEmployees.map(e => e?._id || e).filter(Boolean);
        }
      }
      userFilter.$or = [
        { managerId: req.user._id },
        { manager: req.user._id },
        { _id: req.user._id },
        ...(assignedIds.length > 0 ? [{ _id: { $in: assignedIds } }] : [])
      ];
    }

    // Get list of matching employee IDs for scoped sub-queries
    const scopedEmployees = await User.find(userFilter).select('_id name department manager isTracking isOnline lastSeen employeeId avatar');
    const empIds = scopedEmployees.map(e => e._id);

    const [
      totalEmployees, totalManagers, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      totalExpenses, presentCount, lateCount, halfDayCount,
      totalKmData, totalLeads, totalLeaves, totalTasks,
      dbRecentEmployees, dbUpcomingLeaves, dbLiveLocations, dbRecentActivities
    ] = await Promise.all([
      User.countDocuments({ role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] }, isApproved: true, ...userFilter }),
      User.countDocuments({ role: { $in: ['MANAGER', 'manager'] }, isApproved: true, ...userFilter }),
      User.countDocuments({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, isOnline: true, ...userFilter }),
      User.countDocuments({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, isTracking: true, ...userFilter }),
      Meeting.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Meeting.countDocuments(isSuperAdmin ? { date: { $gte: new Date(today) } } : { employee: { $in: empIds }, date: { $gte: new Date(today) } }),
      Expense.countDocuments(isSuperAdmin ? { status: 'pending' } : { employee: { $in: empIds }, status: 'pending' }),
      Expense.aggregate([
        ...(isSuperAdmin ? [] : [{ $match: { employee: { $in: empIds } } }]),
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: { $in: ['present', 'late', 'half-day'] } } : { employee: { $in: empIds }, date: today, status: { $in: ['present', 'late', 'half-day'] } }),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: 'late' } : { employee: { $in: empIds }, date: today, status: 'late' }),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: 'half-day' } : { employee: { $in: empIds }, date: today, status: 'half-day' }),
      LiveLocation.aggregate([
        { $match: { date: today, ...(isSuperAdmin ? {} : { employee: { $in: empIds } }) } },
        { $group: { _id: null, total: { $sum: '$totalDistance' } } }
      ]),
      Lead.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Leave.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Task.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      User.find({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, ...userFilter })
        .populate('manager', 'name')
        .sort({ isTracking: -1, isOnline: -1, updatedAt: -1 })
        .limit(10)
        .lean(),
      Leave.find(isSuperAdmin ? { status: 'pending' } : { employee: { $in: empIds }, status: 'pending' })
        .populate('employee', 'name department')
        .sort({ startDate: 1 })
        .limit(5)
        .lean(),
      LiveLocation.find({ date: today, ...(isSuperAdmin ? {} : { employee: { $in: empIds } }) })
        .populate('employee', 'name department')
        .sort({ updatedAt: -1 })
        .limit(15)
        .lean(),
      ActivityLog.find(isSuperAdmin ? {} : { employee: { $in: empIds } })
        .populate('employee', 'name department')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const effectiveTotalEmployees = totalEmployees > 0 ? totalEmployees : scopedEmployees.length;
    const absentCount = Math.max(0, effectiveTotalEmployees - presentCount);
    const attendanceRate = effectiveTotalEmployees > 0 ? Math.round((presentCount / effectiveTotalEmployees) * 100) : 0;

    // Build 7-day attendance trend data for bar chart
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      last7Days.push({ dateStr, dayName });
    }

    const attendance7DaysRaw = await Attendance.find({
      date: { $in: last7Days.map(l => l.dateStr) },
      ...(isSuperAdmin ? {} : { employee: { $in: empIds } })
    }).lean();

    const attendanceOverview = last7Days.map(({ dateStr, dayName }) => {
      const dayRecords = attendance7DaysRaw.filter(a => a.date === dateStr);
      const Present = dayRecords.filter(a => a.status === 'present').length;
      const Absent = dayRecords.filter(a => a.status === 'absent').length;
      const Late = dayRecords.filter(a => a.status === 'late').length;
      return {
        date: dateStr,
        day: dayName,
        Present,
        Absent,
        Late: Late || 0,
      };
    });

    // Department-wise distribution
    const deptMap = {};
    scopedEmployees.forEach(e => {
      const dept = e.department || 'Field Services';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
    });
    const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
    const departmentWise = Object.keys(deptMap).map((name, idx) => ({
      name,
      count: deptMap[name],
      color: colors[idx % colors.length],
    }));

    const stats = {
      totalEmployees: effectiveTotalEmployees,
      totalManagers: totalManagers || 0,
      activeEmployees,
      currentlyOnline: activeEmployees,
      trackingNow,
      currentlyTracking: trackingNow,
      todayAttendance: presentCount,
      presentEmployees: presentCount,
      presentToday: presentCount,
      absentEmployees: absentCount,
      absentToday: absentCount,
      lateEmployees: lateCount,
      halfDayEmployees: halfDayCount,
      attendanceRate,
      totalMeetings,
      todayMeetings,
      pendingExpenses,
      totalExpenses: totalExpenses[0]?.total || 0,
      totalKm: totalKmData[0]?.total || 0,
      totalLeads: totalLeads || 0,
      totalLeaves: totalLeaves || 0,
      totalTasks: totalTasks || 0,
    };

    res.json({
      success: true,
      stats,
      attendanceOverview,
      departmentWise,
      recentEmployees: dbRecentEmployees,
      upcomingLeaves: dbUpcomingLeaves,
      liveLocations: dbLiveLocations,
      recentActivities: dbRecentActivities,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAllEmployees = async (req, res) => {
  try {
    const { page = 1, limit = 100, search, department, isActive, role } = req.query;
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const filter = {};
    if (!isSuperAdmin && orgId) {
      filter.organizationId = orgId;
    }

    if (userRole === 'MANAGER') {
      let assignedIds = (req.user?.assignedEmployees || []).map(e => e?._id || e).filter(Boolean);
      if (assignedIds.length === 0) {
        const uDoc = await User.findById(req.user._id).select('assignedEmployees').lean();
        if (uDoc?.assignedEmployees?.length) {
          assignedIds = uDoc.assignedEmployees.map(e => e?._id || e).filter(Boolean);
        }
      }
      filter.$or = [
        { managerId: req.user._id },
        { manager: req.user._id },
        { _id: req.user._id },
        ...(assignedIds.length > 0 ? [{ _id: { $in: assignedIds } }] : [])
      ];
    }

    if (role && role !== 'all') {
      filter.role = role;
    } else if (!isSuperAdmin) {
      filter.role = { $nin: ['super_admin', 'SUPER_ADMIN', 'org_admin', 'ORG_ADMIN'] };
    }

    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ name: searchRegex }, { email: searchRegex }, { employeeId: searchRegex }] }
        ];
        delete filter.$or;
      } else {
        filter.$or = [
          { name: searchRegex },
          { email: searchRegex },
          { employeeId: searchRegex },
        ];
      }
    }

    if (department) filter.department = department;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const employees = await User.find(filter)
      .populate('manager', 'name')
      .sort({ isTracking: -1, isOnline: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const total = await User.countDocuments(filter);

    // Enrich employees with today's real attendance distance and live location metrics
    const empIds = employees.map(e => e._id);
    const today = new Date().toISOString().slice(0, 10);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayAttendances, todayLiveLocations] = await Promise.all([
      Attendance.find({ 
        employee: { $in: empIds }, 
        $or: [{ date: today }, { createdAt: { $gte: startOfToday } }] 
      }).lean(),
      LiveLocation.find({ 
        employee: { $in: empIds }, 
        $or: [{ date: today }, { createdAt: { $gte: startOfToday } }, { isActive: true }] 
      }).lean()
    ]);

    const attMap = new Map();
    todayAttendances.forEach(a => {
      const empKey = String(a.employee);
      const existing = attMap.get(empKey);
      if (!existing || (a.totalDistanceTraveled || 0) > (existing.totalDistanceTraveled || 0)) {
        attMap.set(empKey, a);
      }
    });

    const empSessionsDistMap = new Map();
    const liveMap = new Map();

    todayLiveLocations.forEach(l => {
      const empKey = String(l.employee);
      const sessionDist = Number(l.totalDistance) || Number(l.officialDistance) || Number(l.acceptedDistance) || 0;
      empSessionsDistMap.set(empKey, (empSessionsDistMap.get(empKey) || 0) + sessionDist);

      const existing = liveMap.get(empKey);
      if (!existing || (l.isActive && !existing.isActive) || (new Date(l.updatedAt || 0) > new Date(existing.updatedAt || 0))) {
        liveMap.set(empKey, l);
      }
    });

    const enrichedEmployees = employees.map(e => {
      const empObj = e.toObject ? e.toObject() : { ...e };
      const empIdStr = String(empObj._id);
      const att = attMap.get(empIdStr);
      const live = liveMap.get(empIdStr);

      const isLive = live?.isActive === true || empObj.isTracking === true;
      const authoritativeKm = Number(live?.officialDistance) ||
        Number(live?.totalDistance) ||
        Number(att?.totalDistanceTraveled) ||
        (empSessionsDistMap.get(empIdStr) || 0);
      const todayKm = Math.round(authoritativeKm * 100) / 100;

      const lastPingTime = live?.lastActivity || live?.updatedAt || att?.checkIn || empObj.lastSeen || empObj.updatedAt;

      return {
        ...empObj,
        isTracking: isLive,
        isLive,
        totalDistance: todayKm,
        totalDistanceToday: todayKm,
        lastPing: lastPingTime,
        lastCheckIn: att?.checkIn || empObj.lastCheckIn,
        attendanceStatus: att?.status || (isLive ? 'present' : 'absent'),
        currentAddress: live?.currentAddress || live?.endAddress || live?.startAddress || empObj.address
      };
    });

    res.json({ success: true, employees: enrichedEmployees, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.approveEmployee = async (req, res) => {
  try {
    const employee = await User.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
    const io = req.app.get('io');
    if (employee.socketId) io.to(employee.socketId).emit('account_approved', { message: 'Your account has been approved!' });
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.toggleBlock = async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    employee.isBlocked = !employee.isBlocked;
    await employee.save();
    res.json({ success: true, isBlocked: employee.isBlocked });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateEmployee = async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (updateData.emp_profile_pic) {
      updateData.avatar = updateData.emp_profile_pic;
    } else if (updateData.managerPro_pic) {
      updateData.avatar = updateData.managerPro_pic;
    } else if (updateData.avatar) {
      updateData.emp_profile_pic = updateData.avatar;
      updateData.managerPro_pic = updateData.avatar;
    }
    const employee = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getManagers = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const filter = { role: { $in: ['manager', 'MANAGER'] } };
    if (!isSuperAdmin && orgId) {
      filter.organizationId = orgId;
    }

    const managers = await User.find(filter)
      .select('name email designation employeeId department role allocatedArea address isActive isOnline isTracking isApproved isBlocked salary TA assignedEmployees managers avatar')
      .sort({ name: 1 })
      .lean();

    // Dynamically enrich each manager with their real assigned employees from User collection
    const managerIds = managers.map(m => m._id);
    const allAssignedEmployees = await User.find({
      $or: [
        { manager: { $in: managerIds } },
        { managerId: { $in: managerIds } },
        { managers: { $in: managerIds } }
      ]
    }).select('_id name email department designation manager managerId managers isOnline isTracking avatar').lean();

    const enrichedManagers = managers.map(mgr => {
      const mgrIdStr = String(mgr._id);
      
      // Find all employees assigned to this manager
      const directEmps = allAssignedEmployees.filter(e => {
        const eMgr = String(e.manager || e.managerId || '');
        const eMgrs = (e.managers || []).map(m => String(m));
        return eMgr === mgrIdStr || eMgrs.includes(mgrIdStr);
      });

      // Merge stored assignedEmployees with direct DB assigned employees
      const storedAssigned = Array.isArray(mgr.assignedEmployees) ? mgr.assignedEmployees : [];
      const combinedMap = new Map();

      directEmps.forEach(e => {
        combinedMap.set(String(e._id), {
          _id: e._id,
          name: e.name,
          email: e.email,
          department: e.department || 'Field Services',
          designation: e.designation || 'Field Executive',
          isOnline: e.isOnline,
          isTracking: e.isTracking,
          avatar: e.avatar,
        });
      });

      storedAssigned.forEach(e => {
        const id = String(e._id || e);
        if (!combinedMap.has(id)) {
          combinedMap.set(id, e);
        }
      });

      return {
        ...mgr,
        assignedEmployees: Array.from(combinedMap.values()),
      };
    });

    res.json({ success: true, managers: enrichedManagers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Helper to scope employee IDs by tenant and role
const getScopedEmployeeIds = async (user) => {
  const userRole = (user?.role || '').toUpperCase();
  if (['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) return null;

  const orgId = user?.organizationId?._id || user?.organizationId;
  const userScope = { organizationId: orgId };
  if (userRole === 'MANAGER') {
    let assignedIds = (user?.assignedEmployees || []).map(e => e?._id || e).filter(Boolean);
    if (assignedIds.length === 0) {
      const uDoc = await User.findById(user._id).select('assignedEmployees').lean();
      if (uDoc?.assignedEmployees?.length) {
        assignedIds = uDoc.assignedEmployees.map(e => e?._id || e).filter(Boolean);
      }
    }
    userScope.$or = [
      { managerId: user._id },
      { manager: user._id },
      { _id: user._id },
      ...(assignedIds.length > 0 ? [{ _id: { $in: assignedIds } }] : [])
    ];
  } else if (userRole === 'EMPLOYEE') {
    userScope._id = user._id;
  }

  const scopedUsers = await User.find(userScope).select('_id');
  return scopedUsers.map(u => u._id);
};

exports.approveExpense = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const expense = await Expense.findByIdAndUpdate(req.params.id, {
      status, approvedBy: req.user._id, approvedAt: new Date(),
      ...(rejectionReason && { rejectionReason })
    }, { new: true }).populate('employee', 'name socketId');
    
    const io = req.app.get('io');
    if (expense?.employee?.socketId) {
      io.to(expense.employee.socketId).emit('expense_status_update', { expenseId: expense._id, status });
    }
    res.json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, employeeId, status } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, meetings: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (status) filter.status = status;
    const meetings = await Meeting.find(filter).populate('employee', 'name employeeId department').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId, category } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, expenses: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (status) filter.status = status;
    if (category) filter.category = category;
    const expenses = await Expense.find(filter).populate('employee', 'name employeeId department').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Expense.countDocuments(filter);
    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAttendanceReport = async (req, res) => {
  try {
    const { date, employeeId } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, records: [] });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (date) filter.date = date;
    const records = await Attendance.find(filter).populate('employee', 'name employeeId department').sort({ date: -1 });
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getTrackingHistory = async (req, res) => {
  try {
    const { employeeId, date, startDate, endDate, page = 1, limit = 100 } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, history: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (startDate && endDate) {
      if (startDate === endDate) {
        filter.$or = [{ date: startDate }, { isActive: true }];
      } else {
        filter.$or = [{ date: { $gte: startDate, $lte: endDate } }, { isActive: true }];
      }
    } else if (date) {
      filter.$or = [{ date: date }, { isActive: true }];
    }

    const trackingController = require('./tracking.controller');
    const history = await LiveLocation.find(filter, { 
      coordinates: { $slice: -1 }
    })
      .populate('employee', 'name employeeId department avatar')
      .sort({ isActive: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const targetDateStr = date || startDate || new Date().toISOString().slice(0, 10);
    const startOfTarget = new Date(`${targetDateStr}T00:00:00.000Z`);
    const endOfTarget = new Date(`${targetDateStr}T23:59:59.999Z`);

    // Derive authoritative distance strictly from DistanceLedger for every history session
    const { DistanceLedger } = require('../models/index');
    const sanitizedHistory = await Promise.all((history || []).map(async (doc) => {
      const s = doc.toObject ? doc.toObject() : { ...doc };

      const ledgerAgg = await DistanceLedger.aggregate([
        {
          $match: {
            sessionId: s.sessionId,
            classification: 'ACCEPTED'
          }
        },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      if (s.manualAdjustmentReason) {
        // If an explicit manual admin adjustment was performed, the session's totalDistance is authoritative
        s.totalDistance = Number(s.totalDistance || s.officialDistance || 0);
        s.officialDistance = Number(s.officialDistance || s.totalDistance || 0);
      } else if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        const verifiedKm = Math.round(ledgerAgg[0].totalKm * 100) / 100;
        const manualAdded = Number(s.manualDistanceAdded || 0);
        const finalKm = Math.round((verifiedKm + manualAdded) * 100) / 100;
        const cleanSessionDist = finalKm > 0 ? finalKm : Number(s.totalDistance || 0);
        s.totalDistance = cleanSessionDist;
        s.officialDistance = cleanSessionDist;
      } else if (Number(s.manualDistanceAdded || 0) > 0 || Number(s.totalDistance || 0) > 0) {
        // Keep existing totalDistance / officialDistance when manual credit exists or when distance is set
        s.totalDistance = Number(s.totalDistance || s.officialDistance || 0);
        s.officialDistance = Number(s.officialDistance || s.totalDistance || 0);
      } else if ((!s.totalDistance || s.totalDistance === 0) && Array.isArray(s.coordinates) && s.coordinates.length >= 2) {
        try {
          const recalculated = await trackingController.recalculateSessionFromPoints(s.sessionId, s.date, s._id);
          if (recalculated > 0) {
            s.totalDistance = recalculated;
            s.officialDistance = recalculated;
          }
        } catch (_) {}
      }

      return s;
    }));

    const total = await LiveLocation.countDocuments(filter);

    res.json({
      success: true,
      history: sanitizedHistory,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get organization profile & settings
exports.getOrganizationSettings = async (req, res) => {
  try {
    const Organization = require('../models/Organization.model');
    let orgId = req.organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    let organization = null;
    if (orgId) {
      organization = await Organization.findById(orgId);
    }
    if (!organization) {
      organization = await Organization.findOne();
    }
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
    let orgId = req.organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    if (!orgId) {
      const existing = await Organization.findOne();
      if (existing) orgId = existing._id;
    }
    if (!orgId) return res.status(404).json({ success: false, message: 'Organization record not found' });
    const { name, phone, email, address, settings, logo, Org_logo, companyLogo } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (email) updateData.email = email;
    if (address) updateData.address = address;
    if (settings) updateData.settings = settings;

    const chosenLogo = Org_logo !== undefined ? Org_logo : (companyLogo !== undefined ? companyLogo : logo);
    if (chosenLogo !== undefined) {
      updateData.logo = chosenLogo;
      updateData.Org_logo = chosenLogo;
      updateData.companyLogo = chosenLogo;
    }

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

// @desc Admin KM distance adjustment & credit
exports.adjustDistance = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const { LiveLocation, Attendance, ActivityLog } = require('../models/index');
    const User = require('../models/User.model');

    const { sessionId, employeeId, date, adjustmentKm, distanceToAdd, newTotalDistance, km, mode = 'add', reason } = req.body;
    const kmValue = parseFloat(adjustmentKm ?? distanceToAdd ?? newTotalDistance ?? km);

    if (isNaN(kmValue) || kmValue < 0) {
      return res.status(400).json({ success: false, message: 'Please provide a valid non-negative distance in KM' });
    }

    if (!employeeId && !sessionId) {
      return res.status(400).json({ success: false, message: 'Employee ID or Session ID is required for distance adjustment' });
    }

    let session = null;

    if (sessionId) {
      const isValidId = mongoose.Types.ObjectId.isValid(sessionId);
      session = await LiveLocation.findOne({
        $or: [
          ...(isValidId ? [{ _id: sessionId }] : []),
          { sessionId: sessionId }
        ]
      });
    }

    const targetEmpId = session?.employee || employeeId;
    const targetDate = date || session?.date || new Date().toISOString().slice(0, 10);

    if (!session && targetEmpId) {
      session = await LiveLocation.findOne({ employee: targetEmpId, date: targetDate }).sort({ updatedAt: -1 });
    }

    if (!session && targetEmpId) {
      const newSessionId = `MANUAL-${targetEmpId}-${Date.now()}`;
      const empUser = await User.findById(targetEmpId);
      session = new LiveLocation({
        organizationId: empUser?.organizationId || req.user?.organizationId,
        employee: targetEmpId,
        sessionId: newSessionId,
        date: targetDate,
        startTime: new Date(),
        isActive: false,
        totalDistance: 0,
        officialDistance: 0,
        acceptedDistance: 0,
      });
    }

    if (!session) {
      return res.status(404).json({ success: false, message: 'Could not find or create a tracking session for this employee' });
    }

    const currentDist = Number(session.totalDistance || session.officialDistance || 0);
    let newTotalDist = 0;
    let deltaKm = 0;

    if (mode === 'deduct' || mode === 'subtract') {
      newTotalDist = Math.max(0, Math.round((currentDist - kmValue) * 100) / 100);
      deltaKm = -(currentDist - newTotalDist);
    } else if (mode === 'set') {
      newTotalDist = Math.max(0, Math.round(kmValue * 100) / 100);
      deltaKm = newTotalDist - currentDist;
    } else {
      // mode === 'add' (default)
      newTotalDist = Math.round((currentDist + kmValue) * 100) / 100;
      deltaKm = kmValue;
    }

    session.totalDistance = newTotalDist;
    session.officialDistance = newTotalDist;
    session.acceptedDistance = newTotalDist;
    session.manualDistanceAdded = Math.max(0, (session.manualDistanceAdded || 0) + deltaKm);
    if (reason) session.manualAdjustmentReason = reason;
    await session.save();

    // Update or sync Attendance record for this employee and date (upsert if needed)
    await Attendance.findOneAndUpdate(
      { employee: targetEmpId, date: targetDate },
      {
        $set: {
          totalDistanceTraveled: newTotalDist,
          officialDistance: newTotalDist,
        },
        $setOnInsert: {
          organizationId: session.organizationId || req.user?.organizationId,
          status: 'present',
        }
      },
      { upsert: true, new: true }
    ).catch(() => {});

    // Update User model directly so employee profile & DB reflect adjusted distance
    await User.findByIdAndUpdate(targetEmpId, {
      $set: {
        totalDistance: newTotalDist,
        totalDistanceTraveled: newTotalDist,
      }
    }).catch(() => {});

    // Record manual adjustment entry in DistanceLedger as ACCEPTED segment so DistanceLedger aggregations reflect this KM
    try {
      const { DistanceLedger } = require('../models/index');
      const now = new Date();
      await DistanceLedger.create({
        organizationId: session.organizationId || req.user?.organizationId,
        employee: targetEmpId,
        sessionId: session.sessionId,
        fromEventId: `ADJUST_FROM_${Date.now()}`,
        toEventId: `ADJUST_TO_${Date.now()}`,
        fromTimestamp: now,
        toTimestamp: now,
        fromLat: session.coordinates?.[session.coordinates.length - 1]?.lat || 0,
        fromLng: session.coordinates?.[session.coordinates.length - 1]?.lng || 0,
        toLat: session.coordinates?.[session.coordinates.length - 1]?.lat || 0,
        toLng: session.coordinates?.[session.coordinates.length - 1]?.lng || 0,
        distanceMeters: Math.round(deltaKm * 1000),
        distanceKm: Math.round(deltaKm * 100) / 100,
        classification: 'ACCEPTED',
        reason: reason || 'MANUAL_ADMIN_ADJUSTMENT',
      });
    } catch (ledgerErr) {
      console.warn('Could not create DistanceLedger record for adjustment:', ledgerErr.message);
    }

    // Create ActivityLog entry
    const empUser = await User.findById(targetEmpId).select('name');
    await ActivityLog.create({
      organizationId: session.organizationId || req.user?.organizationId,
      employee: req.user._id,
      action: 'KM_ADJUSTMENT',
      description: `Adjusted distance for ${empUser?.name || 'Employee'}: set to ${newTotalDist} KM (${mode === 'add' ? '+' : ''}${kmValue} KM). Reason: ${reason || 'Admin credit'}`
    }).catch(() => {});

    // Clear live cache so dashboard reflects new KM instantly
    const cacheKey = `admin_dashboard_stats_${req.user?.organizationId?._id || req.user?.organizationId || 'super'}`;
    if (liveCache?.del) {
      await liveCache.del(cacheKey).catch(() => {});
    }

    res.json({
      success: true,
      message: `Successfully adjusted distance for ${empUser?.name || 'Employee'} to ${newTotalDist} KM`,
      session,
      newDistance: newTotalDist,
    });
  } catch (err) {
    console.error('adjustDistance error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to adjust distance' });
  }
};


