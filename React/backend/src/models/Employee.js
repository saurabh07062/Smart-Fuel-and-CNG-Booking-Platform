const mongoose = require("mongoose");

const EmployeeSchema = new mongoose.Schema({
  vendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  station: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Station",
  },
  name: { type: String, required: true },
  email: { type: String },
  phone: { type: String, required: true },
  role: {
    type: String,
    enum: ["Manager", "Attendant", "Cashier", "Cleaner", "Security"],
    default: "Attendant",
  },
  shift: {
    type: String,
    enum: ["Morning", "Evening", "Night", "Full-Time"],
    default: "Full-Time",
  },
  salary: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["Active", "Inactive", "On Leave"],
    default: "Active",
  },
  joinedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("Employee", EmployeeSchema);