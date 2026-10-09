// Generates public/sitemap.xml. Usage: SITE_URL=https://example.com npm run sitemap
// Product/category handles mirror the seed catalogue; admin-added items are
// covered by their listing pages (/shop) until a backend feed exists.
import { writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || process.env.VITE_SITE_URL || '').replace(/\/$/, '') || 'https://huda-gymwear.vercel.app';
const today = new Date().toISOString().slice(0, 10);

const staticPaths = [
  '/', '/shop', '/about', '/lookbook', '/launch',
  '/faq', '/contact', '/shipping', '/returns', '/size-guide', '/terms', '/privacy', '/cookies',
  '/new-arrivals', '/best-sellers', '/leggings', '/sports-bras', '/tops', '/hoodies', '/bottoms', '/sets', '/accessories',
];
const products = [
  'sculpt-seamless-leggings', 'sculpt-seamless-bra', 'form-seamless-leggings',
  'elevate-long-sleeve', 'form-seamless-bra', 'sculpt-matching-set', 'form-matching-set',
  'huda-sculpt-zip-hoodie', 'huda-core-flare-pants', 'elevate-leggings',
];
const shopCats = ['Leggings', 'Sports Bras', 'Tops', 'Hoodies', 'Bottoms', 'Matching Sets', 'Accessories'];

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
