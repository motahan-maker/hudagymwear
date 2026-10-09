import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Heart, Truck, RefreshCw, ArrowRight } from 'lucide-react';
import { products, money, sizes, sizeStock, totalStock, productImage, productColours, isSoldOut, pageHead, useProduct, useProducts } from '@/lib/catalog';
import { ProductReviews, Stars } from '@/components/reviews';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { averageRating } from '@/lib/reviews';
import { useStore, ProductCard } from '@/components/store';
import { Button } from '@/components/ui/button';

export const Route=createFileRoute('/product/$id')({head:({params})=>{const p=products.find(p=>p.id===params.id);return pageHead(p?.name??'Product',`Discover ${p?.name??'premium activewear'} from HUDA GYMWEAR. Your strength. Your style.`,{path:`/product/${params.id}`,...(p?{image:p.image}:{})})},component:ProductPage});

function ProductPage(){
  const {id}=Route.useParams();
  const allProducts = useProducts();
  const p = useProduct(id);
  const [size,setSize]=useState('');
  const [error,setError]=useState(false);
  const [guide,setGuide]=useState(false);
  const {add,wishlist,toggleWish}=useStore();
  const variants=p?productColours(p):[{name:'',tone:'onyx',images:['']}];
  const [colour,setColour]=useState('');
  const shownColour=colour||p?.colour;
  const [rating,setRating]=useState<{avg:number;count:number}|null>(null);

  useEffect(()=>{let live=true;averageRating(id).then(v=>{if(live)setRating({avg:v.avg,count:v.count});});return ()=>{live=false;};},[id]);

  if(!p)return <div className="empty-state"><h1>Piece not found</h1><Link to="/shop">Return to the collection</Link></div>;

  return <><div className="product-page"><Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'The Collection', to: '/shop' }, { label: p.name }]} /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.description ?? `${p.name} in ${p.colour} from HUDA GYMWEAR.`, brand: { '@type': 'Brand', name: 'HUDA GYMWEAR' }, ...(rating&&rating.count>0?{aggregateRating:{'@type':'AggregateRating',ratingValue:rating.avg,reviewCount:rating.count}}:{}), offers: { '@type': 'Offer', priceCurrency: 'GBP', price: p.salePrice ?? p.price, availability: totalStock(p) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' } }) }} /><div className="product-detail"><div className="detail-image"><img src={productImage(p,shownColour)} alt={`${p.name} in ${shownColour}`} width={768} height={1152} fetchPriority="high"/></div><div className="detail-copy"><span className="eyebrow">THE HUDA ESSENTIALS</span><h1>{p.name}</h1>{isSoldOut(p)&&<p className="sold-out-note">SOLD OUT</p>}<div className="detail-price">{p.salePrice?<><del>{money(p.price)}</del> {money(p.salePrice)}</>:money(p.price)}</div>{rating&&rating.count>0?<a className="rating-line" href="#reviews"><Stars value={rating.avg} size={14}/> {rating.avg.toFixed(1)} · {rating.count} review{rating.count===1?'':'s'}</a>:null}{p.description&&<p className="detail-intro">{p.description}</p>}<div className="option-label">COLOUR: {(shownColour??'').toUpperCase()}</div><div className="colour-options">{variants.map(v=><button key={v.name} type="button" aria-label={`Choose ${v.name}`} title={v.name} className={`${v.tone} ${shownColour===v.name?'selected':''}`} onClick={()=>setColour(v.name)}/>)}</div><div className="option-label"><span>SELECT SIZE {size&&`— ${size}`}</span><Button variant="link" size="sm" onClick={()=>setGuide(!guide)}>Size guide</Button></div>{guide&&<><p className="fine-print">Illustrative sizing — measurements in centimetres.</p><div className="table-scroll"><table className="size-table"><thead><tr><th scope="col">Size</th><th scope="col">UK</th><th scope="col">Waist</th><th scope="col">Hips</th></tr></thead><tbody>{sizes.map((s,i)=><tr key={s}><td>{s}</td><td>{6+i*2}</td><td>{60+i*5}–{65+i*5}</td><td>{85+i*5}–{90+i*5}</td></tr>)}</tbody></table></div></>}<div className="size-options">{sizes.map(s=>{const left=sizeStock(p,s);return <Button key={s} variant="quiet" className={s===size?'selected':''} disabled={left<=0} aria-pressed={s===size} title={left<=0?`${s} — sold out`:s} onClick={()=>{setSize(s);setError(false)}}>{s}</Button>})}</div>{error&&<p className="selection-error">Please select your size.</p>}<div className="add-row"><Button variant="fashion" disabled={isSoldOut(p)} onClick={()=>{if(!size){setError(true);return}add(p.id,size)}}>{isSoldOut(p)?'SOLD OUT':'ADD TO BAG'} <ArrowRight/></Button><Button variant="quiet" className={wishlist.includes(p.id)?'is-saved':''} aria-label="Save to wishlist" onClick={()=>toggleWish(p.id)}><Heart/></Button></div><div className="detail-assurance"><span><Truck/> UK delivery</span><span><RefreshCw/> Effortless returns</span></div><details><summary>FIT & FABRIC CARE</summary><p>Choose your usual size for a close fit. Wash inside out on a cool, gentle cycle. Air dry and avoid fabric softener. Product specifications are illustrative for this preview.</p></details><details><summary>DELIVERY & RETURNS</summary><p>Explore our <Link to="/help" search={{topic:'delivery'}}>delivery and returns page</Link> for customer care. Shipping options are presented in the checkout preview.</p></details></div></div></div><ProductReviews productId={p.id}/><section className="section"><div className="section-heading"><h2>Complete your everyday.</h2></div><div className="product-grid">{allProducts.filter(x=>x.id!==id && (x.status ?? 'Active') === 'Active').slice(0,4).map(p=><ProductCard key={p.id} product={p}/>)}</div></section></>;
}
