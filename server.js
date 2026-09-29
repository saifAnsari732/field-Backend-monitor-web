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
 
// Allowed origins list for CORS
const allowedOrigins = [
  'https://tm24news.com',
  'https://tm24news.in',   
  'https://www.tm24news.in', 
  "http://localhost:8081",
  "http://localhost:3000",
  "http://localhost:3001",
  'https://www.tm24news.com',
  'https://kisanteamweb.it.com',
  'https://tm-24news.vercel.app',
  'https://tm24news.vercel.app',
  'https://crm-front-sand.vercel.app'
]; 

// 🔴 यहाँ EXPRESS API के लिए CORS लगाना ज़रूरी है (इसे अपने कोड में जोड़ें):
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      callback(null, true); 
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }, 
  credentials: true
}));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or postman)
      if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
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
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false, 
});
app.use('/api/', limiter);

// Make io accessible to routes
app.set('io', io);
 
// Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/superadmin', require('./routes/superadmin.routes'));
app.use('/api/employees', require('./routes/employee.routes'));
app.use('/api/tracking', require('./routes/tracking.routes'));
app.use('/api/meetings', require('./routes/meeting.routes'));
app.use('/api/expenses', require('./routes/expense.routes'));
app.use('/api/attendance', require('./routes/attendance.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/manager', require('./routes/manager.routes'));
  app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));
app.use('/api/leaves', require('./routes/leave.routes'));
app.use('/api/tasks', require('./routes/task.routes'));
app.use('/api/agent', require('./routes/agent.routes'));
app.use('/api/payment', require('./routes/payment.routes'));
// Mock dashboard route since local backend is missing dashboard.routes.js

app.get('/api/dashboard/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      todayAttendance: { status: 'present' },
      monthlyAttendance: { present: 20, absent: 2, leave: 1 },
      totalExpenses: 500,
      completedMeetings: 10
    }
  });
});
app.use('/api/leads', require('./routes/lead.routes'));
//  news api
app.use('/api', require('./routes/newsRouts'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));

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

    // ── No-Movement Cron (REST API tracking) ─────────────────────────────────
    // Runs every 5 minutes. Checks if the distance between the employee's 
    // current location and their location 5 minutes ago is less than 20 meters.
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

          // Find ALL active tracking sessions for today
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
            
            // Find a coordinate from at least 5 minutes ago
            const fiveMinsAgo = now - NO_MOVE_MS;
            let pastCoord = null;
            
            for (let i = coords.length - 1; i >= 0; i--) {
              const coordTime = new Date(coords[i].timestamp || session.updatedAt).getTime();
              if (coordTime <= fiveMinsAgo) {
                pastCoord = coords[i];
                break;
              }
            }

            // If session started less than 5 mins ago, skip
            if (!pastCoord) continue;

            // Check if they moved more than 20 meters in the last 5 minutes
            const dist = haversineMeters(pastCoord.lat, pastCoord.lng, latestCoord.lat, latestCoord.lng);
            
            if (dist >= MOVE_THRESHOLD) {
              // They moved, so do NOT send an alert
              continue;
            }

            // If we reach here, they have moved LESS than 20 meters in 5 minutes (STATIONARY)


            const alertTitle = '⚠️ चेतावनी (Alert)';
            const alertMsg = 'आप पिछले 5 मिनट से एक ही जगह पर हैं। कृपया अपनी लोकेशन अपडेट करें या आगे बढ़ें।';

            try {
              // Create notification in DB
              await Notification.create({
                recipient: emp._id,
                sender: emp._id,
                type: 'alert',
                title: alertTitle,
                message: alertMsg
              });

              // Emit 'alert' socket event
              io.to(`user_${emp._id}`).emit('alert', {
                title: alertTitle,
                message: alertMsg,
                type: 'stationary'
              });

            } catch (dbErr) {
              console.error('Error creating alert notification:', dbErr.message);
            }

            // Notify admins
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

      console.log('⏰ No-movement cron started (5-min interval, All Employees).');
    } catch (err) {
      console.error('Failed to start no-movement cron:', err.message);
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
        