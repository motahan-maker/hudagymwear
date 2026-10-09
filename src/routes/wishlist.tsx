import { createFileRoute, Link } from '@tanstack/react-router';
import { Heart, ArrowRight } from 'lucide-react';
import { useStore, ProductCard } from '@/components/store';
import { products, pageHead } from '@/lib/catalog';
import { Button } from '@/components/ui/button';
export const Route=createFileRoute('/wishlist')({head:()=>pageHead('Your Wishlist','Keep your favourite HUDA GYMWEAR pieces close. Your personal activewear edit.'),component:Wishlist});
function Wishlist(){const {wishlist}=useStore();return <><div className="page-header"><span className="eyebrow">THE PIECES YOU LOVE</span><h1>Your Wishlist</h1><p>A little inspiration for your next move.</p></div><section className="section shop-section">{wishlist.length?<div className="product-grid">{products.filter(p=>wishlist.includes(p.id)).map(p=><ProductCard key={p.id} product={p}/>)}</div>:<div className="empty-state"><Heart size={36} strokeWidth={1}/><h2>Make it your own.</h2><p>Save the pieces that feel like you.</p><Button variant="fashion" asChild><Link to="/shop">FIND YOUR FAVOURITES <ArrowRight/></Link></Button></div>}</section></>}
