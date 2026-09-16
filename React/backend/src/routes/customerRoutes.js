const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { uploadImage } = require('../middleware/upload');

// All customer endpoints require an authenticated JWT and the 'customer' role.
router.get('/profile', auth, requireRole('customer'), customerController.profile);
router.get('/bookings', auth, requireRole('customer'), customerController.bookings);
router.get('/orders', auth, requireRole('customer'), customerController.orders);
router.get('/favorites', auth, requireRole('customer'), customerController.favorites);
router.get('/notifications', auth, requireRole('customer'), customerController.notifications);
router.get('/dashboard', auth, requireRole('customer'), customerController.dashboard);

// Profile photo. Multer field: "profileImage".
// The photo used to be held as a data URL in localStorage and never left the
// browser, so it was lost on any other device.
router.post(
  '/profile/image',
  auth,
  requireRole('customer'),
  uploadImage('profiles', 'profileImage'),
  customerController.uploadProfileImage,
);
router.delete('/profile/image', auth, requireRole('customer'), customerController.deleteProfileImage);

// Vehicle management — full CRUD was already implemented in
// customerController.js but never mounted, so every one of these requests
// was 404ing before this change.
//
// The upload middleware sits between auth and the controller so a file is
// only ever written for a request that is already authenticated: multer
// writes to disk before the handler runs, and putting it first would let an
// anonymous caller fill the disk.
//
// Multer field: "vehicleImage". These are the same endpoints as before, now
// accepting multipart/form-data as well as JSON — a request with no file
// behaves exactly as it always did, so the image is optional and existing
// clients keep working.
router.post(
  '/vehicles',
  auth,
  requireRole('customer'),
  uploadImage('vehicles', 'vehicleImage'),
  customerController.addVehicle,
);
router.put(
  '/vehicles/:id',
  auth,
  requireRole('customer'),
  uploadImage('vehicles', 'vehicleImage'),
  customerController.updateVehicle,
);
router.delete('/vehicles/:id', auth, requireRole('customer'), customerController.deleteVehicle);
router.patch('/vehicles/:id/default', auth, requireRole('customer'), customerController.setDefaultVehicle);

module.exports = router;
