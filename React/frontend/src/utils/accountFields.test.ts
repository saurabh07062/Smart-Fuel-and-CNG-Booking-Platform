import { describe, it, expect } from "vitest";
import {
  addressProblem,
  collectProblems,
  confirmProblem,
  emailProblem,
  gstProblem,
  nameProblem,
  normalisePhone,
  passwordProblem,
  phoneProblem,
} from "./accountFields";

/**
 * These mirror backend/test/accountFields.test.js. The two must agree: a
 * value the form accepts and the API refuses is a bug the user meets after
 * pressing Submit.
 */
describe("the field rules the vendor forms enforce", () => {
  it("names: real ones pass, junk does not", () => {
    expect(nameProblem("Asha Kale")).toBeNull();
    expect(nameProblem("Shell 24x7")).toBeNull();
    expect(nameProblem("HP Petrol Pump No. 5 (Wagholi)")).toBeNull();
    expect(nameProblem("  ")).toMatch(/required/i);
    expect(nameProblem("a")).toMatch(/at least 2/);
    expect(nameProblem("aaaa")).toMatch(/real name/i);
    expect(nameProblem("1234")).toMatch(/letters/i);
    expect(nameProblem("<script>alert(1)</script>")).toMatch(/may only contain/i);
  });

  it("phones: exactly ten digits, however typed", () => {
    for (const typed of ["9876543210", "+91 98765 43210", "098765-43210"]) {
      expect(phoneProblem(typed)).toBeNull();
      expect(normalisePhone(typed)).toBe("9876543210");
    }
    expect(phoneProblem("")).toMatch(/required/);
    expect(phoneProblem("", { required: false })).toBeNull();
    expect(phoneProblem("98765")).toMatch(/exactly 10 digits/);
    expect(phoneProblem("1234567890")).toMatch(/6, 7, 8 or 9/);
    expect(phoneProblem("9999999999")).toMatch(/not a real/);
  });

  it("emails: the project's own shape", () => {
    expect(emailProblem("asha@example.com")).toBeNull();
    expect(emailProblem("asha@example")).toMatch(/valid email/);
    expect(emailProblem("asha @example.com")).toMatch(/valid email/);
    expect(emailProblem("")).toMatch(/required/);
  });

  it("passwords: length, and the confirmation must match exactly", () => {
    expect(passwordProblem("correct-horse")).toBeNull();
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("        ")).toMatch(/only spaces/);
    expect(passwordProblem("password")).toMatch(/too common/);
    expect(confirmProblem("correct-horse", "correct-horse")).toBeNull();
    expect(confirmProblem("correct-horse", "correct-hors")).toMatch(/do not match/);
    expect(confirmProblem("correct-horse", "")).toMatch(/type the password again/);
  });

  it("GST is optional, but must be a GST number when present", () => {
    expect(gstProblem("")).toBeNull();
    expect(gstProblem("27ABCDE1234F1Z5")).toBeNull();
    expect(gstProblem("27abcde1234f1z5")).toBeNull();
    expect(gstProblem("NOTAGST")).toMatch(/15 characters/);
    expect(gstProblem("XXABCDE1234F1Z5")).toMatch(/not a valid GST/);
  });

  it("addresses must be findable", () => {
    expect(addressProblem("Nagar Road, Wagholi, Pune 412207")).toBeNull();
    expect(addressProblem("Pune")).toMatch(/too short/);
    expect(addressProblem("")).toMatch(/required/);
  });

  it("collectProblems keeps only the fields that failed", () => {
    expect(collectProblems({ a: null, b: "broken" })).toEqual({ b: "broken" });
    expect(collectProblems({ a: null })).toEqual({});
  });
});
