const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    priority: {
      type: String,
      enum: ['urgent', 'high', 'normal', 'info'],
      default: 'high',
    },
    category: {
      type: String,
      enum: ['general', 'maintenance', 'alert', 'feature', 'policy', 'reminder'],
      default: 'general',
    },
    targetRole: {
      type: String,
      default: 'ALL',
    },
    targetOrganization: {
      type: mongoose.Schema.Types.Mixed,
      default: 'ALL',
    },
    organizationName: {
      type: String,
      default: 'All Organizations',
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    senderName: {
      type: String,
      default: 'Super Administrator',
    },
    senderRole: {
      type: String,
      default: 'SUPER_ADMIN',
    },
    recipientCount: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

broadcastSchema.index({ createdAt: -1 });
broadcastSchema.index({ targetRole: 1, targetOrganization: 1 });

module.exports = mongoose.model('Broadcast', broadcastSchema);
