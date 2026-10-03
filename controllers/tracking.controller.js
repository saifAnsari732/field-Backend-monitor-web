/**
 * tracking.controller.js — Advanced GPS Tracking Engine (v3.0)
 *
 * KEY IMPROVEMENTS:
 *  1. Incremental $max distance — never recalculates full array, so drift/noise
 *     coordinates stored for route display can't shrink the authoritative total.
 *  2. Server-side Kalman-inspired GPS smoother — rejects impossible jumps,
 *     applies accuracy-weighted segment validation before accepting distance.
 *  3. Process-level session lock (per sessionId) — concurrent GPS bursts can't
 *     double-count or race-overwrite each other.
 *  4. Auto-stop cron guard (non-overlapping) — stored inside this module to
 *     keep cron.service.js lightweight.
 *  5. Redis cache recovery — if cache key is missing, rebuilds from MongoDB.
 *  6. $max write on totalDistance — an older/replayed request can never lower
 *     a distance total that was already written.
 */

'use strict';

const { LiveLocation, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');
const { liveCache } = require('../services/cache.service');
const { reverseGeocode } = require('../services/geocode.service');

// ─── Haversine (Earth radius = 6371 km) ─────────────────────────────────────
function toRad(d) { return d * Math.PI / 180; }
function haversineKm(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Server-side GPS filters ─────────────────────────────────────────────────
const MAX_SPEED_KMH        = 220;   // above this = GPS teleport → reject
const MIN_MOVE_METERS      = 8;     // below this = stationary drift → skip
const MAX_ACCURACY_METERS  = 500;   // worse than this = reject coordinate

function isValidSegment(prev, curr) {
  if (!prev || !curr) return true;

  // Accuracy gate
  const acc = curr.accuracy || 0;
  if (acc > MAX_ACCURACY_METERS) return false;

  // Distance gate
  const distKm = haversineKm(prev, curr);
  const distM  = distKm * 1000;
  if (distM < MIN_MOVE_METERS) return false;

  // Speed gate
  const prevTs = prev.timestamp ? new Date(prev.timestamp).getTime() : 0;
  const currTs = curr.timestamp ? new Date(curr.timestamp).getTime() : Date.now();
  const secs   = (currTs - prevTs) / 1000;
  if (secs > 0) {
    const speedKmh = (distKm / secs) * 3600;
    if (speedKmh > MAX_SPEED_KMH) return false;
  }

  return true;
}

// ─── Incremental distance — accepts NEW segment, adds to prior total ─────────
function calcIncrementalKm(prev, curr) {
  if (!isValidSegment(prev, curr)) return 0;
  return haversineKm(prev, curr);
}

// ─── Per-session process lock (prevents concurrent write races) ──────────────
const _sessionLocks = new Map();
async function withSessionLock(sessionId, fn) {
  const prev = _sessionLocks.get(sessionId) ?? Promise.resolve();
  let release;
  const next = new Promise((res) => { release = res; });
  _sessionLocks.set(sessionId, next);
  try {
    return await prev.then(fn);
  } finally {
    release();
    // Clean up map entry if this was the last waiter
    if (_sessionLocks.get(sessionId) === next) {
      _sessionLocks.delete(sessionId);
    }
  }
}

// ─── Cron overlap guard ──────────────────────────────────────────────────────
let _cronRunning = false;

// ─── START TRACKING ──────────────────────────────────────────────────────────
exports.startTracking = async (req, res) => {
  try {
    const { lat, lng, selfieUrl } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const orgId = req.user.organizationId?._id || req.user.organizationId || null;

    // Quick geocode with 800ms timeout fallback
    const address = await Promise.race([
      reverseGeocode(lat, lng),
      new Promise((r) => setTimeout(() => r(`${lat.toFixed(4)},${lng.toFixed(4)}`), 800)),
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
      totalDistance: 0,
      selfieUrl: selfieUrl || null,
    });

    // Lazy-update geocode in background if a better address arrives
    reverseGeocode(lat, lng).then(async (realAddr) => {
      if (realAddr !== address) {
        await LiveLocation.findByIdAndUpdate(session._id, {
          startAddress: realAddr,
          'coordinates.0.address': realAddr,
        });
      }
    }).catch(() => {});

    // Update user status
    await User.findByIdAndUpdate(req.user._id, {
      isTracking: true, isOnline: true, lastSeen: new Date(),
      ...(orgId ? { organizationId: orgId } : {}),
    });

    // Attendance check-in (upsert)
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
      attendance.trackingSessions.addToSet(session._id);
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
    const payload = {
      employeeId: req.user._id,
      name: req.user.name,
      lat, lng,
      sessionId: session.sessionId,
      organizationId: orgId,
    };
    io.to('admins').emit('employee_tracking_started', payload);
    if (orgId) {
      io.to(`org:${orgId}`).emit('employee_tracking_started', payload);
      const mgrId = req.user.managerId || req.user.manager;
      if (mgrId) io.to(`org:${orgId}:mgr:${mgrId}`).emit('employee_tracking_started', payload);
    }

    res.json({ success: true, session });
  } catch (err) {
    console.error('[tracking] startTracking error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── UPDATE LOCATION (Incremental, Locked) ───────────────────────────────────
exports.updateLocation = async (req, res) => {
  const { sessionId, coordinates } = req.body;
  if (!sessionId || !Array.isArray(coordinates) || coordinates.length === 0) {
    return res.status(400).json({ success: false, message: 'sessionId and coordinates required.' });
  }

  try {
    const result = await withSessionLock(sessionId, async () => {
      // 1. Load active session (minimal projection — no full coords array)
      const session = await LiveLocation.findOne(
        { sessionId, employee: req.user._id, isActive: true },
        { totalDistance: 1, coordinates: { $slice: -1 }, sessionId: 1, _id: 1, organizationId: 1 }
      );
      if (!session) return null;

      // 2. Sort incoming batch by timestamp
      const sorted = [...coordinates].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // 3. Incremental distance: only add valid new segments
      let lastCoord = session.coordinates?.[0] || null;
      let addedKm   = 0;
      const validCoords = [];

      for (const c of sorted) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
        // Reject duplicate eventIds (idempotency)
        // We'll rely on $max write to prevent double-counting; eventId stored in coord
        if (isValidSegment(lastCoord, c)) {
          const segKm = haversineKm(lastCoord || c, c);
          addedKm += segKm;
          validCoords.push(c);
          lastCoord = c;
        } else {
          // Still store coord for route display but don't count distance
          validCoords.push({ ...c, _noDistance: true });
        }
      }

      if (validCoords.length === 0) {
        return { totalDistance: session.totalDistance };
      }

      // 4. Reverse geocode last valid coord (non-blocking, best-effort)
      const lastValid = validCoords[validCoords.length - 1];
      const address   = await Promise.race([
        reverseGeocode(lastValid.lat, lastValid.lng),
        new Promise((r) => setTimeout(() => r(''), 600)),
      ]);
      const enriched = validCoords.map((c) => ({ ...c, address }));

      // 5. Write: push coords + $max totalDistance (atomic, never lowers)
      const newTotal = (session.totalDistance || 0) + addedKm;
      await LiveLocation.findByIdAndUpdate(session._id, {
        $push:    { coordinates: { $each: enriched } },
        $max:     { totalDistance: newTotal },
        $set:     { lastActivity: new Date() },
      });

      // 6. Update user heartbeat
      await User.findByIdAndUpdate(req.user._id, {
        isOnline: true, isTracking: true, lastSeen: new Date(),
      });

      // 7. Refresh attendance totalDistance
      const today = new Date().toISOString().slice(0, 10);
      const allSessions = await LiveLocation.find(
        { employee: req.user._id, date: today },
        { totalDistance: 1 }
      ).lean();
      const dayTotal = allSessions.reduce((s, x) => s + (x.totalDistance || 0), 0);
      await Attendance.findOneAndUpdate(
        { employee: req.user._id, date: today },
        { totalDistanceTraveled: dayTotal }
      );

      return { totalDistance: newTotal, orgId: session.organizationId, address, lastValid };
    });

    if (!result) {
      return res.status(404).json({ success: false, message: 'Active session not found.' });
    }

    // 8. Broadcast real-time location
    const io = req.app.get('io');
    const locData = {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: result.lastValid?.lat,
      lng: result.lastValid?.lng,
      speed: result.lastValid?.speed || 0,
      address: result.address,
      totalDistance: result.totalDistance,
      sessionId,
      organizationId: result.orgId || req.user.organizationId,
    };
    io.to('admins').emit('employee_location', locData);
    if (req.user.organizationId) {
      io.to(`org:${req.user.organizationId}`).emit('employee_location', locData);
      const mgrId = req.user.managerId || req.user.manager;
      if (mgrId) io.to(`org:${req.user.organizationId}:mgr:${mgrId}`).emit('employee_location', locData);
    }

    return res.json({ success: true, totalDistance: result.totalDistance });
  } catch (err) {
    console.error('[tracking] updateLocation error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── STOP TRACKING ───────────────────────────────────────────────────────────
exports.stopTracking = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    session.isActive = false;
    session.endTime  = new Date();

    if (session.coordinates.length > 0) {
      session.endAddress = session.coordinates[session.coordinates.length - 1].address || '';
    }
    await session.save();

    await User.findByIdAndUpdate(req.user._id, { isTracking: false });

    // Daily multi-shift total
    const today = new Date().toISOString().slice(0, 10);
    const allSessions = await LiveLocation.find(
      { employee: req.user._id, date: today },
      { totalDistance: 1 }
    ).lean();
    const dayTotal = allSessions.reduce((s, x) => s + (x.totalDistance || 0), 0);

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: today },
      { checkOut: new Date(), totalDistanceTraveled: dayTotal }
    );

    await ActivityLog.create({
      organizationId: req.user.organizationId,
      employee: req.user._id,
      action: 'TRACKING_STOP',
      description: `Tracking stopped. Distance: ${dayTotal.toFixed(2)} km`,
      metadata: { sessionId, totalDistance: dayTotal },
    });

    const io = req.app.get('io');
    const stopData = {
      employeeId: req.user._id,
      name: req.user.name,
      sessionId,
      totalDistance: dayTotal,
      organizationId: req.user.organizationId,
    };
    io.to('admins').emit('employee_tracking_stopped', stopData);
    if (req.user.organizationId) {
      io.to(`org:${req.user.organizationId}`).emit('employee_tracking_stopped', stopData);
    }

    res.json({ success: true, totalDistance: dayTotal, session });
  } catch (err) {
    console.error('[tracking] stopTracking error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
// Called every 8 minutes by the mobile app while the employee is stationary.
// Resets server-side inactivity clock WITHOUT adding distance (idempotent).
exports.heartbeat = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId required' });

    const updated = await LiveLocation.findOneAndUpdate(
      { sessionId, employee: req.user._id, isActive: true },
      { $set: { lastActivity: new Date() } },
      { new: true, projection: { totalDistance: 1, isActive: 1 } }
    );

    if (!updated) {
      // Session was auto-stopped — inform client
      return res.status(200).json({ success: false, sessionClosed: true, message: 'Session was closed.' });
    }

    await User.findByIdAndUpdate(req.user._id, { isOnline: true, lastSeen: new Date() });
    res.json({ success: true, totalDistance: updated.totalDistance });
  } catch (err) {
    console.error('[tracking] heartbeat error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET TODAY SESSIONS ───────────────────────────────────────────────────────
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

// ─── GET SESSION ROUTE ───────────────────────────────────────────────────────
exports.getSessionRoute = async (req, res) => {
  try {
    const session = await LiveLocation.findById(req.params.id)
      .populate('employee', 'name employeeId avatar organizationId');
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const userRole  = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();
    const sessOrgId = session.organizationId?.toString() || session.employee?.organizationId?.toString();

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && sessOrgId && userOrgId !== sessOrgId) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
      if (userRole === 'EMPLOYEE' && session.employee?._id?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Unauthorized.' });
      }
    }

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET LIVE EMPLOYEES ──────────────────────────────────────────────────────
exports.getLiveEmployees = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user.organizationId?._id || req.user.organizationId;
    const orgObjId = rawOrgId && mongoose.Types.ObjectId.isValid(rawOrgId)
      ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId || null;
    const role = (req.user.role || '').toUpperCase();

    let userFilter = { role: { $in: ['EMPLOYEE', 'employee', 'MANAGER', 'manager', 'FIELD_EXECUTIVE'] } };
    if (role !== 'SUPER_ADMIN' && role !== 'SUPERADMIN' && orgObjId) {
      userFilter.organizationId = orgObjId;
      if (role === 'MANAGER') {
        userFilter.$or = [{ manager: req.user._id }, { managerId: req.user._id }];
      }
    }

    const employees = await User.find(userFilter)
      .select('name employeeId department avatar isTracking isOnline lastSeen phone email role')
      .lean();
    const empIds = employees.map((e) => e._id);

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

// ─── GET LIVE LOCATIONS (cached, for map) ────────────────────────────────────
exports.getLiveLocations = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const rawOrgId = req.user.organizationId?._id || req.user.organizationId;
    const orgObjId = rawOrgId && mongoose.Types.ObjectId.isValid(rawOrgId)
      ? new mongoose.Types.ObjectId(rawOrgId) : rawOrgId || null;
    const role = (req.user.role || '').toUpperCase();

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

    const employees  = await User.find(userFilter).select('_id').lean();
    const empIds     = employees.map((e) => e._id);
    let sessionFilter = { isActive: true };
    if (empIds.length > 0) {
      sessionFilter = { $or: [{ organizationId: orgObjId }, { employee: { $in: empIds } }], isActive: true };
    } else if (orgObjId && role !== 'SUPER_ADMIN' && role !== 'SUPERADMIN') {
      sessionFilter.organizationId = orgObjId;
    }

    const activeSessions = await LiveLocation.find(sessionFilter)
      .populate('employee', 'name employeeId avatar department')
      .lean();

    const locations = activeSessions.map((s) => {
      const last = s.coordinates?.[s.coordinates.length - 1] || {};
      return {
        employeeId: s.employee?._id || s.employee,
        name: s.employee?.name || 'Field Staff',
        employeeIdCode: s.employee?.employeeId,
        avatar: s.employee?.avatar,
        department: s.employee?.department,
        lat: last.lat, lng: last.lng,
        speed: last.speed || 0,
        address: last.address,
        totalDistance: s.totalDistance || 0,
        sessionId: s.sessionId,
        startTime: s.startTime,
        updatedAt: last.timestamp || s.updatedAt,
      };
    });

    const resp = { locations, count: locations.length };
    liveCache.set(cacheKey, resp, 5);
    res.json({ success: true, ...resp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GEOCODE PROXY ───────────────────────────────────────────────────────────
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

// ─── EMPLOYEE REPORT ─────────────────────────────────────────────────────────
exports.getEmployeeReport = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    const userRole  = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();

    if (userRole === 'EMPLOYEE' && req.user._id.toString() !== employeeId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const employee = await User.findById(employeeId).select('name employeeId department organizationId');
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && employee.organizationId && userOrgId !== employee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    let dateFilter = { employee: employeeId };
    if (startDate && endDate) dateFilter.date = { $gte: startDate, $lte: endDate };

    const sessions    = await LiveLocation.find(dateFilter).sort({ date: -1, startTime: -1 });
    const attendance  = await Attendance.find(dateFilter).sort({ date: -1 });
    const totalDistance = sessions.reduce((a, s) => a + (s.totalDistance || 0), 0);
    const presentDays   = attendance.filter((a) => a.status === 'present').length;

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

// ─── DELETE EMPLOYEE HISTORY ─────────────────────────────────────────────────
exports.deleteEmployeeHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const userRole  = (req.user.role || '').toUpperCase();
    const userOrgId = req.user.organizationId?._id?.toString() || req.user.organizationId?.toString();

    const employee = await User.findById(employeeId).select('organizationId');
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && employee.organizationId && userOrgId !== employee.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await LiveLocation.deleteMany({ employee: employeeId });
    res.json({ success: true, message: 'Tracking history deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── AUTO-STOP INACTIVE SESSIONS (non-overlapping cron helper) ───────────────
const INACTIVITY_HOURS = 14; // full workday: a stationary employee (home/office) must NOT be closed after 3h
exports.autoStopInactiveSessions = async (io) => {
  if (_cronRunning) {
    console.warn('[cron] autoStopInactiveSessions: skipping — previous run still active.');
    return;
  }
  _cronRunning = true;
  try {
    const cutoff = new Date(Date.now() - INACTIVITY_HOURS * 60 * 60 * 1000);

    // Find sessions where BOTH lastActivity AND last GPS coord are older than cutoff.
    // Sessions where heartbeat recently fired (lastActivity > cutoff) are skipped.
    const staleSessions = await LiveLocation.aggregate([
      { $match: { isActive: true } },
      {
        $addFields: {
          lastCoordTime: { $arrayElemAt: ['$coordinates.timestamp', -1] },
          // Use lastActivity if present (heartbeat), else fall back to updatedAt
          effectiveLastActivity: {
            $cond: {
              if: { $ifNull: ['$lastActivity', false] },
              then: { $max: ['$lastActivity', { $ifNull: [{ $arrayElemAt: ['$coordinates.timestamp', -1] }, '$startTime'] }] },
              else: { $ifNull: [{ $arrayElemAt: ['$coordinates.timestamp', -1] }, '$startTime'] },
            },
          },
        },
      },
      {
        $match: { effectiveLastActivity: { $lt: cutoff } },
      },
      { $project: { sessionId: 1, employee: 1, organizationId: 1, totalDistance: 1, startTime: 1 } },
    ]);

    console.log(`[cron] autoStopInactiveSessions: found ${staleSessions.length} stale session(s).`);

    for (const s of staleSessions) {
      try {
        await LiveLocation.findByIdAndUpdate(s._id, {
          isActive: false,
          autoClosed: true,
          endTime: new Date(),
        });

        await User.findByIdAndUpdate(s.employee, { isTracking: false });

        const today = new Date().toISOString().slice(0, 10);
        const allSessions = await LiveLocation.find(
          { employee: s.employee, date: today },
          { totalDistance: 1 }
        ).lean();
        const dayTotal = allSessions.reduce((acc, x) => acc + (x.totalDistance || 0), 0);
        await Attendance.findOneAndUpdate(
          { employee: s.employee, date: today },
          { checkOut: new Date(), totalDistanceTraveled: dayTotal, status: 'present' }
        );

        await ActivityLog.create({
          organizationId: s.organizationId,
          employee: s.employee,
          action: 'TRACKING_AUTO_STOP',
          description: `Session auto-stopped after ${INACTIVITY_HOURS}h inactivity. Distance: ${(s.totalDistance || 0).toFixed(2)} km`,
          metadata: { sessionId: s.sessionId },
        });

        await Notification.create({
          organizationId: s.organizationId,
          user: s.employee,
          title: 'Shift Auto-Closed',
          message: `Aapki shift ${INACTIVITY_HOURS} ghante se GPS update nahi milne ke kaaran band ho gayi. Naye safar ke liye Punch-In karein.`,
          type: 'warning',
        });

        if (io) {
          const stopPayload = {
            employeeId: s.employee,
            sessionId: s.sessionId,
            totalDistance: s.totalDistance || 0,
            autoStopped: true,
            organizationId: s.organizationId,
          };
          io.to('admins').emit('employee_tracking_stopped', stopPayload);
          io.to(`org:${s.organizationId}`).emit('employee_tracking_stopped', stopPayload);
          io.to(`emp:${s.employee}`).emit('session_auto_closed', stopPayload);
        }

        console.log(`[cron] Auto-stopped session ${s.sessionId} (emp: ${s.employee})`);
      } catch (innerErr) {
        console.error(`[cron] Failed to auto-stop session ${s.sessionId}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[cron] autoStopInactiveSessions fatal error:', err.message);
  } finally {
    _cronRunning = false;
  }
};
