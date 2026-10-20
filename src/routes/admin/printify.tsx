import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminGuard } from '@/components/admin';
import { AdminPrintify } from '@/components/printify-admin';
export const Route=createFileRoute('/admin/printify')({head:()=>pageHead('AdminPrintify','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminPrintify/></AdminGuard>});
