const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const User = require('../models/User');

const protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authorised. No token.' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ success: false, message: 'User not found.' });
    if (req.user.status !== 'active') return res.status(403).json({ success: false, message: 'Account suspended.' });
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Access denied. Insufficient role.' });
  }
  next();
};

// Allow if the user has one of the roles OR their linked employee has the given privilege.
// Lets admins delegate abilities (approve transactions, edit users, etc.) to specific staff.
const Employee = require('../models/Employee');
const requireRoleOrPriv = (roles, privilege) => async (req, res, next) => {
  try {
    if (roles.includes(req.user.role)) return next();
    const emp = await Employee.findOne({ userId: req.user._id }).select('privileges').lean();
    if (emp && Array.isArray(emp.privileges) && emp.privileges.includes(privilege)) return next();
    return res.status(403).json({ success: false, message: 'Access denied. You do not have this permission.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { protect, requireRole, requireRoleOrPriv };
