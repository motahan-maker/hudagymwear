import { Link } from '@tanstack/react-router';

export type Crumb = {
  label: string;
  to?: '/' | '/shop' | '/orders';
  shopSearch?: { category?: string; q?: string };
};

// Single breadcrumb trail used site-wide (Home / Section / Page).
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={c.label}>
            {i > 0 && ' / '}
            {last || (!c.to && !c.shopSearch) ? (
              <span aria-current="page">{c.label}</span>
            ) : c.shopSearch ? (
              <Link to="/shop" search={{ category: c.shopSearch.category ?? 'all', q: c.shopSearch.q ?? '' }}>{c.label}</Link>
            ) : (
              <Link to={c.to ?? '/'}>{c.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
