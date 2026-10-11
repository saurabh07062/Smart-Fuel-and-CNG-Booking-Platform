const test = require("node:test");
const assert = require("node:assert/strict");

const v = require("../src/services/validation/accountFields");

test("a name must be a name", () => {
  assert.deepEqual(v.validateName("  Saurabh   Yadav "), { ok: true, value: "Saurabh Yadav" });
  assert.equal(v.validateName("O'Brien & Sons").ok, true);
  assert.equal(v.validateName("").msg, "Name is required.");
  assert.equal(v.validateName("   ").msg, "Name is required.");
  assert.equal(v.validateName("a").msg, "Name must be at least 2 characters.");
  assert.match(v.validateName("aaaa").msg, /real name/i);
  assert.match(v.validateName("1234").msg, /letters/i);
  // A real business name may carry digits and a slash.
  assert.equal(v.validateName("Shell 24x7").ok, true);
  assert.equal(v.validateName("HP Petrol Pump No. 5 (Wagholi)").ok, true);
  assert.match(v.validateName("<script>alert(1)</script>").msg, /may only contain/i);
  assert.match(v.validateName("drop table users;").msg, /may only contain/i);
  assert.match(v.validateName("x".repeat(81)).msg, /80 characters or fewer/);
});

test("a phone number is ten digits, however it was typed", () => {
  for (const typed of ["9876543210", "+91 98765 43210", "098765-43210", "91 9876543210"]) {
    assert.deepEqual(v.validatePhone(typed), { ok: true, value: "9876543210" }, typed);
  }
  assert.equal(v.validatePhone("").msg, "Phone number is required.");
  assert.equal(v.validatePhone("", { required: false }).ok, true);
  assert.match(v.validatePhone("98765").msg, /exactly 10 digits/);
  assert.match(v.validatePhone("98765432101").msg, /exactly 10 digits/);
  assert.match(v.validatePhone("1234567890").msg, /starts with 6, 7, 8 or 9/);
  assert.match(v.validatePhone("9999999999").msg, /not a real phone number/);
  assert.match(v.validatePhone("98765abcde").msg, /digits only/);
});

test("a password is long enough, and matches its confirmation", () => {
  assert.equal(v.validatePassword("correct-horse").ok, true);
  assert.match(v.validatePassword("short").msg, /at least 8 characters/);
  assert.match(v.validatePassword("        ").msg, /only spaces/);
  assert.match(v.validatePassword("aaaaaaaa").msg, /repeated character/);
  assert.match(v.validatePassword("password").msg, /too common/);
  assert.match(v.validatePassword("x".repeat(73)).msg, /too long/);

  const mismatch = v.validatePassword("correct-horse", { confirm: "correct-hors" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.field, "confirmPassword");
  assert.match(mismatch.msg, /do not match/);
  assert.equal(v.validatePassword("correct-horse", { confirm: "correct-horse" }).ok, true);
});

test("a GST number is optional, but must be a GST number when given", () => {
  assert.deepEqual(v.validateGst(" 27abcde1234f1z5 "), { ok: true, value: "27ABCDE1234F1Z5" });
  assert.equal(v.validateGst("").ok, true);
  assert.match(v.validateGst("", { required: true }).msg, /required/);
  assert.match(v.validateGst("27ABCDE1234F1Z").msg, /15 characters/);
  assert.match(v.validateGst("XXABCDE1234F1Z5").msg, /not a valid GST/);
});

test("an address has to be findable", () => {
  assert.equal(v.validateAddress("Nagar Road, Wagholi, Pune 412207").ok, true);
  assert.match(v.validateAddress("Pune").msg, /too short/);
  assert.match(v.validateAddress("").msg, /required/);
  // No letters at all is caught before the "all one character" check.
  assert.match(v.validateAddress("..............").msg, /must contain letters/i);
  assert.match(v.validateAddress("aaaaaaaaaaaaaa").msg, /real address/i);
});

test("all() stops at the first problem and returns the cleaned values", () => {
  const good = v.all([
    ["name", v.validateName(" Asha  Kale ")],
    ["phone", v.validatePhone("+91 9876543210")],
  ]);
  assert.deepEqual(good, { ok: true, values: { name: "Asha Kale", phone: "9876543210" } });

  const bad = v.all([
    ["name", v.validateName("Asha")],
    ["phone", v.validatePhone("123")],
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.field, "phone");
});
