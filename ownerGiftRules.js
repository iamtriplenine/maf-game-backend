import { selectedTournamentSkin } from './studioSkinCatalog.js';

export const OWNER_GIFT_KINDS = Object.freeze(['coupon','skin','background','image','balance','bonus']);
export const OWNER_BACKGROUND_IDS = Object.freeze(['matrix-rain','classic']);
export const MAX_GIFT_LOTS = 5;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function validateGiftLot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Lot invalide.');
  const kind=body.kind;
  if (!OWNER_GIFT_KINDS.includes(kind)) fail('Type de lot inconnu.');
  const payload={};
  if(['balance','bonus','coupon'].includes(kind)) {
    if(!Number.isSafeInteger(body.amount)||body.amount<1||body.amount>1000000)
      fail('Montant entier entre 1 et 1 000 000 F requis.');
    payload.amount=body.amount;
  }
  if(kind==='coupon') {
    if(!['F','V'].includes(body.currency)) fail('Coupon : choisir solde réel ou bonus.');
    payload.currency=body.currency;
  }
  if(kind==='skin') {
    try{payload.skinId=selectedTournamentSkin(body.skinId);}catch(e){fail(e.message);}
    if(!payload.skinId)fail('Sélectionner un skin exclusif.');
  }
  if(kind==='background') {
    if(!OWNER_BACKGROUND_IDS.includes(body.backgroundId))fail('Arrière-plan inconnu.');
    payload.backgroundId=body.backgroundId;
  }
  if(kind==='image') {
    const image=body.imageData;
    if(typeof image!=='string' || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(image))fail('Image PNG, JPEG ou WebP obligatoire.');
    if(image.length>650000)fail('Image trop lourde (environ 450 Ko maximum).');
    const bytes=Buffer.from(image.split(',')[1],'base64');
    if(bytes.length===0 || bytes.length>480000)fail('Image trop lourde.');
    payload.imageData=image;
  }
  return {kind,...payload};
}

export function validateOwnerGift(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Cadeau invalide.');
  const title=String(body.title ?? '').trim();
  if (title.length < 3 || title.length > 80) fail('Titre : entre 3 et 80 caractères.');
  const message=String(body.message ?? '').trim();
  if (message.length > 300) fail('Message trop long (300 caractères maximum).');
  const targetMode=body.targetMode;
  if (!['all','pseudo','clientId'].includes(targetMode)) fail('Destinataire invalide.');
  const targetValue=targetMode==='all' ? '' : String(body.targetValue??'').trim();
  if(targetMode==='pseudo' && (targetValue.length<3 || targetValue.length>20)) fail('Pseudo invalide.');
  if(targetMode==='clientId' && !/^\d{5}$/.test(targetValue)) fail('Identifiant client à cinq chiffres requis.');
  if(body.lots!==undefined) {
    if(!Array.isArray(body.lots)||body.lots.length<2||body.lots.length>MAX_GIFT_LOTS)fail('Un coffre multiple contient de 2 à 5 lots.');
    const lots=body.lots.map(validateGiftLot);
    // Les images sont stockées une fois par cadeau, et non dupliquées par joueur.
    if(Buffer.byteLength(JSON.stringify(lots),'utf8')>1100000)fail('Taille totale des lots trop importante.');
    return {kind:'bundle',title,message,targetMode,targetValue,payload:{lots}};
  }
  const one=validateGiftLot(body);
  const {kind,...payload}=one;
  return {kind,title,message,targetMode,targetValue,payload};
}

export function summarizeOwnerGift(row){
  const p=row.payload||{};
  const lots=row.kind==='bundle' && Array.isArray(p.lots)
    ?p.lots.map(l=>({kind:l.kind,amount:l.amount??null,currency:l.currency??null,skinId:l.skinId??null,backgroundId:l.backgroundId??null}))
    :null;
  return {id:Number(row.id),title:row.title,message:row.message||'',kind:row.kind,
    createdAt:row.created_at,revokedAt:row.revoked_at,recipientCount:Number(row.recipient_count??0),
    openedCount:Number(row.opened_count??0),lotCount:lots?.length||1,lots,
    amount:p.amount||null,currency:p.currency||null,skinId:p.skinId||null,
    backgroundId:p.backgroundId||null,
    imageData:row.kind==='image'?p.imageData:null};
}
