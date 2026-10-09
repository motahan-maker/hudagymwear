import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminReviews, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/reviews')({head:()=>pageHead('AdminReviews','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminReviews/></AdminGuard>});
