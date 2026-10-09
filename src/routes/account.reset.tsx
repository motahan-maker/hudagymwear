import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { pageHead } from '@/lib/catalog';
import { updatePassword, isDemoMode } from '@/lib/account';
import { getSupabase } from '@/lib/supabase';
import { Breadcrumbs } from '@/components/breadcrumbs';
export const Route=createFileRoute('/account/reset')({head:()=>pageHead('Choose a New Password','Set a new password for your HUDA GYMWEAR account.'),component:Reset});

type Status = 'checking' | 'ready' | 'expired';

function Reset(){
 const navigate=useNavigate();
 const [status,setStatus]=useState<Status>('checking');
 const [expiredReason,setExpiredReason]=useState('');
 const [next,setNext]=useState('');const [again,setAgain]=useState('');
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 // A recovery link carries ?code= (PKCE) or ?error= (expired/denied). Only
 // render the form once a real recovery session exists — otherwise the
 // update fails with a cryptic "Auth session missing".
 useEffect(()=>{
  const sb=getSupabase();
  if(!sb){setStatus('expired');return;}
  const params=new URLSearchParams(window.location.search);
  const err=params.get('error');
  if(err){
   setExpiredReason(params.get('error_description')?.replace(/\+/g,' ')||'This reset link is invalid.');
   setStatus('expired');
   return;
  }
  let live=true;
  sb.auth.getSession().then(({data})=>{if(live&&data.session)setStatus('ready');});
  const {data:{subscription}}=sb.auth.onAuthStateChange((ev, session)=>{if(live&&(ev==='PASSWORD_RECOVERY'||(ev==='SIGNED_IN'&&!!session)))setStatus('ready');});
  // If no session arrives shortly, the link is expired or already used.
  const t=window.setTimeout(()=>{if(live)setStatus((s)=>{if(s==='checking'){setExpiredReason('This reset link has expired or was already used.');return 'expired';}return s;});},4000);
  return ()=>{live=false;window.clearTimeout(t);subscription.unsubscribe();};
 },[]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy||status!=='ready')return;setError('');
  if(next!==again){setError('Passwords do not match.');return;}
  setBusy(true);
  const r=await updatePassword(next);
  setBusy(false);
  if(r.error)setError(r.error);
  else{toast.success('Password updated — please sign in.');navigate({to:'/account'});}
 }
 if(isDemoMode())return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>New password</h1><p>To update your password, sign in and manage your credentials from Account → Security.</p></div><div className="account-box"><Button variant="fashion" asChild><Link to="/account">BACK TO YOUR ACCOUNT</Link></Button></div></>;
 if(status==='checking')return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Checking your link…</h1><p>One moment while we verify your reset link.</p></div></>;
 if(status==='expired')return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Link expired</h1><p>{expiredReason||'This reset link has expired or was already used.'} Request a fresh one from the sign-in page.</p></div><div className="account-box"><Button variant="fashion" asChild><Link to="/account">BACK TO SIGN IN</Link></Button></div></>;
 return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Choose a new password</h1><p>Make it strong — at least 6 characters.</p></div><div className="account-box"><form onSubmit={submit}><label className="form-field">New password<input type="password" value={next} onChange={e=>setNext(e.target.value)} autoComplete="new-password" placeholder="••••••••"/></label><label className="form-field">Confirm new password<input type="password" value={again} onChange={e=>setAgain(e.target.value)} autoComplete="new-password" placeholder="••••••••"/></label>{error&&<p className="field-error" role="alert">{error}</p>}<Button variant="fashion" type="submit" disabled={busy}>{busy?'SAVING…':'SET NEW PASSWORD'}</Button></form></div></>;
}
