const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userRole: String,
    actorName: String,
    actorRole: String,
    action: { type: String, required: true },
    targetType: String,
    targetId: String,
    resource: String,
    resourceId: String,
    details: mongoose.Schema.Types.Mixed,
    metadata: mongoose.Schema.Types.Mixed,
    ipAddress: String,
  },
  { timestamps: true }
);

// Fallback pre-save hook for legacy AuditLog calls
auditLogSchema.pre('save', function (next) {
  if (!this.actorUserId && this.userId) {
    this.actorUserId = this.userId;
  }
  if (!this.actorRole && this.userRole) {
    this.actorRole = this.userRole;
  }
  next();
});

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ actorUserId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
