// Money, ticketing, upload, public ticket verification, team and audit routes.
// Mounted by routes.js (before the 404 handler). Business rules live in rules.js (unit-tested).
import {Router} from 'express';
import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import {User,Pkg,Booking,Payment,FlightRequest,AuditLog} from './models.js';
import {wrap,bad,auth,audit,appUrl} from './auth.js';
import {sendMail,tpl,esc,tell,adminAlert} from './mail.js';
import {saveImage,MAX_IMAGE} from './upload.js';
import * as R from './rules.js';

const o=Router();
o.param('id',(q,s,n,v)=>mongoose.isValidObjectId(v)?n():bad(s,'Invalid id'));
const any=auth(),panel=auth(R.CAN.panel),money=auth(R.CAN.money),tixRole=auth(R.CAN.ticketing),catalog=auth(R.CAN.catalog),owner=auth(['admin']);
export const METHODS=['EVC Plus','Edahab','Bank Transfer','Cash','Other'];
const iata=x=>(String(x||'').toUpperCase().match(/\b[A-Z]{3}\b/)||[])[0];
const str=(v,n)=>String(v??'').trim().slice(0,n);
const isOwner=(doc,q)=>String(doc.user)===String(q.user._id);

// ---------- payment bookkeeping ----------
const KIND={booking:{M:Booking,key:'booking',total:d=>d.total},flight:{M:FlightRequest,key:'flight',total:d=>d.quote}};
const paysOf=(kind,doc,extra={})=>Payment.find({[KIND[kind].key]:doc._id,...extra}).select('amount status method reference').lean();
// Recomputes paymentStatus/paidAmount from verified Payment rows. Safe to call any number of times.
export async function recompute(kind,doc){
  const st=R.paymentState(KIND[kind].total(doc),await paysOf(kind,doc)),before=doc.paymentStatus;
  doc.paymentStatus=st.status;doc.paidAmount=st.paid;await doc.save();
  return {st,before};
}
const dupRef=async(method,reference,statuses,exceptId)=>method!=='Cash'&&!!reference&&!!(await Payment.exists({method,reference,status:{$in:statuses},...(exceptId&&{_id:{$ne:exceptId}})}));
const loadFor=async(kind,ref)=>KIND[kind].M.findOne({ref:String(ref)});

// Gives seats back exactly once (seatsHeld is claimed atomically) and rejects any still-pending payment claims.
export async function releaseBooking(b){
  await Payment.updateMany({booking:b._id,status:'pending'},{status:'rejected',rejectReason:'Booking cancelled'});
  if(!b.seatsHeld||!b.package)return;
  const c=await Booking.findOneAndUpdate({_id:b._id,seatsHeld:true},{seatsHeld:false});
  if(c)await Pkg.updateOne({_id:b.package},{$inc:{seats:b.travelers}});
}

// Seat-hold policy: an unpaid, untouched Pending booking releases its seats after HOLD_HOURS (default 48).
export async function sweepHolds(){
  try{
    const cutoff=new Date(Date.now()-Number(process.env.HOLD_HOURS||48)*36e5);
    const old=await Booking.find({status:'Pending',paymentStatus:'unpaid',seatsHeld:true,createdAt:{$lt:cutoff}}).limit(200);
    for(const b of old){
      if(await Payment.exists({booking:b._id,status:{$in:['pending','paid']}}))continue;
      const c=await Booking.findOneAndUpdate({_id:b._id,status:'Pending'},{status:'Cancelled'},{new:true});
      if(!c)continue;
      await releaseBooking(c);
      tell(c.user,'Booking expired',`Booking ${c.ref} was released because no payment was received in time.`);
    }
    if(old.length)console.log('sweepHolds checked',old.length);
  }catch(e){console.error('sweepHolds',e.message)}
}

// ---------- CUSTOMER: submit / list payments ----------
for(const kind of ['booking','flight']){
  const base=kind==='booking'?'bookings':'flights';
  o.get(`/${base}/:ref/payments`,any,wrap(async(q,s)=>{
    const d=await loadFor(kind,q.params.ref);if(!d)return bad(s,'Not found',404);
    if(!isOwner(d,q)&&q.user.role==='customer')return bad(s,'Forbidden',403);
    const list=await Payment.find({[kind]:d._id}).sort('-createdAt').select('amount method reference status note rejectReason source createdAt verifiedAt');
    s.json({payments:list,state:R.paymentState(KIND[kind].total(d),list)});
  }));
  o.post(`/${base}/:ref/payments`,any,wrap(async(q,s)=>{
    const d=await loadFor(kind,q.params.ref);if(!d||!isOwner(d,q))return bad(s,'Not found',404);
    if(kind==='booking'&&d.status==='Cancelled')return bad(s,'Booking-kan waa la joojiyay');
    if(kind==='flight'&&!(d.status==='Quoted'&&d.quote>0))return bad(s,'Lacag-bixinta waxay furmaysaa marka qiimaha (quote) la diro');
    const pays=await paysOf(kind,d),max=R.payableNow(KIND[kind].total(d),pays);
    const input={amount:q.body.amount,method:q.body.method,reference:q.body.reference};
    const errs=R.validatePaymentInput(input,max,METHODS);if(errs.length)return bad(s,errs.join(' · '));
    const reference=str(q.body.reference,80);
    if(await dupRef(input.method,reference,['pending','paid']))return bad(s,'Reference-kan horey ayaa loo isticmaalay');
    const p=await Payment.create({[kind]:d._id,amount:R.round2(input.amount),method:input.method,reference,note:str(q.body.note,300),status:'pending',source:'customer',submittedBy:q.user._id});
    adminAlert(`Payment submitted ${d.ref}`,`<p>${esc(q.user.name)}: ${esc(input.method)} ref ${esc(reference)} — $${p.amount}. Verify it in the admin panel (Payments).</p>`);
    await audit(q,'payment.submit','Payment',p,{for:d.ref,amount:p.amount,method:p.method});
    s.json(p);
  }));
}

// ---------- ADMIN: payments (verify / reject / refund / record) ----------
o.get('/admin/payments',panel,wrap(async(q,s)=>{
  const f={};if(['pending','paid','rejected','refunded'].includes(q.query.status))f.status=q.query.status;
  s.json(await Payment.find(f).populate('booking','ref status total paymentStatus').populate('flight','ref status quote paymentStatus').populate('submittedBy','name email').sort('-createdAt').limit(300));
}));
async function parent(p){return p.booking?{kind:'booking',doc:await Booking.findById(p.booking)}:{kind:'flight',doc:await FlightRequest.findById(p.flight)}}
async function settle(q,s,p,kind,doc,action){
  const {st,before}=await recompute(kind,doc);
  await audit(q,action,'Payment',p,{for:doc.ref,amount:p.amount,method:p.method,reference:p.reference,paymentStatus:`${before}→${st.status}`});
  return st;
}
o.post('/admin/payments/:id/verify',money,wrap(async(q,s)=>{
  const p0=await Payment.findById(q.params.id);if(!p0)return bad(s,'Not found',404);
  if(p0.status!=='pending')return bad(s,'Lacagtan horey ayaa loo go\'aamiyay');
  const {kind,doc}=await parent(p0);if(!doc)return bad(s,'Booking/flight lama helin',404);
  if(await dupRef(p0.method,p0.reference,['paid'],p0._id))return bad(s,'Reference-kan horey ayaa loo xaqiijiyay lacag kale — baar');
  const amount=q.body.amount!==undefined&&q.body.amount!==''?R.round2(q.body.amount):p0.amount;
  const cur=R.paymentState(KIND[kind].total(doc),await paysOf(kind,doc));
  if(!(amount>0)||amount>cur.balance+R.EPS)return bad(s,`Lacagta xaqiijinta ma dhaafi karto haraaga (${cur.balance.toFixed(2)})`);
  // claim atomically so two admins cannot verify the same row twice
  const p=await Payment.findOneAndUpdate({_id:p0._id,status:'pending'},{status:'paid',amount,verifiedBy:q.user._id,verifiedByName:q.user.name,verifiedAt:new Date(),note:amount!==p0.amount?`${p0.note||''} [amount corrected ${p0.amount}→${amount}]`.trim():p0.note},{new:true});
  if(!p)return bad(s,'Lacagtan horey ayaa loo go\'aamiyay');
  const st=await settle(q,s,p,kind,doc,'payment.verify');
  const user=doc.user;
  tell(user,st.status==='paid'?'Payment confirmed':'Partial payment confirmed',`We verified $${amount} for ${doc.ref}. ${st.status==='paid'?'Fully paid — thank you!':`Remaining balance: $${st.balance}.`}`);
  s.json({payment:p,state:st});
}));
o.post('/admin/payments/:id/reject',money,wrap(async(q,s)=>{
  const reason=str(q.body.reason,200);if(reason.length<3)return bad(s,'Geli sababta diidmada');
  const p=await Payment.findOneAndUpdate({_id:q.params.id,status:'pending'},{status:'rejected',rejectReason:reason,verifiedBy:q.user._id,verifiedByName:q.user.name,verifiedAt:new Date()},{new:true});
  if(!p)return bad(s,'Lacagtan lama diidi karo (ma jirto ama horey loo go\'aamiyay)');
  const {kind,doc}=await parent(p);
  if(doc){await settle(q,s,p,kind,doc,'payment.reject');tell(doc.user,'Payment not verified',`We could not verify your payment for ${doc.ref}: ${reason}. Please re-submit with the correct reference.`)}
  s.json({payment:p});
}));
o.post('/admin/payments/:id/refund',money,wrap(async(q,s)=>{
  const reason=str(q.body.reason,200);if(reason.length<3)return bad(s,'Geli sababta soo-celinta');
  const p=await Payment.findOneAndUpdate({_id:q.params.id,status:'paid'},{status:'refunded',refundReason:reason,refundedAt:new Date()},{new:true});
  if(!p)return bad(s,'Kaliya lacag la xaqiijiyay ayaa la soo celin karaa');
  const {kind,doc}=await parent(p);
  let st=null;if(doc){st=await settle(q,s,p,kind,doc,'payment.refund');tell(doc.user,'Refund recorded',`A refund of $${p.amount} was recorded for ${doc.ref}.`)}
  s.json({payment:p,state:st,warning:p.source==='stripe'?'Lacagtan waxay ahayd Stripe: soo-celinta dhabta ah ku samee Stripe Dashboard. Halkan waa diiwaan kaliya.':'Diiwaan kaliya: lacagta dhabta ah gacanta ku celi (EVC/bank/cash).'});
}));
// Record money received outside the website (cash at the office, direct bank transfer). Counts immediately — accountant/admin only.
o.post('/admin/payments',money,wrap(async(q,s)=>{
  const {bookingRef,flightRef}=q.body,kind=bookingRef?'booking':flightRef?'flight':null;if(!kind)return bad(s,'Geli bookingRef ama flightRef');
  const d=await loadFor(kind,bookingRef||flightRef);if(!d)return bad(s,'Lama helin',404);
  if(kind==='booking'&&d.status==='Cancelled')return bad(s,'Booking-kan waa la joojiyay');
  if(kind==='flight'&&!(d.quote>0))return bad(s,'Marka hore quote geli');
  const cur=R.paymentState(KIND[kind].total(d),await paysOf(kind,d));
  const input={amount:q.body.amount,method:q.body.method,reference:q.body.reference};
  const errs=R.validatePaymentInput(input,cur.balance,METHODS);if(errs.length)return bad(s,errs.join(' · '));
  const reference=str(q.body.reference,80);
  if(await dupRef(input.method,reference,['pending','paid']))return bad(s,'Reference-kan horey ayaa loo isticmaalay');
  const p=await Payment.create({[kind]:d._id,amount:R.round2(input.amount),method:input.method,reference,note:str(q.body.note,300),status:'paid',source:'staff',submittedBy:q.user._id,verifiedBy:q.user._id,verifiedByName:q.user.name,verifiedAt:new Date()});
  const st=await settle(q,s,p,kind,d,'payment.record');
  tell(d.user,st.status==='paid'?'Payment confirmed':'Partial payment confirmed',`We recorded $${p.amount} for ${d.ref}.${st.status==='paid'?'':` Remaining: $${st.balance}.`}`);
  s.json({payment:p,state:st});
}));

// ---------- ADMIN: flight ticketing ----------
o.get('/admin/flights',panel,wrap(async(q,s)=>s.json(await FlightRequest.find().populate('user','name email phone').sort('-createdAt').limit(300))));
const cleanSegments=a=>(Array.isArray(a)?a:[]).slice(0,6).map(x=>({from:iata(x?.from),to:iata(x?.to),date:str(x?.date,10),airline:str(x?.airline,40),flightNo:R.normFlightNo(str(x?.flightNo,10)),departTime:str(x?.departTime,5),arriveTime:str(x?.arriveTime,5)}));
const PAX_TEXT=['title','firstName','lastName','dob','gender','nationality','passportNo','passportExpiry'];
o.patch('/admin/flights/:id',tixRole,wrap(async(q,s)=>{
  const f=await FlightRequest.findById(q.params.id);if(!f)return bad(s,'Not found',404);
  if(f.status==='Ticketed')return bad(s,'Ticket-ka la soo saaray lama bedeli karo. Haddii khalad jiro, "Void" samee.');
  const b=q.body,old=f.status,oldQuote=f.quote;
  if(b.quote!==undefined){
    const n=R.round2(b.quote);if(b.quote===''||b.quote===null){f.quote=undefined}
    else{if(!(n>0&&n<=1e6))return bad(s,'Quote ma sax aha');f.quote=n}
  }
  if(b.pnr!==undefined){const p=R.normPnr(b.pnr);if(p&&!R.PNR_RE.test(p))return bad(s,'PNR waa 5-8 xaraf/lambar');f.pnr=p||undefined}
  if(b.segments!==undefined)f.segments=cleanSegments(b.segments);
  if(Array.isArray(b.passengers)){
    b.passengers.slice(0,f.passengers.length).forEach((x,i)=>{
      if(!x)return;const t=f.passengers[i];
      for(const k of PAX_TEXT)if(x[k]!==undefined)t[k]=str(x[k],60);
      if(x.ticketNo!==undefined)t.ticketNo=x.ticketNo===''?undefined:R.normTicketNo(str(x.ticketNo,20));
    });
  }
  if(b.status!==undefined){
    if(b.status==='Ticketed')return bad(s,'Ticket-ka waxaa lagu soo saaraa batoonka "Issue ticket"');
    if(!['New','Quoted','Cancelled'].includes(b.status))return bad(s,'Status ma sax aha');
    f.status=b.status;
  }
  if(f.status==='New'&&f.quote>0&&b.status===undefined)f.status='Quoted';
  const pays=await paysOf('flight',f),st=R.paymentState(f.quote,pays);
  if(f.quote&&f.quote+R.EPS<st.paid)return bad(s,`Quote ma noqon karto ka yar lacagta la bixiyay (${st.paid})`);
  if(f.status==='Cancelled'&&old!=='Cancelled'&&R.cancelBlockedByMoney(st.paid))return bad(s,'Lacag la xaqiijiyay ayaa jirta — marka hore soo celi (refund) kadibna jooji');
  await f.save();await recompute('flight',f);
  if(f.status==='Cancelled'&&old!=='Cancelled')await Payment.updateMany({flight:f._id,status:'pending'},{status:'rejected',rejectReason:'Request cancelled'});
  if(f.status!==old)tell(f.user,'Flight '+f.status,`Your flight request ${f.ref} is now ${f.status}${f.status==='Quoted'&&f.quote?` — quote $${f.quote}`:''}.`);
  await audit(q,'flight.update','FlightRequest',f,{status:`${old}→${f.status}`,quote:`${oldQuote??'-'}→${f.quote??'-'}`});
  s.json(f);
}));
function ticketEmail(f,base){
  const seg=f.segments.map(x=>`<tr><td>${esc(x.from)} → ${esc(x.to)}</td><td>${esc(x.date)}</td><td>${esc(x.airline)} ${esc(x.flightNo)}</td><td>${esc(x.departTime)}–${esc(x.arriveTime)}</td></tr>`).join('');
  const pax=f.passengers.map(p=>`<li>${esc(p.title||'')} ${esc(p.firstName)} ${esc(p.lastName)} — ticket ${esc(p.ticketNo)}</li>`).join('');
  return tpl('Your e-ticket is ready',`<p>Booking reference: <b>${esc(f.ref)}</b> · Airline PNR: <b>${esc(f.pnr)}</b></p><table cellpadding="6" style="border-collapse:collapse;font-size:14px">${seg}</table><ul>${pax}</ul><p><a href="${esc(base)}/flights/${esc(f.ref)}">View / print your e-ticket</a> · <a href="${esc(base)}/verify/${esc(f.verifyCode)}">Verify</a></p><p style="font-size:12px;color:#666">Please arrive at the airport 3 hours before international departures and carry the passport used for this booking.</p>`);
}
o.post('/admin/flights/:id/issue',tixRole,wrap(async(q,s)=>{
  const f0=await FlightRequest.findById(q.params.id);if(!f0)return bad(s,'Not found',404);
  const st=R.paymentState(f0.quote,await paysOf('flight',f0));
  const errors=R.ticketIssueErrors(f0.toObject(),st);
  if(errors.length)return s.status(422).json({error:'Ticket lama soo saari karo: '+errors.join(' · '),errors});
  let f=null;
  for(let i=0;i<3&&!f;i++){
    try{
      f=await FlightRequest.findOneAndUpdate({_id:f0._id,status:{$in:['New','Quoted']}},{status:'Ticketed',verifyCode:crypto.randomBytes(9).toString('base64url'),ticketedAt:new Date(),ticketedByName:q.user.name,paymentStatus:st.status,paidAmount:st.paid,pnr:R.normPnr(f0.pnr)},{new:true});
      if(!f)return bad(s,'Ticket-kan horey ayaa loo beddelay — dib u soo dheji');
    }catch(e){if(e.code!==11000)throw e}
  }
  if(!f)return bad(s,'Dib isku day',500);
  await audit(q,'flight.issue','FlightRequest',f,{pnr:f.pnr,pax:f.passengers.length,segments:f.segments.length});
  const u=await User.findById(f.user);
  tell(f.user,'E-ticket issued',`Your e-ticket for ${f.ref} is ready. PNR ${f.pnr}.`);
  if(u&&!u.isDemo)sendMail(u.email,`E-ticket ${f.ref} — PNR ${f.pnr}`,ticketEmail(f,appUrl(q)));
  s.json(f);
}));
o.post('/admin/flights/:id/void',tixRole,wrap(async(q,s)=>{
  const reason=str(q.body.reason,200);if(reason.length<3)return bad(s,'Geli sababta (void)');
  const f=await FlightRequest.findOneAndUpdate({_id:q.params.id,status:'Ticketed'},{status:'Cancelled',voidedAt:new Date(),voidReason:reason},{new:true});
  if(!f)return bad(s,'Kaliya ticket la soo saaray ayaa la void gareyn karaa');
  await audit(q,'flight.void','FlightRequest',f,{reason});
  tell(f.user,'Ticket voided',`Your ticket for ${f.ref} was voided: ${reason}.`);
  s.json({flight:f,warning:f.paidAmount>0?'Lacag la bixiyay ayaa jirta — haddii loo baahdo, Payments ka samee refund.':''});
}));

// ---------- PUBLIC: ticket verification (no personal data leaked) ----------
o.get('/verify/:code',wrap(async(q,s)=>{
  const code=String(q.params.code||'');if(!/^[A-Za-z0-9_-]{8,32}$/.test(code))return s.status(404).json({valid:false});
  const f=await FlightRequest.findOne({verifyCode:code});if(!f)return s.status(404).json({valid:false});
  const voided=f.status!=='Ticketed';
  s.json({valid:!voided,status:voided?'VOIDED':'VALID',ref:f.ref,cabin:f.cabin,issuedAt:f.ticketedAt,demo:!!f.isDemo,
    passengers:f.passengers.map(p=>({name:R.maskName(p.firstName,p.lastName),type:p.type,ticket:R.lastN(p.ticketNo)})),
    segments:f.segments.map(x=>({from:x.from,to:x.to,date:x.date,airline:x.airline,flightNo:x.flightNo,departTime:x.departTime,arriveTime:x.arriveTime}))});
}));

// ---------- IMAGE UPLOAD (admin/staff) ----------
o.post('/admin/upload',catalog,express.raw({type:'image/*',limit:MAX_IMAGE}),wrap(async(q,s)=>{
  if(!Buffer.isBuffer(q.body)||!q.body.length)return bad(s,'Dooro sawir (JPG/PNG/WEBP/GIF)',415);
  const r=await saveImage(q.body);
  await audit(q,'upload','Image',{_id:undefined,ref:r.url},{storage:r.storage,bytes:q.body.length});
  s.json(r);
}));

// ---------- TEAM (admin only) + AUDIT ----------
const safeUser='-passwordHash -resetHash -resetExp -saved';
o.get('/admin/team',owner,wrap(async(q,s)=>s.json(await User.find({role:{$in:R.STAFF_ROLES}}).select(safeUser).sort('role name'))));
o.post('/admin/team',owner,wrap(async(q,s)=>{
  const {name,email,password,role}=q.body;
  if(!str(name,80)||!/^\S+@\S+\.\S+$/.test(email||'')||!R.STAFF_ROLES.includes(role))return bad(s,'Magac, email iyo role sax ah geli');
  const pw=R.passwordIssue(password,email);if(pw)return bad(s,pw);
  if(await User.findOne({email:String(email).toLowerCase()}))return bad(s,'Email horey ayaa loo isticmaalay');
  const u=await User.create({name:str(name,80),email,role,passwordHash:await bcrypt.hash(String(password),12)});
  await audit(q,'team.create','User',u,{email:u.email,role});
  s.json({id:u._id,name:u.name,email:u.email,role:u.role,status:u.status});
}));
o.patch('/admin/team/:id',owner,wrap(async(q,s)=>{
  if(String(q.params.id)===String(q.user._id))return bad(s,'Naftaada ma bedeli kartid');
  const u=await User.findOne({_id:q.params.id,role:{$in:R.STAFF_ROLES}});if(!u)return bad(s,'Not found',404);
  const was=`${u.role}/${u.status}`;
  if(q.body.role!==undefined){if(!R.STAFF_ROLES.includes(q.body.role))return bad(s,'Role ma sax aha');u.role=q.body.role}
  if(q.body.status!==undefined){if(!['active','suspended'].includes(q.body.status))return bad(s,'Status ma sax aha');u.status=q.body.status}
  const stillAdmin=await User.countDocuments({role:'admin',status:'active',_id:{$ne:u._id}});
  if(!stillAdmin&&!(u.role==='admin'&&u.status==='active'))return bad(s,'Waa inuu ugu yaraan hal admin firfircoon jiraa');
  u.tokenVersion=(u.tokenVersion||0)+1;await u.save();
  await audit(q,'team.update','User',u,{email:u.email,change:`${was}→${u.role}/${u.status}`});
  s.json({id:u._id,name:u.name,email:u.email,role:u.role,status:u.status});
}));
o.get('/admin/audit',owner,wrap(async(q,s)=>{
  const f={};if(q.query.action)f.action=new RegExp('^'+String(q.query.action).replace(/[^a-z.]/gi,''));
  s.json(await AuditLog.find(f).sort('-createdAt').limit(300));
}));
export default o;
