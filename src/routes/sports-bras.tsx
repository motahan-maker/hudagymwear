import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/sports-bras')({head:()=>pageHead('Sports Bras','Discover the HUDA GYMWEAR sports bras edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Sports Bras"/>});
