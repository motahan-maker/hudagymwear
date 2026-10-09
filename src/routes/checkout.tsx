import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowLeft, Check, Banknote, Landmark, MessageCircle } from 'lucide-react';
import { useStore } from '@/components/store';
import { money, getProduct, sizeStock, upsertProduct, pageHead, effectivePrice, type Product } from '@/lib/catalog';
import { getSessionUser, onAuthChange, type SessionUser } from '@/lib/account';
import { createOrder, type PaymentMethod } from '@/lib/orders';
import { validateDiscount, recordDiscountUse, getPendingPromo, clearPendingPromo } from '@/lib/discounts';
import { getSettings, whatsappLink, DEFAULT_SHIPPING } from '@/lib/shop-settings';
import { UK_PLACES, OTHER_CITY, isListedCity, isUkPostcode } from '@/lib/uk-places';
import { Button } from '@/components/ui/button';
export const Route=createFileRoute('/checkout')({head:()=>pageHead('Checkout','Secure UK checkout for HUDA GYMWEAR. Cash on delivery or bank transfer with tracked delivery.'),component:Checkout});
type Details = {email:string;firstName:string;lastName:string;street:string;city:string;postcode:string;country:string;phone:string};
type FieldErrors = Partial<Record<'email'|'firstName'|'lastName'|'street'|'city'|'postcode'|'phone'|'stock',string>>;
const emptyDetails: Details = {email:'',firstName:'',lastName:'',street:'',city:'',postcode:'',country:'United Kingdom',phone:''};
const STEPS = ['Information','Shipping','Payment'];

function Checkout(){
 const {bag,clearBag}=useStore();const navigate=useNavigate();
  const [user,setUser]=useState<SessionUser|null>(null);
  useEffect(()=>{getSessionUser().then(setUser);return onAuthChange(setUser);},[]);
  const shopSettings=getSettings();
  const SHIP_METHODS=shopSettings.shipping?.length?shopSettings.shipping:DEFAULT_SHIPPING;
  const FREE_OVER=shopSettings.freeOver>0?shopSettings.freeOver:100;
  const [step,setStep]=useState(0);
  const [details,setDetails]=useState<Details>(()=>({ ...emptyDetails }));
  const [savedAddr,setSavedAddr]=useState('');
  // Prefill contact + name from the signed-in account once it loads.
  const prefilledRef=useRef(false);
  useEffect(()=>{if(!user||prefilledRef.current)return;prefilledRef.current=true;setDetails(d=>({...d,email:d.email||user.email,firstName:d.firstName||user.name.split(' ')[0]||'',lastName:d.lastName||user.name.split(' ').slice(1).join(' ')||''}));},[user]);
 const [citySel,setCitySel]=useState('');const [cityCustom,setCityCustom]=useState('');
 useEffect(()=>{setDetails(d=>({...d,city:citySel===OTHER_CITY?cityCustom.trim():citySel}));},[citySel,cityCustom]);
 const [ship,setShip]=useState('standard');
 const [pay,setPay]=useState<PaymentMethod>('cod');
 const [ref,setRef]=useState('');
 const [code,setCode]=useState(()=>getPendingPromo()??'');const [promoCode,setPromoCode]=useState<string|null>(()=>getPendingPromo());const [codeMsg,setCodeMsg]=useState('');const [isPlacing,setIsPlacing]=useState(false);
 const [errors,setErrors]=useState<FieldErrors>({});

 const lines=useMemo(()=>bag.map(i=>({item:i,p:getProduct(i.id)})).filter(x=>x.p) as {item:{id:string;size:string;quantity:number};p:Product}[],[bag]);
 const subtotal=lines.reduce((n,{item,p})=>n+effectivePrice(p)*item.quantity,0);
 const shipOption=SHIP_METHODS.find(s=>s.id===ship&&s.enabled)??SHIP_METHODS.find(s=>s.enabled)??DEFAULT_SHIPPING[0]!;
 const freeShip=shipOption.id==='standard'&&subtotal-(promoCode?validateDiscount(promoCode,subtotal).amount:0)>=FREE_OVER;
 // Free STANDARD delivery on the payable subtotal (post-discount); express always charged.
 const shipPrice=freeShip?0:(shipOption?.price??0);
 const promoCheck=promoCode?validateDiscount(promoCode,subtotal):{ok:false as const,amount:0,message:''};
 const discount=promoCheck.ok?promoCheck.amount:0;
 const total=Math.max(0,subtotal+shipPrice-discount);

 const set=(k:keyof Details)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>{setDetails(d=>({...d,[k]:e.target.value}));setErrors(x=>({...x,[k]:''}));};
 function pickAddress(id:string){setSavedAddr(id);const a=user?.addresses.find(x=>x.id===id);if(!a)return;if(isListedCity(a.city)){setCitySel(a.city);setCityCustom('');}else{setCitySel(OTHER_CITY);setCityCustom(a.city);}setDetails(d=>({...d,firstName:a.firstName,lastName:a.lastName,street:a.street,city:a.city,postcode:a.postcode,country:a.country,phone:a.phone}));}
 function validDetails():boolean{
  const e:FieldErrors={};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(details.email.trim()))e.email='Enter a valid email address.';
  if(details.firstName.trim().length<2)e.firstName='Enter your first name.';
  if(details.lastName.trim().length<2)e.lastName='Enter your last name.';
  if(details.street.trim().length<4)e.street='Enter your street address.';
  if(details.city.trim().length<2)e.city='Select your town or city.';
  if(!isUkPostcode(details.postcode))e.postcode='Enter a valid UK postcode (e.g. E2 8DP).';
   if(details.phone.trim()&&!/^[+\d][\d\s-]{6,}$/.test(details.phone.trim()))e.phone='Enter a valid phone number.';
 setErrors(e);return Object.keys(e).length===0;
 }
 function applyCode(e:React.FormEvent){e.preventDefault();const c=code.trim().toUpperCase();const r=validateDiscount(c,subtotal);if(r.ok){setPromoCode(c);setCodeMsg('');}else{setPromoCode(null);setCodeMsg(r.message);}}
   function placeOrder(){
   if(isPlacing)return;
   if(pay==='bank'&&!bankReady){setPay('cod');return;}
   for(const {item,p} of lines){if(sizeStock(p,item.size)<item.quantity){setErrors({stock:`Sorry — ${p.name} (${item.size}) only has ${sizeStock(p,item.size)} left.`});return;}}
   const live=promoCode?validateDiscount(promoCode,subtotal):null;
   const finalDiscount=live&&live.ok?live.amount:0;
   const finalTotal=Math.max(0,subtotal+shipPrice-finalDiscount);
   setIsPlacing(true);
   void (async()=>{
   try{
    const order=await createOrder({
    email:details.email.trim().toLowerCase(),customer:`${details.firstName.trim()} ${details.lastName.trim()}`.trim()||details.email,
   address:{firstName:details.firstName,lastName:details.lastName,street:details.street,city:details.city,postcode:details.postcode,country:details.country,phone:details.phone},
   items:lines.map(({item,p})=>({productId:p.id,name:p.name,colour:p.colour,size:item.size,qty:item.quantity,price:effectivePrice(p),image:p.image})),
   subtotal,discount:finalDiscount,total:finalTotal,payment:pay,
   shipping:{method:shipOption?.label??ship,price:shipPrice},
    ...(promoCode&&live&&live.ok?{discountCode:promoCode}:{}),
    ...(pay==='bank'&&ref.trim()?{transferRef:ref.trim()}:{}),
    ...(user?{userId:user.id}:{}),
   });
  for(const {item,p} of lines){
   const next={...p};
   if(next.stockBySize)next.stockBySize={...next.stockBySize,[item.size]:Math.max(0,(next.stockBySize[item.size]??0)-item.quantity)};
   else if(next.stock!=null)next.stock=Math.max(0,next.stock-item.quantity);
   void upsertProduct(next);
  }
    if(promoCode&&live&&live.ok)recordDiscountUse(promoCode);
    clearPendingPromo();clearBag();
    navigate({to:'/order-success',search:{order:order.id,email:details.email.trim().toLowerCase()}});
   }catch(err){setErrors({stock:err instanceof Error?err.message:'Could not place your order. Please try again.'});
   }finally{setIsPlacing(false);}})();}

 if(!bag.length)return <><div className="page-header"><span className="eyebrow">ONE STEP CLOSER TO YOUR NEXT MOVE</span><h1>Checkout</h1></div><div className="empty-state"><h2>Your bag is waiting for you.</h2><Button variant="fashion" asChild><Link to="/shop">SHOP THE COLLECTION</Link></Button></div></>;
  const settings=shopSettings;
  const bankReady=!!(settings.bankName&&settings.accountNumber&&settings.iban);
  return <><div className="page-header"><span className="eyebrow">ONE STEP CLOSER TO YOUR NEXT MOVE</span><h1>Checkout</h1><ol className="checkout-steps" aria-label="Checkout progress">{STEPS.map((s,i)=><li key={s} className={i===step?'current':i<step?'done':''} {...(i===step?{'aria-current':'step'}:{})}>{i<step?<Check size={12}/>:`${i+1}`} {s}</li>)}</ol></div>
 <div className="checkout-layout"><div className="checkout-main">
  {errors.stock&&<p className="field-error big" role="alert">{errors.stock}</p>}
   {step===0&&<section><h2>Contact & address</h2>{!user&&<p className="fine-print">Have an account? <Link to="/account" className="text-link">Sign in</Link> to check out faster — your order links to it automatically.</p>}{user&&user.addresses.length>0&&<label className="form-field">Saved addresses<select value={savedAddr} onChange={e=>pickAddress(e.target.value)}><option value="">New address…</option>{user.addresses.map(a=><option key={a.id} value={a.id}>{a.label} — {a.street}, {a.city}</option>)}</select></label>}<div className="form-grid"><label className="form-field full">Email address<input type="email" id="co-email" value={details.email} onChange={set('email')} autoComplete="email" aria-invalid={!!errors.email} aria-describedby="co-email-err"/>{errors.email&&<small className="field-error" id="co-email-err" role="alert">{errors.email}</small>}</label><label className="form-field">First name<input id="co-first" value={details.firstName} onChange={set('firstName')} autoComplete="given-name" aria-invalid={!!errors.firstName} aria-describedby="co-first-err"/>{errors.firstName&&<small className="field-error" id="co-first-err" role="alert">{errors.firstName}</small>}</label><label className="form-field">Last name<input id="co-last" value={details.lastName} onChange={set('lastName')} autoComplete="family-name" aria-invalid={!!errors.lastName} aria-describedby="co-last-err"/>{errors.lastName&&<small className="field-error" id="co-last-err" role="alert">{errors.lastName}</small>}</label><label className="form-field full">Street address<input id="co-street" value={details.street} onChange={set('street')} autoComplete="street-address" aria-invalid={!!errors.street} aria-describedby="co-street-err"/>{errors.street&&<small className="field-error" id="co-street-err" role="alert">{errors.street}</small>}</label><label className="form-field">Town / city<select id="co-city" value={isListedCity(details.city)||!details.city?details.city:OTHER_CITY} onChange={e=>{const v=e.target.value;if(v===OTHER_CITY){setCitySel(OTHER_CITY);}else{setCitySel(v);setCityCustom('');}}} autoComplete="address-level2" aria-invalid={!!errors.city} aria-describedby="co-city-err"><option value="">Select town or city…</option>{UK_PLACES.map(p=><option key={p} value={p}>{p}</option>)}<option value={OTHER_CITY}>Other…</option></select>{errors.city&&<small className="field-error" id="co-city-err" role="alert">{errors.city}</small>}</label>{(citySel===OTHER_CITY||(!!details.city&&!isListedCity(details.city)))&&<label className="form-field">Your town / city<input value={cityCustom} onChange={e=>setCityCustom(e.target.value)} placeholder="Type your town…" autoComplete="address-level2"/></label>}<label className="form-field">Postcode<input id="co-postcode" value={details.postcode} onChange={set('postcode')} autoComplete="postal-code" aria-invalid={!!errors.postcode} aria-describedby="co-postcode-err"/>{errors.postcode&&<small className="field-error" id="co-postcode-err" role="alert">{errors.postcode}</small>}</label><label className="form-field">Phone<input id="co-phone" value={details.phone} onChange={set('phone')} autoComplete="tel" placeholder="For delivery updates" aria-invalid={!!errors.phone} aria-describedby="co-phone-err"/>{errors.phone&&<small className="field-error" id="co-phone-err" role="alert">{errors.phone}</small>}</label><label className="form-field">Country<select value={details.country} onChange={set('country')}><option>United Kingdom</option></select></label></div><div className="step-actions"><span/>{<Button variant="fashion" onClick={()=>{if(validDetails())setStep(1);else{const f=document.querySelector('.checkout-main [aria-invalid="true"]');if(f)(f as HTMLElement).focus();}}}>CONTINUE TO SHIPPING <ArrowRight/></Button>}</div></section>}
   {step===1&&<section><h2>Shipping method</h2><div className="pay-options">{SHIP_METHODS.filter(s=>s.enabled).map(s=><label key={s.id} className={`pay-card ${ship===s.id?'selected':''}`}><input type="radio" name="ship" checked={ship===s.id} onChange={()=>setShip(s.id)}/><div><strong>{s.label}</strong><small>{s.hint}</small></div><strong>{freeShip?'FREE':money(s.price)}</strong></label>)}</div>{!freeShip&&<p className="fine-print">Free standard delivery on orders over {money(FREE_OVER)}.</p>}<div className="step-actions"><Button variant="quiet" onClick={()=>setStep(0)}><ArrowLeft/> BACK</Button><Button variant="fashion" onClick={()=>setStep(2)}>CONTINUE TO PAYMENT <ArrowRight/></Button></div></section>}
 {step===2&&<section><h2>Payment</h2><div className="pay-options">
  <label className={`pay-card ${pay==='cod'?'selected':''}`}><input type="radio" name="pay" checked={pay==='cod'} onChange={()=>setPay('cod')}/><Banknote size={22}/><div><strong>Cash on Delivery</strong><small>Pay in cash when your order arrives.</small></div></label>
  <label className={`pay-card ${pay==='bank'?'selected':''} ${!bankReady?'disabled':''}`}><input type="radio" name="pay" checked={pay==='bank'} disabled={!bankReady} onChange={()=>setPay('bank')}/><Landmark size={22}/><div><strong>Bank Transfer</strong><small>{bankReady?'Transfer now, send the receipt on WhatsApp.':'Coming soon — payment details being set up.'}</small></div></label>
 </div>
 {pay==='bank'&&<div className="bank-card"><h3>Transfer to this account</h3><dl><div><dt>Bank</dt><dd>{settings.bankName||'—'}</dd></div><div><dt>Account name</dt><dd>{settings.accountName||'—'}</dd></div><div><dt>Account number</dt><dd>{settings.accountNumber||'—'}</dd></div><div><dt>IBAN</dt><dd>{settings.iban||'—'}</dd></div><div><dt>Amount</dt><dd><strong>{money(total)}</strong></dd></div></dl><label className="form-field">Transfer reference (optional)<input value={ref} onChange={e=>setRef(e.target.value)} placeholder="e.g. your name or transaction ID"/></label><p className="fine-print"><MessageCircle size={13}/> After placing your order you will send the transfer receipt on WhatsApp — we approve it, then pack your order.</p>{(()=>{const wa=whatsappLink(`Hello HUDA GYMWEAR! I am about to place a bank transfer order of ${money(total)}.${ref.trim()?` My transfer reference: ${ref.trim()}.`:''}`);return wa?<Button variant="quiet" asChild><a href={wa} target="_blank" rel="noreferrer"><MessageCircle size={15}/> CHAT ON WHATSAPP</a></Button>:null;})()}</div>}
  <div className="step-actions"><Button variant="quiet" onClick={()=>setStep(1)}><ArrowLeft/> BACK</Button><Button variant="fashion" onClick={placeOrder} disabled={isPlacing} aria-busy={isPlacing}>{isPlacing?'PLACING ORDER…':pay==='bank'?'PLACE ORDER & SHOW PAYMENT DETAILS':'PLACE ORDER'} <ArrowRight/></Button></div></section>}
  </div><aside className="checkout-summary"><h2>Order summary</h2><div className="summary-lines">{lines.map(({item,p})=><div key={item.id+item.size} className="summary-row"><img src={p.image} alt={p.name} width={52} height={64} loading="lazy" decoding="async"/><div><strong>{p.name}</strong><small>{p.colour} / {item.size} × {item.quantity}</small></div><span>{money(effectivePrice(p)*item.quantity)}</span></div>)}</div><div className="bag-total"><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div className="bag-total"><span>Delivery</span><span>{shipPrice===0?'FREE':money(shipPrice)}</span></div>{discount>0&&<div className="bag-total discount"><span>Discount ({promoCode})</span><strong>−{money(discount)}</strong></div>}<form className="promo-form" onSubmit={applyCode}><input value={code} onChange={e=>{setCode(e.target.value);setCodeMsg('');}} aria-label="Discount code" placeholder="Discount code" aria-describedby="promo-msg"/><Button variant="quiet" type="submit">APPLY</Button></form><div id="promo-msg" role="status" aria-live="polite">{codeMsg&&<p className="field-error">{codeMsg}</p>}{promoCode&&discount>0&&<p className="field-ok">{promoCode} applied — you save {money(discount)}.</p>}{promoCode&&!promoCheck.ok&&<p className="field-error">{promoCode} is no longer valid for this bag.</p>}</div><div className="bag-total grand"><span>Total</span><strong>{money(total)}</strong></div></aside></div></>;
}
