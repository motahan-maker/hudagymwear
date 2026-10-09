import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/sets')({head:()=>pageHead('Matching Sets','Discover the HUDA GYMWEAR matching sets edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Matching Sets"/>});
