import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useProducts, totalStock, sizeStock, toneFamilies } from '@/lib/catalog';
import { useVisibleCategories } from '@/lib/merch';
import { Breadcrumbs, type Crumb } from '@/components/breadcrumbs';
import { ProductCard } from '@/components/store';
import { Button } from '@/components/ui/button';

export function CollectionPage({category='all',query='',trail}:{category?:string;query?:string;trail?:Crumb[]}){
  const products = useProducts();
  const visibleCategories = useVisibleCategories();
  const [sort,setSort]=useState('featured');
  const [filters,setFilters]=useState(false);
  const [colour,setColour]=useState('all');
  const [size,setSize]=useState('all');
  const [max,setMax]=useState(100);
  const [availability,setAvailability]=useState('all');

  let filtered=products
    .filter(p => (p.status ?? 'Active') === 'Active')
    .filter(p=>(category==='all'||category==='new'&&p.badge==='NEW'||category==='best'&&p.badge==='BESTSELLER'||p.category===category))
    .filter(p=>(colour==='all'||p.tone===colour)&&(p.salePrice??p.price)<=max&&(!query||(p.name+' '+p.colour).toLowerCase().includes(query.toLowerCase()))&&(availability==='all'||totalStock(p)>0)&&(size==='all'||sizeStock(p,size)>0));

  if(sort==='low')filtered=[...filtered].sort((a,b)=>(a.salePrice??a.price)-(b.salePrice??b.price));
  if(sort==='high')filtered=[...filtered].sort((a,b)=>(b.salePrice??b.price)-(a.salePrice??a.price));

  const title=query?`Results for “${query}”`:category==='all'?'The Collection':category==='new'?'New In':category==='best'?'Best Sellers':category;
  const crumbs=trail??[{label:'Home',to:'/' as const},{label:title}];

  return <><div className="page-wrap"><Breadcrumbs items={crumbs}/><div className="page-header"><span className="eyebrow">YOUR STRENGTH. YOUR STYLE.</span><h1>{title}</h1><p>Considered essentials. Confident movement. Find your perfect fit.</p></div><section className="section shop-section"><div className="shop-toolbar"><nav className="category-tabs">{['all','new',...visibleCategories].map(c=><Link to="/shop" search={{category:c}} className={category===c?'active':''} key={c}>{c==='all'?'All Activewear':c==='new'?'New In':c}</Link>)}</nav><div className="sort-wrap"><span>{filtered.length} pieces</span><Button variant="quiet" onClick={()=>setFilters(!filters)}><SlidersHorizontal size={14}/> Filters</Button><select aria-label="Sort products" value={sort} onChange={e=>setSort(e.target.value)}><option value="featured">Featured</option><option value="low">Price: Low to High</option><option value="high">Price: High to Low</option></select></div></div>{filters&&<div className="filter-panel"><label>COLOUR<select aria-label="Filter colour" value={colour} onChange={e=>setColour(e.target.value)}><option value="all">All colours</option>{toneFamilies.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label>SIZE<select aria-label="Filter size" value={size} onChange={e=>setSize(e.target.value)}><option value="all">All sizes</option>{['XS','S','M','L','XL'].map(s=><option key={s}>{s}</option>)}</select></label><label>PRICE UP TO £{max}<input aria-label="Maximum price" type="range" min="30" max="100" step="5" value={max} onChange={e=>setMax(Number(e.target.value))}/></label><label>AVAILABILITY<select aria-label="Filter availability" value={availability} onChange={e=>setAvailability(e.target.value)}><option value="all">All pieces</option><option value="stock">In stock</option></select></label><Button variant="link" onClick={()=>{setColour('all');setSize('all');setMax(100);setAvailability('all')}}>Clear filters</Button></div>}{filtered.length?<div className="product-grid">{filtered.map(p=><ProductCard key={p.id} product={p}/>)}</div>:<div className="empty-state"><h2>Something new is on the horizon.</h2><p>{category==='Accessories'?'Our accessories edit is coming soon.':'Try a different search or explore the full collection.'}</p><Link to="/shop" search={{category:'all',q:''}} className="text-link">Explore all activewear</Link></div>}</section></div></>;
}
