import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { pageHead } from '@/lib/catalog';
import { getConsent, setConsent } from '@/lib/consent';
import { Button } from '@/components/ui/button';
export const Route=createFileRoute('/cookies')({head:()=>pageHead('Cookie Policy','Which cookies HUDA GYMWEAR uses and how to control them.'),component:Cookies});
function Cookies(){
 const [saved,setSaved]=useState(false);
 const current=getConsent();
 return <><div className="page-header"><span className="eyebrow">SMALL FILES, CLEAR RULES</span><h1>Cookie Policy</h1><p>Last updated October 2026</p></div><section className="section shop-section legal-page"><details open><summary>ESSENTIAL (ALWAYS ON)</summary><p>Bag, wishlist, sign-in session and cookie choice itself. The store cannot work without these. No consent needed.</p></details><details><summary>ANALYTICS (OPTIONAL)</summary><p>Helps us understand visits in aggregate. Runs only if you accept. Currently: {current?(current.preferences?'enabled':'disabled'):'not decided yet'}.</p></details><div className="admin-actions"><Button variant="quiet" onClick={()=>{setConsent(false);setSaved(true);}}>Essential only</Button><Button variant="fashion" onClick={()=>{setConsent(true);setSaved(true);}}>Accept all</Button></div>{saved&&<p className="field-ok" role="status">Preference saved — thank you.</p>}</section></>;}
