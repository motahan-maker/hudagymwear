import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminLogin } from '@/components/admin';
export const Route=createFileRoute('/admin/login')({head:()=>pageHead('AdminLogin','HUDA GYMWEAR Brand Studio.'),component:AdminLogin});


