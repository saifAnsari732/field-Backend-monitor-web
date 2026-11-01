const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');

// Public route to fetch Razorpay public Key ID & Plans
router.get('/key', paymentController.getKey);
router.get('/plans', paymentController.getPlans);

// Apply & Validate Coupon
router.post('/apply-coupon', paymentController.applyCoupon);

// Create Razorpay Order
router.post('/create-order', paymentController.createOrder);

// Verify Razorpay Payment Signature & Activate Subscription
router.post('/verify-payment', paymentController.verifyPayment);

// Razorpay Official Server-to-Server Webhook
router.post('/webhook', paymentController.handleWebhook);

// Check & Sync Specific Order with Razorpay API (Resolves uncaptured / missed payments)
router.post('/sync-order', paymentController.syncOrderById);

// Record Payment Failure with reason from Razorpay SDK
router.post('/record-failure', paymentController.recordPaymentFailure);

// Direct / Simulated Subscription Activation (for instant testing & verification)
router.post('/activate-direct', protect, paymentController.activateSubscriptionDirect);

// Get Organization Payment History
router.get('/history', paymentController.getHistory);

// Sync Latest Payment (queries Razorpay API if recent order is in created state)
router.all('/sync-latest', paymentController.syncLatestPayment);

module.exports = router;
