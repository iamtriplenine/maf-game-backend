import crypto from 'node:crypto';
export const REFERRAL_TTL_MS=30*60*1000;
export const REFERRAL_CODE=/^MAF-[A-F0-9]{24}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>Object.assign(new Error(message),{status:400});
function secret(){const value=process.env.TOKEN_SECRET||'';if(value.length<32)throw Object.assign(new Error('Le parrainage est temporairement indisponible.'),{status:503});return value;}
const signature=payload=>crypto.createHmac('sha256',secret()).update('maf-referral-signup|'+payload).digest('base64url');
export function referralCode(value){if(typeof value!=='string'||!REFERRAL_CODE.test(value))throw fail('Lien de parrainage invalide.');return value;}
export function issueReferralProof(inviteId,now=Date.now()){
 if(!UUID.test(inviteId))throw fail('Invitation invalide.');
 const expires=now+REFERRAL_TTL_MS;
 const payload=Buffer.from(JSON.stringify({purpose:'maf-referral-signup-v1',invite_id:inviteId,exp:expires})).toString('base64url');
 return{proof:payload+'.'+signature(payload),expires_at:new Date(expires).toISOString()};
}
export function readReferralProof(proof,now=Date.now()){
 if(typeof proof!=='string'||proof.length>2048)throw fail('Lien de parrainage invalide.');
 const parts=proof.split('.');
 if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_-]+$/.test(x)))throw fail('Lien de parrainage invalide.');
 const expected=Buffer.from(signature(parts[0])),given=Buffer.from(parts[1]);
 if(expected.length!==given.length||!crypto.timingSafeEqual(expected,given))throw fail('Lien de parrainage invalide.');
 let data;try{data=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw fail('Lien de parrainage invalide.');}
 if(data?.purpose!=='maf-referral-signup-v1'||typeof data.invite_id!=='string'||!UUID.test(data.invite_id)||!Number.isSafeInteger(data.exp)||data.exp>now+REFERRAL_TTL_MS)throw fail('Lien de parrainage invalide.');
 if(data.exp<=now)throw fail('Ce lien d’inscription a expiré. Actualise le lien de parrainage.');
 return data.invite_id;
}
export function registrationReferral(body){
 const forbidden=['referral_code','referralCode','referral','referrer','referrer_id','partner_id','partnerId','sponsor','sponsor_id','sponsorId','parrainage','parrain','parrain_id','invite_code','inviteCode','invitation_id','referral_partner_id'];
 if(forbidden.some(k=>Object.prototype.hasOwnProperty.call(body||{},k)))throw fail('Utilise le lien de parrainage : aucun code ne peut être saisi manuellement.');
 if(!Object.prototype.hasOwnProperty.call(body||{},'referral_proof'))return undefined;
 if(typeof body.referral_proof!=='string'||!body.referral_proof||body.referral_proof.length>2048)throw fail('Lien de parrainage invalide.');
 return body.referral_proof;
}
