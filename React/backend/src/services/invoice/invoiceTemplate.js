/**
 * The FuelMart invoice (TAX INVOICE / BILL OF SUPPLY), as a self-contained A4
 * HTML page.
 *
 * DESIGNED LIKE THE APP, NOT LIKE A FORM
 *
 * This document is the last thing a customer sees after a booking, so it is
 * drawn in the same language as the screens that led to it -- the customer
 * app's own tokens (frontend/src/styles/customer.css `.cx-app`):
 *
 *   red      #e23744   the one accent, used for emphasis, never as a slab
 *   ink      #1c1c1c   text, with #696969 for secondary
 *   line     #e8e8e8   hairline borders
 *   surface  #f8f8f8   quiet fills
 *   Poppins for headings, Inter for text, 14px radii
 *
 * It replaces a version built from gradient banners, boxed-in table cells and
 * a decorative wave -- which read as a government form and matched nothing
 * else in the product. Every figure, label and legal line it carried is still
 * here; only the way they are arranged and coloured has changed.
 *
 * WHAT IT MUST NOT LOSE, whatever the styling:
 *   seller and GSTIN, invoice number, booking reference, place of supply and
 *   date, the customer, the vehicle, the HSN/SAC line items with their tax
 *   split, totals, any reward-points deduction, the amount in words, the
 *   reverse-charge and fuel-tax declarations, the verification code, and the
 *   authorised signatory.
 *
 * Every value is escaped, and comes from the invoice snapshot (`inv.data`,
 * built once at issue time by invoiceService.js) -- never recomputed here, so
 * a price or address change cannot alter an invoice already issued.
 * `autoPrint` adds a nonce'd script that opens the print dialog.
 */

const TZ = "Asia/Kolkata";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r) => (r === null || r === undefined ? "—" : `${r}%`);

function dt(iso, { seconds = false, dateOnly = false } = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(d).replace(/\//g, "-");
  if (dateOnly) return date;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: true }).format(d);
  return `${date}, ${time}`;
}
const timeOnly = (iso) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(iso)) : "—";

const LOGO = `
<svg width="40" height="40" viewBox="0 0 120 120" aria-hidden="true">
  <rect width="120" height="120" rx="30" fill="#e23744"/>
  <g transform="translate(31 27) scale(4.1)" fill="#fff">
    <path d="M2 1.5A1.5 1.5 0 0 1 3.5 0h5A1.5 1.5 0 0 1 10 1.5V15H2V1.5zM3.5 2v4h5V2h-5z"/>
    <path d="M11 4.2l2.6 2.1c.3.2.4.6.4.9v5.8a1.5 1.5 0 0 1-3 0V10h-.5V8.8h.5a1.2 1.2 0 0 1 1.2 1.2v3a.3.3 0 0 0 .6 0V7.5L11 5.9V4.2z"/>
    <rect x="1" y="15" width="10" height="1.6" rx=".8"/>
  </g>
</svg>`;

const ICON = {
  user: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="4.5" r="3.2"/><path d="M1.5 15.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6z"/></svg>',
  pin: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 0a5.5 5.5 0 0 0-5.5 5.5C2.5 9.6 8 16 8 16s5.5-6.4 5.5-10.5A5.5 5.5 0 0 0 8 0zm0 7.8a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6z"/></svg>',
  card: '<svg class="ic" viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5V5H1zM1 7h14v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5zm2 3.5h4V9H3z"/></svg>',
  cal: '<svg class="ic" viewBox="0 0 16 16"><path d="M4 0h1.5v2h5V0H12v2h1.5A1.5 1.5 0 0 1 15 3.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 14.5v-11A1.5 1.5 0 0 1 2.5 2H4zM2.5 6v8.5h11V6zm2 2h3v3h-3z"/></svg>',
  pump: '<svg class="ic" viewBox="0 0 16 16"><path d="M2 1.5A1.5 1.5 0 0 1 3.5 0h5A1.5 1.5 0 0 1 10 1.5V15H2zM3.5 2v4h5V2zM11 4.2l2.6 2.1c.3.2.4.6.4.9v5.8a1.5 1.5 0 0 1-3 0V10h-.5V8.8h.5a1.2 1.2 0 0 1 1.2 1.2v3a.3.3 0 0 0 .6 0V7.5L11 5.9z"/></svg>',
  shield: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 0l6 2.5v4.8c0 4-2.6 7.4-6 8.7-3.4-1.3-6-4.7-6-8.7V2.5zm-1 10.3 4.6-4.6-1.1-1.1L7 8.1 5.5 6.6 4.4 7.7z"/></svg>',
  star: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 .8l2.2 4.5 5 .7-3.6 3.5.9 5L8 12.2l-4.5 2.3.9-5L.8 6l5-.7z"/></svg>',
};

/**
 * The app's tokens, as a print stylesheet.
 *
 * Deliberately flat and quiet: hairlines instead of boxes, one accent colour,
 * and whitespace doing the separating. An invoice is read once and filed, so
 * it has to be scannable in two seconds -- what was bought, what it cost, who
 * sold it.
 */
const STYLE = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  :root {
    --red: #e23744; --red-dark: #c7202d; --red-soft: #fff0f1;
    --green: #267e3e; --green-soft: #eaf5ed; --amber: #d97b1a; --amber-soft: #fdf3e7;
    --ink: #1c1c1c; --body: #3f3f46; --muted: #696969;
    --line: #e8e8e8; --surface: #f8f8f8;
  }
  body { font-family: "Inter","Segoe UI",Arial,sans-serif; color: var(--ink); font-size: 10.5px; line-height: 1.5; }
  .page { width: 210mm; min-height: 297mm; position: relative; padding: 13mm 13mm 10mm; margin: 0 auto; background: #fff; }
  @media screen {
    body { background: #f1f1f2; padding: 18px 0; }
    .page { box-shadow: 0 10px 40px rgba(28,28,28,.12); border-radius: 4px; }
    .toolbar { text-align: center; margin: 0 0 14px; }
    .toolbar button {
      font: 600 13px "Poppins",sans-serif; background: var(--red); color: #fff; border: 0;
      border-radius: 10px; padding: 11px 22px; cursor: pointer; box-shadow: 0 2px 10px rgba(226,55,68,.3);
    }
  }
  @media print { .toolbar { display: none; } body { background: #fff; padding: 0; } .page { box-shadow: none; padding-top: 11mm; } }

  h1, h2, h3, h4, h5 { font-family: "Poppins",sans-serif; margin: 0; }
  svg.ic { width: 12px; height: 12px; fill: currentColor; flex-shrink: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  /* ---- masthead: the brand, then who is selling ---- */
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .name { font: 700 21px/1 "Poppins",sans-serif; letter-spacing: -.4px; }
  .brand .name span { color: var(--red); }
  .brand .tag { font-size: 9.5px; color: var(--muted); margin-top: 2px; letter-spacing: .02em; }
  .docmeta { text-align: right; }
  .docmeta .kind { font: 600 10px "Poppins",sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--red); }
  .docmeta .no { font: 700 13px "Poppins",sans-serif; margin-top: 2px; }
  .docmeta .sub { font-size: 10px; color: var(--muted); margin-top: 1px; }
  .hr { height: 1px; background: var(--line); margin: 14px 0; }
  .hr.accent { height: 2px; background: var(--red); width: 44px; margin: 14px 0 0; border-radius: 2px; }

  /* ---- the three parties / facts, side by side ---- */
  .label { font: 600 8.5px "Poppins",sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .block p { margin: 0 0 1px; }
  .block .strong { font: 600 11.5px "Poppins",sans-serif; margin-bottom: 2px; }
  .block .dim { color: var(--muted); }

  /* ---- items: rows, not cells ---- */
  table { width: 100%; border-collapse: collapse; margin-top: 4px; table-layout: fixed; }
  thead th {
    font: 600 8.5px "Poppins",sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
    text-align: right; padding: 0 5px 7px; border-bottom: 1px solid var(--line); line-height: 1.25;
  }
  thead th.l { text-align: left; } thead th.c { text-align: center; }
  tbody td { padding: 9px 6px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: right; }
  tbody td.l { text-align: left; } tbody td.c { text-align: center; }
  tbody td.item b { display: block; font: 600 11px "Poppins",sans-serif; }
  tbody td.item span { display: block; color: var(--muted); font-size: 9.5px; line-height: 1.45; }
  tfoot td { padding: 8px 6px; font: 600 10.5px "Poppins",sans-serif; text-align: right; border-bottom: 1px solid var(--line); }

  /* ---- what it comes to ---- */
  .totals { display: flex; justify-content: flex-end; margin-top: 12px; }
  .totals .box { width: 58%; }
  .totals .row { display: flex; justify-content: space-between; padding: 5px 12px; font-size: 11px; }
  .totals .row.sub { color: var(--muted); }
  .totals .row.reward { color: var(--green); font-weight: 600; }
  .totals .row.payable {
    background: var(--red-soft); border-radius: 12px; padding: 11px 14px; margin-top: 6px;
    font: 700 15px "Poppins",sans-serif; color: var(--red-dark); align-items: baseline;
  }
  .words { margin-top: 10px; font-size: 10px; color: var(--body); }
  .words b { font-family: "Poppins",sans-serif; font-weight: 600; color: var(--ink); }

  /* ---- the four facts about the fill ---- */
  .tiles { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-top: 16px; }
  .tile { background: var(--surface); border-radius: 12px; padding: 9px 11px; }
  .tile .k { font: 600 8.5px "Poppins",sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 5px; }
  .tile .v { font: 600 10.5px "Poppins",sans-serif; margin-top: 4px; line-height: 1.4; }
  .tile.ok .k, .tile.ok .v { color: var(--green); }
  .tile.due .k, .tile.due .v { color: var(--amber); }

  /* ---- the small print ---- */
  .decl { margin-top: 16px; font-size: 9.5px; color: var(--muted); line-height: 1.6; }
  .decl p { margin: 0; }
  .foot { display: grid; grid-template-columns: 1fr 1fr auto; gap: 18px; align-items: start; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
  .foot .sign { align-self: end; }
  .foot p { margin: 0 0 1px; font-size: 9.5px; }
  .stamp { border: 1px solid var(--green); background: var(--green-soft); color: var(--green); border-radius: 10px; padding: 7px 10px; font-size: 8.5px; line-height: 1.45; }
  .stamp b { display: flex; align-items: center; gap: 5px; font: 600 9.5px "Poppins",sans-serif; letter-spacing: .06em; margin-bottom: 2px; }
  .sign { text-align: center; min-width: 170px; }
  .sign .sigspace { height: 34px; display: flex; align-items: flex-end; justify-content: center; }
  .sign .sigspace img { max-height: 34px; max-width: 160px; object-fit: contain; }
  .sign .line { border-top: 1px solid var(--ink); margin-top: 3px; padding-top: 4px; font: 600 10px "Poppins",sans-serif; }
  .sign .for { font-size: 9.5px; color: var(--muted); margin-bottom: 2px; }
  .note { text-align: center; font-size: 9px; color: var(--muted); margin-top: 14px; }
`;

/**
 * @param {object} inv         Invoice document (lean)
 * @param {object} live        current booking payment fields { paymentStatus, payMethod, collectedAt }
 * @param {object} [opts]      { nonce, autoPrint, supportEmail }
 */
function renderInvoiceHtml(inv, live = {}, { nonce = "", autoPrint = false, supportEmail = null } = {}) {
  const d = inv.data;
  const s = d.seller;
  const dealer = s.businessName && s.businessName !== s.stationName ? `${s.stationName} (${s.businessName})` : s.stationName;
  const paid = live.paymentStatus === "paid";
  const payText = paid ? (live.payMethod === "online" ? "Paid online" : "Paid at pump (Cash / UPI)") : "Due at pump";
  const r = d.refuelling || {};
  const discount = Number(d.totals?.discount) || 0;
  const payable = Number(d.totals?.payable ?? d.totals.total);

  const rows = d.lines
    .map(
      (l) => `<tr>
        <td class="c">${esc(l.sr)}</td>
        <td class="l item"><b>${esc(l.name)}</b><span>${l.description.map(esc).join("<br />")}</span></td>
        <td class="c">${esc(l.hsn)}</td><td class="c">${esc(l.qty)}</td>
        <td>${money(l.rate)}</td><td>${money(l.taxable)}</td>
        <td class="c">${pct(l.cgstRate)}</td><td>${money(l.cgst)}</td>
        <td class="c">${pct(l.sgstRate)}</td><td>${money(l.sgst)}</td>
        <td>${money(l.cess)}</td><td>${money(l.total)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice ${esc(d.invoiceNo)} — FuelMart</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>${STYLE}</style></head>
<body>
<div class="toolbar"><button type="button" id="print">Download / Print PDF</button></div>
<div class="page">

  <div class="top">
    <div class="brand">${LOGO}<div><div class="name">Fuel<span>Mart</span></div><div class="tag">Smart Fuel Booking</div></div></div>
    <div class="docmeta">
      <div class="kind">Tax Invoice / Bill of Supply</div>
      <div class="no">${esc(d.invoiceNo)}</div>
      <div class="sub">${esc(dt(d.issuedAt))}</div>
      <div class="sub">Booking ${esc(d.bookingRef)}</div>
    </div>
  </div>

  <div class="hr"></div>

  <div class="grid3">
    <div class="block">
      <div class="label">${ICON.user} Billed to</div>
      <p class="strong">${esc(d.customer.name)}</p>
      <p class="dim">Customer ID: ${esc(d.customer.id)}</p>
      ${d.customer.phone ? `<p class="dim">${esc(d.customer.phone)}</p>` : ""}
      ${d.vehicle.plate ? `<p>Vehicle: <b>${esc(d.vehicle.plate)}</b>${d.vehicle.name ? ` (${esc(d.vehicle.name)})` : ""}</p>` : ""}
    </div>
    <div class="block">
      <div class="label">${ICON.pin} Fuelled at</div>
      <p class="strong">${esc(dealer)}</p>
      <p class="dim">${esc(s.address)}</p>
      <p class="dim">GSTIN: ${esc(s.gstin || "Not registered")}</p>
      ${s.vendorCode ? `<p class="dim">Vendor code: ${esc(s.vendorCode)}</p>` : ""}
    </div>
    <div class="block">
      <div class="label">${ICON.cal} Supply</div>
      <p>Place of supply: <b>${esc(s.placeOfSupply || "—")}</b></p>
      <p class="dim">Invoice date: ${esc(dt(d.issuedAt, { dateOnly: true }))}</p>
      <p class="dim">Verify code: ${esc(d.verifyCode)}</p>
    </div>
  </div>

  <div class="hr accent"></div>

  <table>
    <colgroup><col style="width:4%"/><col style="width:23%"/><col style="width:9%"/><col style="width:7%"/><col style="width:8.5%"/><col style="width:9%"/><col style="width:5.5%"/><col style="width:7%"/><col style="width:5.5%"/><col style="width:7%"/><col style="width:5.5%"/><col style="width:9%"/></colgroup>
    <thead><tr>
      <th class="c">#</th><th class="l">Item &amp; description</th><th class="c">HSN / SAC</th><th class="c">Qty</th>
      <th>Rate (₹)</th><th>Taxable (₹)</th><th class="c">CGST %</th><th>CGST</th><th class="c">SGST %</th><th>SGST</th><th>Cess</th><th>Total (₹)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td colspan="5">Total</td>
      <td>${money(d.totals.taxable)}</td><td></td><td>${money(d.totals.cgst)}</td>
      <td></td><td>${money(d.totals.sgst)}</td><td>${money(d.totals.cess)}</td><td>${money(d.totals.total)}</td>
    </tr></tfoot>
  </table>

  <div class="totals"><div class="box">
    <div class="row sub"><span>Item total</span><span>₹ ${money(d.totals.total)}</span></div>
    ${
      // Reward points, when any were spent: a deduction from what is payable,
      // leaving the taxable value and the tax above untouched. An invoice with
      // no points discount simply does not show this line.
      discount > 0
        ? `<div class="row reward"><span>${ICON.star} Reward points${d.rewardPointsUsed ? ` (${esc(d.rewardPointsUsed)} pts)` : ""}</span><span>− ₹ ${money(discount)}</span></div>`
        : ""
    }
    <div class="row payable"><span>${discount > 0 ? "Amount payable" : "Invoice value"}</span><span>₹ ${money(payable)}</span></div>
  </div></div>

  <div class="words"><b>Amount in words:</b> ${esc(d.amountInWords)}</div>

  <div class="tiles">
    <div class="tile ${paid ? "ok" : "due"}"><div class="k">${ICON.card} Payment</div><div class="v">${esc(payText)}</div></div>
    <div class="tile"><div class="k">${ICON.cal} Collected</div><div class="v">${esc(live.collectedAt ? dt(live.collectedAt) : paid ? "—" : "Not yet collected")}</div></div>
    <div class="tile"><div class="k">${ICON.pump} Refuelling</div><div class="v">${esc(r.start ? `${timeOnly(r.start)} → ${timeOnly(r.end)}${r.seconds !== null ? ` (${r.seconds >= 60 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds} s`})` : ""}` : "—")}</div></div>
    <div class="tile"><div class="k">${ICON.shield} Verification</div><div class="v">4-digit code at pump</div></div>
  </div>

  <div class="decl">
    <p>Whether GST is payable on reverse-charge — No.</p>
    <p>Petrol, High Speed Diesel and CNG are outside the scope of GST; the fuel price shown is inclusive of applicable State VAT and excise duty.</p>
    ${d.lines.length > 1 ? `<p>GST is charged only on the booking convenience fee (SAC 998599, 18%).</p>` : ""}
  </div>

  <div class="foot">
    <div>
      <div class="label">${ICON.pump} Fuel dispensed from</div>
      <p><b>${esc(s.stationName)}</b>${s.businessName && s.businessName !== s.stationName ? ` (${esc(s.businessName)})` : ""}</p>
      <p>${esc(s.address)}</p>
      <p>GSTIN: ${esc(s.gstin || "Not registered")}</p>
    </div>
    <div>
      <div class="label">Booked through</div>
      <p><b>FuelMart</b> — Smart Fuel Booking</p>
      ${supportEmail ? `<p>Support: ${esc(supportEmail)}</p>` : ""}
      <div class="stamp" style="margin-top:6px">
        <b>${ICON.shield} Digitally signed</b>
        by FuelMart on behalf of the dealer · ${esc(dt(d.issuedAt, { seconds: true }))} IST
      </div>
    </div>
    <div class="sign">
      <div class="for">For ${esc(s.stationName)}</div>
      <div class="sigspace">${s.signatureImage ? `<img src="${esc(s.signatureImage)}" alt="Authorised signature" />` : ""}</div>
      <div class="line">Authorised Signatory</div>
    </div>
  </div>

  <p class="note">This is a computer-generated invoice and does not require a physical signature.</p>
</div>
<script nonce="${esc(nonce)}">
  document.getElementById("print").addEventListener("click", function () { window.print(); });
  ${autoPrint ? 'window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });' : ""}
</script>
</body></html>`;
}

module.exports = { renderInvoiceHtml };
