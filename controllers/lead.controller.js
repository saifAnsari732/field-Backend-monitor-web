const { Lead, Notification } = require('../models/index');
const User = require('../models/User.model');

// @desc Create lead (Admin)
exports.createLead = async (req, res) => {
  try {
    const orgId = req.user?.organizationId?._id || req.user?.organizationId || null;
    const lead = await Lead.create({
      ...req.body,
      organizationId: orgId,
    });
    
    if (lead.assignedTo) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user_${lead.assignedTo}`).emit('notification', {
          title: 'New Lead Assigned',
          message: `You have been assigned a new lead: ${lead.name}`,
          type: 'lead',
          data: { leadId: lead._id }
        });
      }

      await Notification.create({
        organizationId: orgId,
        recipient: lead.assignedTo,
        sender: req.user._id,
        type: 'lead',
        title: 'New Lead Assigned',
        message: `You have been assigned a new lead: ${lead.name}`,
        data: { leadId: lead._id }
      });
    }

    res.status(201).json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get leads (Admin sees all within org, Employee sees assigned)
exports.getLeads = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const rawOrgId = req.user?.organizationId?._id || req.user?.organizationId;

    let filter = {};
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN' && rawOrgId) {
      filter.organizationId = rawOrgId;
    }

    const isManagement = ['ADMIN', 'ORG_ADMIN', 'HR', 'SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    if (!isManagement) {
      filter.assignedTo = req.user._id;
    }

    const leads = await Lead.find(filter).populate('assignedTo', 'name email').sort('-createdAt');
    res.json({ success: true, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update lead status/feedback
exports.updateLead = async (req, res) => {
  try {
    const { status, feedback } = req.body;
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && lead.organizationId && userOrgId !== lead.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    const updatedLead = await Lead.findByIdAndUpdate(
      req.params.id,
      { status, feedback, lastContacted: new Date() },
      { new: true }
    );
    res.json({ success: true, lead: updatedLead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete lead
exports.deleteLead = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const userOrgId = req.user?.organizationId?._id?.toString() || req.user?.organizationId?.toString();

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'SUPERADMIN') {
      if (userOrgId && lead.organizationId && userOrgId !== lead.organizationId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    await Lead.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Lead deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
