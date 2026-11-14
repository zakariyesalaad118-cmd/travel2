import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import {fileURLToPath} from 'url';
import api from './routes.js';
import {seedIfEmpty} from './seed.js';
import {stripeWebhook} from './payments.js';
import {sweepHolds} from './ops.js';
import {UPLOAD_DIR} from './upload.js';
process.on('unhandledRejection',e=>console.error('unhandledRejection',e));
process.on('uncaughtException',e=>console.error('uncaughtException',e));
if(!process.env.MONGODB_URI||!process.env.JWT_SECRET||process.env.JWT_SECRET.length<16){console.error('Set MONGODB_URI and a JWT_SECRET of 16+ chars');process.exit(1)}
const app=express();
app.set('trust proxy',1);
// referrerPolicy: map tiles (OpenStreetMap) waxay u baahan yihiin Referer
// CSP: scripts only from our own origin. Images may come from any https host (Unsplash, OSM tiles, Cloudinary); Google Maps embed is the only allowed frame.
app.use(helmet({contentSecurityPolicy:{useDefaults:false,directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["'self'","https://fonts.gstatic.com","data:"],imgSrc:["'self'","data:","blob:","https:"],connectSrc:["'self'"],frameSrc:["https://www.google.com"],frameAncestors:["'none'"],objectSrc:["'none'"],baseUri:["'self'"],formAction:["'self'"]}},referrerPolicy:{policy:'strict-origin-when-cross-origin'}}),compression());
app.post('/api/payments/stripe-webhook',express.raw({type:'application/json'}),stripeWebhook);
app.use(express.json({limit:'1mb'}),cookieParser());
// CSRF: cookies are SameSite=Lax AND every state-changing request must carry a custom header (a cross-site form/image cannot set it).
app.use('/api',(q,s,n)=>['POST','PUT','PATCH','DELETE'].includes(q.method)&&q.get('x-requested-with')!=='somtrevel'?s.status(403).json({error:'Request blocked'}):n());
app.use('/api',rateLimit({windowMs:9e5,max:800}));
app.use('/api/verify',rateLimit({windowMs:9e5,max:60}));
app.use('/api/admin/upload',rateLimit({windowMs:9e5,max:60}));
app.use('/api/auth',rateLimit({windowMs:9e5,max:40}));
app.use('/api',api);
app.use('/uploads',express.static(UPLOAD_DIR,{maxAge:'30d',immutable:true,index:false}));
const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'../client/dist');
app.use(express.static(dist,{maxAge:'1h'}));
app.get('*',(q,s)=>s.sendFile(path.join(dist,'index.html'),e=>e&&s.status(503).send('Frontend not built. Run: npm run build')));
try{await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000})}catch(e){console.error('MongoDB connection failed:',e.message);process.exit(1)}
await seedIfEmpty();
sweepHolds();setInterval(sweepHolds,36e5).unref();
app.listen(process.env.PORT||5000,()=>console.log('SOM TREVEL running'));
