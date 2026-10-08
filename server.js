const express = require('express');

// 🛡️ Global Crash Protection to prevent server from shutting down on MilesWeb
process.on('uncaughtException', (err) => {
  console.error('🔥 CRITICAL: Uncaught Exception caught to prevent crash:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 CRITICAL: Unhandled Rejection caught to prevent crash. Reason:', reason);
});

const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1); 
 
// Universal CORS  configuration (Allows Vercel, Localhost, Mobile apps, Custom domains)
const corsOptions = {
  origin: (origin, callback) => {
    // Dynamically reflect origin to allow credentials with any origin (Vercel, Localhost, Custom Domains)
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, true);
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: false, // Required for cross-origin images/resources
}));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false, 
});
app.use('/api/', limiter);

// Make io accessible to routes
app.set('io', io);
 
// Route Handlers (Mount both with /api and without /api for universal compatibility)
const authRoutes = require('./routes/auth.routes');
const superadminRoutes = require('./routes/superadmin.routes');
const employeeRoutes = require('./routes/employee.routes');
const trackingRoutes = require('./routes/tracking.routes');
const meetingRoutes = require('./routes/meeting.routes');
const expenseRoutes = require('./routes/expense.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const adminRoutes = require('./routes/admin.routes');
const managerRoutes = require('./routes/manager.routes');
const uploadRoutes = require('./routes/upload.routes');
const notificationRoutes = require('./routes/notification.routes');
const leaveRoutes = require('./routes/leave.routes');
const taskRoutes = require('./routes/task.routes');
const agentRoutes = require('./routes/agent.routes');
const paymentRoutes = require('./routes/payment.routes');
const leadRoutes = require('./routes/lead.routes');
const newsRoutes = require('./routes/newsRouts');

// API Mounts
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);

app.use('/api/superadmin', superadminRoutes);
app.use('/superadmin', superadminRoutes);

app.use('/api/employees', employeeRoutes);
app.use('/employees', employeeRoutes);

app.use('/api/tracking', trackingRoutes);
app.use('/tracking', trackingRoutes);

app.use('/api/meetings', meetingRoutes);
app.use('/meetings', meetingRoutes);

app.use('/api/expenses', expenseRoutes);
app.use('/expenses', expenseRoutes);

app.use('/api/attendance', attendanceRoutes);
app.use('/attendance', attendanceRoutes);

app.use('/api/admin', adminRoutes);
app.use('/admin', adminRoutes);

app.use('/api/manager', managerRoutes);
app.use('/manager', managerRoutes);

app.use('/api/upload', uploadRoutes);
app.use('/upload', uploadRoutes);

app.use('/api/notifications', notificationRoutes);
app.use('/notifications', notificationRoutes);

app.use('/api/leaves', leaveRoutes);
app.use('/leaves', leaveRoutes);

app.use('/api/tasks', taskRoutes);
app.use('/tasks', taskRoutes);

app.use('/api/agent', agentRoutes);
app.use('/agent', agentRoutes);

app.use('/api/payment', paymentRoutes);
app.use('/payment', paymentRoutes);

app.use('/api/leads', leadRoutes);
app.use('/leads', leadRoutes);

app.use('/api', newsRoutes);

// Dashboard mock stats
const dashboardStatsHandler = (req, res) => {
  res.json({
    success: true,
    stats: {
      todayAttendance: { status: 'present' },
      monthlyAttendance: { present: 20, absent: 2, leave: 1 },
      totalExpenses: 500,
      completedMeetings: 10
    }
  });
};
app.get('/api/dashboard/stats', dashboardStatsHandler);
app.get('/dashboard/stats', dashboardStatsHandler);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'OK aws', timestamp: new Date() }));
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));

// Telegram bot bootstrap
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_TOKEN) {
  require('./telegram.bot');
}

// Socket.IO Logic
const socketHandler = require('./socket/socket.handler');
socketHandler(io);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/')
  .then(async () => {
    console.log('✅ MongoDB connected');

    // ── Reset all stuck online status on startup ──────────────────────────────
    try {
      const User = require('./models/User.model');
      await User.updateMany({ isOnline: true }, { isOnline: false, socketId: null });
      console.log('🔄 Reset all online users to offline on startup.');
    } catch (err) {
      console.error('Failed to reset online status:', err.message);
    }

    // ── No-Movement Cron (DISABLED by User Request) ─────────────────────────
    // Stationary alerts have been disabled.
    /*
    try {
      const User = require('./models/User.model');
      const { LiveLocation, Task, Notification } = require('./models/index');

      const NO_MOVE_MS   = 5 * 60 * 1000; // 5 minutes
      const CRON_INTERVAL = 5 * 60 * 1000; // Run every 5 minutes
      const MOVE_THRESHOLD = 20; // 20 meters

      function haversineMeters(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return 0;
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }

      setInterval(async () => {
        try {
          const now   = Date.now();
          const today = new Date().toISOString().slice(0, 10);

          const activeSessions = await LiveLocation.find({
            isActive: true,
            date: today
          }).populate('employee', '_id name socketId isTracking');

          for (const session of activeSessions) {
            const emp = session.employee;
            if (!emp || !emp.isTracking) continue;

            const coords = session.coordinates;
            if (!coords || coords.length === 0) continue;

            const latestCoord = coords[coords.length - 1];
            const fiveMinsAgo = now - NO_MOVE_MS;
            let pastCoord = null;
            
            for (let i = coords.length - 1; i >= 0; i--) {
              const coordTime = new Date(coords[i].timestamp || session.updatedAt).getTime();
              if (coordTime <= fiveMinsAgo) {
                pastCoord = coords[i];
                break;
              }
            }

            if (!pastCoord) continue;
            const dist = haversineMeters(pastCoord.lat, pastCoord.lng, latestCoord.lat, latestCoord.lng);
            if (dist >= MOVE_THRESHOLD) continue;

            const alertTitle = '⚠️ चेतावनी (Alert)';
            const alertMsg = 'आप पिछले 5 मिनट से एक ही जगह पर हैं। कृपया अपनी लोकेशन अपडेट करें या आगे बढ़ें।';

            try {
              await Notification.create({
                recipient: emp._id,
                sender: emp._id,
                type: 'alert',
                title: alertTitle,
                message: alertMsg
              });

              io.to(`user_${emp._id}`).emit('alert', {
                title: alertTitle,
                message: alertMsg,
                type: 'stationary'
              });
            } catch (dbErr) {
              console.error('Error creating alert notification:', dbErr.message);
            }

            io.to('admins').emit('employee_stationary', {
              employeeId: emp._id,
              name: emp.name,
              timestamp: Date.now(),
              message: `[Stationary] ${emp.name} 5 मिनट से एक ही जगह पर है।`
            });

            console.log(`⚠️ [Cron] Stationary alert sent → ${emp.name}`);
          }
        } catch (cronErr) {
          console.error('No-movement cron error:', cronErr.message);
        }
      }, CRON_INTERVAL);
    } catch (err) {
      console.error('Failed to start no-movement cron:', err.message);
    }
    */

    // ── Auto-Stop Inactive Sessions Cron (non-overlapping, every 5 min) ──────
    try {
      const { autoStopInactiveSessions } = require('./controllers/tracking.controller');
      setInterval(() => {
        autoStopInactiveSessions(io).catch((e) =>
          console.error('[cron] autoStop uncaught error:', e.message)
        );
      }, 5 * 60 * 1000);
      console.log('⏰ Auto-stop inactive sessions cron started (5-min interval, 14h threshold).');
    } catch (err) {
      console.error('Failed to start auto-stop cron:', err.message);
    }
  })
  .catch(err => console.error('❌ MongoDB error:', err));


// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal S-erver Error',
  });
});
 
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = { app, server, io };
             