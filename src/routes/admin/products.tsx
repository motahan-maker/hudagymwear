import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminProducts, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/products')({validateSearch:(s:Record<string,unknown>):{q?:string}=>{const q=typeof s['q']==='string'?s['q']:undefined;return q?{q}:{};},head:()=>pageHead('AdminProducts','HUDA GYMWEAR Brand Studio.'),component:AdminProductsRoute});
function AdminProductsRoute(){const {q}=Route.useSearch();return <AdminGuard><AdminProducts initialQuery={q ?? undefined}/></AdminGuard>;}
