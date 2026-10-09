import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { CollectionPage } from '@/components/collection-page';
export const Route=createFileRoute('/shop')({validateSearch:(s:Record<string,unknown>):{category?:string;q?:string}=>({category:typeof s['category']==='string'?s['category']:'all',q:typeof s['q']==='string'?s['q']:''}),head:()=>pageHead('Shop the Collection','Discover HUDA GYMWEAR leggings, sports bras, tops and matching sets. Premium activewear in timeless tones.',{path:'/shop'}),component:Shop});
function Shop(){const {category='all',q=''}=Route.useSearch();return <CollectionPage category={category} query={q}/>}
