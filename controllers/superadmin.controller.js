const Organization = require('../models/Organization.model');
const User = require('../models/User.model');
const Plan = require('../models/Plan.model');
const AuditLog = require('../models/AuditLog.model');
const Payment = require('../models/Payment.model');

// Get SuperAdmin Dashboard Summary Stats
exports.getSuperAdminStats = async (req, res) => {
  try {
    const { LiveLocation } = require('../models/index');
    const totalOrgs = await Organization.countDocuments();
    const activeOrgs = await Organization.countDocuments({ status: 'active' });
    const trialOrgs = await Organization.countDocuments({ status: 'trial' });
    const suspendedOrgs = await Organization.countDocuments({ status: 'suspended' });

    const totalUsers = await User.countDocuments();
    const totalEmployees = await User.countDocuments({ role: { $in: ['EMPLOYEE', 'employee'] } });
    const totalManagers = await User.countDocuments({ role: { $in: ['MANAGER', 'manager'] } });

    const totalKmData = await LiveLocation.aggregate([
      { $group: { _id: null, totalKm: { $sum: '$totalDistance' } } },
    ]);
    const totalDistanceTracked = parseFloat((totalKmData[0]?.totalKm || 0).toFixed(2));

    // Revenue Aggregation from Paid Payments
    const revenueAggregate = await Payment.aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, totalRevenue: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const totalRevenue = revenueAggregate[0]?.totalRevenue || 0;
    const paidTransactionsCount = revenueAggregate[0]?.count || 0;

    res.json({
      success: true,
      data: {
        totalOrgs,
        activeOrgs,
        trialOrgs,
        suspendedOrgs,
        totalUsers,
        totalEmployees,
        totalManagers,
        totalDistanceTracked,
        totalRevenue,
        paidTransactionsCount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create New Organization & Initial Admin
exports.createOrganization = async (req, res) => {
  try {
    const { name, email, phone, address, adminName, adminEmail, adminPassword, planName, maxEmployees, maxManagers } = req.body;

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.floor(1000 + Math.random() * 9000);

    const existingOrg = await Organization.findOne({ email });
    if (existingOrg) {
      return res.status(400).json({ success: false, message: 'An organization with this email already exists.' });
    }

    const org = await Organization.create({
      name,
      slug,
      email,
      phone,
      address,
      status: 'active',
      plan: {
        planName: planName || 'Business Standard',
        maxEmployees: maxEmployees || 50,
        maxManagers: maxManagers || 10,
        startsAt: new Date(),
      },
    });

    const adminUser = await User.create({
      organizationId: org._id,
      name: adminName || `${name} Admin`,
      email: adminEmail || email,
      password: adminPassword || 'Admin@12345',
      role: 'ORG_ADMIN',
      phone,
      isActive: true,
    });

    // Log action
    await AuditLog.create({
      organizationId: org._id,
      actorUserId: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'ORGANIZATION_CREATED',
      targetType: 'Organization',
      targetId: org._id.toString(),
      metadata: { orgName: name, adminEmail },
    });

    res.status(201).json({
      success: true,
      message: 'Organization created successfully!',
      data: { org, adminUser },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// List all Organizations with search & pagination
exports.getAllOrganizations = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 50 } = req.query;
    let query = {};

    if (status) query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }

    const orgs = await Organization.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Organization.countDocuments(query);

    // Populate live employee count, manager count, and total revenue per org
    const orgsWithCounts = await Promise.all(
      orgs.map(async (org) => {
        const empCount = await User.countDocuments({ organizationId: org._id, role: { $in: ['EMPLOYEE', 'employee'] } });
        const mgrCount = await User.countDocuments({ organizationId: org._id, role: { $in: ['MANAGER', 'manager'] } });
        
        const orgRevenueRes = await Payment.aggregate([
          { $match: { organization: org._id, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);
        const orgRevenue = orgRevenueRes[0]?.total || 0;

        return {
          ...org.toObject(),
          currentEmployeeCount: empCount,
          currentManagerCount: mgrCount,
          totalRevenuePaid: orgRevenue,
        };
      })
    );

    res.json({
      success: true,
      data: orgsWithCounts,
      pagination: { total, page: Number(page), pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update Organization Status (Activate / Suspend)
exports.updateOrganizationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const org = await Organization.findByIdAndUpdate(id, { status }, { new: true });
    if (!org) return res.status(404).json({ success: false, message: 'Organization not found.' });

    await AuditLog.create({
      organizationId: org._id,
      actorUserId: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: `ORGANIZATION_STATUS_${status.toUpperCase()}`,
      targetType: 'Organization',
      targetId: org._id.toString(),
    });

    res.json({
      success: true,
      message: `Organization status updated to ${status}.`,
      data: org,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update Organization Subscription / Plan Details
exports.updateOrgSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { planName, maxEmployees, maxManagers, addDays } = req.body;

    const org = await Organization.findById(id);
    if (!org) return res.status(404).json({ success: false, message: 'Organization not found.' });

    if (planName) org.plan.planName = planName;
    if (maxEmployees) org.plan.maxEmployees = Number(maxEmployees);
    if (maxManagers) org.plan.maxManagers = Number(maxManagers);

    if (addDays && Number(addDays) > 0) {
      const currentExpiry = org.plan.expiresAt ? new Date(org.plan.expiresAt) : new Date();
      const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
      baseDate.setDate(baseDate.getDate() + Number(addDays));
      org.plan.expiresAt = baseDate;
    }

    org.status = 'active';
    await org.save();

    res.json({
      success: true,
      message: 'Subscription updated successfully!',
      data: org,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get All Payments & Transactions Ledger for Super Admin
exports.getAllPayments = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    let filter = {};

    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate('organization', 'name email phone slug')
      .populate('user', 'name email role')
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const totalCount = await Payment.countDocuments(filter);

    // Summary calculations
    const summary = await Payment.aggregate([
      {
        $group: {
          _id: '$status',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    let totalRevenue = 0;
    let paidCount = 0;
    let failedCount = 0;
    let createdCount = 0;

    summary.forEach((item) => {
      if (item._id === 'paid') {
        totalRevenue = item.totalAmount;
        paidCount = item.count;
      } else if (item._id === 'failed') {
        failedCount = item.count;
      } else if (item._id === 'created') {
        createdCount = item.count;
      }
    });

    res.json({
      success: true,
      payments,
      pagination: {
        total: totalCount,
        page: Number(page),
        pages: Math.ceil(totalCount / limit),
      },
      summary: {
        totalRevenue,
        paidCount,
        failedCount,
        createdCount,
        avgOrderValue: paidCount > 0 ? Math.round(totalRevenue / paidCount) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// 🎟️ SUPER ADMIN COUPON MANAGEMENT
// ============================================================================

// 1. Get All Coupons
exports.getAllCoupons = async (req, res) => {
  try {
    const Coupon = require('../models/Coupon.model');
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ success: true, coupons, count: coupons.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Create New Coupon
exports.createCoupon = async (req, res) => {
  try {
    const Coupon = require('../models/Coupon.model');
    const {
      code,
      description,
      discountType,
      discountValue,
      minOrderAmount,
      maxDiscountAmount,
      maxUses,
      validTill,
    } = req.body;

    if (!code || !discountValue) {
      return res.status(400).json({ success: false, message: 'Coupon code and discount value are required.' });
    }

    const cleanCode = code.toUpperCase().trim();
    const existing = await Coupon.findOne({ code: cleanCode });
    if (existing) {
      return res.status(400).json({ success: false, message: `Coupon with code "${cleanCode}" already exists.` });
    }

    const newCoupon = await Coupon.create({
      code: cleanCode,
      description: description || '',
      discountType: discountType || 'percentage',
      discountValue: Number(discountValue),
      minOrderAmount: minOrderAmount ? Number(minOrderAmount) : 0,
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
      maxUses: maxUses ? Number(maxUses) : 100,
      validTill: validTill ? new Date(validTill) : null,
      isActive: true,
      createdBy: req.user?._id || null,
    });

    res.status(201).json({
      success: true,
      message: `Coupon "${cleanCode}" created successfully!`,
      coupon: newCoupon,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Toggle Coupon Active / Inactive
exports.toggleCouponStatus = async (req, res) => {
  try {
    const Coupon = require('../models/Coupon.model');
    const { id } = req.params;

    const coupon = await Coupon.findById(id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    coupon.isActive = !coupon.isActive;
    await coupon.save();

    res.json({
      success: true,
      message: `Coupon ${coupon.code} is now ${coupon.isActive ? 'Active' : 'Inactive'}.`,
      coupon,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 4. Delete Coupon
exports.deleteCoupon = async (req, res) => {
  try {
    const Coupon = require('../models/Coupon.model');
    const { id } = req.params;

    const coupon = await Coupon.findByIdAndDelete(id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    res.json({
      success: true,
      message: `Coupon "${coupon.code}" deleted successfully.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// 👥 GLOBAL USERS DIRECTORY MANAGEMENT (CROSS-TENANT)
// ============================================================================

exports.getAllUsers = async (req, res) => {
  try {
    const { role, status, organizationId, search, page = 1, limit = 50 } = req.query;
    let query = {};

    if (role && role !== 'all') {
      query.role = { $regex: new RegExp(`^${role}$`, 'i') };
    }
    if (status && status !== 'all') {
      if (status === 'active') query.isActive = true;
      if (status === 'inactive') query.isActive = false;
      if (status === 'blocked') query.isBlocked = true;
    }
    if (organizationId && organizationId !== 'all') {
      query.organizationId = organizationId;
    }
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .populate('organizationId', 'name slug email phone status plan')
      .populate('manager', 'name email')
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    const total = await User.countDocuments(query);

    const roleStats = {
      totalUsers: await User.countDocuments(),
      orgAdmins: await User.countDocuments({ role: { $in: ['ORG_ADMIN', 'admin', 'hr'] } }),
      managers: await User.countDocuments({ role: { $in: ['MANAGER', 'manager'] } }),
      employees: await User.countDocuments({ role: { $in: ['EMPLOYEE', 'employee', 'agent'] } }),
      activeUsers: await User.countDocuments({ isActive: true }),
      onlineUsers: await User.countDocuments({ isOnline: true }),
    };

    res.json({
      success: true,
      users,
      roleStats,
      pagination: { total, page: Number(page), pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, isBlocked } = req.body;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (typeof isActive === 'boolean') user.isActive = isActive;
    if (typeof isBlocked === 'boolean') user.isBlocked = isBlocked;

    await user.save();

    await AuditLog.create({
      organizationId: user.organizationId,
      actorUserId: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: `SUPER_ADMIN_USER_STATUS_UPDATED`,
      targetType: 'User',
      targetId: user._id.toString(),
      metadata: { newStatus: { isActive: user.isActive, isBlocked: user.isBlocked } },
    });

    res.json({
      success: true,
      message: `User status updated successfully!`,
      user,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.password = newPassword;
    await user.save();

    await AuditLog.create({
      organizationId: user.organizationId,
      actorUserId: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: `SUPER_ADMIN_PASSWORD_RESET`,
      targetType: 'User',
      targetId: user._id.toString(),
      metadata: { targetEmail: user.email },
    });

    res.json({
      success: true,
      message: `Password reset successfully for ${user.name} (${user.email})!`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// 📡 LIVE TELEMETRY & AUDIT STREAM (CROSS-TENANT)
// ============================================================================

exports.getLivePlatformActivity = async (req, res) => {
  try {
    const { LiveLocation, Meeting, Attendance } = require('../models/index');

    // 1. Currently Active Tracking Sessions
    const activeTrackingSessions = await LiveLocation.find({ isActive: true })
      .populate('employee', 'name email phone avatar role department employeeId')
      .populate('organizationId', 'name slug status')
      .sort({ updatedAt: -1 })
      .limit(50);

    // 2. Recent Audit Logs
    const recentAudits = await AuditLog.find()
      .populate('organizationId', 'name slug')
      .sort({ createdAt: -1 })
      .limit(60);

    // 3. Today's Punch-Ins & Visits
    const recentVisits = await Meeting.find()
      .populate('employee', 'name email phone')
      .populate('organizationId', 'name slug')
      .sort({ createdAt: -1 })
      .limit(30);

    res.json({
      success: true,
      activeTrackingSessions,
      recentAudits,
      recentVisits,
      stats: {
        activeTrackingCount: activeTrackingSessions.length,
        totalAuditsRecorded: await AuditLog.countDocuments(),
        totalVisitsRecorded: await Meeting.countDocuments(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// 📢 PLATFORM BROADCASTS & ANNOUNCEMENTS (REAL-TIME + PERSISTED)
// ============================================================================

exports.getBroadcasts = async (req, res) => {
  try {
    const Broadcast = require('../models/Broadcast.model');
    const broadcasts = await Broadcast.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, broadcasts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendBroadcast = async (req, res) => {
  try {
    const Broadcast = require('../models/Broadcast.model');
    const { Notification } = require('../models/index');
    const { title, message, targetRole = 'ALL', organizationId = 'ALL', priority = 'high', category = 'general' } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message are required.' });
    }

    let userQuery = { isActive: true };
    if (targetRole && targetRole !== 'ALL') {
      userQuery.role = { $regex: new RegExp(`^${targetRole}$`, 'i') };
    }
    if (organizationId && organizationId !== 'ALL') {
      userQuery.organizationId = organizationId;
    }

    // Get target org name if specific org selected
    let orgName = 'All Organizations';
    if (organizationId && organizationId !== 'ALL') {
      const org = await Organization.findById(organizationId);
      if (org) orgName = org.name;
    }

    const recipientUsers = await User.find(userQuery).select('_id organizationId');

    // 1. Create Broadcast Master Record
    const broadcast = await Broadcast.create({
      title: title.trim(),
      message: message.trim(),
      priority,
      category,
      targetRole,
      targetOrganization: organizationId,
      organizationName: orgName,
      sender: req.user._id,
      senderName: req.user.name || 'Super Administrator',
      senderRole: req.user.role || 'SUPER_ADMIN',
      recipientCount: recipientUsers.length,
      isActive: true,
    });

    // 2. Insert notifications for all target accounts
    const notificationDocs = recipientUsers.map((u) => ({
      organizationId: u.organizationId,
      recipient: u._id,
      sender: req.user._id,
      type: 'system',
      title: `[BROADCAST] ${title}`,
      message,
      data: {
        broadcastId: broadcast._id,
        priority,
        category,
        senderName: req.user.name,
        broadcastedAt: new Date(),
      },
    }));

    if (notificationDocs.length > 0) {
      await Notification.insertMany(notificationDocs);
    }

    // 3. ⚡ INSTANT REAL-TIME SOCKET BROADCAST TO ALL CONNECTED CLIENTS & EMPLOYEES
    try {
      const io = req.app.get('io');
      if (io) {
        const payload = {
          _id: broadcast._id,
          title: broadcast.title,
          message: broadcast.message,
          priority: broadcast.priority,
          category: broadcast.category,
          targetRole: broadcast.targetRole,
          targetOrganization: broadcast.targetOrganization,
          organizationName: broadcast.organizationName,
          senderName: broadcast.senderName,
          senderRole: broadcast.senderRole,
          recipientCount: broadcast.recipientCount,
          createdAt: broadcast.createdAt,
        };

        // Real-time event for high-priority broadcast banner/toast popup across all screens
        io.emit('platform_broadcast', payload);
        io.emit('new_notification', payload);
      }
    } catch (socketErr) {
      console.warn('Socket broadcast emit error:', socketErr.message);
    }

    // 4. Audit Log
    await AuditLog.create({
      actorUserId: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'PLATFORM_BROADCAST_SENT',
      metadata: { title, targetRole, recipientCount: recipientUsers.length, broadcastId: broadcast._id },
    });

    res.status(201).json({
      success: true,
      message: `Broadcast successfully dispatched to ${recipientUsers.length} users in real-time!`,
      broadcast,
      recipientCount: recipientUsers.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteBroadcast = async (req, res) => {
  try {
    const Broadcast = require('../models/Broadcast.model');
    const { id } = req.params;
    const deleted = await Broadcast.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Broadcast not found' });
    res.json({ success: true, message: 'Broadcast deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// 📊 SYSTEM HEALTH & DATABASE DIAGNOSTICS
// ============================================================================

exports.getSystemHealth = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const os = require('os');
    const { LiveLocation, Meeting, Expense, Attendance, Task, Leave, Lead, Notification, AuditLog, Organization, User, Payment } = require('../models/index');

    // 1. Measure DB Ping Latency
    let pingMs = 0;
    try {
      const pingStart = Date.now();
      await mongoose.connection.db.admin().ping();
      pingMs = Date.now() - pingStart;
    } catch (e) {
      pingMs = -1;
    }

    // 2. Real MongoDB Database Storage Stats
    let dbStorage = {
      dbName: mongoose.connection.name || 'field_tracking',
      dbHost: mongoose.connection.host || 'MongoDB Cluster',
      collectionsCount: 0,
      totalObjects: 0,
      avgObjSizeBytes: 0,
      dataSizeMb: '0.00',
      storageSizeMb: '0.00',
      indexSizeMb: '0.00',
      totalAllocatedMb: '0.00',
      freeStorageMb: '0.00',
      storageUsedPercent: 0,
    };

    try {
      const rawDbStats = await mongoose.connection.db.stats();
      const dataSizeMb = (rawDbStats.dataSize / (1024 * 1024)).toFixed(2);
      const storageSizeMb = (rawDbStats.storageSize / (1024 * 1024)).toFixed(2);
      const indexSizeMb = (rawDbStats.indexSize / (1024 * 1024)).toFixed(2);
      const totalAllocatedMb = ((rawDbStats.storageSize + rawDbStats.indexSize) / (1024 * 1024)).toFixed(2);
      const quotaLimitMb = 512; // Standard 512MB Atlas Free / Basic tier baseline
      const usedPct = Math.min(100, Math.round((parseFloat(totalAllocatedMb) / quotaLimitMb) * 100));

      dbStorage = {
        dbName: rawDbStats.db || mongoose.connection.name,
        dbHost: mongoose.connection.host || 'MongoDB Atlas Cluster',
        collectionsCount: rawDbStats.collections || 0,
        totalObjects: rawDbStats.objects || 0,
        avgObjSizeBytes: Math.round(rawDbStats.avgObjSize || 0),
        dataSizeMb,
        storageSizeMb,
        indexSizeMb,
        totalAllocatedMb,
        quotaLimitMb,
        storageUsedPercent: usedPct,
        indexesCount: rawDbStats.indexes || 0,
      };
    } catch (statErr) {
      console.warn('Could not fetch raw db.stats():', statErr.message);
    }

    // 3. Detailed Collection Breakdown (Real MongoDB Collection Stats)
    const collectionModels = [
      { key: 'organizations', model: Organization, displayName: 'Customer Organizations', category: 'Tenancy' },
      { key: 'users', model: User, displayName: 'Registered Users & Staff', category: 'Auth' },
      { key: 'payments', model: Payment, displayName: 'Payment Orders & Invoices', category: 'Billing' },
      { key: 'liveLocations', model: LiveLocation, displayName: 'GPS Live Location Sessions', category: 'Tracking' },
      { key: 'attendances', model: Attendance, displayName: 'Daily Attendance Punch-Ins', category: 'Operations' },
      { key: 'meetings', model: Meeting, displayName: 'Field Meetings & Client Visits', category: 'Field CRM' },
      { key: 'tasks', model: Task, displayName: 'Field Tasks & Job Dispatches', category: 'Operations' },
      { key: 'expenses', model: Expense, displayName: 'Fuel & OCR Expense Claims', category: 'Finance' },
      { key: 'leaves', model: Leave, displayName: 'Leave Applications', category: 'HR' },
      { key: 'leads', model: Lead, displayName: 'Sales Leads Pipeline', category: 'Field CRM' },
      { key: 'auditLogs', model: AuditLog, displayName: 'Platform Security Audits', category: 'Compliance' },
      { key: 'notifications', model: Notification, displayName: 'Notification Deliveries', category: 'Messaging' },
    ];

    const collectionsDetail = [];
    const counts = {};

    for (const item of collectionModels) {
      try {
        const docCount = await item.model.countDocuments();
        counts[item.key] = docCount;

        let dataSizeBytes = 0;
        let avgObjSize = 0;
        let storageSizeBytes = 0;
        let totalIndexSize = 0;

        try {
          if (item.model && item.model.collection) {
            const collStats = await item.model.collection.stats();
            dataSizeBytes = collStats.size || 0;
            avgObjSize = Math.round(collStats.avgObjSize || 0);
            storageSizeBytes = collStats.storageSize || 0;
            totalIndexSize = collStats.totalIndexSize || 0;
          }
        } catch (csErr) {
          // Fallback calculation if db user lacks collStats command permission
          avgObjSize = dbStorage.avgObjSizeBytes || 350;
          dataSizeBytes = docCount * avgObjSize;
        }

        const sizeKb = Math.round(dataSizeBytes / 1024);
        const sizeMb = (dataSizeBytes / (1024 * 1024)).toFixed(2);
        const sizeFormatted = dataSizeBytes > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;

        collectionsDetail.push({
          key: item.key,
          name: item.displayName,
          category: item.category,
          count: docCount,
          sizeBytes: dataSizeBytes,
          storageSizeBytes,
          totalIndexSize,
          avgObjSizeBytes: avgObjSize,
          sizeFormatted,
        });
      } catch (err) {
        counts[item.key] = 0;
      }
    }

    // 4. Memory & Hardware Performance
    const memUsage = process.memoryUsage();
    const cpus = os.cpus() || [];
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsedPercent = Math.round((usedMem / totalMem) * 100);

    const systemInfo = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'Standard Server CPU',
      cpuSpeedMhz: cpus[0]?.speed || 0,
      loadAvg: os.loadavg ? os.loadavg().map((n) => n.toFixed(2)) : ['0.00', '0.00', '0.00'],
      memory: {
        rssMb: Math.round(memUsage.rss / 1024 / 1024),
        heapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
        heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
        externalMb: Math.round(memUsage.external / 1024 / 1024),
        heapPercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
      },
      osMemory: {
        totalMb: Math.round(totalMem / 1024 / 1024),
        freeMb: Math.round(freeMem / 1024 / 1024),
        usedMb: Math.round(usedMem / 1024 / 1024),
        usedPercent: memUsedPercent,
      },
      dbStatus: mongoose.connection.readyState === 1 ? 'Optimal & Connected' : 'Disconnected',
      dbPingMs: pingMs,
    };

    res.json({
      success: true,
      systemInfo,
      dbStorage,
      counts,
      collectionsDetail,
      timestamp: new Date(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// ⚡ SAAS PRICING PLANS ENGINE
// ============================================================================

const defaultPlans = [
  {
    planId: 'starter',
    name: 'Starter Plan',
    description: 'Ideal for small field teams starting with live GPS tracking',
    badge: 'Starter Tier',
    priceMonthly: 999,
    priceYearly: 11389,
    maxEmployees: 10,
    maxManagers: 3,
    isPopular: false,
    isActive: true,
    displayOrder: 1,
    features: [
      'Up to 10 Employee Accounts',
      '3 Manager Accounts',
      'Real-Time GPS Location Telemetry',
      'Geofenced Selfie Attendance',
      'Daily Travel Distance Calculation',
      'Standard Email Support',
    ],
  },
  {
    planId: 'pro',
    name: 'Growth Pro Plan',
    description: 'For growing medium enterprises needing high accuracy tracking & audit',
    badge: 'Most Popular',
    priceMonthly: 1999,
    priceYearly: 22789,
    maxEmployees: 30,
    maxManagers: 10,
    isPopular: true,
    isActive: true,
    displayOrder: 2,
    features: [
      'Up to 30 Employee Accounts',
      '10 Manager Accounts',
      'Live High-Precision Route Replay',
      'Manager Squad Team Assignment',
      'OCR Fuel & Receipt Expense Audits',
      'Client Visit & Meeting Reports',
      'Priority Phone & Chat Support',
    ],
  },
  {
    planId: 'enterprise',
    name: 'Enterprise Plan',
    description: 'High capacity operations requiring multi-tier squad hierarchy',
    badge: 'Full Capacity',
    priceMonthly: 3999,
    priceYearly: 45589,
    maxEmployees: 50,
    maxManagers: 20,
    isPopular: false,
    isActive: true,
    displayOrder: 3,
    features: [
      'Up to 50 Employee Accounts',
      '20 Manager Accounts',
      'Unlimited Geofence Zones & Polling',
      'Automated Payroll & DA Calculator',
      'Custom Data Exports (Excel, PDF)',
      'Full Multi-Department Hierarchy',
      'Dedicated Technical Account Manager',
      '24/7 VIP Phone Support & Custom SLA',
    ],
  },
];

exports.getPlans = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');

    // Ensure all 3 default plans exist in database
    for (const def of defaultPlans) {
      const existing = await Plan.findOne({ planId: def.planId });
      if (!existing) {
        await Plan.create(def);
      }
    }

    const plans = await Plan.find().sort({ displayOrder: 1, createdAt: 1 });
    res.json({ success: true, plans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.seedDefaultPlans = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');
    for (const def of defaultPlans) {
      await Plan.findOneAndUpdate(
        { planId: def.planId },
        { $set: def },
        { upsert: true, new: true }
      );
    }
    const plans = await Plan.find().sort({ displayOrder: 1, createdAt: 1 });
    res.json({ success: true, message: 'All 3 default SaaS plans synchronized successfully!', plans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');
    const mongoose = require('mongoose');
    const { id } = req.params;
    const {
      planId,
      name,
      description,
      badge,
      priceMonthly,
      priceYearly,
      maxEmployees,
      maxManagers,
      features,
      isPopular,
      isActive,
    } = req.body;

    let plan = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      plan = await Plan.findById(id);
    }
    if (!plan) {
      plan = await Plan.findOne({ planId: id }) || (planId ? await Plan.findOne({ planId }) : null);
    }

    if (!plan) {
      // Create if not yet present in DB
      const cleanPlanId = (planId || id || name || 'plan').toLowerCase().replace(/[^a-z0-9]/g, '_');
      plan = new Plan({
        planId: cleanPlanId,
        name: name || 'Plan Tier',
        priceMonthly: Number(priceMonthly) || 999,
      });
    }

    if (name) plan.name = name;
    if (description !== undefined) plan.description = description;
    if (badge !== undefined) plan.badge = badge;
    if (priceMonthly !== undefined) plan.priceMonthly = Number(priceMonthly);
    if (priceYearly !== undefined) plan.priceYearly = Number(priceYearly);
    if (maxEmployees !== undefined) plan.maxEmployees = Number(maxEmployees);
    if (maxManagers !== undefined) plan.maxManagers = Number(maxManagers);
    if (Array.isArray(features)) plan.features = features;
    if (isPopular !== undefined) plan.isPopular = isPopular;
    if (isActive !== undefined) plan.isActive = isActive;

    await plan.save();

    // 🔄 Sync updated seat quotas across all customer organizations on this tier
    try {
      const Organization = require('../models/Organization.model');
      await Organization.updateMany(
        {
          $or: [
            { 'plan.planId': plan._id },
            { 'plan.planName': { $regex: new RegExp(plan.name || plan.planId, 'i') } },
            { 'plan.planName': { $regex: new RegExp(plan.planId === 'starter' ? 'starter' : plan.planId === 'enterprise' ? 'enterprise' : 'pro', 'i') } },
          ],
        },
        {
          $set: {
            'plan.maxEmployees': plan.maxEmployees,
            'plan.maxManagers': plan.maxManagers,
          },
        }
      );
    } catch (orgSyncErr) {
      console.warn('Organization plan sync warning:', orgSyncErr.message);
    }

    try {
      if (AuditLog) {
        await AuditLog.create({
          actorUserId: req.user?._id,
          actorName: req.user?.name || 'Super Admin',
          actorRole: req.user?.role || 'SUPER_ADMIN',
          action: 'SAAS_PLAN_UPDATED',
          metadata: { planId: plan.planId, name: plan.name, priceMonthly: plan.priceMonthly, maxEmployees: plan.maxEmployees },
        });
      }
    } catch (auditErr) {
      console.warn('AuditLog creation warning:', auditErr.message);
    }

    res.json({
      success: true,
      message: `Plan "${plan.name}" updated and synced across all organizations!`,
      plan,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');
    const {
      planId,
      name,
      description,
      badge,
      priceMonthly,
      priceYearly,
      maxEmployees,
      maxManagers,
      features,
      isPopular,
    } = req.body;

    if (!name || !priceMonthly) {
      return res.status(400).json({ success: false, message: 'Plan name and monthly price are required.' });
    }

    const cleanPlanId = (planId || name).toLowerCase().replace(/[^a-z0-9]/g, '_');
    const existing = await Plan.findOne({ planId: cleanPlanId });
    if (existing) {
      return res.status(400).json({ success: false, message: `A plan with ID "${cleanPlanId}" already exists.` });
    }

    const highestOrder = await Plan.findOne().sort({ displayOrder: -1 });
    const nextOrder = (highestOrder?.displayOrder || 3) + 1;

    const newPlan = await Plan.create({
      planId: cleanPlanId,
      name,
      description: description || '',
      badge: badge || '',
      priceMonthly: Number(priceMonthly),
      priceYearly: Number(priceYearly) || Math.round(Number(priceMonthly) * 12 * 0.95),
      maxEmployees: Number(maxEmployees) || 10,
      maxManagers: Number(maxManagers) || 3,
      features: Array.isArray(features) ? features : [],
      isPopular: Boolean(isPopular),
      isActive: true,
      displayOrder: nextOrder,
    });

    res.status(201).json({
      success: true,
      message: `Plan tier "${name}" created successfully!`,
      plan: newPlan,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');
    const { id } = req.params;
    const deleted = await Plan.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: `Plan "${deleted.name}" deleted successfully!` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};



