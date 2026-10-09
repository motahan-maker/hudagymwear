import { createFileRoute } from '@tanstack/react-router';
import { HelpContent } from '@/components/help-content';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/faq')({head:()=>pageHead('Frequently Asked Questions','HUDA GYMWEAR frequently asked questions. Here for you and your next move.'),component:()=> <HelpContent topic="faq" title="Frequently Asked Questions"/>});
