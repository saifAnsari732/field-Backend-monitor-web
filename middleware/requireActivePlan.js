const Organization = require('../models/Organization.model');
const { evaluateSubscription } = require('../services/subscription.service');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔒 REQUIRE ACTIVE SUBSCRIPTION PLAN MIDDLEWARE
 * ═══════════════════════════════════════════════════════════════════════════
 * Strictly locks operational endpoints whenever an Organization's plan is
 * expired, unpaid, cancelled, or suspended.
 *
 * Exemption:
 * - Super Admins (Platform operators) have master bypass.
 *
 * Response on Expiration:
 * - HTTP 402 Payment Required with rich diagnostics and renewal URL hints.
 */
const requireActivePlan = async (req, res, next) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();

    // 1. Super Admin master bypass
    if (['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) {
      return next();
    }

    // 2. Resolve Organization ID
    const orgId = req.organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    if (!orgId) {
      return res.status(403).json({
        success: false,
        planRequired: true,
        message: 'Account is not associated with any Organization.',
      });
    }

    // 3. Retrieve Organization document
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        success: false,
        planRequired: true,
        message: 'Organization record could not be found.',
      });
    }

    // 4. Mathematical Subscription Evaluation & Self-Healing State Reconciliation
    const io = req.app?.get('io');
    const evaluation = await evaluateSubscription(org, io);

    if (!evaluation.isPlanActive) {
      return res.status(402).json({
        success: false,
        planRequired: true,
        planExpired: true,
        code: 'SUBSCRIPTION_EXPIRED',
        message: evaluation.userMessage,
        subscription: {
          state: evaluation.state,
          status: org.status,
          planName: evaluation.planName,
          startsAt: evaluation.startsAt,
          expiresAt: evaluation.expiresAt,
          daysRemaining: evaluation.daysRemaining,
          healthScore: evaluation.healthScore,
        },
        renewalUrl: '/admin/billing',
      });
    }

    // Attach verified context
    req.organization = org;
    req.subscription = evaluation;
    next();
  } catch (err) {
    console.error('❌ [REQUIRE_ACTIVE_PLAN] Error checking subscription:', err.message);
    next(err);
  }
};

module.exports = requireActivePlan;
