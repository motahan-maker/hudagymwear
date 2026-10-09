import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/bottoms')({head:()=>pageHead('Bottoms','Discover the HUDA GYMWEAR bottoms edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Bottoms"/>});
