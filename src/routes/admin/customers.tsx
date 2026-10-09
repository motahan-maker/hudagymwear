import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminCustomers, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/customers')({head:()=>pageHead('AdminCustomers','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminCustomers/></AdminGuard>});


