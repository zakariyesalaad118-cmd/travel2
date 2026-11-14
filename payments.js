import crypto from 'crypto';
import {Booking,Payment} from './models.js';
import {tell,adminAlert,esc} from './mail.js';
import {recompute} from './ops.js';
import {paymentState,EPS} from './rules.js';
export const stripeOn=()=>!!process.env.STRIPE_SECRET_KEY&&!!process.env.STRIPE_WEBHOOK_SECRET;
// Charges the REMAINING balance (so partial payments + card work together).
export async function createCheckout(b,base,balance){
  const amount=Math.round((balance??b.total)*100);
  const p=new URLSearchParams({mode:'payment',success_url:`${base}/invoice/${b.ref}?paid=1`,cancel_url:`${base}/invoice/${b.ref}`,client_reference_id:b.ref,'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(amount),'line_items[0][price_data][product_data][name]':`${b.packageTitle} (${b.ref})`.slice(0,200)});
  const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:p});
  const d=await r.json();if(!r.ok)throw new Error(d.error?.message||'Stripe error');return d;
}
// A card payment becomes a Payment row (status paid) ONLY when a correctly-signed Stripe webhook arrives.
// The row is idempotent (unique on Stripe reference) and can never push the booking above its total.
export async function stripeWebhook(req,res){
  try{
    const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret)return res.status(503).end();
    const parts=Object.fromEntries(String(req.headers['stripe-signature']||'').split(',').map(x=>x.split('=')));
    const raw=req.body.toString('utf8');
    const exp=Buffer.from(crypto.createHmac('sha256',secret).update(`${parts.t}.${raw}`).digest('hex')),got=Buffer.from(String(parts.v1||''));
    if(exp.length!==got.length||!crypto.timingSafeEqual(exp,got)||Math.abs(Date.now()/1000-Number(parts.t))>600)return res.status(400).end();
    const ev=JSON.parse(raw),s=ev.data?.object;
    if(ev.type==='checkout.session.completed'&&s?.payment_status==='paid'){
      const b=await Booking.findOne({ref:s.client_reference_id}),ref=String(s.payment_intent||s.id);
      if(b&&s.currency==='usd'&&s.amount_total>0&&!(await Payment.exists({source:'stripe',reference:ref}))){
        const amt=s.amount_total/100,st=paymentState(b.total,await Payment.find({booking:b._id}).lean());
        if(amt<=st.balance+EPS){
          try{await Payment.create({booking:b._id,amount:amt,method:'Card (Stripe)',reference:ref,status:'paid',source:'stripe',verifiedAt:new Date(),verifiedByName:'Stripe webhook'})}
          catch(e){if(e.code===11000)return res.json({received:true});throw e}
          const n=await recompute('booking',b);
          await tell(b.user,'Payment received',`We received $${amt} for booking ${b.ref}.${n.st.status==='paid'?' Thank you!':` Remaining: $${n.st.balance}.`}`);
          await adminAlert('Card payment received',`<p>Booking ${esc(b.ref)}: $${amt} (${esc(n.st.status)})</p>`);
        }else await adminAlert('Stripe payment NEEDS MANUAL REVIEW',`<p>Booking ${esc(b.ref)}: Stripe charged $${amt} but only $${st.balance} was outstanding. Reference ${esc(ref)}. No payment row was created.</p>`);
      }
    }
    res.json({received:true});
  }catch(e){console.error('webhook',e.message);res.status(400).end()}
}
