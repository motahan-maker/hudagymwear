import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useNavigate,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { StoreProvider, StoreShell } from "@/components/store";

function NotFoundComponent() {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  return (
    <div className="empty-state section">
      <span className="eyebrow">LOST YOUR WAY?</span>
      <h1>Nothing here yet.</h1>
      <p>The page you are looking for has moved — but your next favourite fit hasn&apos;t.</p>
      <form
        className="promo-form notfound-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) navigate({ to: "/shop", search: { q: q.trim() } });
        }}
      >
        <input aria-label="Search products" placeholder="Search leggings, bras…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="quiet-button" aria-label="Search">→</button>
      </form>
      <div className="notfound-links">
        <Link to="/shop" className="text-link">Shop all</Link>
        <Link to="/shop" search={{ category: "new" }} className="text-link">New in</Link>
        <Link to="/shop" search={{ category: "best" }} className="text-link">Best sellers</Link>
        <Link to="/lookbook" className="text-link">Lookbook</Link>
        <Link to="/help" search={{ topic: "delivery" }} className="text-link">Help</Link>
      </div>
      <p className="fine-print">
        <Link to="/" className="text-link">← Back home</Link>
      </p>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "HUDA GYMWEAR | Your strength. Your style." },
      { name: "description", content: "Premium women's activewear. Designed for strength, styled for you." },
      { property: "og:title", content: "HUDA GYMWEAR" },
      { property: "og:description", content: "Premium women's activewear. Your strength. Your style." },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "en_GB" },
      { property: "og:site_name", content: "HUDA GYMWEAR" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "geo.region", content: "GB" },
      { name: "geo.placename", content: "London" },
      { name: "geo.position", content: "51.5074;-0.1278" },
      { name: "ICBM", content: "51.5074, -0.1278" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Cormorant+Garamond:wght@400;500;600&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'ClothingStore',
              name: 'HUDA GYMWEAR',
              description: "Premium women's activewear. Designed for strength, styled for you.",
              currenciesAccepted: 'GBP',
              priceRange: '££',
              paymentAccepted: 'Cash on delivery, Bank transfer',
              areaServed: {
                '@type': 'Country',
                name: 'United Kingdom',
              },
              address: {
                '@type': 'PostalAddress',
                addressCountry: 'GB',
                addressLocality: 'London',
              },
            }),
          }}
        />
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <StoreProvider><StoreShell><Outlet /></StoreShell></StoreProvider>
    </QueryClientProvider>
  );
}
