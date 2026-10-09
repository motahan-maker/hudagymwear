import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/leggings')({head:()=>pageHead('Leggings','Discover the HUDA GYMWEAR leggings edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Leggings"/>});
