const User = require('../models/User.model');
const Organization = require('../models/Organization.model');
const { ActivityLog } = require('../models/index');
const { generateTokens, generateToken, REFRESH_TOKEN_SECRET, ACCESS_TOKEN_SECRET } = require('../middleware/auth.middleware');
const { v4: uuidv4 } = require('uuid');

// @desc Register employee
exports.register = async (req, res) => {
  try {
    const { name, email, password, phone, department, designation, organizationSlug } = req.body;

    let orgId = null;
    if (organizationSlug) {
      const org = await Organization.findOne({ slug: organizationSlug });
      if (org) orgId = org._id;
    }

    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, message: 'Email already registered' });

    const employeeId = 'EMP-' + uuidv4().slice(0, 8).toUpperCase();
    const user = await User.create({
      organizationId: orgId,
      name,
      email,
      password,
      phone,
      department,
      designation,
      employeeId,
      role: 'EMPLOYEE',
      isApproved: true,
    });

    await ActivityLog.create({
      organizationId: orgId,
      employee: user._id,
      action: 'REGISTER',
      description: 'New employee registered',
    });

    res.status(201).json({ success: true, message: 'Registration successful. You can now login.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Login (supports Email or Phone Number with Dual Token Architecture)
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email/phone and password are required.' });
    }

    const rawInput = String(email).trim();
    const cleanEmail = rawInput.toLowerCase();
    const digitsOnly = rawInput.replace(/\D/g, '');

    const queryConditions = [
      { email: cleanEmail },
      { phone: rawInput },
      { phone: cleanEmail }
    ];
    if (digitsOnly.length >= 7) {
      queryConditions.push({ phone: new RegExp(digitsOnly.slice(-10) + '$') });
    }

    const user = await User.findOne({ $or: queryConditions })
      .populate('manager', 'name email')
      .populate('organizationId', 'name slug logo status plan settings');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, message: 'Account is blocked. Please contact your administrator.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    // Check organization status if user is not Super Admin
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'superadmin' && user.organizationId) {
      if (user.organizationId.status === 'suspended') {
        return res.status(403).json({
          success: false,
          message: 'Your Organization account has been suspended due to billing or compliance. Please contact support.',
        });
      }
    }

    // 🔑 Generate Dual Tokens
    const { accessToken, refreshToken } = generateTokens(user);

    await User.findByIdAndUpdate(user._id, {
      isOnline: true,
      lastSeen: new Date(),
      refreshToken,
    });

    await ActivityLog.create({
      organizationId: user.organizationId ? user.organizationId._id : null,
      employee: user._id,
      action: 'LOGIN',
      description: 'User logged in',
      ip: req.ip,
    });

    // Normalize user response object
    const userObj = user.toJSON();
    const normalizedRole = userObj.role ? userObj.role.toUpperCase() : 'EMPLOYEE';
    userObj.role = normalizedRole;

    res.json({
      success: true,
      token: accessToken,
      accessToken,
      refreshToken,
      user: userObj,
      organization: user.organizationId || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Refresh Token (Silent Token Rotation)
exports.refreshToken = async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');

    let incomingRefreshToken = req.body.refreshToken;
    if (!incomingRefreshToken && req.headers.authorization?.startsWith('Bearer ')) {
      incomingRefreshToken = req.headers.authorization.split(' ')[1];
    }

    if (!incomingRefreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token is missing.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(incomingRefreshToken, REFRESH_TOKEN_SECRET);
    } catch (e) {
      try {
        decoded = jwt.verify(incomingRefreshToken, ACCESS_TOKEN_SECRET);
      } catch (e2) {
        return res.status(401).json({ success: false, message: 'Invalid or expired refresh token. Please login again.' });
      }
    }

    const user = await User.findById(decoded.id).populate('organizationId', 'name slug logo status plan settings');
    if (!user) {
      return res.status(401).json({ success: false, message: 'User account not found.' });
    }

    if (user.isBlocked || !user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated or blocked.' });
    }

    if (user.role !== 'SUPER_ADMIN' && user.role !== 'superadmin' && user.organizationId) {
      if (user.organizationId.status === 'suspended') {
        return res.status(403).json({ success: false, message: 'Organization subscription suspended.' });
      }
    }

    // Generate new pair
    const tokens = generateTokens(user);

    await User.findByIdAndUpdate(user._id, {
      refreshToken: tokens.refreshToken,
      lastSeen: new Date(),
    });

    const userObj = user.toJSON();
    userObj.role = userObj.role ? userObj.role.toUpperCase() : 'EMPLOYEE';

    res.json({
      success: true,
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: userObj,
      organization: user.organizationId || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Logout
exports.logout = async (req, res) => {
  try {
    if (req.user?._id) {
      await User.findByIdAndUpdate(req.user._id, {
        isOnline: false,
        isTracking: false,
        lastSeen: new Date(),
        socketId: null,
        refreshToken: null,
      });
      await ActivityLog.create({
        organizationId: req.user.organizationId,
        employee: req.user._id,
        action: 'LOGOUT',
        description: 'User logged out',
      });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get current user
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user._id)
    .populate('manager', 'name email avatar')
    .populate('organizationId', 'name slug logo status plan settings');
  const userObj = user.toJSON();
  userObj.role = userObj.role ? userObj.role.toUpperCase() : 'EMPLOYEE';
  res.json({ success: true, user: userObj, organization: user.organizationId || null });
};

// @desc Update profile
exports.updateProfile = async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'avatar', 'emergencyContact', 'fcmToken', 'daReceipt', 'DA'];
    const updates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    const updateDoc = { ...updates };
    if (updates.DA !== undefined) {
      const inc = Number(updates.DA);
      updateDoc.$inc = { DA: Number.isNaN(inc) ? 0 : inc };
      delete updateDoc.DA;
    }

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updateDoc, { new: true }).select('-password');
    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Change Password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please provide current and new password' });
    }
    const user = await User.findById(req.user._id);
    if (!user || !(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'Incorrect current password' });
    }
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Register new Organization (SaaS Tenant Onboarding)
// @desc Register new Organization (SaaS Tenant Onboarding with Payment Verification)
exports.registerOrganization = async (req, res) => {
  try {
    const {
      organizationName,
      name,
      email,
      password,
      phone,
      plan = 'pro',
      billingCycle = 'monthly',
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      paymentAmount,
    } = req.body;

    if (!organizationName || !name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Organization Name, Admin Name, Email, and Password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (await User.findOne({ email: cleanEmail })) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    // Verify Razorpay payment signature if provided
    let isPaid = false;
    if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
      const crypto = require('crypto');
      const secret = process.env.RAZORPAY_KEY_SECRET || '5GO0yjbVCTn58B1FDUocEjyb';
      const bodyToSign = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', secret).update(bodyToSign).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Payment verification failed. Signature mismatch.' });
      }
      isPaid = true;
    }

    // Set Max Employees and Expiry
    let maxEmployees = isPaid ? 50 : 0;
    let maxManagers = isPaid ? 10 : 0;
    let planTitle = isPaid ? 'Growth Pro Plan' : 'No Active Plan';
    if (isPaid && plan === 'starter') {
      maxEmployees = 10;
      maxManagers = 2;
      planTitle = 'Starter Plan';
    } else if (isPaid && plan === 'enterprise') {
      maxEmployees = 500;
      maxManagers = 50;
      planTitle = 'Enterprise Plan';
    }

    const expirationDays = billingCycle === 'yearly' ? 365 : 30;
    let expiresAt = null;
    if (isPaid) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expirationDays);
    }

    // Generate unique slug
    const slugBase = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'org';
    const slug = `${slugBase}-${uuidv4().slice(0, 6)}`;

    // 1. Create Organization Document (Default status is 'unpaid' if not paid - No Trial Days!)
    const organization = await Organization.create({
      name: organizationName.trim(),
      slug,
      email: cleanEmail,
      phone: phone || '',
      logo: '/images/superCompanyLOGO.png',
      status: isPaid ? 'active' : 'unpaid',
      plan: {
        planName: planTitle,
        maxEmployees,
        maxManagers,
        startsAt: new Date(),
        expiresAt: expiresAt, // null if unpaid
      },
    });

    // 2. Create Organization Admin User Document
    const employeeId = 'ADM-' + uuidv4().slice(0, 6).toUpperCase();
    const user = await User.create({
      organizationId: organization._id,
      name: name.trim(),
      email: cleanEmail,
      password,
      phone: phone || '',
      role: 'ORG_ADMIN',
      designation: 'Organization Admin',
      department: 'Management',
      employeeId,
      isApproved: true,
      isOnline: true,
    });

    // 3. Save Payment Record if Razorpay Payment was processed
    const Payment = require('../models/Payment.model');
    let paymentRecord = null;
    if (isPaid && razorpay_order_id) {
      paymentRecord = await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        {
          organization: organization._id,
          user: user._id,
          razorpayPaymentId: razorpay_payment_id || '',
          razorpaySignature: razorpay_signature || '',
          amount: paymentAmount || 999,
          amountPaid: paymentAmount || 999,
          status: 'paid',
          plan,
          billingCycle,
          paidAt: new Date(),
        },
        { upsert: true, new: true }
      );
    }

    const { accessToken, refreshToken } = generateTokens(user);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    await ActivityLog.create({
      organizationId: organization._id,
      employee: user._id,
      action: 'ORGANIZATION_REGISTER',
      description: `New organization "${organization.name}" registered (Status: ${organization.status})`,
    });

    const userObj = user.toJSON();
    delete userObj.password;
    userObj.role = 'ORG_ADMIN';

    res.status(201).json({
      success: true,
      token: accessToken,
      accessToken,
      refreshToken,
      user: userObj,
      organization,
      payment: paymentRecord,
      message: isPaid
        ? '🎉 Organization registered and subscription activated successfully!'
        : 'Organization registered successfully! Please purchase a plan to unlock all features.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Verify email or phone exists for password reset (Public)
exports.verifyResetEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email address or phone is required.' });

    const rawInput = String(email).trim();
    const cleanEmail = rawInput.toLowerCase();
    const digitsOnly = rawInput.replace(/\D/g, '');

    const queryConditions = [
      { email: cleanEmail },
      { phone: rawInput },
      { phone: cleanEmail }
    ];
    if (digitsOnly.length >= 7) {
      queryConditions.push({ phone: new RegExp(digitsOnly.slice(-10) + '$') });
    }

    const user = await User.findOne({ $or: queryConditions });

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'No account found with this email address or phone number.' 
      });
    }

    res.json({
      success: true,
      message: 'Account verified successfully.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Direct reset password without OTP (Public - Email or Phone Verified)
exports.resetPasswordDirect = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email or phone and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const rawInput = String(email).trim();
    const cleanEmail = rawInput.toLowerCase();
    const digitsOnly = rawInput.replace(/\D/g, '');

    const queryConditions = [
      { email: cleanEmail },
      { phone: rawInput },
      { phone: cleanEmail }
    ];
    if (digitsOnly.length >= 7) {
      queryConditions.push({ phone: new RegExp(digitsOnly.slice(-10) + '$') });
    }

    const user = await User.findOne({ $or: queryConditions });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    user.password = newPassword;
    await user.save(); // pre('save') hook hashes the password with bcrypt!

    res.json({
      success: true,
      message: 'Password updated successfully! You can now log in with your new password.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

