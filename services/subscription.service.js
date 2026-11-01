const Organization = require('../models/Organization.model');
const User = require('../models/User.model');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛡️ ADVANCED SAAS SUBSCRIPTION & QUOTA INTELLIGENCE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 * Implements rigorous mathematical subscription lifecycle evaluation,
 * autonomous real-time database state reconciliation, and multi-tenant
 * capacity vector calculations.
 */

/**
 * Evaluates the mathematical lifecycle state of an organization's subscription.
 *
 * Mathematical Definitions:
 * - t: Current UTC timestamp in milliseconds
 * - t0: Subscription start timestamp
 * - t1: Subscription expiration timestamp
 * - Duration T = max(t1 - t0, 1)
 * - Delta Δ = t1 - t
 * - Days Remaining D_rem = Δ > 0 ? ceil(Δ / 86400000) : -floor(|Δ| / 86400000)
 * - Elapsed Ratio R = clamp((t - t0) / T, 0, 1)
 * - Health Score S(t) = Δ > 0 ? round((1 - R) * 100) : 0
 *
 * @param {Object} organization - Mongoose doc or plain object
 * @param {Object} [io] - Optional Socket.io instance for real-time events
 * @returns {Promise<Object>} Detailed evaluation metrics
 */
async function evaluateSubscription(organization, io = null) {
  if (!organization) {
    return {
      isValid: false,
      isPlanActive: false,
      state: 'NO_ORGANIZATION',
      healthScore: 0,
      daysRemaining: 0,
      userMessage: 'No organization account associated.',
    };
  }

  const nowMs = Date.now();
  const startsAt = organization.plan?.startsAt ? new Date(organization.plan.startsAt).getTime() : nowMs;
  const expiresAt = organization.plan?.expiresAt ? new Date(organization.plan.expiresAt).getTime() : null;

  // Calculate Delta
  const hasExpiryDate = Boolean(expiresAt && !isNaN(expiresAt));
  const deltaMs = hasExpiryDate ? expiresAt - nowMs : -1;
  const totalDurationMs = hasExpiryDate && expiresAt > startsAt ? expiresAt - startsAt : 30 * 86400000;

  // Mathematical Days Remaining
  const daysRemaining = hasExpiryDate
    ? deltaMs > 0
      ? Math.ceil(deltaMs / (1000 * 60 * 60 * 24))
      : -Math.floor(Math.abs(deltaMs) / (1000 * 60 * 60 * 24))
    : 0;

  // Health Score S(t) in [0, 100]
  let healthScore = 0;
  if (hasExpiryDate && deltaMs > 0) {
    const elapsedRatio = Math.max(0, Math.min(1, (nowMs - startsAt) / totalDurationMs));
    healthScore = Math.max(1, Math.min(100, Math.round((1 - elapsedRatio) * 100)));
  }

  // Determine Exact Operational State
  let state = 'ACTIVE';
  let isPlanActive = false;
  let userMessage = 'Subscription is active.';

  if (organization.status === 'suspended') {
    state = 'SUSPENDED';
    isPlanActive = false;
    userMessage = 'Your organization account is suspended due to billing or compliance. Please contact support.';
  } else if (organization.status === 'cancelled') {
    state = 'CANCELLED';
    isPlanActive = false;
    userMessage = 'Your organization subscription has been cancelled.';
  } else if (!hasExpiryDate || organization.status === 'unpaid') {
    state = 'UNPAID';
    isPlanActive = false;
    userMessage = 'No active subscription plan found. Please purchase a plan in Billing.';
  } else if (deltaMs <= 0) {
    state = 'EXPIRED';
    isPlanActive = false;
    const expiredDays = Math.abs(daysRemaining);
    userMessage = `Your organization's subscription plan expired ${
      expiredDays === 0 ? 'today' : `${expiredDays} day(s) ago`
    }. Please renew your plan in Billing to unlock full operations.`;
  } else if (daysRemaining <= 3) {
    state = 'EXPIRING_SOON';
    isPlanActive = true;
    userMessage = `Subscription expiring in ${daysRemaining} day(s). Please renew soon to avoid operational interruption.`;
  } else {
    state = 'ACTIVE';
    isPlanActive = organization.status === 'active';
    userMessage = 'Subscription is active and healthy.';
  }

  // ── Auto-Reconciliation: If expired but status is still 'active', atomically flip to 'unpaid'
  if (state === 'EXPIRED' && organization.status === 'active' && organization._id) {
    try {
      await Organization.findByIdAndUpdate(organization._id, {
        $set: { status: 'unpaid' },
      });
      organization.status = 'unpaid';

      // Emit real-time notification to all connected org members
      if (io) {
        const orgIdStr = organization._id.toString();
        io.to(`org_${orgIdStr}`).emit('subscription_expired', {
          organizationId: orgIdStr,
          status: 'unpaid',
          message: userMessage,
          expiredAt: organization.plan?.expiresAt,
        });
        io.emit('organization_status_updated', {
          organizationId: orgIdStr,
          status: 'unpaid',
        });
      }
    } catch (reconcileErr) {
      console.error('❌ [SUBSCRIPTION_ENGINE] Auto-reconciliation update failed:', reconcileErr.message);
    }
  }

  return {
    isValid: true,
    isPlanActive,
    state,
    status: organization.status,
    planName: organization.plan?.planName || 'No Active Plan',
    startsAt: organization.plan?.startsAt || null,
    expiresAt: organization.plan?.expiresAt || null,
    daysRemaining,
    deltaMs,
    healthScore,
    userMessage,
    maxEmployees: organization.plan?.maxEmployees || 50,
    maxManagers: organization.plan?.maxManagers || 10,
  };
}

/**
 * Calculates current seat capacity vector Q = [E_used / E_max, M_used / M_max]
 */
async function getCapacityMetrics(organizationId, maxEmployees = 50, maxManagers = 10) {
  if (!organizationId) return { employees: 0, managers: 0, employeeUtilization: 0, managerUtilization: 0 };

  const [activeEmployees, activeManagers] = await Promise.all([
    User.countDocuments({
      organizationId,
      role: { $in: ['EMPLOYEE', 'employee', 'agent'] },
      isActive: true,
    }),
    User.countDocuments({
      organizationId,
      role: { $in: ['MANAGER', 'manager'] },
      isActive: true,
    }),
  ]);

  const employeeUtilization = Math.round((activeEmployees / Math.max(1, maxEmployees)) * 100);
  const managerUtilization = Math.round((activeManagers / Math.max(1, maxManagers)) * 100);

  return {
    activeEmployees,
    maxEmployees,
    employeeUtilization,
    activeManagers,
    maxManagers,
    managerUtilization,
    employeeQuotaReached: activeEmployees >= maxEmployees,
    managerQuotaReached: activeManagers >= maxManagers,
  };
}

/**
 * Reconciles all organizations across the database.
 * Auto-expires organizations whose expiresAt has passed.
 */
async function reconcileAllOrganizations(io = null) {
  try {
    const now = new Date();
    const expiredOrgs = await Organization.find({
      status: 'active',
      'plan.expiresAt': { $lte: now },
    });

    if (expiredOrgs.length === 0) return 0;

    let transitioned = 0;
    for (const org of expiredOrgs) {
      await Organization.findByIdAndUpdate(org._id, {
        $set: { status: 'unpaid' },
      });
      transitioned++;

      if (io) {
        const orgIdStr = org._id.toString();
        io.to(`org_${orgIdStr}`).emit('subscription_expired', {
          organizationId: orgIdStr,
          status: 'unpaid',
          message: `Subscription expired on ${org.plan?.expiresAt?.toISOString() || 'N/A'}. Access locked.`,
        });
      }
    }

    console.log(`🛡️ [SUBSCRIPTION_ENGINE] Reconciled ${transitioned} expired organization(s) to 'unpaid'.`);
    return transitioned;
  } catch (err) {
    console.error('❌ [SUBSCRIPTION_ENGINE] Error reconciling organizations:', err.message);
    return 0;
  }
}

module.exports = {
  evaluateSubscription,
  getCapacityMetrics,
  reconcileAllOrganizations,
};
