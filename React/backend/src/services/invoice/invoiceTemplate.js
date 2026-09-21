/**
 * The approved FuelMart invoice design (TAX INVOICE / BILL OF SUPPLY), as a
 * self-contained A4 HTML page: FuelMart logo, red title banner, Bill To /
 * Fuelled At cards, item table, Invoice Value bar, status tiles, declarations,
 * footer, digital-signature stamp and the vendor's uploaded signature.
 *
 * Every value is escaped. `autoPrint` adds a nonce'd script that opens the
 * browser's print dialog ("Save as PDF").
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
<svg width="54" height="54" viewBox="0 0 120 120" aria-hidden="true">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef4f5c"/><stop offset="1" stop-color="#c7202d"/></linearGradient></defs>
  <rect width="120" height="120" rx="34" fill="url(#lg)"/>
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
  mark: '<svg class="ic" viewBox="0 0 120 120"><rect width="120" height="120" rx="30"/></svg>',
};

const STYLE = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  :root { --red:#e23744; --red-dark:#b81d2a; --red-soft:#fdecee; --amber:#d97b1a; --green:#1f8a4c; --green-soft:#e9f6ee; --slate:#475569; --ink:#1c1c1c; --body:#3f3f46; --muted:#6b7280; --line:#e5e7eb; }
  body { font-family: "Inter","Segoe UI",Arial,sans-serif; color: var(--ink); font-size: 10.5px; line-height: 1.4; }
  .page { width: 210mm; height: 297mm; position: relative; overflow: hidden; padding: 9mm 9mm 0; margin: 0 auto; }
  @media screen { body { background: #e5e7eb; padding: 16px 0; } .page { box-shadow: 0 6px 24px rgba(0,0,0,.18); background: #fff; } .toolbar { text-align:center; margin: 0 0 12px; } .toolbar button { font: 600 13px "Poppins",sans-serif; background: var(--red); color:#fff; border:0; border-radius:8px; padding:9px 18px; cursor:pointer; } }
  @media print { .toolbar { display: none; } body { background: #fff; padding: 0; } .page { box-shadow: none; } }
  .header { display:flex; justify-content:space-between; align-items:flex-start; }
  .seller { font-family:"Poppins",sans-serif; font-weight:600; font-size:11.5px; line-height:1.65; padding-top:6px; max-width: 64%; }
  .seller b { font-weight:700; }
  .logo { display:flex; align-items:center; gap:10px; justify-content:flex-end; margin-top: 8px; }
  .logo .name { font:800 30px/1 "Poppins",sans-serif; letter-spacing:-1px; color:var(--ink); }
  .logo .name span { color:var(--red); }
  .logo .tag { font:500 10.5px "Poppins",sans-serif; color:var(--muted); letter-spacing:.03em; margin-top:3px; text-align:right; }
  .rule { height:3px; margin:8px -9mm 0; background:linear-gradient(90deg,var(--red) 0 12%,#f3f4f6 12% 86%,var(--amber) 86%); }
  .banner { margin-top:10px; background:linear-gradient(90deg,var(--red-dark),var(--red)); color:#fff; border-radius:8px; text-align:center; padding:9px 0; font:700 19px "Poppins",sans-serif; letter-spacing:.04em; position:relative; }
  .banner::before,.banner::after { content:""; position:absolute; top:50%; width:22%; height:1.4px; background:rgba(255,255,255,.75); }
  .banner::before { left:3%; } .banner::after { right:3%; }
  .meta { display:grid; grid-template-columns:1fr 1fr; margin:10px 4px 8px; font-size:11px; }
  .meta > div + div { border-left:1.3px solid var(--line); padding-left:16px; }
  .meta p { margin:2px 0; } .meta b { font-family:"Poppins",sans-serif; font-weight:600; }
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .card { border:1.5px solid; border-radius:8px; overflow:hidden; }
  .card h3 { margin:0; color:#fff; font:600 12px "Poppins",sans-serif; padding:5px 10px; display:flex; align-items:center; gap:6px; }
  .card .body { padding:6px 10px 7px; font-size:11px; } .card .body p { margin:1px 0; } .card .body .strong { font:700 11.5px "Poppins",sans-serif; }
  .card.red { border-color:var(--red); } .card.red h3 { background:linear-gradient(90deg,var(--red-dark),var(--red)); }
  .card.slate { border-color:var(--slate); } .card.slate h3 { background:linear-gradient(90deg,#334155,var(--slate)); }
  svg.ic { width:13px; height:13px; fill:currentColor; flex-shrink:0; }
  table { width:100%; border-collapse:separate; border-spacing:0; margin-top:10px; table-layout:fixed; border:1.5px solid var(--red); border-radius:8px; overflow:hidden; }
  th { background:linear-gradient(180deg,var(--red),var(--red-dark)); color:#fff; font:600 9.5px/1.2 "Poppins",sans-serif; padding:6px 3px; text-align:center; border-left:1px solid rgba(255,255,255,.35); }
  th:first-child { border-left:none; }
  td { padding:6px 4px; font-size:10.5px; vertical-align:top; border-left:1px solid var(--line); border-top:1px solid var(--line); }
  td:first-child { border-left:none; } td.num { text-align:right; } td.c { text-align:center; }
  td.desc b { display:block; font:600 10.5px "Poppins",sans-serif; } td.desc span { color:var(--body); font-size:10px; }
  tr.total td { font:700 10.5px "Poppins",sans-serif; background:#fafafa; border-top:1.3px solid var(--red); }
  tr.total td.grand { background:var(--red-soft); color:var(--red-dark); }
  .itemtotal { margin-top:10px; display:flex; justify-content:space-between; background:var(--red-soft); border-radius:6px 6px 0 0; padding:6px 12px; font:600 12px "Poppins",sans-serif; }
  .invoicevalue { display:flex; justify-content:space-between; background:linear-gradient(90deg,var(--red-dark),var(--red)); color:#fff; border-radius:0 0 6px 6px; padding:8px 12px; font:700 16px "Poppins",sans-serif; }
  .words { margin-top:8px; background:#f8f8f9; border-radius:6px; padding:6px 12px; font-size:10.5px; } .words b { font-family:"Poppins",sans-serif; font-weight:600; }
  .tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:10px; }
  .tile { border:1.5px solid; border-radius:8px; overflow:hidden; }
  .tile h4 { margin:0; color:#fff; font:600 10.5px "Poppins",sans-serif; letter-spacing:.04em; text-transform:uppercase; padding:5px 8px; display:flex; align-items:center; gap:6px; }
  .tile p { margin:0; padding:6px 8px; font-size:10.5px; font-weight:500; }
  .tile.green { border-color:var(--green); } .tile.green h4 { background:var(--green); }
  .tile.red { border-color:var(--red); } .tile.red h4 { background:var(--red); }
  .tile.amber { border-color:var(--amber); } .tile.amber h4 { background:var(--amber); }
  .tile.slate { border-color:var(--slate); } .tile.slate h4 { background:var(--slate); }
  .decl { margin:10px 6px 0; font-size:10.5px; color:var(--body); } .decl p { margin:2px 0; }
  .footer { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px; padding-top:8px; border-top:1.3px solid var(--line); }
  .footer h5 { margin:0 0 4px; background:var(--red-soft); color:var(--ink); font:600 11px "Poppins",sans-serif; padding:5px 8px; border-radius:5px; display:flex; align-items:center; gap:6px; }
  .footer h5 svg { color:var(--red); } .footer p { margin:1px 8px; font-size:10.5px; }
  .signrow { display:flex; justify-content:flex-end; align-items:flex-end; gap:14px; margin-top:10px; }
  .estamp { position:relative; width:212px; border:1.6px solid var(--green); border-radius:8px; padding:6px 8px 6px 34px; color:var(--green); background:var(--green-soft); font-size:9px; line-height:1.35; }
  .estamp svg { position:absolute; left:8px; top:8px; width:20px; height:20px; fill:var(--green); }
  .estamp b { display:block; font:700 10.5px "Poppins",sans-serif; letter-spacing:.03em; } .estamp span { color:#14532d; }
  .sign { text-align:center; width:210px; font-size:10.5px; } .sign .for { color:var(--body); }
  .sign .sigspace { height:38px; display:flex; align-items:flex-end; justify-content:center; }
  .sign .sigspace img { max-height:38px; max-width:180px; object-fit:contain; }
  .sign .line { border-top:1.3px solid var(--ink); margin-top:2px; padding-top:3px; font-family:"Poppins",sans-serif; font-weight:600; }
  .note { text-align:center; font-size:9.5px; font-style:italic; color:var(--muted); margin-top:8px; }
  .band { position:absolute; left:0; right:0; bottom:0; height:26mm; }
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

  const rows = d.lines
    .map(
      (l) => `<tr>
        <td class="c">${esc(l.sr)}</td>
        <td class="desc"><b>${esc(l.name)}</b><span>${l.description.map(esc).join("<br />")}</span></td>
        <td class="c">${esc(l.hsn)}</td><td class="c">${esc(l.qty)}</td>
        <td class="num">${money(l.rate)}</td><td class="num">${money(l.taxable)}</td>
        <td class="c">${pct(l.cgstRate)}</td><td class="num">${money(l.cgst)}</td>
        <td class="c">${pct(l.sgstRate)}</td><td class="num">${money(l.sgst)}</td>
        <td class="num">${money(l.cess)}</td><td class="num">${money(l.total)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice ${esc(d.invoiceNo)} — FuelMart</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${STYLE}</style></head>
<body>
<div class="toolbar"><button type="button" id="print">Download / Print PDF</button></div>
<div class="page">
  <div class="header">
    <div class="seller">
      Seller Name: <b>${esc(dealer)}</b><br />
      ${esc(s.address)}<br />
      GSTIN: ${esc(s.gstin || "Not registered")}<br />
      ${s.vendorCode ? `Vendor Code: ${esc(s.vendorCode)}` : ""}
    </div>
    <div class="logo">${LOGO}<div><div class="name">Fuel<span>Mart</span></div><div class="tag">Smart Fuel Booking</div></div></div>
  </div>
  <div class="rule"></div>
  <div class="banner">TAX INVOICE / BILL OF SUPPLY</div>
  <div class="meta">
    <div><p><b>Invoice No.:</b> ${esc(d.invoiceNo)}</p><p><b>Booking Ref.:</b> ${esc(d.bookingRef)}</p></div>
    <div><p><b>Place Of Supply:</b> ${esc(s.placeOfSupply || "—")}</p><p><b>Date:</b> ${esc(dt(d.issuedAt))}</p></div>
  </div>
  <div class="cards">
    <div class="card red"><h3>${ICON.user} Bill To</h3><div class="body">
      <p class="strong">${esc(d.customer.name)}</p>
      <p>Customer ID: ${esc(d.customer.id)}</p>
      ${d.customer.phone ? `<p>Phone: ${esc(d.customer.phone)}</p>` : ""}
    </div></div>
    <div class="card slate"><h3>${ICON.pin} Fuelled At</h3><div class="body">
      <p class="strong">${esc(dealer)}</p>
      <p>${esc(s.address)}</p>
      ${d.vehicle.plate ? `<p><b>Vehicle:</b> ${esc(d.vehicle.plate)}${d.vehicle.name ? ` (${esc(d.vehicle.name)})` : ""}</p>` : ""}
    </div></div>
  </div>
  <table>
    <colgroup><col style="width:4.5%"/><col style="width:20%"/><col style="width:9%"/><col style="width:7%"/><col style="width:8%"/><col style="width:9%"/><col style="width:6%"/><col style="width:7%"/><col style="width:6%"/><col style="width:7%"/><col style="width:6%"/><col style="width:10.5%"/></colgroup>
    <thead><tr><th>SR<br/>No</th><th>Item &amp; Description</th><th>HSN /<br/>SAC</th><th>Qty</th><th>Unit Rate<br/>(₹)</th><th>Taxable<br/>Amt (₹)</th><th>CGST<br/>%</th><th>CGST<br/>Amt</th><th>SGST<br/>%</th><th>SGST<br/>Amt</th><th>Cess<br/>Amt</th><th>Total<br/>Amt (₹)</th></tr></thead>
    <tbody>${rows}
      <tr class="total"><td colspan="5" class="num">Total</td><td class="num">${money(d.totals.taxable)}</td><td></td><td class="num">${money(d.totals.cgst)}</td><td></td><td class="num">${money(d.totals.sgst)}</td><td class="num">${money(d.totals.cess)}</td><td class="num grand">${money(d.totals.total)}</td></tr>
    </tbody>
  </table>
  <div class="itemtotal"><span>Item Total</span><span>₹ ${money(d.totals.total)}</span></div>
  <div class="invoicevalue"><span>Invoice Value</span><span>₹ ${money(d.totals.total)}</span></div>
  <div class="words"><b>Amount in words:</b> ${esc(d.amountInWords)}</div>
  <div class="tiles">
    <div class="tile ${paid ? "green" : "amber"}"><h4>${ICON.card} Payment</h4><p>${esc(payText)}</p></div>
    <div class="tile red"><h4>${ICON.cal} Collected</h4><p>${esc(live.collectedAt ? dt(live.collectedAt) : paid ? "—" : "Not yet collected")}</p></div>
    <div class="tile amber"><h4>${ICON.pump} Refuelling</h4><p>${esc(r.start ? `${timeOnly(r.start)} → ${timeOnly(r.end)}${r.seconds !== null ? ` (${r.seconds >= 60 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds} s`})` : ""}` : "—")}</p></div>
    <div class="tile slate"><h4>${ICON.shield} Verification</h4><p>4-digit code at pump</p></div>
  </div>
  <div class="decl">
    <p>Whether GST is payable on reverse-charge – No.</p>
    <p>Petrol, High Speed Diesel and CNG are outside the scope of GST; the fuel price shown is inclusive of applicable State VAT and excise duty.</p>
    ${d.lines.length > 1 ? `<p>GST is charged only on the booking convenience fee (SAC 998599, 18%).</p>` : ""}
  </div>
  <div class="footer">
    <div><h5>${ICON.pump} Fuel Dispensed From -</h5>
      <p><b>${esc(s.stationName)}</b>${s.businessName && s.businessName !== s.stationName ? ` (${esc(s.businessName)})` : ""}</p>
      <p>${esc(s.address)}</p>
      <p>GSTIN: ${esc(s.gstin || "Not registered")}</p>
    </div>
    <div><h5>${ICON.mark} Booking Platform Information -</h5>
      <p><b>FuelMart</b> — Smart Fuel Booking</p>
      ${supportEmail ? `<p>Support: ${esc(supportEmail)}</p>` : ""}
      <p>Verify this invoice: code ${esc(d.verifyCode)}</p>
    </div>
  </div>
  <div class="signrow">
    <div class="estamp">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0l6 2.5v4.8c0 4-2.6 7.4-6 8.7-3.4-1.3-6-4.7-6-8.7V2.5zm-1 10.3 4.6-4.6-1.1-1.1L7 8.1 5.5 6.6 4.4 7.7z"/></svg>
      <b>DIGITALLY SIGNED</b>
      <span>by FuelMart on behalf of the dealer</span><br />
      <span>${esc(dt(d.issuedAt, { seconds: true }))} IST</span><br />
      <span>Verify code: ${esc(d.verifyCode)}</span>
    </div>
    <div class="sign">
      <div class="for">For ${esc(s.stationName)}</div>
      <div class="sigspace">${s.signatureImage ? `<img src="${esc(s.signatureImage)}" alt="Authorised signature" />` : ""}</div>
      <div class="line">Authorised Signatory</div>
    </div>
  </div>
  <p class="note">This is a computer-generated invoice and does not require a physical signature.</p>
  <svg class="band" viewBox="0 0 800 100" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 40 C 220 95, 520 95, 800 20 L800 100 L0 100 Z" fill="#b81d2a"/>
    <path d="M0 58 C 240 105, 540 100, 800 38 L800 100 L0 100 Z" fill="#e23744"/>
    <path d="M430 88 C 600 80, 720 55, 800 30 L800 36 C 720 62, 600 88, 430 92 Z" fill="#d97b1a"/>
    <path d="M0 30 C 120 55, 220 66, 330 70 L330 74 C 220 71, 110 62, 0 36 Z" fill="#d97b1a" opacity=".85"/>
  </svg>
</div>
<script nonce="${esc(nonce)}">
  document.getElementById("print").addEventListener("click", function () { window.print(); });
  ${autoPrint ? 'window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });' : ""}
</script>
</body></html>`;
}

module.exports = { renderInvoiceHtml };
