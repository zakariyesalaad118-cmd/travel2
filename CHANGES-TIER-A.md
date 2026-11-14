# SOM TREVEL — Tier A isbeddellada (ticket, lacag, amni, kuraas, upload)

## Waxa la beddelay
**Ticket workflow (flights)**
- Codsiga flight wuxuu hadda ururiyaa rakaab kasta (magac passport, DOB, passport no., nooca: adult/child/infant).
- Ticket "Ticketed" waxaa lagu bixiyaa KALIYA `POST /api/admin/flights/:id/issue` — wuxuu u baahan yahay: quote, lacagta oo dhan oo la xaqiijiyay, PNR dhab ah (5-8), e-ticket number rakaab kasta (13 lambar, kala duwan), segment kasta (airline, flight no, depart/arrive HH:MM) oo la mid ah legs-ka (round-trip = 2 segment). **Nidaamku PNR/ticket number ma abuuro.**
- E-ticket: hal pass rakaab kasta, dhammaan segments, QR → `/verify/CODE` (bog dadweyne; magacyada waa la qariyaa, ticket numbers kaliya 4-ta ugu dambeysa), Print/Save-as-PDF (browser print), Void (VALID → VOIDED).
**Lacag**
- `Payment` waa diiwaan dhab ah: pending → paid / rejected → refunded. Customer wuxuu gelinayaa lacag (qayb-qayb); waxay tirtirmaysaa KALIYA marka accountant/admin **Verify** sameeyo. Admin gacanta uma saari karo "paid".
- Amount-ka la xaqiijiyay waa la saxi karaa; ma dhaafi karo haraaga; reference-ka la isticmaalay lama isticmaali karo.
- Stripe webhook wuxuu abuuraa Payment row (idempotent, unique reference); card wuxuu bixiyaa haraaga.
- Record cash/bank (admin/accountant), Reject/Refund oo leh sabab; Audit log (Admin → Audit).
**Roles**: admin, staff, ticketing, accountant (+customer). Admin → Team.
**Kuraasta**: package booking → `findOneAndUpdate({seats:{$gte:n}},{$inc:{seats:-n}})` (atomic); cancel/expire waa la soo celiyaa hal mar; `HOLD_HOURS` (48).
**Amni**: header `X-Requested-With` (CSRF) + SameSite; CSP; login lockout (5 → 15 daqiiqo); tokenVersion (password/suspend/role → session-yada hore waa dhintaan); password policy; whitelist fields (catalog); booking status transitions; cancel waa la xiray haddii lacag la xaqiijiyay jirto; admin default password production-ka lama oggola.
**Upload sawir**: `POST /api/admin/upload` (raw image body, 5MB, magic-bytes JPG/PNG/WEBP/GIF; SVG diidan) → Cloudinary (`CLOUDINARY_URL`) ama disk (`UPLOAD_DIR`).
**Migration** (wuxuu si toos ah u socdaa startup): bookings "paid" ee hore → `paidAmount=total`; Payment placeholders "Pending" ee hore waa la tirtiraa.

## Hubinta la sameeyay (halkan)
- `npm test` → 18/18 unit tests (lacag, ticket rules, masking, password, lockout, image magic bytes).
- `node --check` server oo dhan; esbuild JSX parse client oo dhan; `tsc --checkJs` (undefined identifiers) → 1 qalad dhab ah (Pkg import) waa la saxay, hadda 0.
- Client API paths ↔ server routes waa la is-barbardhigay.

## WAA LA TIJAABIN WAYDAY (halkan npm registry iyo MongoDB lama heli karo)
- App-ka lama orday: **MongoDB, Express routes, Mongoose queries (updateMany pipeline, partial unique index), UI browser-ka** — `npm install && npm start && npm run smoke` samee marka ugu horreysa.
- Stripe webhook, Resend email, Cloudinary upload, CSP (browser console ka eeg haddii wax la xanibay) — dhammaan lama tijaabin.
- `npm run smoke` hadda wuxuu leeyahay hubin cusub (CSRF, verify, upload 415, ticket blocked).
- Refund = diiwaan kaliya (lacagta dhabta ah gacanta/Stripe dashboard ku celi).

## Wali lama sameyn (Tier B/C)
Hajj/Umrah, accounting double-entry, i18n Somali/English, TypeScript, Framer Motion, SEO/prerender, WhatsApp, EVC/Edahab gateway API, package voucher verify, design overhaul.
