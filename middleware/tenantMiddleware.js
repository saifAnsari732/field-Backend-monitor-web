const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Organization = require('../models/Organization.model');

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_in_production';

// 1. Authenticate JWT Token
const authenticate = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed. Access token is missing.',
        authRequired: true,
      });
    }

    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User account not found or token has expired.',
      });
    }

    if (!user.isActive || user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account is deactivated or blocked. Please contact your admin.',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.',
      error: error.message,
    });
  }
};

// 2. Resolve Organization Context & Enforce Tenant Isolation
const resolveTenant = async (req, res, next) => {
  try {
    // Super admin does not belong to a single organization
    if (['SUPER_ADMIN', 'superadmin'].includes(req.user.role)) {
      req.organizationId = req.headers['x-organization-id'] || null;
      return next();
    }

    if (!req.user.organizationId) {
      return res.status(403).json({
        success: false,
        message: 'Account is not associated with any Organization.',
      });
    }

    const org = await Organization.findById(req.user.organizationId);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found.',
      });
    }

    if (org.status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Organization account is suspended due to billing or compliance. Please contact support.',
      });
    }

    if (org.status === 'cancelled') {
      return res.status(403).json({
        success: false,
        message: 'Organization subscription has been cancelled.',
      });
    }

    req.organization = org;
    req.organizationId = org._id;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error verifying organization status.',
      error: error.message,
    });
  }
};

// 3. Role-Based Access Control Middleware
const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthenticated user.' });
    }

    const normalizedRole = req.user.role ? req.user.role.toUpperCase() : '';
    const normalizedAllowed = allowedRoles.map((r) => r.toUpperCase());

    // Map legacy roles to SaaS roles
    const roleMapping = {
      ADMIN: ['ORG_ADMIN', 'ADMIN'],
      HR: ['ORG_ADMIN', 'ADMIN', 'HR'],
      MANAGER: ['MANAGER'],
      EMPLOYEE: ['EMPLOYEE'],
      SUPERADMIN: ['SUPER_ADMIN'],
    };

    let userRoles = [normalizedRole];
    if (normalizedRole === 'ADMIN' || normalizedRole === 'HR') userRoles.push('ORG_ADMIN');
    if (normalizedRole === 'ORG_ADMIN') userRoles.push('ADMIN');
    if (normalizedRole === 'SUPERADMIN') userRoles.push('SUPER_ADMIN');

    const hasPermission = userRoles.some((r) => normalizedAllowed.includes(r)) || userRoles.includes('SUPER_ADMIN');

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Requires one of roles: [${allowedRoles.join(', ')}]`,
      });
    }

    next();
  };
};

// 4. Enforce SaaS Plan Quotas
const checkQuota = (quotaType) => {
  return async (req, res, next) => {
    try {
      if (['SUPER_ADMIN', 'superadmin'].includes(req.user?.role)) return next();

      const org = req.organization || (await Organization.findById(req.user?.organizationId));
      if (!org) return next();

      // Dynamically resolve live plan limits from Plan collection if matching
      const Plan = require('../models/Plan.model');
      let maxEmployees = org.plan?.maxEmployees || 10;
      let maxManagers = org.plan?.maxManagers || 3;

      const planNameOrId = org.plan?.planId || org.plan?.planName || '';
      const livePlan = await Plan.findOne({
        $or: [
          { planId: planNameOrId.toLowerCase() },
          { name: { $regex: new RegExp(planNameOrId, 'i') } },
          { planId: planNameOrId.toLowerCase().includes('starter') ? 'starter' : planNameOrId.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro' }
        ],
        isActive: true,
      });

      if (livePlan) {
        if (livePlan.maxEmployees) maxEmployees = livePlan.maxEmployees;
        if (livePlan.maxManagers) maxManagers = livePlan.maxManagers;
      }

      if (quotaType === 'EMPLOYEE') {
        const count = await User.countDocuments({
          organizationId: org._id,
          role: { $in: ['EMPLOYEE', 'employee', 'agent'] },
          isActive: true,
        });

        if (count >= maxEmployees) {
          return res.status(403).json({
            success: false,
            limitReached: true,
            currentCount: count,
            maxLimit: maxEmployees,
            message: `⚠️ Employee quota full! You have used ${count}/${maxEmployees} employee seats in your current plan. Please upgrade your subscription plan in Billing to add more staff.`,
          });
        }
      } else if (quotaType === 'MANAGER') {
        const count = await User.countDocuments({
          organizationId: org._id,
          role: { $in: ['MANAGER', 'manager'] },
          isActive: true,
        });

        if (count >= maxManagers) {
          return res.status(403).json({
            success: false,
            limitReached: true,
            currentCount: count,
            maxLimit: maxManagers,
            message: `⚠️ Manager quota full! You have used ${count}/${maxManagers} manager seats in your current plan. Please upgrade your subscription plan in Billing to add more managers.`,
          });
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

// 5. Require Active Subscription Plan for All CRUD/Mutations
const requireActivePlan = async (req, res, next) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    if (['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) {
      return next();
    }

    const org = req.organization || (await Organization.findById(req.user?.organizationId));
    if (!org) {
      return res.status(403).json({
        success: false,
        planRequired: true,
        message: 'No organization account found.',
      });
    }

    const hasActivePlan =
      org.status === 'active' &&
      org.plan?.expiresAt &&
      new Date(org.plan.expiresAt) > new Date();

    if (!hasActivePlan) {
      return res.status(402).json({
        success: false,
        planRequired: true,
        planExpired: true,
        message: 'Active subscription required. Please purchase a plan to unlock all features.',
        organization: {
          id: org._id,
          name: org.name,
          status: org.status,
          plan: org.plan,
        },
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticate,
  resolveTenant,
  checkRole,
  checkQuota,
  requireActivePlan,
};
