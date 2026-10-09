import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/catalog';
import { HelpContent } from '@/components/help-content';
export const Route=createFileRoute('/help')({validateSearch:(s:Record<string,unknown>)=>({topic:typeof s['topic']==='string'?s['topic']:'delivery'}),head:()=>pageHead('Customer Care','Find help with HUDA GYMWEAR delivery, returns, sizing and customer care.'),component:Help});
function Help(){const {topic}=Route.useSearch();return <HelpContent topic={topic}/>}