const { Meeting, Expense, Task, LiveLocation, Lead, Attendance } = require('../models/index');
const User = require('../models/User.model');

exports.getConsolidatedReport = async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    // Normalize date inputs
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();
    if (end) end.setHours(23, 59, 59, 999); // Make end date inclusive
    const startStr = start ? start.toISOString().slice(0, 10) : null;
    const endStr = end ? end.toISOString().slice(0, 10) : null;

    // Build resilient date filters for various document schema field formats
    const dateRangeFilter = start ? {
      $or: [
        { date: { $gte: start, $lte: end } },
        { date: { $gte: startStr, $lte: endStr } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    } : {};

    const stringDateFilter = startStr ? {
      $or: [
        { date: { $gte: startStr, $lte: endStr } },
        { date: { $gte: start, $lte: end } },
        { startTime: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    } : {};

    const [employee, meetings, expenses, tasks, leads, locations, attendances] = await Promise.all([
      User.findById(employeeId).select('name employeeId department designation phone salary TA DA allocatedArea daHistory avatar email organizationId'),
      Meeting.find({ 
        employee: employeeId, 
        ...dateRangeFilter 
      }).sort({ date: -1, createdAt: -1 }),
      Expense.find({ 
        employee: employeeId, 
        ...dateRangeFilter 
      }).sort({ date: -1, createdAt: -1 }),
      Task.find({ 
        $or: [{ employee: employeeId }, { employeeId: employeeId }, { assignedTo: employeeId }], 
        ...(start ? {
          $or: [
            { dueDate: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } }
          ]
        } : {}) 
      }).sort({ dueDate: -1, createdAt: -1 }),
      Lead.find({ 
        assignedTo: employeeId, 
        ...(start ? { createdAt: { $gte: start, $lte: end } } : {}) 
      }).sort({ createdAt: -1 }),
      LiveLocation.find({ 
        employee: employeeId, 
        ...stringDateFilter 
      }).sort({ date: -1, startTime: -1 }),
      Attendance.find({
        employee: employeeId,
        ...stringDateFilter
      }).sort({ date: -1 })
    ]);

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const taRate = Number(employee?.TA) || 2.5;
    const daRate = Number(employee?.DA) || 0;
    const monthlySalary = Number(employee?.salary) || 12000;

    // ── Group LiveLocation Sessions by Date (Daily Aggregation) ─────────────
    const dailyDistanceMap = {};

    locations.forEach((loc) => {
      let dateKey = loc.date;
      if (!dateKey && loc.startTime) {
        dateKey = new Date(loc.startTime).toISOString().slice(0, 10);
      }
      if (!dateKey) {
        dateKey = new Date().toISOString().slice(0, 10);
      }

      if (!dailyDistanceMap[dateKey]) {
        dailyDistanceMap[dateKey] = {
          date: dateKey,
          totalDistance: 0,
          sessionsCount: 0,
          manualDistanceAdded: 0,
          startAddress: loc.startAddress || '',
          endAddress: loc.endAddress || '',
          firstStartTime: loc.startTime,
          lastEndTime: loc.endTime,
          sessions: [],
        };
      }

      const dist = Number(loc.totalDistance) || 0;
      dailyDistanceMap[dateKey].totalDistance += dist;
      dailyDistanceMap[dateKey].manualDistanceAdded += (Number(loc.manualDistanceAdded) || 0);
      dailyDistanceMap[dateKey].sessionsCount += 1;

      if (!dailyDistanceMap[dateKey].startAddress && loc.startAddress) {
        dailyDistanceMap[dateKey].startAddress = loc.startAddress;
      }
      if (loc.endAddress) {
        dailyDistanceMap[dateKey].endAddress = loc.endAddress;
      }
      if (loc.endTime) {
        dailyDistanceMap[dateKey].lastEndTime = loc.endTime;
      }

      dailyDistanceMap[dateKey].sessions.push({
        _id: loc._id,
        sessionId: loc.sessionId,
        distance: parseFloat(dist.toFixed(2)),
        startTime: loc.startTime,
        endTime: loc.endTime,
        startAddress: loc.startAddress || '',
        endAddress: loc.endAddress || '',
        isActive: loc.isActive,
      });
    });

    const dailyDistances = Object.values(dailyDistanceMap)
      .map((item) => ({
        ...item,
        totalDistance: parseFloat(item.totalDistance.toFixed(2)),
        travelPay: parseFloat((item.totalDistance * taRate).toFixed(2)),
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalKm = parseFloat(locations.reduce((a, b) => a + (Number(b.totalDistance) || 0), 0).toFixed(2));
    const travelPay = parseFloat((totalKm * taRate).toFixed(2));
    
    // Filter and compute DA history
    const daHistory = (employee.daHistory || []).filter((da) => {
      const daDate = new Date(da.date).toISOString().slice(0, 10);
      return (!startStr || daDate >= startStr) && (!endStr || daDate <= endStr);
    });
    const totalDaClaimed = daHistory.reduce((a, b) => a + (Number(b.amount) || 0), 0);

    const totalExpenses = expenses.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const approvedExpenses = expenses
      .filter((e) => e.status === 'approved')
      .reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const pendingExpenses = expenses
      .filter((e) => e.status === 'pending')
      .reduce((a, b) => a + (Number(b.amount) || 0), 0);

    const completedMeetings = meetings.filter((m) => m.status === 'completed').length;
    const completedTasks = tasks.filter((t) => t.status === 'completed').length;
    const daysPresent = attendances.filter((a) => a.status === 'present').length;

    res.json({
      success: true,
      data: {
        employee,
        summary: {
          totalKm,
          travelPay,
          taRate,
          daRate,
          monthlySalary,
          totalDaClaimed,
          totalMeetings: meetings.length,
          completedMeetings,
          totalExpenses,
          approvedExpenses,
          pendingExpenses,
          totalTasks: tasks.length,
          completedTasks,
          totalLeads: leads.length,
          daysPresent,
          totalAttendances: attendances.length,
        },
        dailyDistances,
        locations,
        meetings,
        expenses,
        tasks,
        leads,
        daHistory,
        attendances,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
