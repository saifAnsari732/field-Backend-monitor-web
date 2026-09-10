// ═══════════════════════════════════════════════════════════════════════════
// OPENCLAW AGENT ENGINE — Full Admin Power AI Agent
// Uses Gemini Function Calling + Direct DB Access
// ═══════════════════════════════════════════════════════════════════════════

const User = require('./models/User.model');
const {
  LiveLocation, Meeting, Expense, Attendance,
  Notification, Leave, Task, Lead, TravelLog
} = require('./models/index');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ═══════════════════════════════════════════════════════════════════════════
// ALL ADMIN TOOLS (Functions the Agent can call)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_FUNCTIONS = {

  // ─── Dashboard ───────────────────────────────────────────────────────
  async getDashboard() {
    const today = new Date().toISOString().slice(0, 10);
    const [totalEmp, activeEmp, blockedEmp, liveTracking, todayAttendance, pendingExpenses, pendingExpTotal, pendingLeaves, totalTasks, pendingTasks, completedTasks, totalLeads, pendingLeads, todayMeetings, totalMeetings] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: { $ne: 'admin' }, isActive: true, isBlocked: false }),
      User.countDocuments({ isBlocked: true }),
      LiveLocation.countDocuments({ isActive: true, date: today }),
      Attendance.countDocuments({ date: today }),
      Expense.countDocuments({ status: 'pending' }),
      Expense.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Leave.countDocuments({ status: 'pending' }),
      Task.countDocuments({}),
      Task.countDocuments({ status: 'pending' }),
      Task.countDocuments({ status: 'completed' }),
      Lead.countDocuments({}),
      Lead.countDocuments({ status: 'pending' }),
      Meeting.countDocuments({ date: { $gte: new Date(today), $lt: new Date(new Date(today).getTime() + 86400000) } }),
      Meeting.countDocuments({}),
    ]);
    return {
      date: today,
      team: { totalEmployees: totalEmp, active: activeEmp, blocked: blockedEmp, liveTracking },
      today: { attendance: todayAttendance, meetings: todayMeetings },
      tasks: { total: totalTasks, pending: pendingTasks, completed: completedTasks },
      leads: { total: totalLeads, pending: pendingLeads },
      pendingApprovals: { expenses: pendingExpenses, expenseAmount: pendingExpTotal?.[0]?.total || 0, leaves: pendingLeaves },
    };
  },

  // ─── Employees ───────────────────────────────────────────────────────
  async getEmployees({ search, department, limit = 20 }) {
    const query = { role: { $ne: 'admin' } };
    if (search) query.$or = [{ name: new RegExp(search, 'i') }, { employeeId: new RegExp(search, 'i') }];
    if (department) query.department = new RegExp(department, 'i');
    const employees = await User.find(query).select('name employeeId department role phone isActive isBlocked isTracking salary designation').sort({ name: 1 }).limit(limit);
    return { count: employees.length, employees: employees.map(e => e.toJSON()) };
  },

  async getEmployeeDetail({ employeeId, name }) {
    const query = {};
    if (employeeId) query.employeeId = new RegExp(employeeId, 'i');
    else if (name) query.name = new RegExp(name, 'i');
    else return { error: 'Provide employeeId or name' };

    const emp = await User.findOne(query).select('-password');
    if (!emp) return { error: 'Employee not found' };

    const today = new Date().toISOString().slice(0, 10);
    const [sessions, attendance, expenses, tasks, meetings, leads, leaves] = await Promise.all([
      LiveLocation.countDocuments({ employee: emp._id }),
      Attendance.countDocuments({ employee: emp._id }),
      Expense.aggregate([{ $match: { employee: emp._id } }, { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } }]),
      Task.aggregate([{ $match: { employee: emp._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Meeting.countDocuments({ employee: emp._id }),
      Lead.countDocuments({ assignedTo: emp._id }),
      Leave.aggregate([{ $match: { employee: emp._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const liveNow = await LiveLocation.findOne({ employee: emp._id, date: today, isActive: true });

    return {
      employee: emp.toJSON(),
      stats: { totalSessions: sessions, totalAttendance: attendance, totalMeetings: meetings, totalLeads: leads },
      expenses: expenses.reduce((o, e) => ({ ...o, [e._id]: { count: e.count, amount: e.total } }), {}),
      tasks: tasks.reduce((o, t) => ({ ...o, [t._id]: t.count }), {}),
      leaves: leaves.reduce((o, l) => ({ ...o, [l._id]: l.count }), {}),
      isLiveNow: !!liveNow,
      liveDistance: liveNow ? (liveNow.totalDistance || 0).toFixed(2) + ' km' : null,
    };
  },

  async blockEmployee({ name, employeeId }) {
    const query = {};
    if (employeeId) query.employeeId = new RegExp(employeeId, 'i');
    else if (name) query.name = new RegExp(name, 'i');
    const emp = await User.findOne(query);
    if (!emp) return { error: 'Employee not found' };
    emp.isBlocked = true;
    await emp.save();
    return { success: true, message: `${emp.name} has been BLOCKED` };
  },

  async unblockEmployee({ name, employeeId }) {
    const query = {};
    if (employeeId) query.employeeId = new RegExp(employeeId, 'i');
    else if (name) query.name = new RegExp(name, 'i');
    const emp = await User.findOne(query);
    if (!emp) return { error: 'Employee not found' };
    emp.isBlocked = false;
    await emp.save();
    return { success: true, message: `${emp.name} has been UNBLOCKED` };
  },

  async approveEmployee({ name, employeeId }) {
    const query = {};
    if (employeeId) query.employeeId = new RegExp(employeeId, 'i');
    else if (name) query.name = new RegExp(name, 'i');
    const emp = await User.findOneAndUpdate(query, { isApproved: true }, { new: true });
    if (!emp) return { error: 'Employee not found' };
    return { success: true, message: `${emp.name} has been APPROVED` };
  },

  // ─── Live Tracking ───────────────────────────────────────────────────
  async getLiveTracking() {
    const today = new Date().toISOString().slice(0, 10);
    const sessions = await LiveLocation.find({ isActive: true, date: today }).populate('employee', 'name employeeId department');
    return {
      count: sessions.length,
      employees: sessions.map(s => {
        const last = s.coordinates?.[s.coordinates.length - 1];
        return {
          name: s.employee?.name, employeeId: s.employee?.employeeId,
          distance: (s.totalDistance || 0).toFixed(2) + ' km',
          since: s.startTime, lastAddress: last?.address || 'Unknown',
          speed: last?.speed ? Math.round(last.speed) + ' km/h' : 'N/A',
          coordinates: last ? { lat: last.lat, lng: last.lng } : null,
        };
      }),
    };
  },

  // ─── Attendance ──────────────────────────────────────────────────────
  async getAttendance({ date }) {
    const d = date || new Date().toISOString().slice(0, 10);
    const records = await Attendance.find({ date: d }).populate('employee', 'name employeeId department');
    const summary = { present: 0, absent: 0, halfDay: 0, leave: 0 };
    records.forEach(r => {
      if (r.status === 'present') summary.present++;
      else if (r.status === 'absent') summary.absent++;
      else if (r.status === 'half-day') summary.halfDay++;
      else if (r.status === 'leave') summary.leave++;
    });
    return {
      date: d, summary, totalRecords: records.length,
      records: records.slice(0, 20).map(r => ({
        name: r.employee?.name, employeeId: r.employee?.employeeId,
        status: r.status, checkIn: r.checkIn, checkOut: r.checkOut,
        workHours: r.totalWorkHours ? r.totalWorkHours.toFixed(1) + 'h' : 'N/A',
        distanceTraveled: (r.totalDistanceTraveled || 0).toFixed(2) + ' km',
      })),
    };
  },

  // ─── Tasks ───────────────────────────────────────────────────────────
  async getTasks({ status, employeeName, limit = 15 }) {
    const query = {};
    if (status) query.status = status;
    if (employeeName) {
      const emp = await User.findOne({ name: new RegExp(employeeName, 'i') });
      if (emp) query.employee = emp._id;
    }
    const tasks = await Task.find(query).populate('employee', 'name').populate('assignedBy', 'name').sort({ createdAt: -1 }).limit(limit);
    return {
      count: tasks.length,
      tasks: tasks.map(t => ({
        id: t._id, title: t.title, description: t.description,
        employee: t.employee?.name, assignedBy: t.assignedBy?.name,
        status: t.status, priority: t.priority, dueDate: t.dueDate,
      })),
    };
  },

  async createTask({ employeeName, employeeId, title, description, priority, dueDate }) {
    const query = {};
    if (employeeId) query.employeeId = new RegExp(employeeId, 'i');
    else if (employeeName) query.name = new RegExp(employeeName, 'i');
    const emp = await User.findOne(query);
    if (!emp) return { error: 'Employee not found' };
    const admin = await User.findOne({ role: 'admin' });
    const task = await Task.create({
      title, description: description || title, employee: emp._id,
      assignedBy: admin?._id || emp._id, priority: priority || 'medium',
      dueDate: dueDate ? new Date(dueDate) : new Date(Date.now() + 86400000),
    });
    return { success: true, message: `Task "${title}" assigned to ${emp.name}`, taskId: task._id };
  },

  // ─── Meetings ────────────────────────────────────────────────────────
  async getMeetings({ filter, employeeName, limit = 15 }) {
    const query = {};
    if (filter === 'today') {
      const today = new Date(new Date().toISOString().slice(0, 10));
      query.date = { $gte: today, $lt: new Date(today.getTime() + 86400000) };
    }
    if (employeeName) {
      const emp = await User.findOne({ name: new RegExp(employeeName, 'i') });
      if (emp) query.employee = emp._id;
    }
    const meetings = await Meeting.find(query).populate('employee', 'name').sort({ date: -1 }).limit(limit);
    return {
      count: meetings.length,
      meetings: meetings.map(m => ({
        id: m._id, clientName: m.clientName, companyName: m.companyName,
        employee: m.employee?.name, status: m.status, date: m.date,
        dealAmount: m.dealAmount, address: m.meetingAddress, notes: m.meetingNotes,
      })),
    };
  },

  // ─── Expenses ────────────────────────────────────────────────────────
  async getExpenses({ status, employeeName, limit = 15 }) {
    const query = {};
    if (status) query.status = status;
    if (employeeName) {
      const emp = await User.findOne({ name: new RegExp(employeeName, 'i') });
      if (emp) query.employee = emp._id;
    }
    const expenses = await Expense.find(query).populate('employee', 'name').sort({ createdAt: -1 }).limit(limit);
    const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    return {
      count: expenses.length, totalAmount: total,
      expenses: expenses.map(e => ({
        id: e._id, amount: e.amount, category: e.category,
        employee: e.employee?.name, status: e.status, date: e.date,
        description: e.description,
      })),
    };
  },

  async approveExpense({ expenseId }) {
    const exp = await Expense.findByIdAndUpdate(expenseId, { status: 'approved', approvedAt: new Date() }, { new: true }).populate('employee', 'name');
    if (!exp) return { error: 'Expense not found' };
    return { success: true, message: `Expense ₹${exp.amount} (${exp.category}) by ${exp.employee?.name} APPROVED` };
  },

  async rejectExpense({ expenseId, reason }) {
    const exp = await Expense.findByIdAndUpdate(expenseId, { status: 'rejected', rejectionReason: reason || 'Rejected' }, { new: true }).populate('employee', 'name');
    if (!exp) return { error: 'Expense not found' };
    return { success: true, message: `Expense ₹${exp.amount} by ${exp.employee?.name} REJECTED. Reason: ${reason || 'N/A'}` };
  },

  // ─── Leaves ──────────────────────────────────────────────────────────
  async getLeaves({ status, employeeName, limit = 15 }) {
    const query = {};
    if (status) query.status = status;
    if (employeeName) {
      const emp = await User.findOne({ name: new RegExp(employeeName, 'i') });
      if (emp) query.employee = emp._id;
    }
    const leaves = await Leave.find(query).populate('employee', 'name').sort({ createdAt: -1 }).limit(limit);
    return {
      count: leaves.length,
      leaves: leaves.map(l => ({
        id: l._id, employee: l.employee?.name, type: l.type,
        startDate: l.startDate, endDate: l.endDate, duration: l.duration,
        reason: l.reason, status: l.status,
      })),
    };
  },

  async approveLeave({ leaveId }) {
    const lv = await Leave.findByIdAndUpdate(leaveId, { status: 'approved', approvedAt: new Date() }, { new: true }).populate('employee', 'name');
    if (!lv) return { error: 'Leave not found' };
    return { success: true, message: `Leave for ${lv.employee?.name} (${lv.type}) APPROVED` };
  },

  async rejectLeave({ leaveId, reason }) {
    const lv = await Leave.findByIdAndUpdate(leaveId, { status: 'rejected', rejectionReason: reason || 'Rejected' }, { new: true }).populate('employee', 'name');
    if (!lv) return { error: 'Leave not found' };
    return { success: true, message: `Leave for ${lv.employee?.name} REJECTED. Reason: ${reason || 'N/A'}` };
  },

  // ─── Leads ───────────────────────────────────────────────────────────
  async getLeads({ status, limit = 15 }) {
    const query = {};
    if (status) query.status = status;
    const leads = await Lead.find(query).populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(limit);
    return {
      count: leads.length,
      leads: leads.map(l => ({
        id: l._id, name: l.name, contactNo: l.contactNo,
        address: l.address, assignedTo: l.assignedTo?.name,
        status: l.status, feedback: l.feedback,
      })),
    };
  },

  async createLead({ name, contactNo, address, assignToName }) {
    let assignTo = null;
    if (assignToName) {
      const emp = await User.findOne({ name: new RegExp(assignToName, 'i') });
      if (emp) assignTo = emp._id;
    }
    const lead = await Lead.create({ name, contactNo, address, assignedTo: assignTo });
    return { success: true, message: `Lead "${name}" created`, leadId: lead._id };
  },

  // ─── Notifications ──────────────────────────────────────────────────
  async sendNotification({ employeeName, title, message }) {
    const emp = await User.findOne({ name: new RegExp(employeeName, 'i') });
    if (!emp) return { error: 'Employee not found' };
    const admin = await User.findOne({ role: 'admin' });
    await Notification.create({ recipient: emp._id, sender: admin?._id, type: 'system', title, message });
    return { success: true, message: `Notification sent to ${emp.name}` };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI TOOL DEFINITIONS (For Function Calling)
// ═══════════════════════════════════════════════════════════════════════════

const GEMINI_TOOLS = [{
  functionDeclarations: [
    { name: 'getDashboard', description: 'Get complete admin dashboard with all stats', parameters: { type: 'object', properties: {} } },
    { name: 'getEmployees', description: 'List employees, optionally search by name/department', parameters: { type: 'object', properties: { search: { type: 'string', description: 'Search name or ID' }, department: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'getEmployeeDetail', description: 'Get full detail and report of a specific employee', parameters: { type: 'object', properties: { name: { type: 'string' }, employeeId: { type: 'string' } } } },
    { name: 'blockEmployee', description: 'Block an employee', parameters: { type: 'object', properties: { name: { type: 'string' }, employeeId: { type: 'string' } }, required: [] } },
    { name: 'unblockEmployee', description: 'Unblock an employee', parameters: { type: 'object', properties: { name: { type: 'string' }, employeeId: { type: 'string' } }, required: [] } },
    { name: 'approveEmployee', description: 'Approve an employee registration', parameters: { type: 'object', properties: { name: { type: 'string' }, employeeId: { type: 'string' } }, required: [] } },
    { name: 'getLiveTracking', description: 'Get all live tracking employees with current location', parameters: { type: 'object', properties: {} } },
    { name: 'getAttendance', description: 'Get attendance for a specific date (default today)', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD format' } } } },
    { name: 'getTasks', description: 'Get tasks list, filter by status or employee', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'completed', 'overdue'] }, employeeName: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'createTask', description: 'Create and assign a new task to an employee', parameters: { type: 'object', properties: { employeeName: { type: 'string' }, employeeId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, dueDate: { type: 'string' } }, required: ['title'] } },
    { name: 'getMeetings', description: 'Get meetings list', parameters: { type: 'object', properties: { filter: { type: 'string', enum: ['today', 'all'] }, employeeName: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'getExpenses', description: 'Get expenses, filter by status or employee', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, employeeName: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'approveExpense', description: 'Approve a pending expense by its ID', parameters: { type: 'object', properties: { expenseId: { type: 'string' } }, required: ['expenseId'] } },
    { name: 'rejectExpense', description: 'Reject a pending expense by its ID with a reason', parameters: { type: 'object', properties: { expenseId: { type: 'string' }, reason: { type: 'string' } }, required: ['expenseId'] } },
    { name: 'getLeaves', description: 'Get leave requests, filter by status', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, employeeName: { type: 'string' }, limit: { type: 'integer' } } } },
    { name: 'approveLeave', description: 'Approve a pending leave request by its ID', parameters: { type: 'object', properties: { leaveId: { type: 'string' } }, required: ['leaveId'] } },
    { name: 'rejectLeave', description: 'Reject a pending leave request by its ID', parameters: { type: 'object', properties: { leaveId: { type: 'string' }, reason: { type: 'string' } }, required: ['leaveId'] } },
    { name: 'getLeads', description: 'Get leads list, filter by status', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'completed', 'follow-up'] }, limit: { type: 'integer' } } } },
    { name: 'createLead', description: 'Create a new lead', parameters: { type: 'object', properties: { name: { type: 'string' }, contactNo: { type: 'string' }, address: { type: 'string' }, assignToName: { type: 'string' } }, required: ['name', 'contactNo'] } },
    { name: 'sendNotification', description: 'Send a notification to an employee', parameters: { type: 'object', properties: { employeeName: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' } }, required: ['employeeName', 'title', 'message'] } },
  ],
}];

// ═══════════════════════════════════════════════════════════════════════════
// AGENT EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function executeAgent(userMessage, conversationHistory = []) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');

  const systemPrompt = `You are the KisanTeam CRM Admin AI Agent. You have FULL admin power over the CRM system.

CRITICAL FORMATTING RULES FOR TELEGRAM:
1. Keep the layout BEAUTIFUL, SPACIOUS, and EASY TO READ on a mobile phone.
2. NEVER use markdown bold asterisks (*) right next to bullet points (it looks messy).
3. Always add a dividing line like ━━━━━━━━━━━━━━━━━━ under main headings.
4. Use standard bullet points (•) for lists.
5. Example of GOOD layout:

📊 *CRM OVERVIEW*
━━━━━━━━━━━━━━━━━━

👥 *Team Status*
• Total Employees: 6
• Active: 6 | Blocked: 0
• Live Tracking: 0 Online

📅 *Today's Activity*
• Attendance: 2 Checked In
• Meetings: 1 Scheduled

⏳ *Pending Approvals*
• Leaves: 0 Pending
• Expenses: 5 Pending (Total: ₹11,694)

6. If the user speaks Hindi, respond in Hindi or Hinglish, but maintain this structured layout.
7. Use the available tools to fetch real data before answering.
Current date: ${new Date().toISOString().slice(0, 10)}`;

  const contents = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Understood. I am ready to help manage the CRM with full admin access.' }] },
    ...conversationHistory,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  // Step 1: Send to Gemini with tools
  let response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, tools: GEMINI_TOOLS }),
  });

  let data = await response.json();
  if (data.error) {
    console.error('Gemini API Error (Step 1):', data.error);
    throw new Error(data.error.message || 'Gemini API Error');
  }

  let candidate = data?.candidates?.[0];
  let parts = candidate?.content?.parts || [];

  // Step 2: Handle function calls (up to 5 rounds)
  let rounds = 0;
  while (rounds < 5) {
    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) break;

    // Add model's function call to contents
    contents.push({ role: 'model', parts });

    // Execute each function call
    const functionResponses = [];
    for (const fc of functionCalls) {
      const fnName = fc.functionCall.name;
      const fnArgs = fc.functionCall.args || {};
      
      console.log(`🤖 Agent calling tool: ${fnName}`, fnArgs);

      let result;
      try {
        if (TOOL_FUNCTIONS[fnName]) {
          result = await TOOL_FUNCTIONS[fnName](fnArgs);
        } else {
          result = { error: `Unknown function: ${fnName}` };
        }
      } catch (err) {
        result = { error: err.message };
      }

      functionResponses.push({
        functionResponse: { name: fnName, response: { result } },
      });
    }

    // Add function responses
    contents.push({ role: 'function', parts: functionResponses });

    // Call Gemini again with results
    response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, tools: GEMINI_TOOLS }),
    });

    data = await response.json();
    if (data.error) {
      console.error('Gemini API Error (Step 2):', data.error);
      throw new Error(data.error.message || 'Gemini API Error');
    }

    candidate = data?.candidates?.[0];
    parts = candidate?.content?.parts || [];
    rounds++;
  }

  // Step 3: Extract final text response
  const textParts = parts.filter(p => p.text).map(p => p.text);
  const finalText = textParts.join('\n') || 'No response generated.';

  return {
    success: true,
    response: finalText,
    toolsUsed: rounds,
    source: 'openclaw-agent',
  };
}

module.exports = { executeAgent, TOOL_FUNCTIONS };
