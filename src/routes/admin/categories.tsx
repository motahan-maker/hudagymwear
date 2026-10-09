import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminCategories, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/categories')({head:()=>pageHead('AdminCategories','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminCategories/></AdminGuard>});


