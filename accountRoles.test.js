import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRole, isOwnerAccount, ownerAccountId, privilegedRegistration, ensureAccountRoles } from './accountRoles.js';

const fixture = (id=42, failCommit=false) => {
  const calls=[];
  const c={
    async query(sql) {
      calls.push(sql);
      if (failCommit && sql==='COMMIT') throw new Error('Connection lost');
      return { rows: sql.includes('SELECT o.owner_user_id') ? [{owner_user_id:id}] : [] };
    },
    release(){calls.push('RELEASE');}
  };
  return { calls, c, connect:async()=>c };
};

test('only the pinned internal ID is owner, never the pseudo or a supplied owner role',async()=>{
  const db=fixture();await ensureAccountRoles(db);
  assert.equal(accountRole({id:42,pseudo:'renamed-owner'}),'owner');
  assert.equal(accountRole({id:7,pseudo:'999',account_role:'owner'}),'player');
  assert.equal(accountRole({id:7,account_role:'partner'}),'partner');
  assert.equal(accountRole({id:7}),'player');
  assert.equal(accountRole(null),'player');
  assert.equal(await isOwnerAccount(42,db.c),true);
  assert.equal(await isOwnerAccount(7,db.c),false);
  assert.equal(await isOwnerAccount('42',db.c),false);
  assert.equal(await isOwnerAccount(-1,db.c),false);
});

test('ordinary registration is allowed; every privilege field is refused even when false',()=>{
  assert.equal(privilegedRegistration({pseudo:'player',code:'1234567890'}),false);
  for(const key of ['role','account_role','is_owner','isOwner','owner_id','owner_user_id','permissions']){
    assert.equal(privilegedRegistration({pseudo:'player',[key]:false}),true,key);
  }
});

test('owner lookup fails closed when the pinned account is missing',async()=>{
  const db={query:async()=>({rows:[]})};
  await assert.rejects(ownerAccountId(db),{status:503});
  await assert.rejects(isOwnerAccount(42,db),{status:503});
});

test('migration rolls back and releases the connection when it cannot commit',async()=>{
  const db=fixture(99,true);
  await assert.rejects(ensureAccountRoles(db),/Connection lost/);
  assert.equal(db.calls.at(-2),'ROLLBACK');
  assert.equal(db.calls.at(-1),'RELEASE');
  assert.notEqual(accountRole({id:99}),'owner');
});

test('migration never leaves a partial owner identity when the legacy account is absent',async()=>{
  const db=fixture(undefined);db.c.query=async(sql)=>{db.calls.push(sql);return{rows:[]};};
  await assert.rejects(ensureAccountRoles(db),{status:503});
  assert.ok(!db.calls.includes('COMMIT'));
  assert.deepEqual(db.calls.slice(-2),['ROLLBACK','RELEASE']);
});
