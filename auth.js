import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {User,AuditLog} from './models.js';
export const wrap=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(n);
export const bad=(s,m,c=400)=>s.status(c).json({error:m});
export const mkRef=p=>`${p}-${Date.now().toString(36).toUpperCase()}${crypto.randomInt(100,999)}`;
export const sha=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
export const appUrl=q=>process.env.APP_URL||`${q.protocol}://${q.get('host')}`;
// Cookie carries the user id AND tokenVersion: changing a password / suspending a user bumps tokenVersion, killing old sessions.
export const cookie=(s,u)=>s.cookie('t',jwt.sign({id:u._id,v:u.tokenVersion||0},process.env.JWT_SECRET,{expiresIn:'7d'}),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:6048e5});
export const auth=roles=>async(q,s,n)=>{
  let u;
  try{
    const p=jwt.verify(q.cookies.t,process.env.JWT_SECRET);
    u=await User.findById(p.id);
    if(!u||u.status!=='active'||(p.v||0)!==(u.tokenVersion||0))u=null;
  }catch{u=null}
  if(!u)return bad(s,'Login required',401);
  if(roles&&!roles.includes(u.role))return bad(s,'Forbidden',403);
  q.user=u;n();
};
export const pub=u=>({id:u._id,name:u.name,email:u.email,phone:u.phone,role:u.role});
// Every sensitive action (money, tickets, roles, deletions) writes an audit row. Never throws.
export async function audit(q,action,entity,doc,detail){
  try{await AuditLog.create({actor:q.user?._id,actorName:q.user?.name,role:q.user?.role,action,entity,entityId:doc?._id,ref:doc?.ref||doc?.reference,detail,ip:q.ip})}
  catch(e){console.error('audit',e.message)}
}
