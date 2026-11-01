const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_in_production';
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET || (ACCESS_TOKEN_SECRET + '_refresh_sec');
const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRE || '30d';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRE || '30d';

/**
 * 🔑 Generate Dual Tokens: Short-lived Access Token & Long-lived Refresh Token
 */
const generateTokens = (user) => {
  const userId = user._id ? user._id.toString() : user.toString();
  const userRole = (user.role || 'EMPLOYEE').toUpperCase();
  const orgId = user.organizationId ? (user.organizationId._id || user.organizationId).toString() : null;

  const accessToken = jwt.sign(
    {
      id: userId,
      role: userRole,
      organizationId: orgId,
      tokenType: 'ACCESS',
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const refreshToken = jwt.sign(
    {
      id: userId,
      tokenType: 'REFRESH',
    },
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );

  return { accessToken, refreshToken };
};

/**
 * Backward compatibility for legacy single-token calls
 */
const generateToken = (id) =>
  jwt.sign({ id: id.toString(), tokenType: 'ACCESS' }, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });

/**
 * 🛡️ Protect Middleware: Validates Access Token on Protected Routes
 */
const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith('Bearer ')) {
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

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User account not found or has been removed.',
        authRequired: true,
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Account is blocked. Please contact support.',
        accountBlocked: true,
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated. Access revoked.',
        accountDeactivated: true,
      });
    }

    req.user = user;
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes((user.role || '').toUpperCase());
    const headerOrgId = req.headers['x-organization-id'];
    req.organizationId = (isSuperAdmin && headerOrgId)
      ? headerOrgId
      : (user.organizationId?._id || user.organizationId || null);
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Access token is invalid or expired. Please refresh token.',
      tokenExpired: true,
      authRequired: true,
    });
  }
};

/**
 * 🔒 Authorize Middleware: Strict Role-Based Access Control (RBAC)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !req.user.role) {
    return res.status(403).json({ success: false, message: 'Access denied: No role assigned' });
  }

  const userRole = req.user.role.toUpperCase();
  const allowedRoles = roles.map((r) => r.toUpperCase());

  // Super admin master bypass for all endpoints
  if (['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) {
    return next();
  }

  // Org Admin bypass for administrative endpoints
  if (['ORG_ADMIN', 'ADMIN'].includes(userRole)) {
    if (allowedRoles.includes('ORG_ADMIN') || allowedRoles.includes('ADMIN') || allowedRoles.includes('ALL')) {
      return next();
    }
  }

  // Manager permissions
  if (userRole === 'MANAGER' || userRole === 'HR') {
    if (allowedRoles.includes('MANAGER') || allowedRoles.includes('HR') || allowedRoles.includes('ALL')) {
      return next();
    }
  }

  // Exact role match
  if (allowedRoles.includes(userRole) || allowedRoles.includes('ALL')) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: `Access denied. Requires one of roles: [${roles.join(', ')}]`,
  });
};

const requireActivePlan = require('./requireActivePlan');

module.exports = {
  protect,
  authorize,
  generateTokens,
  generateToken,
  requireActivePlan,
  ACCESS_TOKEN_SECRET,
  REFRESH_TOKEN_SECRET,
};
