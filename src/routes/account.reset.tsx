import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { pageHead } from '@/lib/catalog';
import { updatePassword, logout, isDemoMode } from '@/lib/account';
import { getSupabase } from '@/lib/supabase';
import { Breadcrumbs } from '@/components/breadcrumbs';
export const Route=createFileRoute('/account/reset')({head:()=>pageHead('Choose a New Password','Set a new password for your HUDA GYMWEAR account.'),component:Reset});

type Status = 'checking' | 'ready' | 'expired';

function Reset(){
 const navigate=useNavigate();
 const [status,setStatus]=useState<Status>('checking');
 const [expiredReason,setExpiredReason]=useState('');
 const [next,setNext]=useState('');const [again,setAgain]=useState('');
 const [showNext,setShowNext]=useState(false);const [showAgain,setShowAgain]=useState(false);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);

 const passLength = next.length >= 8;
 const passHasLetter = /[a-zA-Z]/.test(next);
 const passHasNumber = /\d/.test(next);

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
  // Check if link carries recovery token in query or hash fragment
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = params.get("code");
  const hasToken = !!code || params.has("token") || hashParams.has("access_token") || hashParams.get("type") === "recovery";
  
  if (hasToken) {
    // Show form immediately if recovery token/params are present in URL
    setStatus("ready");
  }

  // If Supabase uses PKCE (?code=...), exchange it immediately for a valid session
  if (code) {
    sb.auth.exchangeCodeForSession(code).then(({ data, error }) => {
      if (!error && data.session && live) {
        setStatus("ready");
      }
    }).catch(() => {/* handled by auth listener */});
  }

  sb.auth.getSession().then(({data})=>{
    if(live && data.session) setStatus("ready");
  });

  const {data:{subscription}}=sb.auth.onAuthStateChange((ev, session)=>{
    if(live && (ev==='PASSWORD_RECOVERY' || ev==='USER_UPDATED' || (ev==='SIGNED_IN'&&!!session))) {
      setStatus("ready");
    }
  });

  const t=window.setTimeout(()=>{
    if(live) {
      setStatus((s)=>{
        if(s==='checking') {
          // If we have token in URL, allow them to attempt password reset rather than failing
          if(hasToken) return "ready";
          setExpiredReason("This reset link has expired or was already used.");
          return "expired";
        }
        return s;
      });
    }
  }, 3000);
  return ()=>{live=false;window.clearTimeout(t);subscription.unsubscribe();};
 },[]);

  async function submit(e:React.FormEvent){
   e.preventDefault();if(busy||status!=='ready')return;setError('');
   if(next.length < 8){setError('Password must be at least 8 characters.');return;}
   if(next!==again){setError('Passwords do not match.');return;}
   setBusy(true);
   // The form can render from URL tokens before the session exchange
   // finishes — never submit blindly, or users get raw "Auth session missing".
   const sb=getSupabase();
   const {data:{session}}=sb?await sb.auth.getSession():{data:{session:null}};
   if(!session){
    setBusy(false);
    setError('This reset link has expired or was already used. Request a fresh link from sign-in, and open it in the same browser.');
    return;
   }
  const r=await updatePassword(next);
  if(r.error){
    setBusy(false);
    setError(r.error);
  }else{
    // Sign out to require clean authentication with the brand new password
    await logout();
    setBusy(false);
    toast.success('Password updated successfully! Please sign in with your new password.');
    navigate({to:'/account'});
  }
 }

 if(isDemoMode())return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>New password</h1><p>To update your password, sign in and manage your credentials from Account → Security.</p></div><div className="account-box"><Button variant="fashion" asChild><Link to="/account">BACK TO YOUR ACCOUNT</Link></Button></div></>;
 if(status==='checking')return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Checking your link…</h1><p>One moment while we verify your reset link.</p></div></>;
 if(status==='expired')return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Link expired</h1><p>{expiredReason||'This reset link has expired or was already used.'} Request a fresh one from the sign-in page.</p></div><div className="account-box"><Button variant="fashion" asChild><Link to="/account">BACK TO SIGN IN</Link></Button></div></>;
 return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account',to:'/account'},{label:'New password'}]}/></div><div className="page-header"><span className="eyebrow">PASSWORD RESET</span><h1>Choose a new password</h1><p>Set your new password below, then sign in to your account.</p></div><div className="account-box"><form onSubmit={submit}>
  <div className="form-field">
    <label htmlFor="reset-new">New password</label>
    <div style={{position:'relative',display:'flex',alignItems:'center'}}>
      <input id="reset-new" type={showNext ? 'text' : 'password'} value={next} onChange={e=>setNext(e.target.value)} autoComplete="new-password" placeholder="••••••••" required style={{width:'100%',paddingRight:'40px'}}/>
      <button type="button" onClick={()=>setShowNext(!showNext)} aria-label={showNext ? "Hide password" : "Show password"} tabIndex={-1} style={{position:'absolute',right:'10px',background:'none',border:'none',cursor:'pointer',padding:'4px',display:'grid',placeItems:'center',color:'var(--muted-foreground)'}}>
        {showNext ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
    {next.length>0&&(
      <div style={{marginTop:'8px',padding:'10px 12px',background:'var(--secondary)',border:'1px solid var(--border)',fontSize:'11px',display:'flex',flexDirection:'column',gap:'5px'}} role="status">
        <span style={{fontWeight:600,color:'var(--foreground)'}}>Password requirements:</span>
        <div style={{display:'flex',alignItems:'center',gap:'6px',color:passLength?'#1d7a3a':'var(--muted-foreground)'}}>
          {passLength ? <Check size={13} strokeWidth={2.5}/> : <X size={13}/>}
          <span>At least 8 characters ({next.length}/8)</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:'6px',color:passHasLetter?'#1d7a3a':'var(--muted-foreground)'}}>
          {passHasLetter ? <Check size={13} strokeWidth={2.5}/> : <X size={13}/>}
          <span>Contains at least one letter</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:'6px',color:passHasNumber?'#1d7a3a':'var(--muted-foreground)'}}>
          {passHasNumber ? <Check size={13} strokeWidth={2.5}/> : <X size={13}/>}
          <span>Contains at least one number</span>
        </div>
      </div>
    )}
  </div>
  <div className="form-field" style={{marginTop:'14px'}}>
    <label htmlFor="reset-confirm">Confirm new password</label>
    <div style={{position:'relative',display:'flex',alignItems:'center'}}>
      <input id="reset-confirm" type={showAgain ? 'text' : 'password'} value={again} onChange={e=>setAgain(e.target.value)} autoComplete="new-password" placeholder="••••••••" required style={{width:'100%',paddingRight:'40px'}}/>
      <button type="button" onClick={()=>setShowAgain(!showAgain)} aria-label={showAgain ? "Hide password" : "Show password"} tabIndex={-1} style={{position:'absolute',right:'10px',background:'none',border:'none',cursor:'pointer',padding:'4px',display:'grid',placeItems:'center',color:'var(--muted-foreground)'}}>
        {showAgain ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  </div>
  {error&&<p className="field-error" role="alert" style={{marginTop:'12px'}}>{error}</p>}
  <Button variant="fashion" type="submit" disabled={busy} style={{width:'100%',marginTop:'20px'}}>{busy?'SAVING…':'SET NEW PASSWORD & SIGN IN'}</Button>
 </form></div></>;
}
