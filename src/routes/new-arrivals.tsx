import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/new-arrivals')({head:()=>pageHead('New Arrivals','Discover the HUDA GYMWEAR new arrivals edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="new"/>});
