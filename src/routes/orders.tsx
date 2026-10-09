import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ArrowRight, Package } from 'lucide-react';
import { toast } from 'sonner';
import { pageHead, money, getProduct, sizeStock } from '@/lib/catalog';
import { useStore } from '@/components/store';
import { ordersByEmail, getGuestOrder, statusIndex, PIPELINE, type Order } from '@/lib/orders';
import { getSessionUser, onAuthChange, type SessionUser } from '@/lib/account';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Button } from '@/components/ui/button';
export const Route=createFileRoute('/orders')({head:()=>pageHead('Your Orders','Track your HUDA GYMWEAR orders, from packing to delivery.'),component:Orders});
const INITIALS=['Awaiting payment proof','Order received'];
export function OrderTimeline({order}:{order:Order}){
  if(order.status==='Cancelled')return <p className="status-tag cancelled">This order was cancelled.</p>;
  const steps=INITIALS.includes(order.status)?[order.status,...PIPELINE]:PIPELINE;
  const idx=INITIALS.includes(order.status)?0:statusIndex(order.status);
  return <ol className="timeline" aria-label={`Order progress: ${order.status}`}>{steps.map((s,i)=><li key={s} className={i<idx?'done':i===idx?'current':''} {...(i===idx?{'aria-current':'step'}:{})}><span className="dot"/>{s}{i===idx&&<small> · current step</small>}</li>)}</ol>;
}
function Orders(){
 const [user,setUser]=useState<SessionUser|null>(null);
 const [loading,setLoading]=useState(true);
 const [email,setEmail]=useState('');const [orderId,setOrderId]=useState('');const [searched,setSearched]=useState(false);
 const [detail,setDetail]=useState<string|null>(null);
 const [mine,setMine]=useState<Order[]>([]);
 const [guest,setGuest]=useState<Order[]>([]);
 useEffect(()=>{let live=true;getSessionUser().then(u=>{if(live){setUser(u);setLoading(false);}});return onAuthChange(u=>{setUser(u);setLoading(false);});},[]);
 useEffect(()=>{if(!user){setMine([]);return;}ordersByEmail(user.email).then(setMine);},[user?.email]);
  async function lookup(e:React.FormEvent){e.preventDefault();setSearched(true);setDetail(null);const o=await getGuestOrder(orderId.trim().toUpperCase(),email);setGuest(o?[o]:[]);}
 const list=user?mine:guest;
 const current=list.find(o=>o.id===detail);
 if(loading)return <div className="page-wrap"><p className="fine-print">Loading your orders…</p></div>;
 if(!user)return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Orders'}]}/></div><div className="page-header"><span className="eyebrow">YOUR HUDA JOURNEY</span><h1>Your Orders</h1><p>Track with your order number and checkout email.</p></div><div className="account-box"><form className="lookup-form" onSubmit={lookup}><label className="form-field">Order email<input type="email" value={email} onChange={e=>{setEmail(e.target.value);setSearched(false);}} placeholder="you@example.co.uk" required/></label><label className="form-field">Order number<input value={orderId} onChange={e=>{setOrderId(e.target.value.toUpperCase());setSearched(false);}} placeholder="HG-1032" required aria-describedby="lookup-hint"/></label><p className="fine-print" id="lookup-hint">Find both on your confirmation message.</p><Button variant="fashion" type="submit">TRACK ORDER</Button></form>{searched&&(list.length===0?<div className="empty-state"><Package size={36}/><h2>No matching order.</h2><p>Check the order number and email, then try again.</p><Button variant="fashion" asChild><Link to="/shop">START SHOPPING</Link></Button></div>:<OrderList list={list} detail={detail} setDetail={setDetail} current={current}/>)}</div></>;
 return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Orders'}]}/></div><div className="page-header"><span className="eyebrow">YOUR HUDA JOURNEY</span><h1>Your Orders</h1><p>{list.length?`${list.length} order${list.length>1?'s':''} and counting.`:'Nothing here yet — your next favourite fit is waiting.'}</p></div><section className="section shop-section">{list.length===0?<div className="empty-state"><Package size={36}/><h2>Make your first move.</h2><Button variant="fashion" asChild><Link to="/shop">SHOP THE COLLECTION</Link></Button></div>:<OrderList list={list} detail={detail} setDetail={setDetail} current={current}/>}</section></>;
}
function OrderList({list,detail,setDetail,current}:{list:Order[];detail:string|null;setDetail:(v:string|null)=>void;current:Order|undefined}){
 const shopAgain=current?current.items.filter(it=>getProduct(it.productId)):[];
 const {add}=useStore();
 function reorderAll(){
  if(!current)return;
  let n=0;const skipped:string[]=[];
  for(const it of current.items){
   const p=getProduct(it.productId);
   if(!p){skipped.push(it.name);continue;}
   const q=Math.min(it.qty,sizeStock(p,it.size));
   if(q<=0){skipped.push(`${it.name} (${it.size})`);continue;}
   for(let k=0;k<q;k++)add(it.productId,it.size);
   n+=q;
  }
  if(n>0){toast.success(`${n} piece${n>1?'s':''} re-added — review your bag.`);setDetail(null);}
  else toast.error('These pieces are currently out of stock.');
  if(skipped.length)toast.info(`Skipped (unavailable): ${skipped.slice(0,3).join(' · ')}${skipped.length>3?` +${skipped.length-3} more`:''}.`);
 }
 return <><div className="table-scroll"><table className="order-table"><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Payment</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col" /></tr></thead><tbody>{list.map(o=><tr key={o.id}><td>{o.id}</td><td>{new Date(o.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</td><td><span className="status-tag">{o.payment==='cod'?'Cash on delivery':'Bank transfer'}</span></td><td><span className={`status-tag ${o.status==='Delivered'?'done':o.status==='Cancelled'?'cancelled':'pending'}`}>{o.status}</span></td><td>{money(o.total)}</td><td><Button variant="link" size="sm" onClick={()=>setDetail(detail===o.id?null:o.id)}>{detail===o.id?'Hide':'Track'}</Button></td></tr>)}</tbody></table></div>
 {current&&<div className="preview-note mt-6"><h3>Tracking {current.id}</h3><OrderTimeline order={current}/><div className="order-items">{current.items.length===0?<p className="fine-print">Item lines unavailable for this order.</p>:current.items.map((it,i)=><p key={i}>{it.name} · {it.colour} · Size {it.size} × {it.qty} — {money(it.price*it.qty)}</p>)}</div>{current.discount>0&&<p>Discount {current.discountCode}: −{money(current.discount)}</p>}<p>Delivery ({current.shipping.method}): {current.shipping.price===0?'FREE':money(current.shipping.price)}</p><p><strong>Total{current.payment==='bank'&&current.paymentStatus!=='Paid'?' (awaiting approval)':''}: {money(current.total)}</strong></p>{shopAgain.length>0&&<div className="reorder-links"><Button variant="fashion" size="sm" onClick={reorderAll}>ADD ALL AGAIN</Button>{shopAgain.map(it=><Link key={it.productId} to="/product/$id" params={{id:it.productId}} className="text-link mt-4">SHOP {it.name.toUpperCase()} AGAIN <ArrowRight size={14}/></Link>)}</div>}</div>}</>;
}
