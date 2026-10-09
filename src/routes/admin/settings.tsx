import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminSettings, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/settings')({head:()=>pageHead('AdminSettings','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminSettings/></AdminGuard>});


