import { createFileRoute } from '@tanstack/react-router';
import { HelpContent } from '@/components/help-content';
import { pageHead } from '@/lib/catalog';
export const Route=createFileRoute('/contact')({head:()=>pageHead('Contact','HUDA GYMWEAR contact. Here for you and your next move.'),component:()=> <HelpContent topic="contact" title="Contact"/>});
