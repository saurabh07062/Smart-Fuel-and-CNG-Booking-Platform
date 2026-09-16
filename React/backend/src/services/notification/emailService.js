const nodemailer = require("nodemailer");

/**
 * Centralized SMTP email service for FuelMart.
 * Reads SMTP configuration from environment variables and provides
 * a reusable transporter + helper methods for sending emails.
 *
 * Supported .env variables:
 *   SMTP_HOST       - SMTP server host (e.g. smtp.gmail.com)
 *   SMTP_PORT       - SMTP server port (e.g. 587)
 *   SMTP_SECURE     - "true" for 465 (TLS), "false" for 587 (STARTTLS)
 *   SMTP_USER       - SMTP username / email address
 *   SMTP_PASS       - SMTP password / app password
 *   SMTP_FROM_NAME  - Display name for the From address (default: FuelMart)
 *   SMTP_FROM_EMAIL - From email address (default: SMTP_USER)
 *
 * Backwards compatible with older EMAIL_USER / EMAIL_PASS variables.
 */

let transporter = null;
let isInitialized = false;

function initTransporter() {
  if (isInitialized) return transporter;
  isInitialized = true;

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const mailPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!mailUser || !mailPass) {
    console.warn("⚠️  SMTP credentials missing in .env — emails disabled");
    console.warn("   Set SMTP_USER and SMTP_PASS in backend/.env to enable email features");
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: mailUser, pass: mailPass },
    tls: { rejectUnauthorized: false },
  });

  // Verify connection on startup
  transporter.verify((error, success) => {
    if (error) {
      console.error("❌ SMTP Connection Failed:", error.message);
      console.error("   Fix: Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in backend/.env");
      console.error("   For Gmail: use an App Password, not your regular password");
      transporter = null; // disable broken transporter
    } else {
      console.log(`✅ SMTP Server connected successfully (${host}:${port}) — emails will work!`);
    }
  });

  return transporter;
}

function getTransporter() {
  if (!isInitialized) return initTransporter();
  return transporter;
}

function getFromAddress() {
  const fromName = process.env.SMTP_FROM_NAME || "FuelMart";
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
  return `"${fromName}" <${fromEmail}>`;
}

/**
 * Send an email.
 * @param {Object} options - { to, subject, html, text }
 * @returns {Promise<boolean>} true if sent, false otherwise
 */
async function sendMail({ to, subject, html, text }) {
  const tp = getTransporter();
  if (!tp) {
    console.warn("[Email] ⚠️ SMTP transporter not available — email not sent");
    return false;
  }

  try {
    const info = await tp.sendMail({
      from: getFromAddress(),
      to,
      subject,
      html,
      text,
    });
    console.log(`[Email] ✅ Sent to ${to} — ${info.messageId}`);
    return true;
  } catch (err) {
    console.error(`[Email] ❌ Failed to send to ${to}:`, err.message);
    return false;
  }
}

/**
 * Send a booking confirmation email.
 * @param {Object} userDoc - { name, email }
 * @param {Object} booking - { verificationCode, amount, bookingDate, timeSlot }
 */
async function sendBookingConfirmation(userDoc, booking) {
  if (!userDoc || !userDoc.email) return false;
  return sendMail({
    to: userDoc.email,
    subject: "FuelMart - Booking Confirmed",
    html: `<h3>Hi ${userDoc.name}, your booking is confirmed!</h3>
           <p>Booking Code: <strong>${booking.verificationCode}</strong></p>
           <p>Amount: INR ${booking.amount}</p>
           <p>Date: ${booking.bookingDate} at ${booking.timeSlot}</p>`,
  });
}

/**
 * Send an email verification link.
 * @param {string} email - recipient email
 * @param {string} verificationToken - token for verification
 */
async function sendVerificationEmail(email, verificationToken) {
  const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
  const verifyLink = `${clientUrl}/?verify=${verificationToken}`;
  return sendMail({
    to: email,
    subject: "Welcome to FuelMart - Verify Your Email",
    html: `<h1>Verify your email</h1><a href="${verifyLink}">Click Here</a>`,
  });
}

/**
 * Notify a vendor their application/account status changed. One function
 * for every lifecycle transition (approve/reject/suspend/reactivate/under
 * review) since they all boil down to the same shape: tell the vendor what
 * happened and, where there is one, why.
 *
 * @param {Object} vendor - { name, email }
 * @param {'active'|'rejected'|'suspended'|'under_review'} status
 * @param {string} [reason]
 */
async function sendVendorStatusEmail(vendor, status, reason) {
  if (!vendor || !vendor.email) return false;

  const copy = {
    active: {
      subject: "FuelMart - Your vendor application was approved",
      heading: "You're approved!",
      // The secret code travels in its own email (sendVendorSecretCodeEmail),
      // so this one must not promise a code it is not carrying.
      body: "Your secret access code is on its way in a separate email. Use it to open your Vendor Dashboard.",
    },
    under_review: {
      subject: "FuelMart - Your vendor application is under review",
      heading: "We're reviewing your application",
      body: "An administrator is now reviewing the details you submitted. We'll email you again as soon as a decision is made.",
    },
    rejected: {
      subject: "FuelMart - Your vendor application was not approved",
      heading: "Application not approved",
      body: reason ? `Reason: ${reason}` : "Please contact support if you have questions.",
    },
    suspended: {
      subject: "FuelMart - Your vendor account has been suspended",
      heading: "Account suspended",
      body: reason ? `Reason: ${reason}` : "Your stations have been taken offline. Please contact support.",
    },
    reactivated: {
      subject: "FuelMart - Your vendor account is active again",
      heading: "Welcome back",
      body: "Your account and stations are active again.",
    },
  }[status];

  if (!copy) return false;

  // Deep link straight to this vendor's own status/activation page. Without
  // it an approved vendor has to find the site, work out that "vendor" means
  // the normal login, and sign in -- which is where they gave up before.
  // Query string BEFORE the hash on purpose: the SPA routes on the hash
  // alone, so "#vendor-track?id=..." would not match any known page.
  const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
  const trackUrl = vendor._id ? `${clientUrl}/?vendorId=${vendor._id}#vendor-track` : clientUrl;

  const referenceBlock = vendor.vendorCode
    ? `<p style="color:#64748b;font-size:13px">Your vendor reference: <b>${vendor.vendorCode}</b></p>`
    : "";

  const ctaBlock = `<p style="margin:22px 0"><a href="${trackUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${
    status === "active" ? "Activate & open my dashboard" : "View my application"
  }</a></p>`;

  return sendMail({
    to: vendor.email,
    subject: copy.subject,
    html: `<h2>${copy.heading}</h2><p>Hi ${vendor.name || "there"},</p><p>${copy.body}</p>${ctaBlock}${referenceBlock}`,
  });
}

/**
 * The one email that carries a vendor's secret code.
 *
 * Separate from sendVendorStatusEmail on purpose. That function is a general
 * status notifier called from half a dozen places with a vendor document; if
 * the code lived in it, every future caller would be one careless argument
 * away from mailing a credential to the wrong person. This one takes the
 * plaintext explicitly, is called from exactly two places (approve and
 * reissue), and is the only code path in the app that ever sees it.
 *
 * @param {object} vendor   the vendor user document
 * @param {string} code     PLAINTEXT secret code -- never store or log this
 * @param {Date}   expiresAt
 * @returns {Promise<boolean>} whether the mail was accepted by the transport
 */
async function sendVendorSecretCodeEmail(vendor, code, expiresAt) {
  if (!vendor || !vendor.email || !code) return false;

  const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
  const accessUrl = `${clientUrl}/vendor/secret-code`;

  const validity = expiresAt
    ? `Use it for the first time before <b>${new Date(expiresAt).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      })}</b>.`
    : "Use it for the first time soon.";

  const reference = vendor.vendorCode
    ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px">Vendor reference: <b>${vendor.vendorCode}</b></p>`
    : "";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h2 style="margin:0 0 4px;font-size:22px">FuelMart Vendor Account Approved</h2>
    <p style="margin:0 0 18px;color:#64748b;font-size:14px">Hi ${vendor.name || "there"},</p>

    <p style="font-size:15px;line-height:1.6">
      Your vendor registration${vendor.businessName ? ` for <b>${vendor.businessName}</b>` : ""}
      has been reviewed and <b style="color:#059669">approved</b> by a FuelMart administrator.
    </p>

    <div style="margin:24px 0;padding:20px;border:2px solid #2563eb;border-radius:12px;background:#f8fafc;text-align:center">
      <p style="margin:0 0 8px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Your secret code</p>
      <p style="margin:0;font-size:30px;font-weight:700;letter-spacing:.12em;font-family:ui-monospace,Menlo,monospace;color:#2563eb">${code}</p>
    </div>

    <p style="font-size:15px;line-height:1.6;margin:0 0 6px"><b>How to open your dashboard</b></p>
    <ol style="font-size:14px;line-height:1.75;color:#334155;margin:0 0 20px;padding-left:20px">
      <li>Go to the FuelMart Home Page.</li>
      <li>Click the <b>Vendor Secret Code</b> button in the top navigation.</li>
      <li>Enter this registered email address (<b>${vendor.email}</b>) and the code above.</li>
      <li>Your Vendor Dashboard opens straight away.</li>
    </ol>

    <p style="margin:0 0 22px">
      <a href="${accessUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700;display:inline-block">Open Vendor Secret Code page</a>
    </p>

    <p style="font-size:13px;color:#475569;line-height:1.6;margin:0 0 4px">${validity}
      After that, <b>use the same code every time</b> you open your dashboard. It stays active until an
      administrator issues a new one, and locks after ${require("../vendor/vendorSecretCode").MAX_ATTEMPTS} incorrect attempts in a row.</p>

    <div style="margin:18px 0 0;padding:12px 14px;border-left:3px solid #dc2626;background:#fef2f2;border-radius:0 6px 6px 0">
      <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">
        <b>Do not share this code with anyone.</b> Anyone who has it can open your
        vendor dashboard. FuelMart staff will never ask you for it. If you did not
        expect this email, contact support and do not use the code.
      </p>
    </div>
    ${reference}
  </div>`;

  const text = [
    "FuelMart Vendor Account Approved",
    "",
    `Hi ${vendor.name || "there"},`,
    `Your vendor registration${vendor.businessName ? ` for ${vendor.businessName}` : ""} has been approved.`,
    "",
    `SECRET CODE: ${code}`,
    "",
    "To open your dashboard: go to the FuelMart Home Page, click \"Vendor Secret Code\",",
    `then enter ${vendor.email} and the code above.`,
    "",
    expiresAt ? `Use it for the first time before: ${new Date(expiresAt).toISOString()}` : "",
    "Reusable: use the same code every time you open your dashboard, until an administrator issues a new one.",
    "Do not share this code with anyone.",
  ].join("\n");

  return sendMail({
    to: vendor.email,
    subject: "FuelMart Vendor Account Approved - Your Secret Code",
    html,
    text,
  });
}

module.exports = {
  initTransporter,
  getTransporter,
  sendMail,
  sendBookingConfirmation,
  sendVerificationEmail,
  sendVendorStatusEmail,
  sendVendorSecretCodeEmail,
};