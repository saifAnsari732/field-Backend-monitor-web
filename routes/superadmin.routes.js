const express = require('express');
const router = express.Router();
const superadminController = require('../controllers/superadmin.controller');
const { authenticate, checkRole } = require('../middleware/tenantMiddleware');

router.use(authenticate, checkRole('SUPER_ADMIN'));

router.get('/stats', superadminController.getSuperAdminStats);
router.get('/organizations', superadminController.getAllOrganizations);
router.post('/organizations', superadminController.createOrganization);
router.patch('/organizations/:id/status', superadminController.updateOrganizationStatus);
router.patch('/organizations/:id/subscription', superadminController.updateOrgSubscription);
router.get('/payments', superadminController.getAllPayments);

// Coupon Management Routes
router.get('/coupons', superadminController.getAllCoupons);
router.post('/coupons', superadminController.createCoupon);
router.patch('/coupons/:id/toggle', superadminController.toggleCouponStatus);
router.delete('/coupons/:id', superadminController.deleteCoupon);

// Global Users Directory Routes
router.get('/users', superadminController.getAllUsers);
router.patch('/users/:id/status', superadminController.updateUserStatus);
router.patch('/users/:id/password', superadminController.resetUserPassword);

// Live Telemetry & Audits
router.get('/activity', superadminController.getLivePlatformActivity);

// Broadcasts & Announcements
router.get('/broadcasts', superadminController.getBroadcasts);
router.post('/broadcasts', superadminController.sendBroadcast);
router.delete('/broadcasts/:id', superadminController.deleteBroadcast);

// System Health & Diagnostics
router.get('/system-health', superadminController.getSystemHealth);

// SaaS Pricing Plans Management
router.get('/plans', superadminController.getPlans);
router.post('/plans', superadminController.createPlan);
router.post('/plans/seed-defaults', superadminController.seedDefaultPlans);
router.patch('/plans/:id', superadminController.updatePlan);
router.delete('/plans/:id', superadminController.deletePlan);

module.exports = router;


