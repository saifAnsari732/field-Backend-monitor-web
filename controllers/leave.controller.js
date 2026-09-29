const { Leave, Notification } = require('../models/index');
const User = require('../models/User.model');

// @desc Apply for leave
exports.applyLeave = async (req, res) => {
  try {
    const { type, startDate, endDate, reason } = req.body;
    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;
    
    // Calculate duration in days
    const start = new Date(startDate);
    const end = new Date(endDate);
    const duration = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    const leave = await Leave.create({
      organizationId: orgId,
      employee: req.user._id,
      type,
      startDate,
      endDate,
      reason,
      duration
    });

    // Notify admins
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('new_leave_request', {
        leave,
        employeeName: req.user.name
      });
      if (orgId) {
        io.to(`org:${orgId}`).emit('new_leave_request', { leave, employeeName: req.user.name });
      }
    }

    res.status(201).json({ success: true, leave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get my leaves
exports.getMyLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find({ employee: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get all leaves (admin / manager)
exports.getAllLeaves = async (req, res) => {
  try {
    const { status, employeeId } = req.query;
    const userRole = (req.user?.role || '').toUpperCase();
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;

    let filter = {};
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN' && rawOrgId) {
      const orgUsers = await User.find({ organizationId: rawOrgId }).select('_id');
      const orgEmpIds = orgUsers.map((u) => u._id);
      if (orgEmpIds.length > 0) {
        filter.$or = [{ organizationId: rawOrgId }, { employee: { $in: orgEmpIds } }];
      } else {
        filter.organizationId = rawOrgId;
      }
    }
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;

    const leaves = await Leave.find(filter)
      .populate('employee', 'name employeeId department avatar')
      .sort({ createdAt: -1 });
    
    res.json({ success: true, leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update leave status (admin)
exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const leave = await Leave.findById(req.params.id).populate('employee', 'name socketId organizationId');
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });

    const leaveOrgId = leave.organizationId?.toString() || leave.employee?.organizationId?.toString();
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && leaveOrgId && userOrgId !== leaveOrgId) {
        return res.status(403).json({ success: false, message: 'Access denied. Leave request belongs to another organization.' });
      }
    }

    leave.status = status;
    leave.approvedBy = req.user._id;
    leave.approvedAt = new Date();
    if (rejectionReason) leave.rejectionReason = rejectionReason;
    await leave.save();

    // Notify employee
    const io = req.app.get('io');
    if (io && leave.employee && leave.employee.socketId) {
      io.to(leave.employee.socketId).emit('leave_status_update', {
        leaveId: leave._id,
        status
      });
    }

    // Create and send real-time notification
    const { sendNotification } = require('../services/notification.service');
    if (io && leave.employee) {
      await sendNotification(io, {
        recipient: leave.employee._id,
        sender: req.user._id,
        type: 'leave',
        title: `Leave ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        message: `Your leave request for ${new Date(leave.startDate).toLocaleDateString()} has been ${status}.`,
        data: { leaveId: leave._id }
      });
    }

    res.json({ success: true, leave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete leave
exports.deleteLeave = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && leave.organizationId && userOrgId !== leave.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await Leave.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Leave deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
