import { createFileRoute } from '@tanstack/react-router';
import { HelpContent } from '@/components/help-content';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/shipping')({head:()=>pageHead('Shipping & Delivery','HUDA GYMWEAR shipping & delivery. Here for you and your next move.'),component:()=> <HelpContent topic="delivery" title="Shipping & Delivery"/>});
