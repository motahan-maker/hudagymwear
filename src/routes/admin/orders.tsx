import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminOrders, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/orders')({head:()=>pageHead('AdminOrders','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminOrders/></AdminGuard>});

