import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, MapPin, Package, Heart, LogOut, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { pageHead, money } from '@/lib/catalog';
import { getSessionUser, register, login, logout, signInWithGoogle, resendVerification, updateProfile, changePassword, resetPassword, saveAddress, deleteAddress, exportUserData, deleteAccount, isDemoMode, onAuthChange, claimGuestOrders, migrateLocalData, type Address, type SessionUser } from '@/lib/account';
import { UK_PLACES, OTHER_CITY, isListedCity } from '@/lib/uk-places';
import { ordersByEmail, type Order } from '@/lib/orders';
import { Breadcrumbs } from '@/components/breadcrumbs';
export const Route=createFileRoute('/account')({head:()=>pageHead('Your Account','Sign in to your HUDA GYMWEAR account — orders, addresses and favourites.'),component:Account});

function Account(){
 const [user,setUser]=useState<SessionUser|null>(null);
 const [loading,setLoading]=useState(true);
 const [mode,setMode]=useState<'signin'|'register'|'forgot'>('signin');
 const [name,setName]=useState('');const [email,setEmail]=useState('');const [password,setPassword]=useState('');
 const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const [pendingVerify,setPendingVerify]=useState('');
 const [tab,setTab]=useState<'orders'|'addresses'|'profile'|'security'>('orders');
 const [myOrders,setMyOrders]=useState<Order[]>([]);
 const navigate=useNavigate();
 async function refresh(){setUser(await getSessionUser());}
 useEffect(()=>{
  let live=true;
  const params=new URLSearchParams(window.location.search);
  const cbError=params.get('error_description')||params.get('error');
  if(cbError){setError(cbError.replace(/\+/g,' '));setLoading(false);}
  else{
   // OAuth/PKCE callbacks carry ?code=: the session exchange runs async, so
   // hold the loading state until the auth event (or a timeout) resolves it.
   const awaitingCode=params.has('code');
   getSessionUser().then(u=>{if(live){setUser(u);if(!awaitingCode)setLoading(false);}});
   if(awaitingCode)window.setTimeout(()=>{if(live)setLoading(false);},8000);
  }
  return onAuthChange(u=>{setUser(u);setLoading(false);});
 },[]);
 useEffect(()=>{if(!user){setMyOrders([]);return;}ordersByEmail(user.email).then(setMyOrders);},[user?.email]);
 // Post-auth sync: claim guest orders + migrate local demo data (covers Google redirect too).
 const claimedRef=useRef<string|null>(null);
 useEffect(()=>{if(!user||claimedRef.current===user.id)return;claimedRef.current=user.id;
  claimGuestOrders().then(n=>{if(n>0){toast.success(`Linked ${n} previous order${n>1?'s':''} to your account`);ordersByEmail(user.email).then(setMyOrders);}});
  migrateLocalData().then(r=>{if(r.addresses>0||r.wishlist>0)refresh();});
 },[user]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy)return;setError('');setNotice('');setBusy(true);
  try{
   if(mode==='forgot'){const r=await resetPassword(email);if(r.error)setError(r.error);else setNotice(isDemoMode()?'If an account exists for this email, a reset link is on its way (demo — no email is sent).':'Check your inbox — if an account exists for this email, a reset link is on its way.');return;}
   const r=mode==='register'?await register({name,email,password}):await login({email,password});
   if(r.error){setError(r.error);setPendingVerify('');}
   else if(r.needsVerification){setPendingVerify(email);setNotice('Account created — check your inbox to verify your email, then sign in.');setMode('signin');setPassword('');}
   else{setPendingVerify('');setPassword('');await refresh();}
  }finally{setBusy(false);}
 }
 async function google(){if(busy)return;setError('');setNotice('');setBusy(true);try{const r=await signInWithGoogle();if(r.error){setError(r.error);setBusy(false);}}catch{setBusy(false);}}
 async function doLogout(){await logout();navigate({to:'/'});}
 async function resend(addr?:string){const r=await resendVerification(addr);if(r.error)toast.error(r.error);else toast.success('Verification email sent — check your inbox.');}
 if(loading)return <div className="page-wrap"><p className="fine-print">Loading your account…</p></div>;
 if(!user)return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account'}]}/></div><div className="page-header"><span className="eyebrow">YOUR WORLD. YOUR HUDA.</span><h1>Your Account</h1><p>A space for your favourites, orders and next chapter.</p></div><div className="account-box"><div className="account-tabs" role="tablist" aria-label="Account access"><Button variant="quiet" className={mode==='signin'?'selected':''} aria-pressed={mode==='signin'} onClick={()=>{setMode('signin');setError('');setNotice('');}}>Sign in</Button><Button variant="quiet" className={mode==='register'?'selected':''} aria-pressed={mode==='register'} onClick={()=>{setMode('register');setError('');setNotice('');}}>Create account</Button></div>
 <form onSubmit={submit}>{mode==='register'&&<label className="form-field">Your name<input value={name} onChange={e=>setName(e.target.value)} autoComplete="name" placeholder="Amelia Clarke"/></label>}<label className="form-field">Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" placeholder="you@example.co.uk"/></label>{mode!=='forgot'&&<label className="form-field">Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==='signin'?'current-password':'new-password'} placeholder="••••••••"/></label>}{error&&<p className="field-error" role="alert">{error}</p>}{notice&&<p className="field-ok" role="status">{notice}</p>}{pendingVerify&&!isDemoMode()&&<p className="fine-print">Didn't get it? <Button variant="link" size="sm" onClick={()=>resend(pendingVerify)}>RESEND VERIFICATION EMAIL</Button></p>}<Button variant="fashion" type="submit" disabled={busy}>{busy?'PLEASE WAIT…':mode==='signin'?'SIGN IN':mode==='register'?'CREATE ACCOUNT':'SEND RESET LINK'}</Button></form>
 {!isDemoMode()&&mode!=='forgot'&&<><div className="flex items-center gap-3 my-4" aria-hidden="true"><span className="h-px flex-1 bg-black/10"/><span className="fine-print">or</span><span className="h-px flex-1 bg-black/10"/></div><Button variant="quiet" onClick={google} disabled={busy}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.5h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.6-5 3.6-8.9z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.6 2.8v.1C3.5 21.3 7.5 24 12 24z"/><path fill="#FBBC05" d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.6-2.8-.1.1C.5 8.7 0 10.3 0 12s.5 3.3 1.4 4.7l3.8-2.3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.5 0 3.5 2.7 1.4 6.8l3.8 3C6.2 6.8 8.9 4.7 12 4.7z"/></svg> CONTINUE WITH GOOGLE</Button></>}
 {mode==='signin'&&<Button variant="link" size="sm" onClick={()=>{setMode('forgot');setError('');setNotice('');}}>Forgot your password?</Button>}{mode==='forgot'&&<Button variant="link" size="sm" onClick={()=>{setMode('signin');setError('');setNotice('');}}>Back to sign in</Button>}
 <p className="fine-print">Secured accounts — your orders and addresses follow you on every device.</p></div></>;
 return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Account'}]}/></div><div className="page-header"><span className="eyebrow">YOUR WORLD. YOUR HUDA.</span><h1>Welcome back{user.name?`, ${user.name.split(' ')[0]}`:''}.</h1><p>Your next move starts here.</p></div>
 {!isDemoMode()&&!user.emailVerified&&<div className="page-wrap"><div className="notice-bar" role="status"><p><strong>Please verify your email</strong> — check your inbox for the confirmation link.</p><Button variant="quiet" size="sm" onClick={()=>resend(user.email)}>RESEND EMAIL</Button></div></div>}
 <div className="account-layout"><nav className="account-nav">{([['orders','My orders',Package],['addresses','Addresses',MapPin],['profile','Profile',null],['security','Security',null]] as const).map(([t,label,Icon])=><button key={t} className={tab===t?'active':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{Icon&&<Icon size={15}/>} {label}</button>)}<Link to="/wishlist"><Heart size={15}/> Favourites</Link><button onClick={doLogout}><LogOut size={15}/> Sign out</button></nav>
 <section className="account-panel">
 {tab==='orders'&&<div>{myOrders.length===0?<div className="empty-state"><Package size={36}/><h2>No orders yet.</h2><p>Your orders will appear here with live tracking.</p><Button variant="fashion" asChild><Link to="/shop">SHOP THE COLLECTION</Link></Button></div>:<><div className="table-scroll"><table className="order-table"><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Total</th></tr></thead><tbody>{myOrders.slice(0,5).map(o=><tr key={o.id}><td>{o.id}</td><td>{new Date(o.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</td><td><span className={`status-tag ${o.status==='Delivered'?'done':o.status==='Cancelled'?'cancelled':'pending'}`}>{o.status}</span></td><td>{money(o.total)}</td></tr>)}</tbody></table></div><Button variant="fashion" asChild className="mt-6"><Link to="/orders">VIEW ALL ORDERS <ArrowRight size={14}/></Link></Button></>}</div>}
 {tab==='addresses'&&<AddressBook user={user} onChange={setUser}/>}
 {tab==='profile'&&<ProfileForm name={user.name} email={user.email} onSaved={refresh}/>}
 {tab==='security'&&<><SecurityForm email={user.email}/><GdprBox email={user.email}/></>}
 </section></div></>;
}

function ProfileForm({name,email,onSaved}:{name:string;email:string;onSaved:()=>void}){
 const [n,setN]=useState(name);const [err,setErr]=useState('');const [ok,setOk]=useState('');
 return <form onSubmit={e=>{e.preventDefault();void (async()=>{const r=await updateProfile(email,{name:n});if(r.error){setErr(r.error);setOk('');}else{setErr('');setOk('Profile updated.');onSaved();}})();}}><h2>Profile</h2><label className="form-field">Your name<input value={n} onChange={e=>setN(e.target.value)} autoComplete="name"/></label><label className="form-field">Email address<input value={email} disabled/></label>{err&&<p className="field-error" role="alert">{err}</p>}{ok&&<p className="field-ok" role="status">{ok}</p>}<Button variant="fashion" type="submit">SAVE CHANGES</Button></form>;
}
function SecurityForm({email}:{email:string}){
 const [cur,setCur]=useState('');const [next,setNext]=useState('');const [err,setErr]=useState('');const [ok,setOk]=useState('');
 return <form onSubmit={e=>{e.preventDefault();void (async()=>{const r=await changePassword(email,cur,next);if(r.error){setErr(r.error);setOk('');}else{setErr('');setOk('Password changed.');setCur('');setNext('');}})();}}><h2>Security</h2><label className="form-field">Current password<input type="password" value={cur} onChange={e=>setCur(e.target.value)} autoComplete="current-password"/></label><label className="form-field">New password<input type="password" value={next} onChange={e=>setNext(e.target.value)} autoComplete="new-password"/></label>{err&&<p className="field-error" role="alert">{err}</p>}{ok&&<p className="field-ok" role="status">{ok}</p>}<Button variant="fashion" type="submit">CHANGE PASSWORD</Button></form>;
}
function AddressBook({user,onChange}:{user:SessionUser;onChange:(u:SessionUser|null)=>void}){
 const [open,setOpen]=useState(false);
 const [other,setOther]=useState(false);const [customCity,setCustomCity]=useState('');const [addrErr,setAddrErr]=useState('');
 const [form,setForm]=useState<Omit<Address,'id'>>({label:'Home',firstName:'',lastName:'',street:'',city:'',postcode:'',country:'United Kingdom',phone:'',isDefault:false});
 const [editId,setEditId]=useState<string|null>(null);
 function startNew(){setEditId(null);setOther(false);setCustomCity('');setForm({label:'Home',firstName:'',lastName:'',street:'',city:'',postcode:'',country:'United Kingdom',phone:'',isDefault:user.addresses.length===0});setOpen(true);}
 function startEdit(a:Address){setEditId(a.id);if(isListedCity(a.city)){setOther(false);setCustomCity('');}else{setOther(true);setCustomCity(a.city);}setForm({...a});setOpen(true);}
 function save(e:React.FormEvent){e.preventDefault();const city=other?customCity.trim():form.city.trim();if(!form.firstName.trim()||!form.street.trim()||city.length<2||!form.postcode.trim()){setAddrErr('Please complete name, street, town/city and postcode.');return;}setAddrErr('');void saveAddress(user.email,{...form,city,...(editId?{id:editId}:{})}).then(u=>{if(u){setOpen(false);onChange(u);}});}
 return <div><div className="account-page-title"><h2>Addresses</h2><Button variant="quiet" onClick={startNew}><Plus size={14}/> ADD ADDRESS</Button></div>
  {(user.addresses??[]).length===0&&!open&&<p className="fine-print">No addresses yet — add one to speed up checkout.</p>}
  <div className="address-grid">{(user.addresses??[]).map(a=><div key={a.id} className="address-card"><strong>{a.label} {a.isDefault&&<span className="status-tag done">Default</span>}</strong><p>{a.firstName} {a.lastName}<br/>{a.street}<br/>{a.city} {a.postcode}<br/>{a.country}{a.phone&&<><br/>{a.phone}</>}</p><div className="admin-actions"><Button variant="link" size="sm" onClick={()=>startEdit(a)}>Edit</Button><Button variant="link" size="sm" onClick={()=>{void deleteAddress(user.email,a.id).then(u=>{if(u)onChange(u);});}}><Trash2 size={13}/> Remove</Button></div></div>)}</div>
 {open&&<form className="form-grid mt-6" onSubmit={save}><label className="form-field">Label<input value={form.label} onChange={e=>setForm({...form,label:e.target.value})} placeholder="Home / Work"/></label><label className="form-field">First name<input value={form.firstName} onChange={e=>setForm({...form,firstName:e.target.value})} required/></label><label className="form-field">Last name<input value={form.lastName} onChange={e=>setForm({...form,lastName:e.target.value})} required/></label><label className="form-field full">Street<input value={form.street} onChange={e=>setForm({...form,street:e.target.value})} required/></label><label className="form-field">Town / city<select value={other?OTHER_CITY:(isListedCity(form.city)||!form.city?form.city:OTHER_CITY)} onChange={e=>{const v=e.target.value;if(v===OTHER_CITY){setOther(true);}else{setOther(false);setCustomCity('');setForm({...form,city:v});}}} required><option value="">Select town or city…</option>{UK_PLACES.map(p=><option key={p} value={p}>{p}</option>)}<option value={OTHER_CITY}>Other…</option></select></label>{other&&<label className="form-field">Your town / city<input value={customCity} onChange={e=>setCustomCity(e.target.value)} placeholder="Type your town…" required/></label>}<label className="form-field">Postcode<input value={form.postcode} onChange={e=>setForm({...form,postcode:e.target.value})} required/></label><label className="form-field">Phone<input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></label><label className="form-field">Country<select value={form.country} onChange={e=>setForm({...form,country:e.target.value})}><option>United Kingdom</option></select></label><label className="check-line full"><input type="checkbox" checked={!!form.isDefault} onChange={e=>setForm({...form,isDefault:e.target.checked})}/> Default address</label>{addrErr&&<p className="field-error full" role="alert">{addrErr}</p>}<div className="full step-actions"><Button variant="quiet" type="button" onClick={()=>setOpen(false)}>CANCEL</Button><Button variant="fashion" type="submit">SAVE ADDRESS</Button></div></form>}</div>;
}
function GdprBox({email}:{email:string}){
 const navigate=useNavigate();
  function download(){
   void exportUserData(email).then(data=>{
    if(!data){toast.error('Could not prepare your export.');return;}
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`huda-account-${email}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    toast.success('Your data export is downloading.');
   });
  }
  function remove(){
   if(!window.confirm('Delete your account permanently? Your orders stay in store records.'))return;
   if(!window.confirm('Last chance — this cannot be undone. Delete now?'))return;
   void deleteAccount(email).then(ok=>{if(ok){toast.success('Your account has been deleted.');navigate({to:'/'});}});
  }
 return <div className="admin-panel mt-6"><h2>Your data (GDPR)</h2><p className="fine-print">Download everything we hold about you, or erase your account. Placed orders remain in store records as required by tax law.</p><div className="admin-actions"><Button variant="quiet" type="button" onClick={download}>EXPORT MY DATA</Button><Button variant="link" type="button" onClick={remove}>Delete my account</Button></div></div>;
}
