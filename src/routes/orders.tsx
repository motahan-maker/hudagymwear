import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ArrowRight, Package } from 'lucide-react';
import { toast } from 'sonner';
import { pageHead, money, getProduct, sizeStock } from '@/lib/catalog';
import { useStore } from '@/components/store';
import { getGuestOrder, statusIndex, PIPELINE, type Order } from '@/lib/orders';
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
 const [email,setEmail]=useState('');const [orderId,setOrderId]=useState('');const [searched,setSearched]=useState(false);
 const [detail,setDetail]=useState<string|null>(null);
 const [guest,setGuest]=useState<Order[]>([]);
  async function lookup(e:React.FormEvent){e.preventDefault();setSearched(true);setDetail(null);const o=await getGuestOrder(orderId.trim().toUpperCase(),email);setGuest(o?[o]:[]);}
 const list=guest;
 const current=list.find(o=>o.id===detail);
 return <><div className="page-wrap"><Breadcrumbs items={[{label:'Home',to:'/'},{label:'Your Orders'}]}/></div><div className="page-header"><span className="eyebrow">YOUR HUDA JOURNEY</span><h1>Your Orders</h1><p>Track with your order number and checkout email.</p></div><div className="account-box"><form className="lookup-form" onSubmit={lookup}><label className="form-field">Order email<input type="email" value={email} onChange={e=>{setEmail(e.target.value);setSearched(false);}} placeholder="you@example.co.uk" required/></label><label className="form-field">Order number<input value={orderId} onChange={e=>{setOrderId(e.target.value.toUpperCase());setSearched(false);}} placeholder="HG-1032" required aria-describedby="lookup-hint"/></label><p className="fine-print" id="lookup-hint">Find both on your confirmation message.</p><Button variant="fashion" type="submit">TRACK ORDER</Button></form>{searched&&(list.length===0?<div className="empty-state"><Package size={36}/><h2>No matching order.</h2><p>Check the order number and email, then try again.</p><Button variant="fashion" asChild><Link to="/shop">START SHOPPING</Link></Button></div>:<OrderList list={list} detail={detail} setDetail={setDetail} current={current}/>)}</div></>;
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
 return <><div className="table-scroll"><table className="order-table"><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Payment</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col" /></tr></thead><tbody>{list.map(o=><tr key={o.id}><td data-label="Order">{o.id}</td><td data-label="Date">{new Date(o.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</td><td data-label="Payment"><span className="status-tag">{o.payment==='cod'?'Cash on delivery':'Bank transfer'}</span></td><td data-label="Status"><span className={`status-tag ${o.status==='Delivered'?'done':o.status==='Cancelled'?'cancelled':'pending'}`}>{o.status}</span></td><td data-label="Total">{money(o.total)}</td><td className="no-label"><Button variant="link" size="sm" onClick={()=>setDetail(detail===o.id?null:o.id)}>{detail===o.id?'Hide':'Track'}</Button></td></tr>)}</tbody></table></div>
 {current&&<div className="preview-note mt-6"><h3>Tracking {current.id}</h3><OrderTimeline order={current}/><div className="order-items">{current.items.length===0?<p className="fine-print">Item lines unavailable for this order.</p>:current.items.map((it,i)=><p key={i}><span>{it.name} · {it.colour} · Size {it.size} × {it.qty}</span><strong>{money(it.price*it.qty)}</strong></p>)}</div><div className="order-totals">{current.discount>0&&<div className="bag-total discount"><span>Discount {current.discountCode}</span><strong>−{money(current.discount)}</strong></div>}<div className="bag-total"><span>Delivery ({current.shipping.method})</span><strong>{current.shipping.price===0?'FREE':money(current.shipping.price)}</strong></div><div className="bag-total grand"><span>Total{current.payment==='bank'&&current.paymentStatus!=='Paid'?' (awaiting approval)':''}</span><strong>{money(current.total)}</strong></div></div>{shopAgain.length>0&&<div className="reorder-links"><Button variant="fashion" size="sm" onClick={reorderAll}>ADD ALL AGAIN</Button>{shopAgain.map(it=><Link key={it.productId} to="/product/$id" params={{id:it.productId}} className="text-link">SHOP {it.name.toUpperCase()} AGAIN <ArrowRight size={14}/></Link>)}</div>}</div>}</>;
}
