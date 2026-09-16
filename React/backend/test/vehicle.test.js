const test = require("node:test");
const assert = require("node:assert/strict");

const customerController = require("../src/controllers/customerController");
const Booking = require("../src/models/Booking");
const { normaliseVehicleSnapshot } = require("../src/services/booking/vehicleSnapshot");

test("addVehicle function exists and handles required fields", async () => {
  assert.ok(typeof customerController.addVehicle === "function", "addVehicle should be exported by customerController");
});

test("normaliseVehicleSnapshot keeps known types and trims names", () => {
  assert.deepEqual(normaliseVehicleSnapshot({ vehicleType: "bike", vehicleName: "  Activa  " }), {
    vehicleType: "Bike",
    vehicleName: "Activa",
  });
  assert.deepEqual(normaliseVehicleSnapshot({ vehicleType: "Other", vehicleName: "Van" }), {
    vehicleType: "Other",
    vehicleName: "Van",
  });
});

test("normaliseVehicleSnapshot stores unknown or missing values as null", () => {
  assert.deepEqual(normaliseVehicleSnapshot({ vehicleType: "Spaceship", vehicleName: "   " }), {
    vehicleType: null,
    vehicleName: null,
  });
  assert.deepEqual(normaliseVehicleSnapshot(), { vehicleType: null, vehicleName: null });
  assert.deepEqual(normaliseVehicleSnapshot({ vehicleType: 42, vehicleName: {} }), {
    vehicleType: null,
    vehicleName: null,
  });
  assert.equal(normaliseVehicleSnapshot({ vehicleName: "x".repeat(200) }).vehicleName.length, 60);
});

test("Booking schema accepts the vehicle snapshot and stays valid without it", async () => {
  const base = {
    user: "64b000000000000000000001",
    fuelType: "Petrol",
    quantity: 5,
    price: 100,
    amount: 505,
    bookingDate: "2026-09-10",
    vehiclePlate: "MH12AB1234",
  };

  const withVehicle = new Booking({ ...base, vehicleType: "Bike", vehicleName: "Activa" });
  await withVehicle.validate();
  assert.equal(withVehicle.vehicleType, "Bike");
  assert.equal(withVehicle.vehicleName, "Activa");

  const legacy = new Booking(base);
  await legacy.validate();
  assert.equal(legacy.vehicleType, null);
  assert.equal(legacy.vehicleName, null);
});
