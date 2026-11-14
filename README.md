# SOM TREVEL — Travel Platform (React + Express + MongoDB)

## 1. Orod local (tijaabo)
```
cp .env.example .env        # geli MONGODB_URI iyo JWT_SECRET (16+ xaraf)
npm install
npm run build               # dhisa frontend-ka
npm start                   # http://localhost:5000
npm test                    # unit tests ee xeerarka (lacag, ticket, password, upload) — DB looma baahna
npm run smoke               # (server-ka oo socda) hubi dhammaan API-yada
```
Marka ugu horreysa demo data si toos ah ayaa loo abuuraa. Admin = ADMIN_EMAIL/ADMIN_PASSWORD. Demo customer: `demo.ahmed.hassan@example.com` / `Demo12345`.
Commands: `npm run db:seed`, `npm run db:reset-demo`.

## 2. Deploy
1. **GitHub**: `git init && git add . && git commit -m "SOM TREVEL"` → push repo cusub (`.env` GitHub ha gelin).
2. **MongoDB Atlas**: free cluster → Database user → Network Access `0.0.0.0/0` → copy URI → `MONGODB_URI`.
3. **Render**: New → Blueprint (render.yaml). Geli env vars. `APP_URL` = URL-ka dhabta ah (https://...).
4. **Cloudflare**: Add site → DNS CNAME (`@` iyo `www`) → `your-app.onrender.com` (Proxied) → SSL "Full". Render → Custom Domains ku dar domain-ka.
5. **Production dhab**: `DEMO_ENABLED=false`; marka hore Admin → Settings → Reset all demo.

## 3. Features la xiray
- **Email (Resend)**: `RESEND_API_KEY` + `MAIL_FROM` (domain-ka resend.com ku xaqiiji). La'aantiisa emails waxay ku qoranyihiin server log; forgot-password link-gu wuxuu ku jiraa log-ka.
- **Card payment (Stripe)**: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. Stripe Dashboard → Webhooks → endpoint `https://DOMAIN/api/payments/stripe-webhook`, event `checkout.session.completed`. "Paid" waxaa la dhigaa KALIYA marka webhook-ga saxiixan yimaado.
- **Lacag-bixin (EVC Plus / Edahab / Bank / Cash)**: customer wuxuu Invoice-ka ka gelinayaa lacagta (qayb-qayb ayuu bixin karaa) iyo transaction reference. Lacagtaas **ma tirtirmayso** ilaa Admin/Accountant Payments → **Verify** uu sameeyo. "Paid" waxaa la xisaabiyaa KALIYA lacagaha la xaqiijiyay; admin gacanta uma saari karo "paid". Reject / Refund waxay leeyihiin sabab, dhammaan waxaa lagu qoraa **Audit log**.
- **Flights → e-ticket dhab ah**: customer wuxuu geliyaa rakaab kasta (magac passport, DOB, passport no.). Admin geliyaa quote → customer wuu bixiyaa → accountant wuu xaqiijiyaa → ticketing wuxuu geliyaa **PNR dhab ah**, segment kasta (airline, flight no, waqti) iyo **e-ticket number** rakaab kasta → "Issue ticket". Nidaamku **PNR/ticket number ma abuurin** oo ticket ma bixiyo haddii lacagta oo dhan aan la xaqiijin. E-ticket-ku waa hal boarding-pass rakaab kasta (dhammaan flights, QR, Print/Save PDF) iyo bog dadweyne `/verify/CODE` oo muujiya VALID/VOIDED (magacyada qayb ahaan la qariyo).
- **Roles**: admin, staff (bookings+catalog), ticketing (issue tickets), accountant (verify/refund payments). Admin → Team.
- **Kuraasta**: package booking wuxuu **atomically** dhimaa kuraasta; cancel/expire waa la soo celiyaa. Pending aan la bixin ayaa kuraasta ka sii daaya `HOLD_HOURS` (48) kadib.
- **Sawirada**: Admin → Destinations/Packages/Hotels → upload (JPG/PNG/WEBP/GIF, 5MB, waxaa la hubiyaa bytes-ka run ahaan). `CLOUDINARY_URL` haddii la dhigo → Cloudinary; haddii kale disk (`UPLOAD_DIR`) — Render free disk waa ku-meel-gaar!
- **Amni**: CSRF header + SameSite, CSP, login lockout (5 isku-day → 15 daqiiqo), session version (password beddelid/suspend → session-yada hore waa dhintaan), password policy, whitelist ee catalog fields.
- **Maps**: Google Maps embed (key looma baahna), khariidad interactive oo flight route ah (OpenStreetMap + Leaflet).
- **Hotels, Reviews, Support tickets, Notifications (bell), Saved destinations, Forgot/Reset password, Profile**.

## 4. Xusuus
- Sawirada Soomaaliya: gradient ayaa muuqda ilaa admin URL geliyo (Admin → Destinations).
- Visa info: link Google ah oo lagu hubiyo; ma aha xog rasmi ah.
