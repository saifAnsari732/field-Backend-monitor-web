const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN missing. Telegram bot disabled.');
}

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// ─── Direct DB Access (No JWT, No Expiry) ──────────────────────────────────
const User = require('./models/User.model');
const {
  LiveLocation, Meeting, Expense, Attendance,
  Notification, Leave, Task, Lead, TravelLog
} = require('./models/index');

// ─── Telegram Markdown Escape ──────────────────────────────────────────────
function esc(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── Date Helpers ──────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A'; }
function fmtTime(d) { return d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'N/A'; }

// ─── Safe Reply (splits long messages) ─────────────────────────────────────
async function safeReply(ctx, text, parseMode = 'MarkdownV2') {
  const MAX = 4000;
  if (text.length <= MAX) {
    try {
      return await ctx.reply(text, { parse_mode: parseMode });
    } catch (e) {
      return await ctx.reply(text.replace(/[\\*_`~]/g, ''), {});
    }
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      if (chunk) {
        try { await ctx.reply(chunk, { parse_mode: parseMode }); }
        catch { await ctx.reply(chunk.replace(/[\\*_`~]/g, ''), {}); }
      }
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) {
    try { await ctx.reply(chunk, { parse_mode: parseMode }); }
    catch { await ctx.reply(chunk.replace(/[\\*_`~]/g, ''), {}); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND HANDLERS (Direct DB)
// ═══════════════════════════════════════════════════════════════════════════

async function cmdDashboard(ctx) {
  const today = todayStr();
  const [totalEmp, activeEmp, liveTracking, todayAttendance, pendingExpenses, pendingLeaves, totalTasks, pendingTasks, totalLeads, todayMeetings] = await Promise.all([
    User.countDocuments({ role: { $ne: 'admin' } }),
    User.countDocuments({ role: { $ne: 'admin' }, isActive: true, isBlocked: false }),
    LiveLocation.countDocuments({ isActive: true, date: today }),
    Attendance.countDocuments({ date: today }),
    Expense.countDocuments({ status: 'pending' }),
    Leave.countDocuments({ status: 'pending' }),
    Task.countDocuments({}),
    Task.countDocuments({ status: 'pending' }),
    Lead.countDocuments({}),
    Meeting.countDocuments({ date: { $gte: new Date(today), $lt: new Date(new Date(today).getTime() + 86400000) } }),
  ]);

  const msg = [
    `📊 *ADMIN DASHBOARD*`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `👥 *Team Overview*`,
    `   Total Staff: *${esc(String(totalEmp))}*`,
    `   Active: *${esc(String(activeEmp))}*`,
    `   Live Tracking: *${esc(String(liveTracking))}*`,
    ``,
    `📅 *Today \\(${esc(fmtDate(new Date()))}\\)*`,
    `   ✅ Attendance: *${esc(String(todayAttendance))}*`,
    `   🤝 Meetings: *${esc(String(todayMeetings))}*`,
    ``,
    `📋 *Work Status*`,
    `   📌 Tasks: *${esc(String(pendingTasks))}* pending / *${esc(String(totalTasks))}* total`,
    `   🎯 Leads: *${esc(String(totalLeads))}*`,
    ``,
    `⏳ *Pending Approvals*`,
    `   💰 Expenses: *${esc(String(pendingExpenses))}*`,
    `   🏖 Leaves: *${esc(String(pendingLeaves))}*`,
  ].join('\n');
  await safeReply(ctx, msg);
}

async function cmdEmployees(ctx, search) {
  const query = { role: { $ne: 'admin' } };
  if (search) {
    query.$or = [
      { name: new RegExp(search, 'i') },
      { employeeId: new RegExp(search, 'i') },
      { department: new RegExp(search, 'i') },
    ];
  }
  const emps = await User.find(query).select('name employeeId department role isActive isBlocked isTracking phone').sort({ name: 1 }).limit(20);

  if (emps.length === 0) {
    return safeReply(ctx, `👥 *EMPLOYEES*\n\nNo employees found\\.`);
  }

  const lines = [`👥 *EMPLOYEES* \\(${esc(String(emps.length))}\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  emps.forEach((e, i) => {
    const status = e.isBlocked ? '🔴' : e.isTracking ? '🟢' : e.isActive ? '🟡' : '⚪';
    lines.push(`${status} *${esc(e.name)}*`);
    lines.push(`   ID: \`${esc(e.employeeId || 'N/A')}\` \\| ${esc(e.department || 'N/A')} \\| ${esc(e.role)}`);
    if (e.phone) lines.push(`   📞 ${esc(e.phone)}`);
    if (i < emps.length - 1) lines.push(``);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdLiveTracking(ctx) {
  const today = todayStr();
  const sessions = await LiveLocation.find({ isActive: true, date: today }).populate('employee', 'name employeeId department');

  if (sessions.length === 0) {
    return safeReply(ctx, `📍 *LIVE TRACKING*\n\nNo employees are currently being tracked\\.`);
  }

  const lines = [`📍 *LIVE TRACKING* \\(${esc(String(sessions.length))} active\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  sessions.forEach((s, i) => {
    const last = s.coordinates?.[s.coordinates.length - 1];
    const dist = (s.totalDistance || 0).toFixed(2);
    lines.push(`🟢 *${esc(s.employee?.name || 'Unknown')}*`);
    lines.push(`   📏 Distance: *${esc(dist)} km*`);
    lines.push(`   🕐 Since: ${esc(fmtTime(s.startTime))}`);
    if (last?.address) lines.push(`   📌 ${esc(last.address.slice(0, 60))}`);
    if (last?.speed) lines.push(`   🚀 Speed: ${esc(String(Math.round(last.speed)))} km/h`);
    if (i < sessions.length - 1) lines.push(``);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdAttendance(ctx, dateStr) {
  const date = dateStr || todayStr();
  const records = await Attendance.find({ date }).populate('employee', 'name employeeId department').sort({ checkIn: 1 });

  if (records.length === 0) {
    return safeReply(ctx, `📅 *ATTENDANCE \\(${esc(date)}\\)*\n\nNo attendance records found\\.`);
  }

  const present = records.filter(r => r.status === 'present').length;
  const absent = records.filter(r => r.status === 'absent').length;
  const halfDay = records.filter(r => r.status === 'half-day').length;

  const lines = [
    `📅 *ATTENDANCE \\(${esc(date)}\\)*`,
    `━━━━━━━━━━━━━━━━━━`,
    `✅ Present: *${esc(String(present))}* \\| ❌ Absent: *${esc(String(absent))}* \\| ½ Half: *${esc(String(halfDay))}*`,
    ``,
  ];
  records.slice(0, 15).forEach(r => {
    const icon = r.status === 'present' ? '✅' : r.status === 'absent' ? '❌' : '🟡';
    const hrs = r.totalWorkHours ? `${r.totalWorkHours.toFixed(1)}h` : '—';
    lines.push(`${icon} *${esc(r.employee?.name || 'N/A')}* — ${esc(fmtTime(r.checkIn))} to ${esc(fmtTime(r.checkOut))} \\(${esc(hrs)}\\)`);
  });
  if (records.length > 15) lines.push(`\n_\\.\\.\\. and ${esc(String(records.length - 15))} more_`);
  await safeReply(ctx, lines.join('\n'));
}

async function cmdTasks(ctx, statusFilter) {
  const query = {};
  if (statusFilter) query.status = statusFilter;
  const tasks = await Task.find(query).populate('employee', 'name employeeId').populate('assignedBy', 'name').sort({ createdAt: -1 }).limit(15);

  if (tasks.length === 0) {
    return safeReply(ctx, `📋 *TASKS*\n\nNo tasks found\\.`);
  }

  const lines = [`📋 *TASKS* \\(${esc(String(tasks.length))}\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  tasks.forEach(t => {
    const icon = t.status === 'completed' ? '✅' : t.status === 'in-progress' ? '🔄' : t.status === 'overdue' ? '🔴' : '📌';
    const priority = t.priority === 'high' ? '🔥' : t.priority === 'medium' ? '🟡' : '🟢';
    lines.push(`${icon} ${priority} *${esc(t.title?.slice(0, 40))}*`);
    lines.push(`   👤 ${esc(t.employee?.name || 'N/A')} \\| Due: ${esc(fmtDate(t.dueDate))} \\| ${esc(t.status)}`);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdMeetings(ctx, filter) {
  const query = {};
  if (filter === 'today') {
    const today = new Date(todayStr());
    query.date = { $gte: today, $lt: new Date(today.getTime() + 86400000) };
  }
  const meetings = await Meeting.find(query).populate('employee', 'name employeeId').sort({ date: -1 }).limit(15);

  if (meetings.length === 0) {
    return safeReply(ctx, `🤝 *MEETINGS*\n\nNo meetings found\\.`);
  }

  const lines = [`🤝 *MEETINGS* \\(${esc(String(meetings.length))}\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  meetings.forEach(m => {
    const icon = m.status === 'completed' ? '✅' : m.status === 'cancelled' ? '❌' : m.status === 'follow-up' ? '🔄' : '📅';
    lines.push(`${icon} *${esc(m.clientName)}* ${m.companyName ? `\\(${esc(m.companyName)}\\)` : ''}`);
    lines.push(`   👤 ${esc(m.employee?.name || 'N/A')} \\| ${esc(fmtDate(m.date))} \\| ₹${esc(String(m.dealAmount || 0))}`);
    if (m.meetingAddress) lines.push(`   📍 ${esc(m.meetingAddress.slice(0, 50))}`);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdExpenses(ctx, statusFilter) {
  const query = {};
  if (statusFilter) query.status = statusFilter;
  const expenses = await Expense.find(query).populate('employee', 'name employeeId').sort({ createdAt: -1 }).limit(15);

  if (expenses.length === 0) {
    return safeReply(ctx, `💰 *EXPENSES*\n\nNo expenses found\\.`);
  }

  const totalAmt = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const lines = [
    `💰 *EXPENSES* \\(${esc(String(expenses.length))}\\)`,
    `━━━━━━━━━━━━━━━━━━`,
    `Total: *₹${esc(String(totalAmt))}*`,
    ``,
  ];
  expenses.forEach(e => {
    const icon = e.status === 'approved' ? '✅' : e.status === 'rejected' ? '❌' : '⏳';
    lines.push(`${icon} *₹${esc(String(e.amount))}* \\| ${esc(e.category)} \\| ${esc(e.employee?.name || 'N/A')}`);
    if (e.description) lines.push(`   📝 ${esc(e.description.slice(0, 50))}`);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdLeaves(ctx, statusFilter) {
  const query = {};
  if (statusFilter) query.status = statusFilter;
  const leaves = await Leave.find(query).populate('employee', 'name employeeId').sort({ createdAt: -1 }).limit(15);

  if (leaves.length === 0) {
    return safeReply(ctx, `🏖 *LEAVES*\n\nNo leave requests found\\.`);
  }

  const lines = [`🏖 *LEAVES* \\(${esc(String(leaves.length))}\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  leaves.forEach(l => {
    const icon = l.status === 'approved' ? '✅' : l.status === 'rejected' ? '❌' : '⏳';
    lines.push(`${icon} *${esc(l.employee?.name || 'N/A')}* — ${esc(l.type)}`);
    lines.push(`   📆 ${esc(fmtDate(l.startDate))} → ${esc(fmtDate(l.endDate))} \\(${esc(String(l.duration || '?'))} days\\)`);
    if (l.reason) lines.push(`   📝 ${esc(l.reason.slice(0, 50))}`);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdLeads(ctx, statusFilter) {
  const query = {};
  if (statusFilter) query.status = statusFilter;
  const leads = await Lead.find(query).populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(15);

  if (leads.length === 0) {
    return safeReply(ctx, `🎯 *LEADS*\n\nNo leads found\\.`);
  }

  const lines = [`🎯 *LEADS* \\(${esc(String(leads.length))}\\)`, `━━━━━━━━━━━━━━━━━━`, ``];
  leads.forEach(l => {
    const icon = l.status === 'completed' ? '✅' : l.status === 'follow-up' ? '🔄' : '📌';
    lines.push(`${icon} *${esc(l.name)}* — ${esc(l.contactNo)}`);
    lines.push(`   👤 ${esc(l.assignedTo?.name || 'Unassigned')} \\| ${esc(l.status)}`);
    if (l.address) lines.push(`   📍 ${esc(l.address.slice(0, 50))}`);
  });
  await safeReply(ctx, lines.join('\n'));
}

async function cmdEmployeeReport(ctx, empSearch) {
  if (!empSearch) return safeReply(ctx, `Usage: /report EmployeeName or EmployeeID`);

  const emp = await User.findOne({
    $or: [
      { employeeId: new RegExp(empSearch, 'i') },
      { name: new RegExp(empSearch, 'i') },
    ],
  }).select('name employeeId department role phone isActive isBlocked isTracking salary');

  if (!emp) return safeReply(ctx, `❌ Employee not found: "${esc(empSearch)}"`);

  const today = todayStr();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  const [totalSessions, totalAttendance, totalExpenses, pendingExpAmt, totalMeetings, totalTasks, completedTasks, totalLeads] = await Promise.all([
    LiveLocation.countDocuments({ employee: emp._id }),
    Attendance.countDocuments({ employee: emp._id, date: { $gte: thirtyDaysAgo.toISOString().slice(0, 10) } }),
    Expense.countDocuments({ employee: emp._id }),
    Expense.aggregate([{ $match: { employee: emp._id, status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Meeting.countDocuments({ employee: emp._id }),
    Task.countDocuments({ employee: emp._id }),
    Task.countDocuments({ employee: emp._id, status: 'completed' }),
    Lead.countDocuments({ assignedTo: emp._id }),
  ]);

  const pendingAmt = pendingExpAmt?.[0]?.total || 0;
  const todaySession = await LiveLocation.findOne({ employee: emp._id, date: today, isActive: true });

  const lines = [
    `📄 *EMPLOYEE REPORT*`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `👤 *${esc(emp.name)}*`,
    `   ID: \`${esc(emp.employeeId || 'N/A')}\``,
    `   📱 ${esc(emp.phone || 'N/A')} \\| ${esc(emp.department || 'N/A')}`,
    `   Role: ${esc(emp.role)} \\| Salary: ₹${esc(String(emp.salary || 0))}`,
    `   Status: ${emp.isBlocked ? '🔴 Blocked' : emp.isActive ? '🟢 Active' : '⚪ Inactive'}`,
    `   Tracking: ${todaySession ? '🟢 LIVE NOW' : emp.isTracking ? '🟡 Enabled' : '⚪ Off'}`,
    ``,
    `📊 *30\\-Day Summary*`,
    `   📅 Attendance: *${esc(String(totalAttendance))}* days`,
    `   📍 Tracking Sessions: *${esc(String(totalSessions))}*`,
    `   🤝 Meetings: *${esc(String(totalMeetings))}*`,
    `   📋 Tasks: *${esc(String(completedTasks))}*/*${esc(String(totalTasks))}* completed`,
    `   🎯 Leads: *${esc(String(totalLeads))}*`,
    `   💰 Pending Expenses: *₹${esc(String(pendingAmt))}*`,
  ];

  if (todaySession) {
    const dist = (todaySession.totalDistance || 0).toFixed(2);
    const lastCoord = todaySession.coordinates?.[todaySession.coordinates.length - 1];
    lines.push(``);
    lines.push(`🔴 *LIVE SESSION*`);
    lines.push(`   📏 ${esc(dist)} km \\| Since ${esc(fmtTime(todaySession.startTime))}`);
    if (lastCoord?.address) lines.push(`   📌 ${esc(lastCoord.address.slice(0, 60))}`);
  }

  await safeReply(ctx, lines.join('\n'));
}

async function cmdApprove(ctx, type, id) {
  if (!type || !id) return safeReply(ctx, `Usage: /approve expense\\|leave ITEM\\_ID`);

  if (type === 'expense') {
    const exp = await Expense.findByIdAndUpdate(id, { status: 'approved', approvedAt: new Date() }, { new: true }).populate('employee', 'name');
    if (!exp) return safeReply(ctx, `❌ Expense not found`);
    return safeReply(ctx, `✅ *Expense Approved*\n\n💰 ₹${esc(String(exp.amount))} \\| ${esc(exp.category)} \\| ${esc(exp.employee?.name || 'N/A')}`);
  }

  if (type === 'leave') {
    const lv = await Leave.findByIdAndUpdate(id, { status: 'approved', approvedAt: new Date() }, { new: true }).populate('employee', 'name');
    if (!lv) return safeReply(ctx, `❌ Leave not found`);
    return safeReply(ctx, `✅ *Leave Approved*\n\n🏖 ${esc(lv.employee?.name || 'N/A')} \\| ${esc(fmtDate(lv.startDate))} → ${esc(fmtDate(lv.endDate))}`);
  }

  return safeReply(ctx, `Unknown type\\. Use: /approve expense\\|leave ID`);
}

async function cmdReject(ctx, type, id, reason) {
  if (!type || !id) return safeReply(ctx, `Usage: /reject expense\\|leave ITEM\\_ID reason`);

  if (type === 'expense') {
    const exp = await Expense.findByIdAndUpdate(id, { status: 'rejected', rejectionReason: reason || 'Rejected by admin' }, { new: true }).populate('employee', 'name');
    if (!exp) return safeReply(ctx, `❌ Expense not found`);
    return safeReply(ctx, `❌ *Expense Rejected*\n\n💰 ₹${esc(String(exp.amount))} \\| ${esc(exp.employee?.name || 'N/A')}\nReason: ${esc(reason || 'No reason')}`);
  }

  if (type === 'leave') {
    const lv = await Leave.findByIdAndUpdate(id, { status: 'rejected', rejectionReason: reason || 'Rejected by admin' }, { new: true }).populate('employee', 'name');
    if (!lv) return safeReply(ctx, `❌ Leave not found`);
    return safeReply(ctx, `❌ *Leave Rejected*\n\n🏖 ${esc(lv.employee?.name || 'N/A')}\nReason: ${esc(reason || 'No reason')}`);
  }
}

async function cmdBlockToggle(ctx, action, empSearch) {
  if (!empSearch) return safeReply(ctx, `Usage: /${esc(action)} EmployeeName`);

  const emp = await User.findOne({
    $or: [
      { employeeId: new RegExp(empSearch, 'i') },
      { name: new RegExp(empSearch, 'i') },
    ],
  });
  if (!emp) return safeReply(ctx, `❌ Employee not found: "${esc(empSearch)}"`);

  const isBlock = action === 'block';
  emp.isBlocked = isBlock;
  await emp.save();
  return safeReply(ctx, `${isBlock ? '🔴' : '🟢'} *${esc(emp.name)}* has been ${isBlock ? 'BLOCKED' : 'UNBLOCKED'}`);
}

async function cmdHelp(ctx) {
  const msg = [
    `🤖 *KISANTEAM CRM BOT*`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 *Dashboard \\& Overview*`,
    `   /dashboard — Full summary`,
    `   /status — Server health`,
    ``,
    `👥 *Employees*`,
    `   /employees — All employees`,
    `   /employees \\[search\\] — Search by name`,
    `   /report \\[name/ID\\] — Full employee report`,
    `   /block \\[name\\] — Block employee`,
    `   /unblock \\[name\\] — Unblock employee`,
    ``,
    `📍 *Tracking*`,
    `   /live — Live tracking status`,
    `   /attendance — Today's attendance`,
    `   /attendance \\[date\\] — Specific date`,
    ``,
    `📋 *Work Management*`,
    `   /tasks — All tasks`,
    `   /tasks pending — Pending tasks`,
    `   /meetings — All meetings`,
    `   /meetings today — Today's meetings`,
    `   /leads — All leads`,
    ``,
    `💰 *Finance*`,
    `   /expenses — All expenses`,
    `   /expenses pending — Pending expenses`,
    `   /leaves — Leave requests`,
    `   /leaves pending — Pending leaves`,
    ``,
    `✅ *Admin Actions*`,
    `   /approve expense\\|leave ID`,
    `   /reject expense\\|leave ID reason`,
    ``,
    `🎙 *Voice Commands*`,
    `   Send any voice message in Hindi or English\\!`,
    `   Example: "dashboard dikhao" or "show employees"`,
  ].join('\n');
  await safeReply(ctx, msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// AI COMMAND PARSER (Gemini)
// ═══════════════════════════════════════════════════════════════════════════

async function parseNaturalLanguage(text) {
  if (!GEMINI_API_KEY) return text.trim();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `You are a CRM bot command parser. Convert the following Hindi/English message into one of these EXACT commands. Return ONLY the command, nothing else.

Available commands:
/dashboard
/employees
/employees [searchTerm]
/live
/attendance
/attendance [YYYY-MM-DD]
/tasks
/tasks pending
/meetings
/meetings today
/expenses
/expenses pending
/leaves
/leaves pending
/leads
/report [employeeName]
/approve expense [id]
/approve leave [id]
/reject expense [id] [reason]
/block [employeeName]
/unblock [employeeName]
/help
/status

User message: "${text}"

Return ONLY the command string. If unclear, return /help`
            }],
          }],
        }),
      }
    );

    const data = await response.json();
    const result = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    return result.trim() || text.trim();
  } catch {
    return text.trim();
  }
}

async function transcribeVoice(fileUrl) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const audioRes = await fetch(fileUrl);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const base64 = buffer.toString('base64');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            {
              text: `You are a CRM bot command parser. Listen to this voice message (Hindi or English) and convert it into one of these EXACT commands. Return ONLY the command.

Available commands:
/dashboard, /employees, /employees [search], /live, /attendance, /tasks, /tasks pending, /meetings, /meetings today, /expenses, /expenses pending, /leaves, /leaves pending, /leads, /report [name], /block [name], /unblock [name], /approve expense|leave [id], /help, /status

Return ONLY the command. If unclear, return /help`,
            },
            { inline_data: { mime_type: 'audio/ogg', data: base64 } },
          ],
        }],
      }),
    }
  );

  const data = await response.json();
  return (data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '/help').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND ROUTER
// ═══════════════════════════════════════════════════════════════════════════

async function routeCommand(ctx, rawCmd) {
  const cmd = rawCmd.trim();
  if (!cmd) return;

  try {
    const parts = cmd.split(/\s+/).filter(Boolean);
    const base = parts[0].toLowerCase();
    const arg1 = parts[1] || '';
    const arg2 = parts[2] || '';
    const rest = parts.slice(3).join(' ');

    switch (base) {
      case '/dashboard': return await cmdDashboard(ctx);
      case '/employees': return await cmdEmployees(ctx, arg1 || null);
      case '/live': return await cmdLiveTracking(ctx);
      case '/attendance': return await cmdAttendance(ctx, arg1 || null);
      case '/tasks': return await cmdTasks(ctx, arg1 || null);
      case '/meetings': return await cmdMeetings(ctx, arg1 || null);
      case '/expenses': return await cmdExpenses(ctx, arg1 || null);
      case '/leaves': return await cmdLeaves(ctx, arg1 || null);
      case '/leads': return await cmdLeads(ctx, arg1 || null);
      case '/report': return await cmdEmployeeReport(ctx, parts.slice(1).join(' '));
      case '/approve': return await cmdApprove(ctx, arg1, arg2);
      case '/reject': return await cmdReject(ctx, arg1, arg2, rest);
      case '/block': return await cmdBlockToggle(ctx, 'block', parts.slice(1).join(' '));
      case '/unblock': return await cmdBlockToggle(ctx, 'unblock', parts.slice(1).join(' '));
      case '/agent': return await cmdAgent(ctx, parts.slice(1).join(' '));
      case '/help': return await cmdHelp(ctx);
      case '/status':
      case '/ping':
        return await safeReply(ctx, `🟢 *Bot Status: ONLINE*\n⏰ ${esc(new Date().toLocaleString('en-IN'))}`);
      default:
        return await safeReply(ctx, `❓ Unknown command\\. Try /help`);
    }
  } catch (err) {
    console.error('Telegram cmd error:', err.message);
    await safeReply(ctx, `❌ Error: ${esc(err.message?.slice(0, 100))}`);
  }
}

// ─── /agent — OpenClaw AI Agent (Complex queries) ──────────────────────────
async function cmdAgent(ctx, query) {
  if (!query) return safeReply(ctx, `Usage: /agent your question here\n\nExample: /agent Ritesh ki aaj ki attendance aur expenses dikhao`);

  try {
    const { executeAgent } = require('./agent.engine');
    const result = await executeAgent(query);
    
    if (result?.response) {
      // Agent response is plain text, send as-is
      await ctx.reply(result.response, {});
    } else {
      await safeReply(ctx, `❌ Agent returned no response`);
    }
  } catch (err) {
    await safeReply(ctx, `❌ Agent error: ${esc(err.message?.slice(0, 200))}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════

if (bot) {
  bot.start((ctx) => cmdHelp(ctx));
  bot.help((ctx) => cmdHelp(ctx));

  // Direct command handlers
  const directCmds = ['dashboard', 'employees', 'live', 'attendance', 'tasks', 'meetings', 'expenses', 'leaves', 'leads', 'report', 'approve', 'reject', 'block', 'unblock', 'agent', 'status', 'ping', 'help'];
  directCmds.forEach(c => {
    bot.command(c, async (ctx) => routeCommand(ctx, ctx.message.text));
  });

  // Natural language text — Use AI Agent for complex queries
  bot.on('text', async (ctx) => {
    const text = ctx.message?.text || '';
    if (!text || text.startsWith('/')) return;
    
    await ctx.reply('🤖 AI Agent processing...');
    
    // Try direct command parsing first
    const parsed = await parseNaturalLanguage(text);
    
    if (parsed.startsWith('/') && parsed !== '/help') {
      // Parsed into a known command
      await routeCommand(ctx, parsed);
    } else {
      // Complex query — use OpenClaw Agent Engine
      try {
        const { executeAgent } = require('./agent.engine');
        const result = await executeAgent(text);
        if (result?.response) {
          await ctx.reply(result.response, {});
        } else {
          await safeReply(ctx, `❓ Could not process your request\\. Try /help`);
        }
      } catch (err) {
        await safeReply(ctx, `❌ ${esc(err.message?.slice(0, 100))}`);
      }
    }
  });

  // Voice — Transcribe then route through Agent
  bot.on('voice', async (ctx) => {
    try {
      await ctx.reply('🎙 Processing voice command...');
      const fileId = ctx.message.voice.file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const command = await transcribeVoice(fileLink.href);
      
      if (command.startsWith('/') && command !== '/help') {
        await routeCommand(ctx, command);
      } else {
        // Complex voice query — use Agent Engine
        const { executeAgent } = require('./agent.engine');
        const result = await executeAgent(command);
        if (result?.response) {
          await ctx.reply(result.response, {});
        } else {
          await safeReply(ctx, `❓ Voice command unclear\\. Try again\\.`);
        }
      }
    } catch (err) {
      await safeReply(ctx, `❌ Voice error: ${esc(err.message?.slice(0, 100))}`);
    }
  });

  bot.launch();
  console.log('🤖 Telegram CRM Bot started (Direct DB + OpenClaw Agent Engine)');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { bot };

