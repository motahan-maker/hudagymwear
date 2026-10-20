import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminInventory, AdminGuard } from '@/components/admin';

// The inventory screen accepts a search parameter so the product editor and
// the low-stock banner can deep-link to one product's stock row.
export const Route=createFileRoute('/admin/inventory')({
  validateSearch:(s:Record<string,unknown>):{q?:string}=>{const q=typeof s['q']==='string'&&s['q'].trim()!==''?s['q']:undefined;return q?{q}:{};},
  head:()=>pageHead('AdminInventory','HUDA GYMWEAR Brand Studio.'),
  component:AdminInventoryRoute,
});
function AdminInventoryRoute(){const {q}=Route.useSearch();return <AdminGuard><AdminInventory focus={q}/></AdminGuard>;}
