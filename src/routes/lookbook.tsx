import { createFileRoute, Link } from '@tanstack/react-router';
import { pageHead, activeProducts, productImage } from '@/lib/catalog';
import { Button } from '@/components/ui/button';
import black from '@/assets/black-set.jpg';
import burgundy from '@/assets/burgundy-hoodie.jpg';
export const Route=createFileRoute('/lookbook')({head:()=>pageHead('The Lookbook','The HUDA GYMWEAR edit. Discover sculpting essentials, elevated layers and confident complete looks.'),component:Lookbook});
function Lookbook(){
 const live=activeProducts();
 const setItems=live.filter(p=>p.category==='Matching Sets');
 const hoodieItems=live.filter(p=>p.category==='Hoodies');
 const hero1=setItems[0];const hero2=hoodieItems[0];
 return <><div className="page-header"><span className="eyebrow brand-accent">THE HUDA EDIT / VOLUME 01</span><h1>The art of showing up.</h1><p>Strong silhouettes. Soft moments. A wardrobe in motion.</p></div>
 {setItems.length>0&&<section className="section editorial-grid"><img src={hero1?productImage(hero1):black} width={768} height={1152} alt={hero1?.name??'Matching sets'}/><div><span className="eyebrow">01 / MATCHING SETS</span><h2>A little strength.<br/>A lot of you.</h2><p>Clean lines, second-skin comfort and the confidence to own every move. The black-on-black essentials you'll come back to.</p><div className="account-welcome"><Button variant="fashion" asChild><Link to="/shop" search={{category:'Matching Sets'}}>SHOP THE COLLECTION</Link></Button>{hero1&&<Button variant="quiet" asChild><Link to="/product/$id" params={{id:hero1.id}}>SHOP THE LOOK</Link></Button>}</div></div></section>}
 {hoodieItems.length>0&&<section className="section editorial-grid reverse"><img src={hero2?productImage(hero2):burgundy} width={768} height={1152} loading="lazy" alt={hero2?.name??'Off-duty layers'}/><div><span className="eyebrow brand-accent">02 / HOODIES & LAYERS</span><h2>Beyond the studio.</h2><p>Warm up. Wind down. Elevated layers in our signature burgundy — made for everything between.</p><div className="account-welcome"><Button variant="fashion" asChild><Link to="/shop" search={{category:'Hoodies'}}>SHOP THE COLLECTION</Link></Button>{hero2&&<Button variant="quiet" asChild><Link to="/product/$id" params={{id:hero2.id}}>DISCOVER THE HERO PIECE</Link></Button>}</div></div></section>}</>;
}
