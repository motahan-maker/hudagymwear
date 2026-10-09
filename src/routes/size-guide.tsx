import { createFileRoute } from '@tanstack/react-router';
import { HelpContent } from '@/components/help-content';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/size-guide')({head:()=>pageHead('Size Guide','HUDA GYMWEAR size guide. Here for you and your next move.'),component:()=> <HelpContent topic="sizing" title="Size Guide"/>});
