const User = require('../models/User');
const Booking = require('../models/Booking');
const { storedPath, removeUploadedFile } = require('../middleware/upload');

/**
 * Multipart bodies are all strings: an unchecked `isDefault` arrives as the
 * string "false", which is truthy, and would silently make every uploaded
 * vehicle the default. JSON requests still send a real boolean, so both
 * shapes have to work.
 */
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on';
  return Boolean(v);
}
let Notification = null;
try { Notification = require('../models/Notification'); } catch (e) {}

// One implementation of the expiry rule, shared with booking creation.
const { expireUserPastBookings } = require('../services/booking/bookingCreate');

exports.profile = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.bookings = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });

    await expireUserPastBookings(userId);

    const bookings = await Booking.find({ user: userId }).populate('station', 'name address images coordinates location').sort({ createdAt: -1 });
    res.json(await require('../services/booking/booking').attachWaitlistPositions(bookings));
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.notifications = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    if (!Notification) return res.json([]);
    // The latest 200: the list grows forever, and older ones are never shown.
    const notes = await Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(200).lean();
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.dashboard = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const bookingsCount = await Booking.countDocuments({ user: userId });
    const upcoming = await Booking.find({ user: userId, status: 'upcoming' }).limit(5).sort({ createdAt: -1 }).populate('station', 'name coordinates location');
    res.json({ summary: { bookingsCount }, upcoming });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

/**
 * POST /api/customer/profile/image   (multer field: "profileImage")
 *
 * Replaces the caller's own profile photo. The user id comes from the JWT,
 * never from the body, so this cannot be pointed at anyone else's account.
 */
exports.uploadProfileImage = async (req, res) => {
  const uploaded = storedPath(req.file, 'profiles');
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) {
      removeUploadedFile(uploaded);
      return res.status(401).json({ msg: 'Unauthenticated' });
    }
    if (!uploaded) {
      return res.status(400).json({ msg: 'No image was uploaded. Choose a JPG, PNG or WEBP file.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      removeUploadedFile(uploaded);
      return res.status(404).json({ msg: 'User not found' });
    }

    const previous = user.profileImage;
    user.profileImage = uploaded;
    await user.save();

    // Only once the new path is committed.
    if (previous && previous !== uploaded) removeUploadedFile(previous);

    res.json({ msg: 'Profile photo updated', profileImage: user.profileImage });
  } catch (err) {
    removeUploadedFile(uploaded);
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

/** DELETE /api/customer/profile/image — revert to the initial-letter avatar. */
exports.deleteProfileImage = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const previous = user.profileImage;
    user.profileImage = null;
    await user.save();
    removeUploadedFile(previous);

    res.json({ msg: 'Profile photo removed', profileImage: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.addVehicle = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const user = await User.findById(userId);
    if (!user) {
      // multer has already written the file by the time this handler runs, so
      // any path that does not save a vehicle has to remove it.
      removeUploadedFile(storedPath(req.file, 'vehicles'));
      return res.status(404).json({ msg: 'User not found' });
    }

    let { vehicleType, nickname, registrationNumber, brand, model, fuelType, color, image, isDefault } = req.body;

    // An uploaded file wins over an `image` string in the body, so a client
    // cannot point a vehicle at an arbitrary path by sending both.
    const uploadedImage = storedPath(req.file, 'vehicles');
    if (uploadedImage) image = uploadedImage;

    isDefault = asBool(isDefault);

    // Legacy support
    if (!vehicleType && req.body.type) vehicleType = req.body.type;
    if (!registrationNumber && req.body.plate) registrationNumber = req.body.plate;

    if (!nickname || !registrationNumber || !vehicleType || !fuelType) {
      removeUploadedFile(uploadedImage);
      return res.status(400).json({ msg: 'Nickname, Registration Number, Vehicle Type, and Fuel Type are required' });
    }

    registrationNumber = registrationNumber.trim().toUpperCase();
    const regRegex = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}$/;
    // Basic validation, allow generic alphanumeric for edge cases if regex fails, but we prefer strict. 
    // We'll just trim and uppercase for now, exact strictness can be client side or simple server side.
    if (!registrationNumber.match(/^[A-Z0-9 ]+$/)) {
      removeUploadedFile(uploadedImage);
      return res.status(400).json({ msg: 'Invalid registration number format' });
    }

    const isDuplicate = user.vehicles.some(v => v.registrationNumber === registrationNumber || v.plate === registrationNumber);
    if (isDuplicate) {
      removeUploadedFile(uploadedImage);
      return res.status(400).json({ msg: 'Vehicle with this registration number already exists' });
    }

    // Auto default if it's the first vehicle or user requested
    if (user.vehicles.length === 0) isDefault = true;
    
    if (isDefault) {
      user.vehicles.forEach(v => v.isDefault = false);
    }

    user.vehicles.push({ 
      vehicleType, nickname, registrationNumber, brand, model, fuelType, color, image, isDefault,
      type: vehicleType, plate: registrationNumber // legacy fields
    });
    
    await user.save();
    res.json({ msg: 'Vehicle added successfully', vehicles: user.vehicles });
  } catch (err) {
    // The file is on disk but no vehicle references it. Remove it rather than
    // leaving an orphan nothing will ever clean up.
    removeUploadedFile(storedPath(req.file, 'vehicles'));
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.updateVehicle = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const vehicleId = req.params.id;
    const vehicle = user.vehicles.id(vehicleId);
    if (!vehicle) {
      removeUploadedFile(storedPath(req.file, 'vehicles'));
      return res.status(404).json({ msg: 'Vehicle not found' });
    }

    let { vehicleType, nickname, registrationNumber, brand, model, fuelType, color, image } = req.body;

    const uploadedImage = storedPath(req.file, 'vehicles');
    if (uploadedImage) image = uploadedImage;

    if (registrationNumber) {
      registrationNumber = registrationNumber.trim().toUpperCase();
      const isDuplicate = user.vehicles.some(v => (v.registrationNumber === registrationNumber || v.plate === registrationNumber) && v._id.toString() !== vehicleId);
      if (isDuplicate) {
        removeUploadedFile(uploadedImage);
        return res.status(400).json({ msg: 'Vehicle with this registration number already exists' });
      }
      vehicle.registrationNumber = registrationNumber;
      vehicle.plate = registrationNumber; // legacy
    }

    if (vehicleType) {
      vehicle.vehicleType = vehicleType;
      vehicle.type = vehicleType; // legacy
    }
    if (nickname) vehicle.nickname = nickname;
    if (brand !== undefined) vehicle.brand = brand;
    if (model !== undefined) vehicle.model = model;
    if (fuelType) vehicle.fuelType = fuelType;
    if (color !== undefined) vehicle.color = color;

    // Order matters: keep a handle on the outgoing file, write the record,
    // and only then delete. Deleting first would leave the vehicle pointing
    // at nothing if the save failed.
    const previousImage = vehicle.image;
    if (image !== undefined) vehicle.image = image;

    await user.save();

    if (uploadedImage && previousImage && previousImage !== uploadedImage) {
      removeUploadedFile(previousImage);
    }

    res.json({ msg: 'Vehicle updated successfully', vehicles: user.vehicles });
  } catch (err) {
    removeUploadedFile(storedPath(req.file, 'vehicles'));
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.deleteVehicle = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const vehicleId = req.params.id;
    const vehicle = user.vehicles.id(vehicleId);
    if (!vehicle) return res.status(404).json({ msg: 'Vehicle not found' });

    const wasDefault = vehicle.isDefault;
    const removedImage = vehicle.image;
    user.vehicles.pull(vehicleId);
    
    // Auto re-assign default
    if (wasDefault && user.vehicles.length > 0) {
      user.vehicles[0].isDefault = true;
    }

    await user.save();

    // Only after the record is gone. If the save throws, the vehicle still
    // exists and must still have its picture.
    removeUploadedFile(removedImage);

    res.json({ msg: 'Vehicle deleted successfully', vehicles: user.vehicles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

exports.setDefaultVehicle = async (req, res) => {
  try {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return res.status(401).json({ msg: 'Unauthenticated' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const vehicleId = req.params.id;
    const vehicle = user.vehicles.id(vehicleId);
    if (!vehicle) return res.status(404).json({ msg: 'Vehicle not found' });

    user.vehicles.forEach(v => v.isDefault = false);
    vehicle.isDefault = true;

    await user.save();
    res.json({ msg: 'Default vehicle updated', vehicles: user.vehicles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};
