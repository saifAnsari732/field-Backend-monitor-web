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
  try {
    const Plan = require('../models/Plan.model');
    const dbPlan = await Plan.findOne({
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

  if (billingCycle === 'yearly') {
    const totalYearlyOriginal = monthlyPrice * 12;
    // Exactly 5% OFF on Yearly Billing!
    const discountedYearly = Math.round(totalYearlyOriginal * 0.95);
    return {
      monthlyPrice,
      totalAmount: discountedYearly,
      discountPercent: 5,
      savings: totalYearlyOriginal - discountedYearly,
      originalAmount: totalYearlyOriginal,
    };
  }

  return {
    monthlyPrice,
    totalAmount: monthlyPrice,
    discountPercent: 0,
    savings: 0,
    originalAmount: monthlyPrice,
  };
}

// 🎟️ Validate and Apply Coupon Function
async function validateAndApplyCoupon(couponCode, orderAmount) {
  if (!couponCode) return { valid: false, discount: 0, finalAmount: orderAmount, coupon: null };

  const code = couponCode.toUpperCase().trim();
  const coupon = await Coupon.findOne({ code, isActive: true });

  if (!coupon) {
    return { valid: false, message: 'Invalid or inactive coupon code.', discount: 0, finalAmount: orderAmount };
  }

  if (coupon.validTill && new Date(coupon.validTill) < new Date()) {
    return { valid: false, message: 'This coupon has expired.', discount: 0, finalAmount: orderAmount };
  }

  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, message: 'This coupon usage limit has been reached.', discount: 0, finalAmount: orderAmount };
  }

  if (coupon.minOrderAmount && orderAmount < coupon.minOrderAmount) {
    return {
      valid: false,
      message: `Minimum order amount of ₹${coupon.minOrderAmount} required for coupon ${code}.`,
      discount: 0,
      finalAmount: orderAmount,
    };
  }

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
    const { couponCode, plan = 'pro', billingCycle = 'monthly' } = req.body;
    if (!couponCode) {
      return res.status(400).json({ success: false, message: 'Coupon code is required.' });
    }

    const priceInfo = await calculatePlanPrice(plan, billingCycle);
    const couponResult = await validateAndApplyCoupon(couponCode, priceInfo.totalAmount);

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
    const effectiveBillingCycle = isAddon ? 'onetime' : billingCycle;

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
      const couponCheck = await validateAndApplyCoupon(couponCode, finalAmountINR);
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
      organization: organizationId || null,
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

    // Atomically increment coupon usage if used
    const codeToIncrement = couponCode || payment?.notes?.couponCode;
    if (codeToIncrement) {
      await Coupon.findOneAndUpdate(
        { code: codeToIncrement.toUpperCase().trim() },
        { $inc: { usedCount: 1 } }
      );
    }

    let targetOrgId = organizationId || (payment && payment.organization);
    if (!targetOrgId && req.user?.organizationId) {
      targetOrgId = req.user.organizationId;
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
    // Calculate subscription expiration date (30 days for monthly, 365 days for yearly)
    const expirationDays = billingCycle === 'yearly' ? 365 : 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expirationDays);

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
    if (targetOrgId) {
      updatedOrg = await Organization.findByIdAndUpdate(
        targetOrgId,
        {
          status: 'active',
          'plan.planName': planTitle,
          'plan.maxEmployees': maxEmployees,
          'plan.maxManagers': maxManagers,
          'plan.startsAt': new Date(),
          'plan.expiresAt': expiresAt,
        },
        { new: true }
      );
    }

    return res.json({
      success: true,
      message: `🎉 Subscription activated! You are now on the ${planTitle}.`,
      payment,
      organization: updatedOrg,
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
