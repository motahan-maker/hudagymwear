import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/hoodies')({head:()=>pageHead('Hoodies','Discover the HUDA GYMWEAR hoodies edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Hoodies"/>});
