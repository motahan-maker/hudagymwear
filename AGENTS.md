## Storefront architecture
- Keep the storefront strictly client-side with in-memory shopping state in a shared React provider; this is a presentation prototype without backend integrations.
- Define catalog fixtures in a browser-safe catalog module and use dedicated TanStack routes for each shopping and content page; this keeps product references and navigation consistent.
- Define all storefront visual styling and semantic palette roles in src/styles.css and use the fashion, quiet and tool Button variants; this preserves a coherent premium design.
