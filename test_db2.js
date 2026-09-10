const mongoose = require('mongoose');
const User = require('./models/User.model');
const { Meeting, Expense, Attendance, LiveLocation, Leave, Task } = require('./models/index');

async function test() {
  await mongoose.connect('mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App', { useNewUrlParser: true, useUnifiedTopology: true });
  
  // Find a manager
  const manager = await User.findOne({ role: 'manager' });
  if (!manager) {
    console.log('No manager found');
    process.exit();
  }

  const myTeamFilter = { manager: manager._id };
  const teamMembers = await User.find(myTeamFilter).select('_id');
  const teamIds = teamMembers.map(emp => emp._id);
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      todayAttendance, totalLeaves, totalTasks,
      totalKmData
    ] = await Promise.all([
      User.countDocuments(myTeamFilter),
      User.countDocuments({ ...myTeamFilter, isOnline: true }),
      User.countDocuments({ ...myTeamFilter, isTracking: true }),
      Meeting.countDocuments({ employee: { $in: teamIds } }),
      Meeting.countDocuments({ employee: { $in: teamIds }, date: { $gte: new Date(today) } }),
      Expense.countDocuments({ employee: { $in: teamIds }, status: 'pending' }),
      Attendance.countDocuments({ employee: { $in: teamIds }, date: today, status: 'present' }),
      Leave.countDocuments({ employee: { $in: teamIds } }),
      Task.countDocuments({ employee: { $in: teamIds } }),
      LiveLocation.aggregate([
        { $match: { employee: { $in: teamIds }, date: today } },
        { $group: { _id: null, total: { $sum: '' } } }
      ])
    ]);
    console.log('Success!');
    console.log({ totalEmployees, todayMeetings, pendingExpenses, totalTasks });
  } catch (err) {
    console.error('Error in Promise.all:', err);
  }
  process.exit();
}

test();
