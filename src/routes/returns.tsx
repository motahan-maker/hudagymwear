import { createFileRoute } from '@tanstack/react-router';
import { HelpContent } from '@/components/help-content';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/returns')({head:()=>pageHead('Returns','HUDA GYMWEAR returns. Here for you and your next move.'),component:()=> <HelpContent topic="delivery" title="Returns"/>});
