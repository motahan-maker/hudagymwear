import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { pageHead } from '@/lib/catalog';
import { submitMessage } from '@/lib/messages';
import campaign from '@/assets/campaign.png';
export const Route=createFileRoute('/launch')({head:()=>pageHead('The Next Chapter','Something strong is coming. Join the HUDA GYMWEAR collection launch preview.'),component:Launch});
function Launch(){const [err,setErr]=useState('');return <section className="launch-page"><img src={campaign} width={1717} height={916} alt="The next HUDA GYMWEAR collection"/><div className="hero-content"><span className="eyebrow brand-accent">THE NEXT CHAPTER / COMING SOON</span><h1>BUILT FOR HER.</h1><p>A new kind of energy.<br/>Be first in line for our next collection.</p><form className="launch-form" onSubmit={e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const em=String(fd.get('email')??'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)){setErr('Enter a valid email to join the list.');return;}setErr('');submitMessage({kind:'launch',email:em});toast.success('You are on the preview list — see you at launch.');e.currentTarget.reset()}}><input required type="email" name="email" aria-label="Launch email address" aria-describedby="launch-err" placeholder="Your email address"/><Button variant="tool" aria-label="Join launch list"><ArrowRight/></Button></form>{err&&<p className="field-error" id="launch-err" role="alert">{err}</p>}</div></section>}
