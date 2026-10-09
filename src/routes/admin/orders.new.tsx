import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminOrderDraft, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/orders/new')({head:()=>pageHead('AdminNewOrder','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminOrderDraft/></AdminGuard>});
