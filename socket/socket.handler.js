const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const HEARTBEAT_TIMEOUT = 60000; // 60 seconds
const heartbeatTimers = new Map(); // Track heartbeat timers per socket

module.exports = (io) => {
  // Auth middleware for socket
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication error'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (!user) return next(new Error('User not found'));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    console.log(`🔌 ${user.name} connected [${user.role}] - ${socket.id}`);

    // Update user socket ID and online status
    await User.findByIdAndUpdate(user._id, { socketId: socket.id, isOnline: true });

    const normalizedRole = user.role ? user.role.toUpperCase() : 'EMPLOYEE';
    const orgId = user.organizationId ? (user.organizationId._id || user.organizationId).toString() : null;

    // Join role-based & organization-based rooms for real-time telemetry
    if (['ORG_ADMIN', 'ADMIN', 'HR', 'SUPER_ADMIN', 'SUPERADMIN', 'MANAGER'].includes(normalizedRole)) {
      socket.join('admins');
      if (orgId) {
        socket.join(`org:${orgId}`);
        socket.join(`org_${orgId}`);
      }
      
      // Send current online employees to admin (case-insensitive role matching)
      let empFilter = { isOnline: true, role: { $in: ['EMPLOYEE', 'employee'] } };
      if (normalizedRole !== 'SUPER_ADMIN' && normalizedRole !== 'SUPERADMIN' && orgId) {
        empFilter.organizationId = orgId;
      }

      const onlineEmployees = await User.find(empFilter)
        .select('name employeeId isTracking isOnline lastSeen avatar department organizationId');
      socket.emit('online_employees', onlineEmployees);
    }

    if (orgId) {
      socket.join(`org:${orgId}`);
      socket.join(`org_${orgId}`);
    }
    socket.join(`user_${user._id}`);

    // ─── Heartbeat Mechanism ────────────────────────────────────────────────────
    const setupHeartbeatTimeout = () => {
      if (heartbeatTimers.has(socket.id)) {
        clearTimeout(heartbeatTimers.get(socket.id));
      }

      const timer = setTimeout(() => {
        console.log(`⏱️ Heartbeat timeout for ${user.name}, disconnecting...`);
        socket.disconnect(true);
      }, HEARTBEAT_TIMEOUT);

      heartbeatTimers.set(socket.id, timer);
    };

    socket.on('heartbeat', (data) => {
      // Reset heartbeat timeout on client heartbeat
      setupHeartbeatTimeout();
      socket.emit('heartbeat_ack', { timestamp: Date.now() });
    });

    setupHeartbeatTimeout();

    // ─── No-Movement Detection ──────────────────────────────────────────────────
    const NO_MOVE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    const MOVE_THRESHOLD_METERS = 20; // less than 20m = not moved

    // Haversine distance in meters
    function haversineMeters(lat1, lng1, lat2, lng2) {
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    let lastKnownPos = null;        // { lat, lng }
    let noMoveTimer = null;         // setTimeout handle
    let stationaryAlertSent = false; // avoid spam

    function resetNoMoveTimer(lat, lng) {
      if (noMoveTimer) clearTimeout(noMoveTimer);
      stationaryAlertSent = false;
      noMoveTimer = setTimeout(() => {
        if (stationaryAlertSent) return;
        stationaryAlertSent = true;
        // Alert employee
        socket.emit('alert', {
          title: '⚠️ Movement Alert',
          message: 'You have been stationary for 5 minutes. Please start moving or update your status.',
          type: 'stationary'
        });
        // Alert admins
        const alertData = {
          employeeId: user._id,
          name: user.name,
          avatar: user.avatar,
          department: user.department,
          organizationId: orgId,
          lat,
          lng,
          timestamp: Date.now(),
          message: `${user.name} has been stationary for 5 minutes.`
        };
        io.to('admins').emit('employee_stationary', alertData);
        if (orgId) {
          io.to(`org:${orgId}`).emit('employee_stationary', alertData);
        }
        console.log(`⚠️ Stationary alert sent for ${user.name}`);
      }, NO_MOVE_TIMEOUT);
    }

    // ─── Tracking Events ────────────────────────────────────────────────────────
    socket.on('location_ping', async (data) => {
      const { lat, lng } = data;

      // Check movement
      if (lastKnownPos && lat && lng) {
        const dist = haversineMeters(lastKnownPos.lat, lastKnownPos.lng, lat, lng);
        if (dist >= MOVE_THRESHOLD_METERS) {
          lastKnownPos = { lat, lng };
          resetNoMoveTimer(lat, lng);
        }
      } else if (lat && lng) {
        lastKnownPos = { lat, lng };
        resetNoMoveTimer(lat, lng);
      }

      const locationPayload = {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        department: user.department,
        organizationId: orgId,
        ...data,
      };

      // Real-time location broadcast to admins & organization room
      io.to('admins').emit('employee_location', locationPayload);
      if (orgId) {
        io.to(`org:${orgId}`).emit('employee_location', locationPayload);
        io.to(`org_${orgId}`).emit('employee_location', locationPayload);
      }
    });

    socket.on('tracking_started', (data) => {
      const startedPayload = {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        organizationId: orgId,
        ...data,
      };

      io.to('admins').emit('employee_tracking_started', startedPayload);
      if (orgId) {
        io.to(`org:${orgId}`).emit('employee_tracking_started', startedPayload);
        io.to(`org_${orgId}`).emit('employee_tracking_started', startedPayload);
      }
    });

    socket.on('tracking_stopped', (data) => {
      if (noMoveTimer) { clearTimeout(noMoveTimer); noMoveTimer = null; }
      lastKnownPos = null;
      stationaryAlertSent = false;

      const stoppedPayload = {
        employeeId: user._id,
        name: user.name,
        organizationId: orgId,
        ...data,
      };

      io.to('admins').emit('employee_tracking_stopped', stoppedPayload);
      if (orgId) {
        io.to(`org:${orgId}`).emit('employee_tracking_stopped', stoppedPayload);
        io.to(`org_${orgId}`).emit('employee_tracking_stopped', stoppedPayload);
      }
    });

    // ─── Chat / Notifications ────────────────────────────────────────────────────
    socket.on('send_notification', async (data) => {
      const { recipientId, title, message, type } = data;
      io.to(`user_${recipientId}`).emit('notification', {
        title,
        message,
        type,
        from: user.name,
      });
    });

    socket.on('admin_alert', (data) => {
      io.to(`user_${data.employeeId}`).emit('alert', {
        message: data.message,
        from: 'Admin',
      });
    });

    // ─── Disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`🔌 ${user.name} disconnected`);

      // Clear heartbeat timer
      if (heartbeatTimers.has(socket.id)) {
        clearTimeout(heartbeatTimers.get(socket.id));
        heartbeatTimers.delete(socket.id);
      }
      // Clear no-movement timer
      if (noMoveTimer) { clearTimeout(noMoveTimer); noMoveTimer = null; }

      await User.findByIdAndUpdate(user._id, {
        isOnline: false,
        lastSeen: new Date(),
        socketId: null,
      });

      io.to('admins').emit('employee_offline', {
        employeeId: user._id,
        name: user.name,
      });
    });

    // ─── Error Handling ─────────────────────────────────────────────────────────
    socket.on('error', (error) => {
      console.error(`Socket error for ${user.name}:`, error);
    });

    // Confirm connection to client
    socket.emit('connected', {
      message: 'Connected to server',
      userId: user._id,
      timestamp: Date.now(),
    });
  });

  // Cleanup on server shutdown
  io.on('disconnect', (socket) => {
    if (heartbeatTimers.has(socket.id)) {
      clearTimeout(heartbeatTimers.get(socket.id));
      heartbeatTimers.delete(socket.id);
    }
  });
};
