const fail = message => Object.assign(new Error(message),{status:400});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function partnerAccountId(value) {
  if(typeof value!=='string'||! /^[1-9]\d*$/.test(value))throw fail('Compte invalide.');
  const id=Number(value);
  if(!Number.isSafeInteger(id)||id>2147483647)throw fail('Compte invalide.');
  return id;
}
export function partnerSearch(query={}) {
  if(query.q!==undefined&&typeof query.q!=='string')throw fail('Recherche invalide.');
  const q=String(query.q||'').trim();
  if(q.length>40)throw fail('Recherche limitee a 40 caracteres.');
  const raw=query.offset===undefined?'0':query.offset;
  if(typeof raw!=='string'||! /^(0|[1-9]\d*)$/.test(raw))throw fail('Page invalide.');
  const offset=Number(raw);
  if(!Number.isSafeInteger(offset)||offset>1000000)throw fail('Page invalide.');
  return {q:q.toLowerCase(),offset,limit:30};
}
export function partnerRoleChange(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['active','expected_role','request_key'].includes(k)))throw fail('Modification de statut invalide.');
  if(typeof body.active!=='boolean'||!['player','partner'].includes(body.expected_role)||typeof body.request_key!=='string'||!UUID.test(body.request_key))throw fail('Modification de statut invalide.');
  return {active:body.active,expectedRole:body.expected_role,requestKey:body.request_key.toLowerCase(),desiredRole:body.active?'partner':'player'};
}
