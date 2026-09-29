const { LiveLocation, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');
const { liveCache } = require('../services/cache.service');
const { reverseGeocode } = require('../services/geocode.service');

// Haversine formula (UNTOUCHED AND PRESERVED EXACTLY)
function haversineDistance(p1, p2) {
  const R = 6371;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * (Math.PI / 180); }

// @desc Start tracking session (with multi-tenant organizationId)
exports.startTracking = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const orgId = req.user.organizationId?._id || req.user.organizationId || req.user.organization?._id || req.user.organization || null;

    const addressPromise = reverseGeocode(lat, lng);
    const address = await Promise.race([
      addressPromise,
      new Promise((resolve) => setTimeout(() => resolve(`Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`), 800)),
    ]);

    const session = await LiveLocation.create({
      organizationId: orgId,
      employee: req.user._id,
      sessionId: uuidv4(),
      coordinates: [{ lat, lng, timestamp: new Date(), address }],
      isActive: true,
      date: today,
      startAddress: address,
      startTime: new Date(),
    });

    addressPromise.then(async (realAddr) => {
      if (realAddr !== address) {
        await LiveLocation.findByIdAndUpdate(session._id, {
          startAddress: realAddr,
          'coordinates.0.address': realAddr,
        });
      }
    }).catch(() => {});

    await User.findByIdAndUpdate(req.user._id, {
      isTracking: true,
      isOnline: true,
      lastSeen: new Date(),
      ...(orgId ? { organizationId: orgId } : {}),
    });

    // Attendance check-in scoped by organizationId
    let attendance = await Attendance.findOne({ employee: req.user._id, date: today });
    if (!attendance) {
      attendance = await Attendance.create({
        organizationId: orgId,
        employee: req.user._id,
        date: today,
        checkIn: new Date(),
        status: 'present',
        trackingSessions: [session._id],
      });
    } else {
      attendance.trackingSessions.push(session._id);
      await attendance.save();
    }

    await ActivityLog.create({
      organizationId: orgId,
      employee: req.user._id,
      action: 'TRACKING_START',
      description: 'Location tracking started',
      metadata: { lat, lng, sessionId: session.sessionId },
    });

    const io = req.app.get('io');
    const trackingPayload = {
      employeeId: req.user._id,
      name: req.user.name,
      lat,
      lng,
      sessionId: session.sessionId,
      organizationId: orgId,
    };

    io.to('admins').emit('employee_tracking_started', trackingPayload);
    if (orgId) {
      io.to(`org:${orgId}`).emit('employee_tracking_started', trackingPayload);
      if (req.user.managerId || req.user.manager) {
        const mgrId = req.user.managerId || req.user.manager;
        io.to(`org:${orgId}:mgr:${mgrId}`).emit('employee_tracking_started', trackingPayload);
      }
    }

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update location (bulk coordinates)
exports.updateLocation = async (req, res) => {
  try {
    const { sessionId, coordinates } = req.body;
    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const lastCoord = coordinates[coordinates.length - 1];
    const address = await reverseGeocode(lastCoord.lat, lastCoord.lng);

    const updatedCoords = coordinates.map((c) => ({ ...c, address }));
    session.coordinates.push(...updatedCoords);

    // Exact Distance calculation rules
    const coords = session.coordinates;
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
      totalDist += haversineDistance(coords[i - 1], coords[i]);
    }
    session.totalDistance = totalDist;
    await session.save();

    await User.findByIdAndUpdate(req.user._id, {
      isOnline: true,
      isTracking: true,
      lastSeen: new Date(),
    });

    const io = req.app.get('io');
    const locationData = {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: lastCoord.lat,
      lng: lastCoord.lng,
      speed: lastCoord.speed,
      address,
      totalDistance: totalDist,
      sessionId,
      organizationId: req.user.organizationId,
    };

    io.to('admins').emit('employee_location', locationData);
    if (req.user.organizationId) {
      io.to(`org:${req.user.organizationId}`).emit('employee_location', locationData);
      if (req.user.managerId || req.user.manager) {
        const mgrId = req.user.managerId || req.user.manager;
        io.to(`org:${req.user.organizationId}:mgr:${mgrId}`).emit('employee_location', locationData);
      }
    }

    res.json({ success: true, totalDistance: totalDist });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Stop tracking session
exports.stopTracking = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    session.isActive = false;
    session.endTime = new Date();

    if (session.coordinates.length > 0) {
      session.endAddress = session.coordinates[session.coordinates.length - 1].address;
    }

    await session.save();
    await User.findByIdAndUpdate(req.user._id, { isTracking: false });

    const today = new Date().toISOString().slice(0, 10);
    const allSessions = await LiveLocation.find({ employee: req.user._id, date: today });
    const totalDist = allSessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: today },
      { checkOut: new Date(), totalDistanceTraveled: totalDist }
    );

    await ActivityLog.create({
      organizationId: req.user.organizationId,
      employee: req.user._id,
      action: 'TRACKING_STOP',
      description: `Tracking stopped. Distance: ${totalDist.toFixed(2)} km`,
      metadata: { sessionId, totalDistance: totalDist },
    });

    const io = req.app.get('io');
    const stopData = {
      employeeId: req.user._id,
      name: req.user.name,
      sessionId,
      totalDistance: totalDist,
      organizationId: req.user.organizationId,
    };

    io.to('admins').emit('employee_tracking_stopped', stopData);
    if (req.user.organizationId) {
      io.to(`org:${req.user.organizationId}`).emit('employee_tracking_stopped', stopData);
    }

    res.json({ success: true, totalDistance: totalDist, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get today's tracking sessions
exports.getTodaySessions = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sessions = await LiveLocation.find(
      { employee: req.user._id, date: today },
      { coordinates: 0 }
    ).sort({ createdAt: -1 });
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get session route
exports.getSessionRoute = async (req, res) => {
  try {
    const session = await LiveLocation.findById(req.params.id).populate('employee', 'name employeeId avatar organizationId');
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    // Multi-tenant & ownership authorization check
    const userRole = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();
    const sessionOrgId = session.organizationId?.toString() || session.employee?.organizationId?.toString();

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && sessionOrgId && userOrgId !== sessionOrgId) {
        return res.status(403).json({ success: false, message: 'Access denied to session from another organization.' });
      }
      if (userRole === 'EMPLOYEE' && session.employee?._id?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Unauthorized access to this session.' });
      }
    }

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get all live employees (scoped by tenant and manager)
exports.getLiveEmployees = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user.organizationId?._id || req.user.organizationId;
    const orgObjId = rawOrgId
      ? (mongoose.Types.ObjectId.isValid(rawOrgId) ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId)
      : null;
    const role = req.user.role ? req.user.role.toUpperCase() : '';

    let userFilter = {};
    if (role !== 'SUPER_ADMIN' && role !== 'SUPERADMIN' && orgObjId) {
      userFilter.organizationId = orgObjId;
      if (role === 'MANAGER') {
        userFilter.$or = [{ manager: req.user._id }, { managerId: req.user._id }];
      }
    }
    userFilter.role = { $in: ['EMPLOYEE', 'employee', 'MANAGER', 'manager', 'FIELD_EXECUTIVE'] };

    // Get all employees for this organization/scope
    const employees = await User.find(userFilter)
      .select('name employeeId department avatar isTracking isOnline lastSeen phone email role')
      .lean();

    const empIds = employees.map((e) => e._id);

    // Fetch active live tracking sessions for these employees or organization
    const locFilter = orgObjId
      ? (empIds.length > 0 ? { $or: [{ organizationId: orgObjId }, { employee: { $in: empIds } }], isActive: true } : { organizationId: orgObjId, isActive: true })
      : { isActive: true };

    const locations = await LiveLocation.find(locFilter)
      .populate('employee', 'name employeeId avatar department')
      .lean();

    res.json({ success: true, employees, locations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Geocode proxy
exports.geocode = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng required' });
    const address = await reverseGeocode(parseFloat(lat), parseFloat(lng));
    res.json({ success: true, address });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get live locations (scoped by tenant and manager)
exports.getLiveLocations = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user.organizationId?._id || req.user.organizationId;
    const orgObjId = rawOrgId
      ? (mongoose.Types.ObjectId.isValid(rawOrgId) ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId)
      : null;
    const role = req.user.role ? req.user.role.toUpperCase() : '';

    const cacheKey = `live_loc_${orgObjId || 'all'}_${req.user._id}`;
    if (liveCache.has(cacheKey)) {
      return res.json({ success: true, ...liveCache.get(cacheKey) });
    }

    let userFilter = {};
    if (role !== 'SUPER_ADMIN' && role !== 'SUPERADMIN' && orgObjId) {
      userFilter.organizationId = orgObjId;
      if (role === 'MANAGER') {
        userFilter.$or = [{ manager: req.user._id }, { managerId: req.user._id }];
      }
    }

    const employees = await User.find(userFilter).select('_id');
    const empIds = employees.map((e) => e._id);

    let sessionFilter = { isActive: true };
    if (empIds.length > 0) {
      sessionFilter = {
        $or: [{ organizationId: orgObjId }, { employee: { $in: empIds } }],
        isActive: true,
      };
    } else if (orgObjId && role !== 'SUPER_ADMIN' && role !== 'SUPERADMIN') {
      sessionFilter.organizationId = orgObjId;
    }

    const activeSessions = await LiveLocation.find(sessionFilter)
      .populate('employee', 'name employeeId avatar department')
      .lean();

    const locations = activeSessions.map((session) => {
      const latestCoord = session.coordinates?.[session.coordinates.length - 1] || {};
      return {
        employeeId: session.employee?._id || session.employee,
        name: session.employee?.name || 'Field Staff',
        employeeIdCode: session.employee?.employeeId,
        avatar: session.employee?.avatar,
        department: session.employee?.department,
        lat: latestCoord.lat,
        lng: latestCoord.lng,
        speed: latestCoord.speed || 0,
        address: latestCoord.address,
        totalDistance: session.totalDistance || 0,
        sessionId: session.sessionId,
        startTime: session.startTime,
        updatedAt: latestCoord.timestamp || session.updatedAt,
      };
    });

    const responseData = { locations, count: locations.length };
    liveCache.set(cacheKey, responseData, 5);

    res.json({ success: true, ...responseData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get employee report
exports.getEmployeeReport = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    const userRole = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();

    if (userRole === 'EMPLOYEE' && req.user._id.toString() !== employeeId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const employee = await User.findById(employeeId).select('name employeeId department organizationId');
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && employee.organizationId && userOrgId !== employee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Employee belongs to another organization.' });
      }
    }

    let dateFilter = { employee: employeeId };
    if (startDate && endDate) {
      dateFilter.date = { $gte: startDate, $lte: endDate };
    }

    const sessions = await LiveLocation.find(dateFilter).sort({ date: -1, startTime: -1 });
    const attendance = await Attendance.find(dateFilter).sort({ date: -1 });

    const totalDistance = sessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);
    const presentDays = attendance.filter((a) => a.status === 'present').length;

    res.json({
      success: true,
      report: {
        employee,
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        presentDays,
        totalSessions: sessions.length,
        sessions,
        attendance,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete employee tracking history
exports.deleteEmployeeHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userRole = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();

    const employee = await User.findById(employeeId).select('organizationId');
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && employee.organizationId && userOrgId !== employee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. Employee belongs to another organization.' });
      }
    }

    await LiveLocation.deleteMany({ employee: employeeId });
    res.json({ success: true, message: 'Tracking history deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
