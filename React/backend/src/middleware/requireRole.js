const User = require('../models/User');

/**
 * Role gate. Must run after `auth` (or another middleware that populates a
 * real, JWT-verified req.user) -- it does not authenticate on its own, and
 * it no longer fabricates an admin identity when req.user is missing. If
 * req.user isn't set, that means auth didn't run first, so this fails
 * closed instead of quietly granting access.
 */
const ensureRole = (role) => {
  const allowed = Array.isArray(role) ? role : role ? [role] : null;

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ msg: 'Authentication required' });
    }

    let userRole = req.user.role;
    if (!userRole) {
      try {
        const user = await User.findById(req.user.id).select('role');
        userRole = user?.role;
        if (userRole) req.user.role = userRole;
      } catch (err) {
        return res.status(500).json({ msg: 'Could not verify role' });
      }
    }

    // 'admin' can act as any role; otherwise the caller's role must be
    // explicitly on the allow list.
    if (!allowed || userRole === 'admin' || allowed.includes(userRole)) {
      return next();
    }

    // Usually another tab in the same browser signed in with a different
    // account: the browser holds one session, so say which one it is.
    const needed = allowed.join(' or ');
    return res.status(403).json({
      msg: `This page needs a ${needed} account, but this browser is now signed in as a ${userRole || 'different user'}. Sign in again as the ${needed}.`,
      reason: 'WRONG_ROLE',
      role: userRole || null,
    });
  };
};

module.exports = ensureRole;
