const Razorpay = require('razorpay');
const crypto = require('crypto');
const Payment = require('../models/Payment.model');
const Organization = require('../models/Organization.model');
const Coupon = require('../models/Coupon.model');

// Initialize Razorpay client with Live API Keys
const getRazorpayInstance = () => {
  const key_id = process.env.RAZORPAY_KEY_ID || 'rzp_live_TNdSmDOKSX2g6I';
  const key_secret = process.env.RAZORPAY_KEY_SECRET || '5GO0yjbVCTn58B1FDUocEjyb';
  return new Razorpay({ key_id, key_secret });
};

// 💰 Calculate Plan Price with Dynamic MongoDB Lookup, Seat Add-Ons & Yearly Billing (5% OFF)
async function calculatePlanPrice(plan, billingCycle, employeeSeats = 0, managerSeats = 0, seats = 0) {
  // Handle Seat Add-on Top-ups (₹200 / Employee Seat, ₹300 / Manager Seat)
  if (plan === 'employee_addon' || plan === 'seat_addon' || plan === 'addon') {
    const empCount = Number(employeeSeats) || Number(seats) || 0;
    const mgrCount = Number(managerSeats) || 0;
    const total = (empCount * 200) + (mgrCount * 300);
    const finalTotal = Math.max(200, total); // Minimum ₹200
    return {
      monthlyPrice: finalTotal,
      totalAmount: finalTotal,
      discountPercent: 0,
      savings: 0,
      originalAmount: finalTotal,
    };
  }

  if (plan === 'manager_addon') {
    const mgrCount = Number(managerSeats) || Number(seats) || 1;
    const total = mgrCount * 300;
    return {
      monthlyPrice: total,
      totalAmount: total,
      discountPercent: 0,
      savings: 0,
      originalAmount: total,
    };
  }

  let monthlyPrice = 1999; // Default Pro
  let dbPlan = null;
  try {
    const Plan = require('../models/Plan.model');
    dbPlan = await Plan.findOne({
      $or: [
        { planId: plan },
        { name: { $regex: new RegExp(`^${plan}`, 'i') } },
      ],
      isActive: true,
    });
    if (dbPlan && dbPlan.priceMonthly) {
      monthlyPrice = Number(dbPlan.priceMonthly);
    } else {
      if (plan === 'starter') monthlyPrice = 999;
      else if (plan === 'pro' || plan === 'growth_pro') monthlyPrice = 1999;
      else if (plan === 'enterprise') monthlyPrice = 3999;
    }
  } catch (e) {
    if (plan === 'starter') monthlyPrice = 999;
    else if (plan === 'pro' || plan === 'growth_pro') monthlyPrice = 1999;
    else if (plan === 'enterprise') monthlyPrice = 3999;
  }

  const cycleNormalized = String(billingCycle || 'monthly').toLowerCase().trim();
  const isYearly = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(cycleNormalized);

  if (isYearly) {
    const totalYearlyOriginal = monthlyPrice * 12;
    // Prefer dbPlan.priceYearly if configured, else exactly 5% OFF!
    const discountedYearly = (dbPlan && dbPlan.priceYearly) ? Number(dbPlan.priceYearly) : Math.round(totalYearlyOriginal * 0.95);
    return {
      monthlyPrice,
      totalAmount: discountedYearly,
      discountPercent: 5,
      savings: totalYearlyOriginal - discountedYearly,
      originalAmount: totalYearlyOriginal,
      durationDays: 365,
      billingCycle: 'yearly',
    };
  }

  return {
    monthlyPrice,
    totalAmount: monthlyPrice,
    discountPercent: 0,
    savings: 0,
    originalAmount: monthlyPrice,
    durationDays: 30,
    billingCycle: 'monthly',
  };
}

// 🎟️ Validate and Apply Coupon Function with Comprehensive Multi-Layer Security Checks
async function validateAndApplyCoupon(couponCode, orderAmount, organizationId = null, selectedPlan = null) {
  if (!couponCode) return { valid: false, discount: 0, finalAmount: orderAmount, coupon: null };

  const code = String(couponCode).toUpperCase().replace(/[^A-Z0-9_-]/g, '').trim();
  const coupon = await Coupon.findOne({ code, isActive: true });

  if (!coupon) {
    return { valid: false, message: 'Invalid or inactive promotional coupon code.', discount: 0, finalAmount: orderAmount };
  }

  // 1. Time validity (validFrom & validTill)
  if (coupon.validFrom && new Date(coupon.validFrom) > new Date()) {
    return { valid: false, message: 'This coupon promotion has not started yet.', discount: 0, finalAmount: orderAmount };
  }

  if (coupon.validTill && new Date(coupon.validTill) < new Date()) {
    return { valid: false, message: 'This promotional coupon has expired.', discount: 0, finalAmount: orderAmount };
  }

  // 2. Global Total Usage Limit
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, message: 'This coupon total redemption limit has been reached.', discount: 0, finalAmount: orderAmount };
  }

  // 3. Minimum Order Amount Check
  if (coupon.minOrderAmount && orderAmount < coupon.minOrderAmount) {
    return {
      valid: false,
      message: `Minimum order amount of ₹${coupon.minOrderAmount} required for coupon ${code}. (Cart value: ₹${orderAmount})`,
      discount: 0,
      finalAmount: orderAmount,
    };
  }

  // 4. Applicable Plans Restriction
  if (selectedPlan && Array.isArray(coupon.applicablePlans) && coupon.applicablePlans.length > 0) {
    const planNormalized = String(selectedPlan).toLowerCase();
    const isApplicable =
      coupon.applicablePlans.includes('all') ||
      coupon.applicablePlans.map((p) => p.toLowerCase()).includes(planNormalized);
    if (!isApplicable) {
      return {
        valid: false,
        message: `Coupon "${code}" is valid only on [${coupon.applicablePlans.join(', ').toUpperCase()}] plans.`,
        discount: 0,
        finalAmount: orderAmount,
      };
    }
  }

  // 5. Anti-Abuse: Per-Organization Usage Limit
  if (organizationId && coupon.maxUsesPerOrg) {
    const existingRedemptions = await Payment.countDocuments({
      organization: organizationId,
      'notes.couponCode': code,
      status: 'paid',
    });

    if (existingRedemptions >= coupon.maxUsesPerOrg) {
      return {
        valid: false,
        message: `Your organization has already redeemed coupon "${code}" the maximum allowed ${coupon.maxUsesPerOrg} time(s).`,
        discount: 0,
        finalAmount: orderAmount,
      };
    }
  }

  // 6. First-Time Buyer Restriction
  if (organizationId && coupon.firstTimeOnly) {
    const priorPaidPayments = await Payment.countDocuments({
      organization: organizationId,
      status: 'paid',
    });

    if (priorPaidPayments > 0) {
      return {
        valid: false,
        message: `Coupon "${code}" is exclusively valid for first-time organization activations.`,
        discount: 0,
        finalAmount: orderAmount,
      };
    }
  }

  // 7. Calculate Discount Mathematically
  let discount = 0;
  if (coupon.discountType === 'percentage') {
    discount = Math.round((orderAmount * coupon.discountValue) / 100);
    if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
      discount = coupon.maxDiscountAmount;
    }
  } else if (coupon.discountType === 'flat') {
    discount = Math.min(coupon.discountValue, orderAmount - 1);
  }

  const finalAmount = Math.max(1, orderAmount - discount);
  return {
    valid: true,
    coupon,
    discount,
    finalAmount,
    message: `🎉 Coupon "${code}" applied! You saved ₹${discount}.`,
  };
}

// 💳 1. GET PUBLIC RAZORPAY KEY ID & PRICING METADATA
exports.getKey = async (req, res) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TNdSmDOKSX2g6I';
    const Plan = require('../models/Plan.model');
    const plansList = await Plan.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 });
    const plansMap = {};
    if (plansList && plansList.length > 0) {
      plansList.forEach(p => {
        plansMap[p.planId] = {
          name: p.name,
          monthly: p.priceMonthly,
          yearly: p.priceYearly || Math.round(p.priceMonthly * 12 * 0.95),
          yearlyDiscount: '5% OFF',
          maxEmployees: p.maxEmployees,
          maxManagers: p.maxManagers,
          features: p.features,
        };
      });
    }

    return res.json({
      success: true,
      keyId,
      plans: Object.keys(plansMap).length > 0 ? plansMap : {
        starter: { name: 'Starter Plan', monthly: 999, yearly: Math.round(999 * 12 * 0.95), yearlyDiscount: '5% OFF', maxEmployees: 10, maxManagers: 3 },
        pro: { name: 'Growth Pro Plan', monthly: 1999, yearly: Math.round(1999 * 12 * 0.95), yearlyDiscount: '5% OFF', maxEmployees: 30, maxManagers: 10 },
        enterprise: { name: 'Enterprise Plan', monthly: 3999, yearly: Math.round(3999 * 12 * 0.95), yearlyDiscount: '5% OFF', maxEmployees: 50, maxManagers: 20 },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 📦 Fetch all active SaaS pricing plans for org checkout
exports.getPlans = async (req, res) => {
  try {
    const Plan = require('../models/Plan.model');
    let plans = await Plan.find({ isActive: true }).sort({ displayOrder: 1, createdAt: 1 });
    return res.json({ success: true, plans });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 🎟️ 2. CHECK / APPLY COUPON (USER SIDE)
exports.applyCoupon = async (req, res) => {
  try {
    const { couponCode, plan = 'pro', billingCycle = 'monthly', organizationId } = req.body;
    if (!couponCode) {
      return res.status(400).json({ success: false, message: 'Coupon code is required.' });
    }

    const orgId = organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    const priceInfo = await calculatePlanPrice(plan, billingCycle);
    const couponResult = await validateAndApplyCoupon(couponCode, priceInfo.totalAmount, orgId, plan);

    if (!couponResult.valid) {
      return res.status(400).json({
        success: false,
        message: couponResult.message || 'Invalid coupon code.',
      });
    }

    return res.json({
      success: true,
      valid: true,
      couponCode: couponResult.coupon.code,
      discount: couponResult.discount,
      originalAmount: priceInfo.totalAmount,
      finalAmount: couponResult.finalAmount,
      discountType: couponResult.coupon.discountType,
      discountValue: couponResult.coupon.discountValue,
      message: couponResult.message,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 💳 3. CREATE RAZORPAY ORDER (WITH SECURE SERVER-SIDE PRICING & COUPON VALIDATION)
exports.createOrder = async (req, res) => {
  try {
    const {
      plan = 'pro',
      billingCycle = 'monthly',
      seats = 10,
      employeeSeats = 0,
      managerSeats = 0,
      addonType = 'none',
      organizationId,
      userEmail,
      userName,
      couponCode,
    } = req.body;

    const isAddon = ['employee_addon', 'manager_addon', 'seat_addon', 'addon'].includes(plan);
    const cycleNormalized = String(billingCycle || 'monthly').toLowerCase().trim();
    const isYearlyOrder = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(cycleNormalized);
    const effectiveBillingCycle = isAddon ? 'onetime' : (isYearlyOrder ? 'yearly' : 'monthly');

    // 🔒 Validation: Check that Organization has an Active Base Subscription before allowing Add-On purchases
    let targetOrgId = organizationId;
    if (!targetOrgId && req.user?.organizationId) {
      targetOrgId = req.user.organizationId;
    }

    if (isAddon && targetOrgId) {
      const orgDoc = await Organization.findById(targetOrgId);
      const isOrgActive =
        orgDoc &&
        orgDoc.status === 'active' &&
        orgDoc.plan?.expiresAt &&
        new Date(orgDoc.plan.expiresAt) > new Date();

      if (!isOrgActive) {
        return res.status(400).json({
          success: false,
          message:
            '⚠️ Cannot purchase extra seat add-ons because your base subscription plan is inactive or expired. Please activate/renew your Starter, Pro, or Enterprise plan first.',
        });
      }
    }

    // 1. Calculate Base Price (Yearly billing includes exact 5% OFF, Addons use per-seat rate)
    const priceInfo = await calculatePlanPrice(
      plan,
      effectiveBillingCycle,
      Number(employeeSeats) || 0,
      Number(managerSeats) || 0,
      Number(seats) || 0
    );
    let finalAmountINR = priceInfo.totalAmount;
    let appliedDiscount = 0;
    let validCouponDoc = null;

    // 2. Validate Coupon Server-side if provided
    if (couponCode) {
      const couponCheck = await validateAndApplyCoupon(couponCode, finalAmountINR, targetOrgId, plan);
      if (couponCheck.valid) {
        finalAmountINR = couponCheck.finalAmount;
        appliedDiscount = couponCheck.discount;
        validCouponDoc = couponCheck.coupon;
      }
    }

    const amountInPaise = Math.round(finalAmountINR * 100);
    const razorpay = getRazorpayInstance();
    const receiptId = `rcpt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: receiptId,
      notes: {
        plan,
        billingCycle: effectiveBillingCycle,
        seats: String(seats),
        employeeSeats: String(employeeSeats || 0),
        managerSeats: String(managerSeats || 0),
        addonType: isAddon ? (addonType || (plan === 'manager_addon' ? 'manager' : 'employee')) : 'none',
        organizationId: organizationId ? String(organizationId) : '',
        userEmail: userEmail || '',
        userName: userName || '',
        couponCode: validCouponDoc ? validCouponDoc.code : '',
        discountAmount: String(appliedDiscount),
        originalAmount: String(priceInfo.totalAmount),
      },
    };

    const order = await razorpay.orders.create(options);

    // 3. Record created transaction in Database
    const payment = new Payment({
      organization: targetOrgId || organizationId || null,
      user: req.user ? req.user._id : null,
      razorpayOrderId: order.id,
      amount: finalAmountINR,
      amountPaid: 0,
      currency: 'INR',
      status: 'created',
      plan,
      addonType: options.notes.addonType,
      employeeSeats: Number(employeeSeats) || (plan === 'employee_addon' ? Number(seats) : 0),
      managerSeats: Number(managerSeats) || (plan === 'manager_addon' ? Number(seats) : 0),
      billingCycle: effectiveBillingCycle,
      seats: Number(seats),
      notes: options.notes,
    });

    await payment.save();

    return res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_live_TNdSmDOKSX2g6I',
      orderId: order.id,
      amount: order.amount,
      amountINR: finalAmountINR,
      originalAmountINR: priceInfo.totalAmount,
      discountINR: appliedDiscount,
      couponCode: validCouponDoc ? validCouponDoc.code : null,
      currency: order.currency,
      paymentId: payment._id,
      plan,
      billingCycle: effectiveBillingCycle,
    });
  } catch (err) {
    console.error('🔥 Razorpay Create Order Error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create payment order: ' + err.message,
    });
  }
};

// 🛡️ REUSABLE HELPER: ACTIVATE ORGANIZATION FROM A CONFIRMED/CAPTURED PAYMENT
async function activateOrganizationFromPayment(payment, io = null) {
  if (!payment) return null;

  let targetOrgId = payment.organization || payment.notes?.organizationId;
  if (!targetOrgId && payment.user) {
    const User = require('../models/User.model');
    const u = await User.findById(payment.user);
    if (u?.organizationId) targetOrgId = u.organizationId;
  }
  if (!targetOrgId && (payment.notes?.userEmail)) {
    const User = require('../models/User.model');
    const u = await User.findOne({ email: payment.notes.userEmail });
    if (u?.organizationId) targetOrgId = u.organizationId;
  }

  if (!targetOrgId) {
    console.error('Cannot activate organization: No targetOrgId found for payment', payment._id);
    return null;
  }

  const isAddon = ['employee_addon', 'manager_addon', 'seat_addon', 'addon'].includes(payment.plan);

  // 1. Handle Seat Add-ons
  if (isAddon) {
    let incEmp = Number(payment.employeeSeats) || 0;
    let incMgr = Number(payment.managerSeats) || 0;
    if (incEmp === 0 && incMgr === 0) {
      if (payment.plan === 'manager_addon') {
        incMgr = Number(payment.seats) || 1;
      } else {
        incEmp = Number(payment.seats) || 1;
      }
    }

    const currentOrgDoc = await Organization.findById(targetOrgId);
    const setFields = { status: 'active' };

    if (!currentOrgDoc?.plan?.expiresAt || new Date(currentOrgDoc.plan.expiresAt) < new Date()) {
      const exp = new Date();
      exp.setDate(exp.getDate() + 30);
      setFields['plan.expiresAt'] = exp;
      if (!currentOrgDoc?.plan?.planName || currentOrgDoc?.plan?.planName === 'No Active Plan') {
        setFields['plan.planName'] = 'Custom Seat Top-Up';
      }
    }

    const incFields = {};
    if (incEmp > 0) incFields['plan.maxEmployees'] = incEmp;
    if (incMgr > 0) incFields['plan.maxManagers'] = incMgr;

    const updateOperation = { $set: setFields };
    if (Object.keys(incFields).length > 0) {
      updateOperation.$inc = incFields;
    }

    const updatedOrg = await Organization.findByIdAndUpdate(targetOrgId, updateOperation, { new: true });

    if (io && updatedOrg) {
      const orgIdStr = updatedOrg._id.toString();
      io.to(`org_${orgIdStr}`).emit('subscription_activated', {
        organizationId: orgIdStr,
        status: 'active',
        plan: updatedOrg.plan,
        isAddon: true,
      });
      io.emit('organization_status_updated', {
        organizationId: orgIdStr,
        status: 'active',
      });
    }

    return updatedOrg;
  }

  // 2. Handle Full SaaS Tier Plan Activation
  const effectiveBillingCycle = String(
    payment.billingCycle ||
    payment.notes?.billingCycle ||
    'monthly'
  ).toLowerCase().trim();

  const isYearly = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(effectiveBillingCycle);
  const expirationDays = isYearly ? 365 : 30;
  const cleanCycle = isYearly ? 'yearly' : 'monthly';

  let maxEmployees = 30;
  let maxManagers = 10;
  let planTitle = 'Growth Pro Plan';

  try {
    const Plan = require('../models/Plan.model');
    const planKey = payment.plan || 'pro';
    const dbPlan = await Plan.findOne({
      $or: [
        { planId: planKey },
        { name: { $regex: new RegExp(`^${planKey}`, 'i') } },
      ],
      isActive: true,
    });
    if (dbPlan) {
      maxEmployees = dbPlan.maxEmployees || maxEmployees;
      maxManagers = dbPlan.maxManagers || maxManagers;
      planTitle = dbPlan.name || planTitle;
    } else {
      if (planKey === 'starter') {
        maxEmployees = 10;
        maxManagers = 3;
        planTitle = 'Starter Plan';
      } else if (planKey === 'enterprise') {
        maxEmployees = 50;
        maxManagers = 20;
        planTitle = 'Enterprise Plan';
      }
    }
  } catch (e) {
    if (payment.plan === 'starter') {
      maxEmployees = 10;
      maxManagers = 3;
      planTitle = 'Starter Plan';
    } else if (payment.plan === 'enterprise') {
      maxEmployees = 50;
      maxManagers = 20;
      planTitle = 'Enterprise Plan';
    }
  }

  const currentOrgDoc = await Organization.findById(targetOrgId);
  const currentExpiry = currentOrgDoc?.plan?.expiresAt ? new Date(currentOrgDoc.plan.expiresAt) : null;
  const baseDate = (currentExpiry && currentExpiry > new Date()) ? new Date(currentExpiry) : new Date();
  baseDate.setDate(baseDate.getDate() + expirationDays);
  const expiresAt = baseDate;

  const updatedOrg = await Organization.findByIdAndUpdate(
    targetOrgId,
    {
      status: 'active',
      'plan.planName': planTitle,
      'plan.maxEmployees': maxEmployees,
      'plan.maxManagers': maxManagers,
      'plan.startsAt': (currentExpiry && currentExpiry > new Date()) ? currentOrgDoc.plan.startsAt || new Date() : new Date(),
      'plan.expiresAt': expiresAt,
    },
    { new: true }
  );

  if (io && updatedOrg) {
    const orgIdStr = updatedOrg._id.toString();
    io.to(`org_${orgIdStr}`).emit('subscription_activated', {
      organizationId: orgIdStr,
      status: 'active',
      plan: updatedOrg.plan,
      billingCycle: cleanCycle,
      durationDays: expirationDays,
      daysRemaining: Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)),
    });
    io.emit('organization_status_updated', {
      organizationId: orgIdStr,
      status: 'active',
    });
  }

  return updatedOrg;
}

// 💳 4. VERIFY RAZORPAY PAYMENT & ACTIVATE SUBSCRIPTION / SEAT TOP-UP
exports.verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      organizationId,
      plan = 'pro',
      billingCycle = 'monthly',
      couponCode,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required Razorpay payment credentials.',
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || '5GO0yjbVCTn58B1FDUocEjyb';
    const bodyToSign = razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyToSign)
      .digest('hex');

    const isSignatureValid = expectedSignature === razorpay_signature;

    if (!isSignatureValid) {
      await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { status: 'failed', failureReason: 'Cryptographic HMAC signature mismatch' }
      );

      return res.status(400).json({
        success: false,
        message: 'Payment verification failed: Invalid cryptographic signature.',
      });
    }

    // Payment signature is valid! Update Payment status to PAID
    const payment = await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        status: 'paid',
        amountPaid: req.body.amountPaid || undefined,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paidAt: new Date(),
      },
      { new: true }
    );

    // Atomically increment coupon usage and savings if used
    const codeToIncrement = couponCode || payment?.notes?.couponCode;
    if (codeToIncrement) {
      const cleanIncCode = String(codeToIncrement).toUpperCase().trim();
      const discAmt = Number(payment?.notes?.discountAmount) || 0;
      await Coupon.findOneAndUpdate(
        { code: cleanIncCode },
        {
          $inc: {
            usedCount: 1,
            totalSavingsGenerated: discAmt,
          },
        }
      );
    }

    let targetOrgId = organizationId || (payment && payment.organization) || (payment && payment.notes && payment.notes.organizationId);
    if (!targetOrgId && req.user?.organizationId) {
      targetOrgId = req.user.organizationId;
    }
    if (!targetOrgId && payment?.user) {
      const User = require('../models/User.model');
      const u = await User.findById(payment.user);
      if (u?.organizationId) targetOrgId = u.organizationId;
    }
    if (!targetOrgId && (payment?.notes?.userEmail || req.user?.email)) {
      const User = require('../models/User.model');
      const emailToFind = payment?.notes?.userEmail || req.user?.email;
      const u = await User.findOne({ email: emailToFind });
      if (u?.organizationId) targetOrgId = u.organizationId;
    }

    const isAddon = ['employee_addon', 'manager_addon', 'seat_addon', 'addon'].includes(plan);

    // ⚡ HANDLE SEAT ADD-ONS (ATOMICALLY INCREMENT MAX EMPLOYEES / MANAGERS)
    if (isAddon) {
      let incEmp = Number(payment?.employeeSeats) || 0;
      let incMgr = Number(payment?.managerSeats) || 0;

      if (incEmp === 0 && incMgr === 0) {
        if (plan === 'manager_addon') {
          incMgr = Number(payment?.seats) || Number(req.body.managerSeats) || 1;
        } else {
          incEmp = Number(payment?.seats) || Number(req.body.employeeSeats) || 1;
        }
      }

      let updatedOrg = null;
      if (targetOrgId) {
        const currentOrgDoc = await Organization.findById(targetOrgId);
        const setFields = { status: 'active' };

        // If organization has no active plan or expired, provide an active window
        if (!currentOrgDoc?.plan?.expiresAt || new Date(currentOrgDoc.plan.expiresAt) < new Date()) {
          const exp = new Date();
          exp.setDate(exp.getDate() + 30);
          setFields['plan.expiresAt'] = exp;
          if (!currentOrgDoc?.plan?.planName || currentOrgDoc?.plan?.planName === 'No Active Plan') {
            setFields['plan.planName'] = 'Custom Seat Top-Up';
          }
        }

        const incFields = {};
        if (incEmp > 0) incFields['plan.maxEmployees'] = incEmp;
        if (incMgr > 0) incFields['plan.maxManagers'] = incMgr;

        const updateOperation = { $set: setFields };
        if (Object.keys(incFields).length > 0) {
          updateOperation.$inc = incFields;
        }

        updatedOrg = await Organization.findByIdAndUpdate(
          targetOrgId,
          updateOperation,
          { new: true }
        );

        const io = req.app?.get('io');
        if (io && updatedOrg) {
          const orgIdStr = updatedOrg._id.toString();
          io.to(`org_${orgIdStr}`).emit('subscription_activated', {
            organizationId: orgIdStr,
            status: 'active',
            plan: updatedOrg.plan,
          });
        }
      }

      const summaryParts = [];
      if (incEmp > 0) summaryParts.push(`${incEmp} Employee seat(s)`);
      if (incMgr > 0) summaryParts.push(`${incMgr} Manager seat(s)`);

      return res.json({
        success: true,
        message: `🎉 Top-up successful! Added ${summaryParts.join(' & ')} to your organization.`,
        payment,
        organization: updatedOrg,
        isAddon: true,
      });
    }

    // 📦 HANDLE FULL SAAS TIER PLAN ACTIVATION
    const effectiveBillingCycle = String(
      req.body.billingCycle ||
      payment?.billingCycle ||
      payment?.notes?.billingCycle ||
      'monthly'
    ).toLowerCase().trim();

    const isYearly = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(effectiveBillingCycle);
    const expirationDays = isYearly ? 365 : 30;
    const cleanCycle = isYearly ? 'yearly' : 'monthly';

    let maxEmployees = 30;
    let maxManagers = 10;
    let planTitle = 'Growth Pro Plan';

    try {
      const Plan = require('../models/Plan.model');
      const dbPlan = await Plan.findOne({
        $or: [
          { planId: plan },
          { name: { $regex: new RegExp(`^${plan}`, 'i') } },
        ],
        isActive: true,
      });
      if (dbPlan) {
        maxEmployees = dbPlan.maxEmployees || maxEmployees;
        maxManagers = dbPlan.maxManagers || maxManagers;
        planTitle = dbPlan.name || planTitle;
      } else {
        if (plan === 'starter') {
          maxEmployees = 10;
          maxManagers = 3;
          planTitle = 'Starter Plan';
        } else if (plan === 'enterprise') {
          maxEmployees = 50;
          maxManagers = 20;
          planTitle = 'Enterprise Plan';
        }
      }
    } catch (e) {
      if (plan === 'starter') {
        maxEmployees = 10;
        maxManagers = 3;
        planTitle = 'Starter Plan';
      } else if (plan === 'enterprise') {
        maxEmployees = 50;
        maxManagers = 20;
        planTitle = 'Enterprise Plan';
      }
    }

    let updatedOrg = null;
    let expiresAt = new Date();
    if (targetOrgId) {
      const currentOrgDoc = await Organization.findById(targetOrgId);
      const currentExpiry = currentOrgDoc?.plan?.expiresAt ? new Date(currentOrgDoc.plan.expiresAt) : null;
      // Mathematical extension: If current plan is active and unexpired, extend from current expiry.
      // Otherwise, start from now.
      const baseDate = (currentExpiry && currentExpiry > new Date()) ? new Date(currentExpiry) : new Date();
      baseDate.setDate(baseDate.getDate() + expirationDays);
      expiresAt = baseDate;

      updatedOrg = await Organization.findByIdAndUpdate(
        targetOrgId,
        {
          status: 'active',
          'plan.planName': planTitle,
          'plan.maxEmployees': maxEmployees,
          'plan.maxManagers': maxManagers,
          'plan.startsAt': (currentExpiry && currentExpiry > new Date()) ? currentOrgDoc.plan.startsAt || new Date() : new Date(),
          'plan.expiresAt': expiresAt,
        },
        { new: true }
      );

      const io = req.app?.get('io');
      if (io && updatedOrg) {
        const orgIdStr = updatedOrg._id.toString();
        io.to(`org_${orgIdStr}`).emit('subscription_activated', {
          organizationId: orgIdStr,
          status: 'active',
          plan: updatedOrg.plan,
          billingCycle: cleanCycle,
          durationDays: expirationDays,
          daysRemaining: Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)),
        });
        io.emit('organization_status_updated', {
          organizationId: orgIdStr,
          status: 'active',
        });
      }
    }

    return res.json({
      success: true,
      message: `🎉 ${cleanCycle === 'yearly' ? '1 Year (365 Days)' : '1 Month (30 Days)'} subscription activated! You are now on the ${planTitle}.`,
      payment,
      organization: updatedOrg,
      billingCycle: cleanCycle,
      durationDays: expirationDays,
      expiresAt,
      isAddon: false,
    });
  } catch (err) {
    console.error('🔥 Razorpay Verify Payment Error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment: ' + err.message,
    });
  }
};

// 💳 5. GET PAYMENT HISTORY FOR ORGANIZATION
exports.getHistory = async (req, res) => {
  try {
    const rawOrgId = req.query.organizationId || req.user?.organizationId || req.user?.organization;
    const filter = rawOrgId ? { organization: rawOrgId } : {};

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate('organization', 'name email phone')
      .limit(100);

    return res.json({
      success: true,
      count: payments.length,
      payments,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ⚡ 6. AUTO SYNC LATEST PAID SUBSCRIPTION FOR ORGANIZATION
exports.syncLatestPayment = async (req, res) => {
  try {
    const orgId = req.organizationId || req.user?.organizationId || req.query.organizationId;
    if (!orgId) return res.status(400).json({ success: false, message: 'Organization ID required' });

    const latestPaidPayment = await Payment.findOne({
      $or: [{ organization: orgId }, { 'notes.organizationId': String(orgId) }],
      status: 'paid',
    }).sort({ paidAt: -1, createdAt: -1 });

    if (!latestPaidPayment) {
      return res.json({ success: true, message: 'No recent paid payment records found.' });
    }

    const Plan = require('../models/Plan.model');
    const planKey = latestPaidPayment.plan || 'pro';
    const dbPlan = await Plan.findOne({
      $or: [{ planId: planKey }, { name: { $regex: new RegExp(`^${planKey}`, 'i') } }],
    });

    const maxEmployees = dbPlan?.maxEmployees || (planKey === 'starter' ? 10 : planKey === 'enterprise' ? 50 : 30);
    const maxManagers = dbPlan?.maxManagers || (planKey === 'starter' ? 3 : planKey === 'enterprise' ? 20 : 10);
    const planTitle = dbPlan?.name || (planKey === 'starter' ? 'Starter Plan' : planKey === 'enterprise' ? 'Enterprise Plan' : 'Growth Pro Plan');

    const latestCycle = String(latestPaidPayment.billingCycle || latestPaidPayment.notes?.billingCycle || 'monthly').toLowerCase().trim();
    const isYearly = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(latestCycle);
    const durationDays = isYearly ? 365 : 30;

    const currentOrg = await Organization.findById(orgId);
    const currentExpiry = currentOrg?.plan?.expiresAt ? new Date(currentOrg.plan.expiresAt) : null;
    const baseDate = (currentExpiry && currentExpiry > new Date()) ? new Date(currentExpiry) : new Date();
    baseDate.setDate(baseDate.getDate() + durationDays);
    const expiresAt = baseDate;

    const updatedOrg = await Organization.findByIdAndUpdate(
      orgId,
      {
        status: 'active',
        'plan.planName': planTitle,
        'plan.maxEmployees': maxEmployees,
        'plan.maxManagers': maxManagers,
        'plan.startsAt': (currentExpiry && currentExpiry > new Date()) ? currentOrg?.plan?.startsAt || new Date() : (latestPaidPayment.paidAt || new Date()),
        'plan.expiresAt': expiresAt,
      },
      { new: true }
    );

    return res.json({
      success: true,
      message: `🎉 Successfully synced latest payment and activated ${planTitle}!`,
      organization: updatedOrg,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ⚡ 7. DIRECT / INSTANT VERIFY SUBSCRIPTION ACTIVATION (1 MONTH OR 1 YEAR)
exports.activateSubscriptionDirect = async (req, res) => {
  try {
    const {
      plan = 'pro',
      billingCycle = 'monthly',
      couponCode,
      organizationId,
    } = req.body;

    let targetOrgId = organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    if (!targetOrgId && req.organizationId) {
      targetOrgId = req.organizationId;
    }

    if (!targetOrgId) {
      return res.status(400).json({ success: false, message: 'Organization ID is required.' });
    }

    const cycleNormalized = String(billingCycle || 'monthly').toLowerCase().trim();
    const isYearly = ['yearly', '1 year', '1year', 'year', 'annual', '12 months', '12months'].includes(cycleNormalized);
    const effectiveCycle = isYearly ? 'yearly' : 'monthly';
    const durationDays = isYearly ? 365 : 30;

    const priceInfo = await calculatePlanPrice(plan, effectiveCycle);
    let finalAmountINR = priceInfo.totalAmount;
    let appliedDiscount = 0;
    let validCouponDoc = null;

    if (couponCode) {
      const couponCheck = await validateAndApplyCoupon(couponCode, finalAmountINR, targetOrgId, plan);
      if (couponCheck.valid) {
        finalAmountINR = couponCheck.finalAmount;
        appliedDiscount = couponCheck.discount;
        validCouponDoc = couponCheck.coupon;

        await Coupon.findOneAndUpdate(
          { code: validCouponDoc.code },
          {
            $inc: {
              usedCount: 1,
              totalSavingsGenerated: appliedDiscount,
            },
          }
        );
      }
    }

    let maxEmployees = 30;
    let maxManagers = 10;
    let planTitle = 'Growth Pro Plan';

    const Plan = require('../models/Plan.model');
    const dbPlan = await Plan.findOne({
      $or: [{ planId: plan }, { name: { $regex: new RegExp(`^${plan}`, 'i') } }],
      isActive: true,
    });
    if (dbPlan) {
      maxEmployees = dbPlan.maxEmployees || maxEmployees;
      maxManagers = dbPlan.maxManagers || maxManagers;
      planTitle = dbPlan.name || planTitle;
    } else {
      if (plan === 'starter') {
        maxEmployees = 10;
        maxManagers = 3;
        planTitle = 'Starter Plan';
      } else if (plan === 'enterprise') {
        maxEmployees = 50;
        maxManagers = 20;
        planTitle = 'Enterprise Plan';
      }
    }

    const currentOrgDoc = await Organization.findById(targetOrgId);
    if (!currentOrgDoc) {
      return res.status(404).json({ success: false, message: 'Organization document not found.' });
    }

    const currentExpiry = currentOrgDoc.plan?.expiresAt ? new Date(currentOrgDoc.plan.expiresAt) : null;
    const baseDate = (currentExpiry && currentExpiry > new Date()) ? new Date(currentExpiry) : new Date();
    baseDate.setDate(baseDate.getDate() + durationDays);
    const expiresAt = baseDate;

    const receiptId = `inst_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const payment = new Payment({
      organization: targetOrgId,
      user: req.user ? req.user._id : null,
      razorpayOrderId: `order_${receiptId}`,
      razorpayPaymentId: `pay_${receiptId}`,
      razorpaySignature: 'instant_verified',
      amount: finalAmountINR,
      amountPaid: finalAmountINR,
      currency: 'INR',
      status: 'paid',
      plan,
      billingCycle: effectiveCycle,
      paidAt: new Date(),
      notes: {
        plan,
        billingCycle: effectiveCycle,
        durationDays: String(durationDays),
        couponCode: validCouponDoc ? validCouponDoc.code : '',
        discountAmount: String(appliedDiscount),
        originalAmount: String(priceInfo.totalAmount),
        activationType: 'instant_verify',
      },
    });
    await payment.save();

    const updatedOrg = await Organization.findByIdAndUpdate(
      targetOrgId,
      {
        status: 'active',
        'plan.planName': planTitle,
        'plan.maxEmployees': maxEmployees,
        'plan.maxManagers': maxManagers,
        'plan.startsAt': (currentExpiry && currentExpiry > new Date()) ? currentOrgDoc.plan.startsAt || new Date() : new Date(),
        'plan.expiresAt': expiresAt,
      },
      { new: true }
    );

    const io = req.app?.get('io');
    if (io && updatedOrg) {
      const orgIdStr = updatedOrg._id.toString();
      io.to(`org_${orgIdStr}`).emit('subscription_activated', {
        organizationId: orgIdStr,
        status: 'active',
        plan: updatedOrg.plan,
        billingCycle: effectiveCycle,
        durationDays,
        daysRemaining: Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)),
      });
      io.emit('organization_status_updated', {
        organizationId: orgIdStr,
        status: 'active',
      });
    }

    return res.json({
      success: true,
      message: `🎉 ${effectiveCycle === 'yearly' ? '1 Year (365 Days)' : '1 Month (30 Days)'} subscription activated! You are now on the ${planTitle}.`,
      payment,
      organization: updatedOrg,
      billingCycle: effectiveCycle,
      durationDays,
      expiresAt,
    });
  } catch (err) {
    console.error('🔥 Instant Subscription Activation Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to activate subscription: ' + err.message });
  }
};

// 🔄 8. ACTIVE RAZORPAY ORDER SYNC & VERIFICATION (RESOLVES UNCAPTURED PAYMENTS BY ORDER ID)
exports.syncOrderById = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Razorpay Order ID is required.' });
    }

    const cleanOrderId = String(orderId).trim();
    let payment = await Payment.findOne({ razorpayOrderId: cleanOrderId });

    const rzp = getRazorpayInstance();
    const orderData = await rzp.orders.fetch(cleanOrderId);
    const paymentsList = await rzp.orders.fetchPayments(cleanOrderId);

    const items = paymentsList.items || [];
    const capturedPayment = items.find((p) => p.status === 'captured');
    const authorizedPayment = items.find((p) => p.status === 'authorized');
    const failedPayment = items.find((p) => p.status === 'failed');

    // Case A: Payment was captured on Razorpay
    if (capturedPayment || orderData.status === 'paid' || orderData.amount_paid > 0) {
      const activePayItem = capturedPayment || authorizedPayment || items[0];
      const payId = activePayItem ? activePayItem.id : (payment?.razorpayPaymentId || '');

      if (!payment) {
        payment = new Payment({
          organization: req.user?.organizationId || null,
          razorpayOrderId: cleanOrderId,
          amount: orderData.amount / 100,
          amountPaid: orderData.amount_paid / 100,
          currency: orderData.currency || 'INR',
          status: 'paid',
          plan: orderData.notes?.plan || 'pro',
          billingCycle: orderData.notes?.billingCycle || 'monthly',
          paidAt: new Date(),
          razorpayPaymentId: payId,
          notes: orderData.notes || {},
        });
      } else {
        payment.status = 'paid';
        payment.amountPaid = orderData.amount_paid ? orderData.amount_paid / 100 : payment.amount;
        payment.razorpayPaymentId = payId;
        payment.paidAt = new Date();
      }

      await payment.save();

      const io = req.app?.get('io');
      const updatedOrg = await activateOrganizationFromPayment(payment, io);

      return res.json({
        success: true,
        message: '🎉 Payment successfully confirmed and captured from Razorpay! Subscription is now active.',
        status: 'paid',
        payment,
        organization: updatedOrg,
      });
    }

    // Case B: Payment failed on Razorpay (e.g. Website whitelisting block or bank decline)
    if (failedPayment) {
      const failureReason = failedPayment.error_description || failedPayment.error_code || 'Payment declined by Razorpay';
      if (payment) {
        payment.status = 'failed';
        payment.razorpayPaymentId = failedPayment.id;
        payment.failureReason = failureReason;
        await payment.save();
      }

      return res.status(400).json({
        success: false,
        status: 'failed',
        failureReason,
        message: `Razorpay reported payment failure: ${failureReason}`,
        helpHint: failureReason.includes('website does not match registered')
          ? 'Razorpay Live security blocked this payment because your domain (e.g. field-moniter-frontend.vercel.app) is not added in Razorpay Dashboard > Settings > Website & App Details.'
          : undefined,
      });
    }

    // Case C: Order is created but no transaction attempt has finished yet
    return res.json({
      success: false,
      status: 'created',
      message: 'Razorpay has not received any completed payment for this order yet. If you completed UPI payment on your phone, please wait a few seconds and try again.',
    });
  } catch (err) {
    console.error('🔥 Sync Order Error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to sync with Razorpay: ' + err.message });
  }
};

// 📡 9. RAZORPAY OFFICIAL SERVER-TO-SERVER WEBHOOK HANDLER
exports.handleWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || '5GO0yjbVCTn58B1FDUocEjyb';
    const signature = req.headers['x-razorpay-signature'];

    // Verify HMAC SHA256 Webhook Signature
    if (signature) {
      const rawPayload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawPayload)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.warn('⚠️ [RAZORPAY_WEBHOOK] Signature mismatch. Event received but signature check failed.');
      }
    }

    const event = req.body?.event;
    const paymentEntity = req.body?.payload?.payment?.entity;
    const orderEntity = req.body?.payload?.order?.entity;

    const orderId = paymentEntity?.order_id || orderEntity?.id;
    const paymentId = paymentEntity?.id;

    console.log(`📡 [RAZORPAY_WEBHOOK] Received event: ${event} for Order: ${orderId}`);

    if (event === 'payment.captured' || event === 'order.paid') {
      if (orderId) {
        let payment = await Payment.findOne({ razorpayOrderId: orderId });
        if (payment) {
          payment.status = 'paid';
          payment.razorpayPaymentId = paymentId || payment.razorpayPaymentId;
          payment.amountPaid = paymentEntity?.amount ? paymentEntity.amount / 100 : payment.amount;
          payment.paidAt = new Date();
          await payment.save();
        } else {
          payment = new Payment({
            organization: orderEntity?.notes?.organizationId || null,
            razorpayOrderId: orderId,
            razorpayPaymentId: paymentId || '',
            amount: (paymentEntity?.amount || orderEntity?.amount || 0) / 100,
            amountPaid: (paymentEntity?.amount || orderEntity?.amount || 0) / 100,
            currency: 'INR',
            status: 'paid',
            plan: orderEntity?.notes?.plan || 'pro',
            billingCycle: orderEntity?.notes?.billingCycle || 'monthly',
            paidAt: new Date(),
            notes: orderEntity?.notes || paymentEntity?.notes || {},
          });
          await payment.save();
        }

        const io = req.app?.get('io');
        await activateOrganizationFromPayment(payment, io);
        console.log(`✅ [RAZORPAY_WEBHOOK] Organization successfully activated for order: ${orderId}`);
      }
    } else if (event === 'payment.failed') {
      if (orderId) {
        await Payment.findOneAndUpdate(
          { razorpayOrderId: orderId },
          {
            status: 'failed',
            razorpayPaymentId: paymentId || '',
            failureReason: paymentEntity?.error_description || 'Payment failed',
          }
        );
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('🔥 [RAZORPAY_WEBHOOK] Error processing webhook:', err.message);
    return res.status(200).json({ status: 'error', message: err.message });
  }
};

// ❌ 10. RECORD CLIENT-SIDE CHECKOUT FAILURE WITH EXACT REASON
exports.recordPaymentFailure = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, error } = req.body;
    if (!razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'Order ID required' });
    }

    const reason = error?.description || error?.reason || 'Payment failed';
    const payment = await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        status: 'failed',
        razorpayPaymentId: razorpay_payment_id || error?.metadata?.payment_id || '',
        failureReason: reason,
      },
      { new: true }
    );

    return res.json({ success: true, payment, failureReason: reason });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
