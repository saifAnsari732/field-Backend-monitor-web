const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: String,
    actorRole: String,
    action: { type: String, required: true },
    targetType: String,
    targetId: String,
    metadata: mongoose.Schema.Types.Mixed,
    ipAddress: String,
  },
  { timestamps: true }
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ actorUserId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
