const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const User = require('../models/User.model');

router.get('/', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const filter = { role: { $in: ['employee', 'EMPLOYEE', 'FIELD_EXECUTIVE'] } };
    if (!isSuperAdmin && orgId) {
      filter.organizationId = orgId;
    }

    const employees = await User.find(filter).select('-password').populate('manager', 'name email').sort({ createdAt: -1 });
    res.json({ success: true, employees });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      department,
      designation,
      managerId,
      manager,
      salary,
      TA,
      DA,
      allocatedArea,
      emergencyContact,
      address
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required'
      });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const cleanPhone = phone ? String(phone).trim() : '';

    // Check duplicate email
    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: `An account with email "${cleanEmail}" already exists.`
      });
    }

    // Check duplicate phone if provided
    if (cleanPhone) {
      const existingPhone = await User.findOne({ phone: cleanPhone });
      if (existingPhone) {
        return res.status(400).json({
          success: false,
          message: `Phone number "${cleanPhone}" is already registered to user "${existingPhone.name}".`
        });
      }
    }

    // Check seat quota limits for non-superadmin
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    if (!isSuperAdmin && orgId) {
      const Organization = require('../models/Organization.model');
      const org = await Organization.findById(orgId);
      const maxEmployees = org?.plan?.maxEmployees || 50;
      const currentEmployees = await User.countDocuments({
        organizationId: orgId,
        role: { $in: ['EMPLOYEE', 'employee', 'FIELD_EXECUTIVE'] }
      });

      if (currentEmployees >= maxEmployees) {
        return res.status(403).json({
          success: false,
          limitReached: true,
          message: `Employee quota reached (${currentEmployees}/${maxEmployees} Seats Used). Please upgrade your subscription plan in Billing.`
        });
      }
    }

    const assignedManager = managerId || manager || null;
    let managerNameStr = '';
    if (assignedManager) {
      const mgrUser = await User.findById(assignedManager).select('name');
      if (mgrUser) managerNameStr = mgrUser.name;
    }

    const { v4: uuidv4 } = require('uuid');
    const newEmployee = await User.create({
      organizationId: orgId || req.user?.organizationId,
      name: name.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      password,
      department: department || 'Field Services',
      designation: designation || 'Field Executive',
      employeeId: req.body.employeeId || ('EMP-' + uuidv4().slice(0, 6).toUpperCase()),
      manager: assignedManager,
      managerId: assignedManager,
      managerName: managerNameStr,
      salary: Number(salary) || 15000,
      TA: Number(TA) || 2.5,
      DA: Number(DA) || 0,
      allocatedArea: allocatedArea || 'Default Zone',
      emergencyContact: emergencyContact || {},
      address: address || {},
      role: 'EMPLOYEE',
      isApproved: true,
      isActive: true,
    });

    const { ActivityLog } = require('../models/index');
    await ActivityLog.create({
      organizationId: orgId || req.user?.organizationId,
      employee: req.user._id,
      action: 'CREATE_EMPLOYEE',
      description: `Onboarded new employee ${newEmployee.name} (${newEmployee.employeeId})`
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: `Employee "${newEmployee.name}" created successfully`,
      employee: newEmployee
    });
  } catch (err) {
    console.error('Error creating employee:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create employee' });
  }
});

router.post('/assign-manager', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), async (req, res) => {
  try {
    const { managerId, employeeIds } = req.body;

    if (!managerId) {
      return res.status(400).json({ success: false, message: 'Manager ID is required' });
    }

    const targetManager = await User.findById(managerId);
    if (!targetManager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const idsToAssign = Array.isArray(employeeIds) ? employeeIds : [];

    // 1. Assign targetManager to all selected employeeIds
    if (idsToAssign.length > 0) {
      await User.updateMany(
        { _id: { $in: idsToAssign } },
        {
          $set: {
            manager: targetManager._id,
            managerId: targetManager._id,
            managerName: targetManager.name,
          },
          $addToSet: { managers: targetManager._id }
        }
      );
    }

    // 2. Clear targetManager assignment from any employees NOT in idsToAssign who were previously assigned to this manager
    await User.updateMany(
      {
        $or: [{ managerId: targetManager._id }, { manager: targetManager._id }],
        _id: { $nin: idsToAssign }
      },
      {
        $unset: { manager: 1, managerId: 1, managerName: 1 },
        $pull: { managers: targetManager._id }
      }
    );

    // 3. Update targetManager's assignedEmployees list
    const assignedEmpObjs = await User.find({ _id: { $in: idsToAssign } }).select('_id name email department designation');
    const formattedAssigned = assignedEmpObjs.map(e => ({
      _id: e._id,
      name: e.name,
      email: e.email,
      department: e.department,
      designation: e.designation,
    }));

    targetManager.assignedEmployees = formattedAssigned;
    await targetManager.save();

    const { ActivityLog } = require('../models/index');
    await ActivityLog.create({
      organizationId: req.user?.organizationId,
      employee: req.user._id,
      action: 'ASSIGN_MANAGER',
      description: `Assigned ${idsToAssign.length} employee(s) to Manager ${targetManager.name}`
    }).catch(() => {});

    res.json({
      success: true,
      message: `Successfully assigned ${idsToAssign.length} employee(s) to Manager ${targetManager.name}`,
      manager: targetManager,
      assignedEmployees: formattedAssigned,
    });
  } catch (err) {
    console.error('Error assigning manager:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to assign employees' });
  }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const employee = await User.findById(req.params.id).select('-password').populate('manager', 'name email');
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/:id', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), async (req, res) => {
  try {
    const employee = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:id', protect, authorize('admin', 'org_admin', 'super_admin'), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Employee deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
