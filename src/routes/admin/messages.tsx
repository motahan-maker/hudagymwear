import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminMessages, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/messages')({head:()=>pageHead('AdminMessages','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminMessages/></AdminGuard>});
