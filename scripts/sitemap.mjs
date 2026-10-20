// Generates public/sitemap.xml.
//
//   SITE_URL=https://your-domain npm run sitemap
//
// The product list is read from the catalogue when Supabase credentials are
// available, so admin-added products are included. Without credentials it
// falls back to the seed catalogue, which keeps the script usable offline.
//
// Only pages that should be indexed appear here. Private or transactional
// pages (/cart, /orders, /wishlist, /checkout) are excluded and are blocked
// in public/robots.txt instead.
import { writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, '') || 'https://hudagymwear.vercel.app';
const today = new Date().toISOString().slice(0, 10);

const staticPaths = [
  '/', '/shop', '/about', '/lookbook', '/help', '/launch',
  '/terms', '/privacy', '/cookies',
];
const seedProducts = [
  'sculpt-seamless-leggings', 'sculpt-seamless-bra', 'form-seamless-leggings',
  'elevate-long-sleeve', 'form-seamless-bra', 'sculpt-matching-set', 'form-matching-set',
  'huda-sculpt-zip-hoodie', 'huda-core-flare-pants', 'elevate-leggings',
];
const shopCats = [
  'Leggings', 'Sports Bras', 'Tops', 'Hoodies', 'Bottoms', 'Matching Sets', 'Accessories',
  'new', 'best',
];

/** Catalogue ids, from the database when it is reachable, otherwise the seed. */
async function productIds() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log('sitemap: no Supabase credentials, using the seed catalogue');
    return seedProducts;
  }
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb.from('products').select('id').eq('status', 'Active');
    if (error || !data?.length) throw new Error(error?.message || 'no rows');
    console.log(`sitemap: ${data.length} products from the catalogue`);
    return data.map((r) => r.id);
  } catch (err) {
    console.log(`sitemap: catalogue unavailable (${err.message}), using the seed catalogue`);
    return seedProducts;
  }
}

const products = await productIds();

const urls = [
  ...staticPaths.map((p) => ({ loc: p, changefreq: p === '/' ? 'daily' : 'weekly', priority: p === '/' ? '1.0' : '0.7' })),
  ...products.map((id) => ({ loc: `/product/${id}`, changefreq: 'weekly', priority: '0.8' })),
  ...shopCats.map((c) => ({ loc: `/shop?category=${encodeURIComponent(c)}`, changefreq: 'weekly', priority: '0.5' })),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
  .map((u) => `  <url><loc>${SITE}${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`)
  .join('\n')}\n</urlset>\n`;

writeFileSync(new URL('../public/sitemap.xml', import.meta.url), xml);
console.log(`sitemap.xml written with ${urls.length} URLs for ${SITE}`);
