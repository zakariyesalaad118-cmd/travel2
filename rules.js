// Pure business rules — no database, no network. Everything here is unit-tested (server/tests/rules.test.js).
// Money is Number rounded to 2 decimals. Compare with EPS, never with ===.
export const EPS=0.005;
export const round2=n=>Math.round((Number(n)||0)*100+(Number(n)<0?-1e-9:1e-9))/100;
export const cents=n=>Math.round((Number(n)||0)*100);

// ---------- PAYMENTS ----------
// A payment row is {amount,status}. Only status 'paid' counts. 'pending' (customer says "I paid") NEVER counts.
// status 'refunded' = a previously paid row that was returned in full; it no longer counts.
export function paymentState(total,payments=[]){
  const T=round2(total);
  const paid=round2(payments.filter(p=>p.status==='paid').reduce((a,p)=>a+(Number(p.amount)||0),0));
  const pending=round2(payments.filter(p=>p.status==='pending').reduce((a,p)=>a+(Number(p.amount)||0),0));
  const refunded=round2(payments.filter(p=>p.status==='refunded').reduce((a,p)=>a+(Number(p.amount)||0),0));
  const balance=round2(Math.max(0,T-paid));
  let status='unpaid';
  if(paid>0&&paid+EPS<T)status='partial';
  else if(paid>0&&paid+EPS>=T)status='paid';
  else if(refunded>0)status='refunded';
  return {total:T,paid,pending,refunded,balance,status,overpaid:round2(Math.max(0,paid-T))};
}
// How much a customer may still submit as a new (pending) payment.
export const payableNow=(total,payments)=>{const s=paymentState(total,payments);return round2(Math.max(0,s.total-s.paid-s.pending))};
export function validatePaymentInput({amount,method,reference},max,methods){
  const errs=[],a=round2(amount);
  if(!(a>0))errs.push('Lacagta waa inay ka weyn tahay 0');
  else if(a>max+EPS)errs.push(`Lacagta ma dhaafi karto ${max.toFixed(2)}`);
  if(!methods.includes(method))errs.push('Habka lacag-bixinta ma sax aha');
  const ref=String(reference||'').trim();
  if(method!=='Cash'&&ref.length<4)errs.push('Geli transaction reference (4+ xaraf)');
  if(ref.length>80)errs.push('Reference aad buu u dheer yahay');
  return errs;
}

// ---------- BOOKING STATUS ----------
const NEXT={Pending:['Under Review','Confirmed','Cancelled'],'Under Review':['Pending','Confirmed','Cancelled'],Confirmed:['Completed','Cancelled'],Completed:[],Cancelled:[]};
export const canMoveBooking=(from,to)=>from===to||(NEXT[from]||[]).includes(to);
// Cancelling a booking that still holds real money is blocked until the money is refunded.
export const cancelBlockedByMoney=paid=>round2(paid)>EPS;

// ---------- FLIGHT TICKETING ----------
export const PNR_RE=/^[A-Z0-9]{5,8}$/;
export const TICKET_NO_RE=/^\d{3}-?\d{10}$/;           // standard IATA e-ticket: 3-digit airline code + 10 digits
export const FLIGHT_NO_RE=/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/;
export const normPnr=v=>String(v||'').toUpperCase().replace(/\s/g,'');
export const normTicketNo=v=>{const d=String(v||'').replace(/[\s-]/g,'');return /^\d{13}$/.test(d)?`${d.slice(0,3)}-${d.slice(3)}`:String(v||'').trim()};
export const normFlightNo=v=>String(v||'').toUpperCase().replace(/\s/g,'');
// Legs the customer asked for, plus the return leg for round trips. A ticket must have one segment per leg.
export function expectedLegs(f){
  const legs=(f.legs||[]).map(l=>({from:l.from,to:l.to,date:l.date}));
  if(f.tripType==='Round-trip'&&legs[0]&&f.returnDate)legs.push({from:legs[0].to,to:legs[0].from,date:f.returnDate});
  return legs;
}
const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
// Returns a list of human-readable problems. EMPTY LIST = ticket may be issued. We never invent PNRs / ticket numbers.
export function ticketIssueErrors(f,pay){
  const e=[];
  if(f.status==='Ticketed')return ['Ticket-kan horey ayaa loo soo saaray'];
  if(f.status==='Cancelled')return ['Codsigan waa la joojiyay'];
  if(!(Number(f.quote)>0))e.push('Geli qiimaha (quote) dhabta ah');
  if(!pay||pay.paid+EPS<round2(f.quote))e.push('Lacagta oo dhan weli lama xaqiijin (payment verified)');
  if(!PNR_RE.test(normPnr(f.pnr)))e.push('PNR sax ah ayaa loo baahan yahay (5-8 xaraf/lambar)');
  const pax=f.passengers||[];
  if(pax.length!==Number(f.pax))e.push(`Tirada rakaabka (${pax.length}) ma la mid aha ${f.pax}`);
  pax.forEach((p,i)=>{
    const n=`Rakaab ${i+1}`;
    if(!String(p.firstName||'').trim()||!String(p.lastName||'').trim())e.push(`${n}: magaca oo buuxa (sida passport-ka)`);
    if(!TICKET_NO_RE.test(String(p.ticketNo||'').trim()))e.push(`${n}: ticket number (13 lambar, tus. 176-1234567890)`);
  });
  const tn=pax.map(p=>normTicketNo(p.ticketNo)).filter(Boolean);
  if(new Set(tn).size!==tn.length)e.push('Ticket number-ka rakaabka ma ahaan karo mid isku mid ah');
  const want=expectedLegs(f),seg=f.segments||[];
  if(seg.length!==want.length)e.push(`Waxaa loo baahan yahay ${want.length} segment (hal mid safar kasta)`);
  else seg.forEach((s,i)=>{
    const n=`Segment ${i+1}`;
    if(s.from!==want[i].from||s.to!==want[i].to)e.push(`${n}: waa inuu noqdaa ${want[i].from}→${want[i].to}`);
    if(!String(s.airline||'').trim())e.push(`${n}: airline`);
    if(!FLIGHT_NO_RE.test(normFlightNo(s.flightNo)))e.push(`${n}: flight number sax ah (tus. EK722)`);
    if(!TIME_RE.test(String(s.departTime||'')))e.push(`${n}: depart time HH:MM`);
    if(!TIME_RE.test(String(s.arriveTime||'')))e.push(`${n}: arrive time HH:MM`);
    if(!s.date||isNaN(new Date(s.date)))e.push(`${n}: taariikh`);
  });
  return e;
}
// Public verification page must not leak personal data.
export const maskName=(first,last)=>{const m=x=>{x=String(x||'').trim();return x?x[0].toUpperCase()+'*'.repeat(Math.min(Math.max(x.length-1,2),6)):''};return `${m(first)} ${m(last)}`.trim()};
export const lastN=(v,n=4)=>{v=String(v||'');return v?'•••'+v.slice(-n):''};

// ---------- PASSWORDS / LOGIN LOCKOUT ----------
const COMMON=new Set(['password','password1','password123','12345678','123456789','1234567890','qwertyui','qwerty123','11111111','iloveyou','admin123','changeme123','changeme123!','welcome1','letmein123','somtrevel','somtrevel123']);
export function passwordIssue(p,email=''){
  p=String(p||'');
  if(p.length<8)return 'Password 8+ xaraf';
  if(p.length>128)return 'Password aad buu u dheer yahay';
  if(!/[A-Za-z]/.test(p)||!/\d/.test(p))return 'Password waa inuu leeyahay xaraf iyo lambar';
  if(COMMON.has(p.toLowerCase()))return 'Password-kan aad buu u fudud yahay';
  const local=String(email).split('@')[0].toLowerCase();
  if(local.length>=4&&p.toLowerCase().includes(local))return 'Password-ku ha ka koobnaanin email-kaaga';
  return '';
}
export const MAX_FAILS=5,LOCK_MS=15*60*1000;
export const isLocked=(u,now=Date.now())=>!!u.lockUntil&&new Date(u.lockUntil).getTime()>now;
// returns the fields to $set after a failed login
export function afterFailedLogin(u,now=Date.now()){
  const expired=u.lockUntil&&new Date(u.lockUntil).getTime()<=now;
  const n=(expired?0:u.failedLogins||0)+1;
  return n>=MAX_FAILS?{failedLogins:0,lockUntil:new Date(now+LOCK_MS)}:{failedLogins:n,lockUntil:undefined};
}

// ---------- IMAGE UPLOAD ----------
// Trust the bytes, never the Content-Type header. SVG is deliberately NOT allowed (script injection).
export function sniffImage(b){
  if(!b||b.length<12)return null;
  if(b[0]===0xFF&&b[1]===0xD8&&b[2]===0xFF)return {ext:'jpg',mime:'image/jpeg'};
  if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4E&&b[3]===0x47&&b[4]===0x0D&&b[5]===0x0A&&b[6]===0x1A&&b[7]===0x0A)return {ext:'png',mime:'image/png'};
  if(b.slice(0,4).toString('latin1')==='RIFF'&&b.slice(8,12).toString('latin1')==='WEBP')return {ext:'webp',mime:'image/webp'};
  if(b.slice(0,4).toString('latin1')==='GIF8')return {ext:'gif',mime:'image/gif'};
  return null;
}

// ---------- ROLES ----------
export const ROLES=['customer','staff','ticketing','accountant','admin'];
export const STAFF_ROLES=['admin','staff','ticketing','accountant'];
// who may do what (admin may do everything)
export const CAN={
  panel:['admin','staff','ticketing','accountant'],
  catalog:['admin','staff'],
  bookings:['admin','staff'],
  ticketing:['admin','staff','ticketing'],
  money:['admin','accountant'],
};
