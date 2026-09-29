const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    badge: { type: String, default: '' },
    priceMonthly: { type: Number, required: true, default: 999 },
    priceYearly: { type: Number, required: true, default: 11389 },
    maxEmployees: { type: Number, required: true, default: 10 },
    maxManagers: { type: Number, required: true, default: 3 },
    features: [{ type: String }],
    isPopular: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Plan', planSchema);
