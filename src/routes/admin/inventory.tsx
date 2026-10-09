import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminInventory, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/inventory')({head:()=>pageHead('AdminInventory','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminInventory/></AdminGuard>});


