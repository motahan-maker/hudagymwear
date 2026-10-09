import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/tops')({head:()=>pageHead('Tops','Discover the HUDA GYMWEAR tops edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="Tops"/>});
