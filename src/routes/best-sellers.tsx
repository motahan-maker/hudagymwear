import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '@/components/collection-page';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/best-sellers')({head:()=>pageHead('Best Sellers','Discover the HUDA GYMWEAR best sellers edit. Confident essentials for your everyday.'),component:()=> <CollectionPage category="best"/>});
