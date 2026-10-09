import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { AdminAnalytics, AdminGuard } from '@/components/admin';
export const Route=createFileRoute('/admin/analytics')({head:()=>pageHead('AdminAnalytics','HUDA GYMWEAR Brand Studio.'),component:()=><AdminGuard><AdminAnalytics/></AdminGuard>});


