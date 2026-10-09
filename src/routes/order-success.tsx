import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Check, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { pageHead, money } from '@/lib/catalog';
import { getGuestOrder, getOrder, setTransferProof, type Order } from '@/lib/orders';
import { uploadTransferProof } from '@/lib/product-images';
import { getSettings, whatsappLink } from '@/lib/shop-settings';
export const Route=createFileRoute('/order-success')({validateSearch:(s:Record<string,unknown>)=>({order:typeof s['order']==='string'?s['order']:'',email:typeof s['email']==='string'?s['email']:''}),head:()=>pageHead('Order Confirmed','Your HUDA GYMWEAR order is confirmed.'),component:Success});
async function fetchOrder(id:string,email:string):Promise<Order|null>{
  const direct=await getOrder(id).catch(()=>undefined);
  if(direct)return direct;
  if(email){
    const guest=await getGuestOrder(id,email).catch(()=>undefined);
    if(guest)return guest;
  }
  return null;
}
function Success(){
  const {order:orderId,email:searchEmail}=Route.useSearch();
  const [order,setOrder]=useState<Order|null>(null);
  const [loading,setLoading]=useState(!!orderId);
  const [uploading,setUploading]=useState(false);
  const [uploadError,setUploadError]=useState('');
  useEffect(()=>{if(!orderId){setLoading(false);return;}setLoading(true);fetchOrder(orderId,searchEmail).then(o=>{setOrder(o);setLoading(false);});},[orderId,searchEmail]);
  const settings=getSettings();
  const wa=order?whatsappLink(`Hello HUDA GYMWEAR! I just placed order ${order.id} (${money(order.total)})${order.transferRef?` — transfer ref: ${order.transferRef}`:''}. Here is my transfer receipt.`):null;
  async function onReceipt(e:React.ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0];
    e.target.value='';
    if(!f||!order||uploading)return;
    const email=(searchEmail||order.email).trim().toLowerCase();
    if(!email){setUploadError('We need your checkout email to attach this receipt.');return;}
    setUploading(true);
    setUploadError('');
    try{
      const {path}=await uploadTransferProof(order.id,f);
      const ok=await setTransferProof(order.id,email,path);
      if(!ok)throw new Error('Could not attach your receipt. Please try again.');
      const fresh=await fetchOrder(order.id,email);
      if(fresh)setOrder(fresh);
    }catch(err){setUploadError(err instanceof Error?err.message:'Upload failed. Please try again.');}
    finally{setUploading(false);}
  }
  if(loading)return <section className="empty-state section"><p className="fine-print">Confirming your order…</p></section>;
  if(!order)return <section className="empty-state section"><Check size={45}/><span className="eyebrow brand-accent">YOUR NEXT MOVE LOOKS GOOD</span><h1>All set. All you.</h1><p>Thank you for shopping with HUDA GYMWEAR.</p><div className="account-welcome"><Button variant="fashion" asChild><Link to="/orders">TRACK YOUR ORDERS</Link></Button><Button variant="quiet" asChild><Link to="/shop">KEEP EXPLORING</Link></Button></div></section>;
  return <section className="empty-state section"><Check size={45}/><span className="eyebrow brand-accent">ORDER {order.id} CONFIRMED</span><h1>All set. All you.</h1><p>Thank you, {order.customer}. A confirmation was saved to your account.</p>
  {order.payment==='bank'&&order.paymentStatus!=='Paid'&&<div className="bank-card wide"><h3>Complete your bank transfer — {money(order.total)}</h3><dl><div><dt>Bank</dt><dd>{settings.bankName||'—'}</dd></div><div><dt>Account name</dt><dd>{settings.accountName||'—'}</dd></div><div><dt>Account number</dt><dd>{settings.accountNumber||'—'}</dd></div><div><dt>IBAN</dt><dd>{settings.iban||'—'}</dd></div></dl>{order.transfer_proof_url?<p className="field-ok">Receipt received — we will approve it shortly, then start packing.</p>:<p className="fine-print">Upload your receipt here so we can approve it faster — or send it on WhatsApp below.</p>}<label className="form-field">Upload transfer receipt (image)<input type="file" accept="image/*" onChange={onReceipt} disabled={uploading} aria-label="Upload transfer receipt"/>{uploading&&<span className="fine-print">Uploading your receipt…</span>}{uploadError&&<small className="field-error" role="alert">{uploadError}</small>}</label>{wa?<Button variant="fashion" asChild><a href={wa} target="_blank" rel="noreferrer"><MessageCircle size={16}/> SEND RECEIPT ON WHATSAPP</a></Button>:<p className="fine-print">WhatsApp checkout support is coming soon.</p>}<p className="fine-print">We start packing as soon as your payment is approved.</p></div>}
  {order.payment==='cod'&&<p className="preview-note">Cash on delivery — please have {money(order.total)} ready when your order arrives.</p>}
  <div className="account-welcome"><Button variant="fashion" asChild><Link to="/orders">TRACK YOUR ORDERS</Link></Button><Button variant="quiet" asChild><Link to="/shop">KEEP EXPLORING</Link></Button></div></section>;
}
