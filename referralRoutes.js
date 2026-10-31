import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable } from './auth.js';
import { resolveInvitation } from './referrals.js';
export const referralRouter=Router();
referralRouter.get('/referrals/resolve',async(req,res,next)=>{
 res.set('Cache-Control','no-store');
 try{await ensureTable();res.json(await resolveInvitation(pool,req.query.code));}
 catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});
