import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminDiscounts, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/discounts')({head:()=>pageHead('AdminDiscounts','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminDiscounts/></AdminGuard>});


