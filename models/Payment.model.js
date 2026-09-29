const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: false,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: '',
    },
    razorpaySignature: {
      type: String,
      default: '',
    },
    amount: {
      type: Number,
      required: true,
    },
    amountPaid: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    status: {
      type: String,
      enum: ['created', 'paid', 'failed', 'refunded'],
      default: 'created',
      index: true,
    },
    plan: {
      type: String,
      default: 'pro',
    },
    addonType: {
      type: String,
      enum: ['employee', 'manager', 'combo', 'none'],
      default: 'none',
    },
    employeeSeats: {
      type: Number,
      default: 0,
    },
    managerSeats: {
      type: Number,
      default: 0,
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly', 'onetime'],
      default: 'monthly',
    },
    seats: {
      type: Number,
      default: 10,
    },
    notes: {
      type: Object,
      default: {},
    },
    paidAt: {
      type: Date,
    },
    failureReason: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
