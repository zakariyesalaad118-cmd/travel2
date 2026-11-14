import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {fileURLToPath} from 'url';
import {sniffImage} from './rules.js';
export const UPLOAD_DIR=process.env.UPLOAD_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'uploads');
export const MAX_IMAGE=5*1024*1024;
async function toCloudinary(buf,mime,ext){
  const m=String(process.env.CLOUDINARY_URL).match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if(!m)throw new Error('CLOUDINARY_URL format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME');
  const [,key,secret,cloud]=m,timestamp=Math.floor(Date.now()/1000),folder='somtrevel';
  const signature=crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
  const fd=new FormData();
  fd.append('file',new Blob([buf],{type:mime}),`upload.${ext}`);
  fd.append('api_key',key);fd.append('timestamp',String(timestamp));fd.append('folder',folder);fd.append('signature',signature);
  const r=await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`,{method:'POST',body:fd});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error?.message||'Cloudinary upload failed');
  return d.secure_url;
}
// Validates by magic bytes, then stores on Cloudinary (if CLOUDINARY_URL is set) or on local disk.
export async function saveImage(buf){
  const t=sniffImage(buf);
  if(!t)throw Object.assign(new Error('Sawirka waa inuu noqdaa JPG, PNG, WEBP ama GIF'),{status:415,expose:true});
  if(buf.length>MAX_IMAGE)throw Object.assign(new Error('Sawirka aad buu u weyn yahay (max 5MB)'),{status:413,expose:true});
  if(process.env.CLOUDINARY_URL)return {url:await toCloudinary(buf,t.mime,t.ext),storage:'cloudinary'};
  await fs.mkdir(UPLOAD_DIR,{recursive:true});
  const name=`${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${t.ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR,name),buf,{flag:'wx'});
  return {url:`/uploads/${name}`,storage:'local'};
}
