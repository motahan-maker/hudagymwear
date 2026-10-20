import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { sizes, money, sizeStock, productColours, productImage, type Product } from '@/lib/catalog';
import { useStore } from '@/components/store';
export function QuickView({product,open,onOpenChange}:{product:Product;open:boolean;onOpenChange:(value:boolean)=>void}){
  const [size,setSize]=useState('');
  // The colour is part of the line the shopper buys, so it is chosen here and
  // carried into the bag — never silently replaced by the product default.
  const [colour,setColour]=useState('');
  const {add}=useStore();
  const variants=productColours(product);
  const shownColour=colour||product.colour;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="quick-dialog"><img src={productImage(product,shownColour)} alt={`${product.name} in ${shownColour}`} width={600} height={750} loading="lazy" decoding="async"/><div><DialogTitle>{product.name}</DialogTitle><DialogDescription>{shownColour} · {product.salePrice?<>{money(product.salePrice)} (was {money(product.price)})</>:money(product.price)}</DialogDescription>{variants.length>1&&<><p className="option-label">COLOUR: {shownColour.toUpperCase()}</p><div className="colour-options">{variants.map(v=><button key={v.name} type="button" aria-label={`Choose ${v.name}`} aria-pressed={shownColour===v.name} title={v.name} className={`${v.tone} ${shownColour===v.name?'selected':''}`} onClick={()=>setColour(v.name)}/>)}</div></>}<p className="fine-print">Select your perfect fit</p><div className="size-options">{sizes.map(s=>{const left=sizeStock(product,s);return <Button key={s} variant="quiet" className={s===size?'selected':''} disabled={left<=0} aria-disabled={left<=0} aria-pressed={s===size} title={left<=0?`${s} — sold out`:s} onClick={()=>setSize(s)}>{s}</Button>})}</div><Button variant="fashion" disabled={!size} className="w-full" onClick={()=>{onOpenChange(false);add(product.id,size,shownColour)}}>ADD TO BAG</Button><Link to="/product/$id" params={{id:product.id}} className="text-link" onClick={()=>onOpenChange(false)}>VIEW FULL DETAILS</Link></div></DialogContent></Dialog>;
}
