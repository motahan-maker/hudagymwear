import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminOverview, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/')({head:()=>pageHead('AdminOverview','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminOverview/></AdminGuard>});


