import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { REFERRAL_TTL_MS,referralCode,issueReferralProof,readReferralProof,registrationReferral } from './referralProof.js';
process.env.TOKEN_SECRET='unit-referral-secret-'.repeat(3);
const id='12345678-1234-4234-8234-123456789abc',now=1700000000000,code='MAF-'+'AB12'.repeat(6);
test('Une preuve emise par le serveur rattache uniquement son invitation',()=>{
 const result=issueReferralProof(id,now);assert.equal(readReferralProof(result.proof,now+1),id);assert.equal(Date.parse(result.expires_at),now+REFERRAL_TTL_MS);
});
test('Une preuve expiree est refusee, y compris a la limite exacte',()=>{
 const{proof}=issueReferralProof(id,now);assert.throws(()=>readReferralProof(proof,now+REFERRAL_TTL_MS),{status:400});
});
test('Un code brut, une signature modifiee et une preuve mal formee sont refuses',()=>{
 const{proof}=issueReferralProof(id,now);
 for(const token of [code,proof+'x',proof+'.extra','',null,'x'.repeat(2049)])assert.throws(()=>readReferralProof(token,now),{status:400});
});
test('Une preuve pour un autre usage ne peut pas servir a inscrire un filleul',()=>{
 const payload=Buffer.from(JSON.stringify({purpose:'maf-session',invite_id:id,exp:now+1000})).toString('base64url');
 const signature=crypto.createHmac('sha256',process.env.TOKEN_SECRET).update('maf-referral-signup|'+payload).digest('base64url');
 assert.throws(()=>readReferralProof(payload+'.'+signature,now),{status:400});
});
test('Une cle absente ou trop courte ne produit pas de preuve',()=>{
 const old=process.env.TOKEN_SECRET;process.env.TOKEN_SECRET='short';
 try{assert.throws(()=>issueReferralProof(id,now),{status:503});}finally{process.env.TOKEN_SECRET=old;}
});
test('Une inscription normale reste possible sans donnees de parrainage',()=>{
 assert.equal(registrationReferral({pseudo:'normal',code:'1234567890'}),undefined);
 assert.equal(registrationReferral({referral_proof:'proof'}),'proof');
});
test('Aucun code ou ID saisi manuellement ne peut imposer un parrain',()=>{
 for(const key of ['referral_code','partner_id','parrainage','parrain_id','invite_code','invitation_id'])assert.throws(()=>registrationReferral({[key]:code}),{status:400});
 for(const value of ['',null,42,{}])assert.throws(()=>registrationReferral({referral_proof:value}),{status:400});
});
test('Seuls les codes generes pour les liens sont acceptes',()=>{
 assert.equal(referralCode(code),code);
 for(const value of ['',code.toLowerCase(),code+'x',[code],42])assert.throws(()=>referralCode(value),{status:400});
});
