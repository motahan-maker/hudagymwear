import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/accessories')({head:()=>pageHead('Accessories','Discover the HUDA GYMWEAR accessories edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Accessories"/>});
