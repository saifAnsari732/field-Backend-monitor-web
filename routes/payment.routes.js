const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

// Public route to fetch Razorpay public Key ID & Plans
router.get('/key', paymentController.getKey);
router.get('/plans', paymentController.getPlans);

// Apply & Validate Coupon
router.post('/apply-coupon', paymentController.applyCoupon);

// Create Razorpay Order
router.post('/create-order', paymentController.createOrder);

// Verify Razorpay Payment Signature & Activate Subscription
router.post('/verify-payment', paymentController.verifyPayment);

// Get Organization Payment History
router.get('/history', paymentController.getHistory);

// Sync Latest Paid Payment & Activate Subscription
router.all('/sync-latest', paymentController.syncLatestPayment);

module.exports = router;
