import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Privileged secrets whose VALUES must never reach a client bundle.
 *
 * The store has three: the Supabase service-role key, the Printify Personal
 * Access Token, and the Supabase Edge Function secrets. All are server-side
 * only. The Printify token in particular authorises real production orders
 * that are charged to the merchant card, so leaking it into the browser would
 * be a direct financial exposure.
 *
 * These are checked by VALUE in the emitted bundle, not by presence in the
 * environment. A deployment platform (Vercel, for one) exposes project
 * environment variables to the build, and a server-side secret being present
 * there is normal and harmless — what matters is whether its value ends up
 * in a file the browser can download.
 */
const FORBIDDEN_VALUES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY_SERVER",
  "PRINTIFY_API_TOKEN",
  "PRINTIFY_TOKEN",
  "PRINTIFY_WEBHOOK_SECRET",
  "PUSH_WEBHOOK_SECRET",
  "VAPID_PRIVATE_KEY",
  "VITE_ADMIN_EMAIL",
  "VITE_ADMIN_PASS",
] as const;

/**
 * Names that are a mistake whatever their value.
 *
 * Vite inlines every `VITE_`-prefixed variable into the public bundle, so
 * putting a secret behind that prefix guarantees a leak. These are refused at
 * config time, before anything is written.
 */
const FORBIDDEN_VITE_NAMES = [
  "VITE_SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SERVICE_ROLE_KEY",
  "VITE_PRINTIFY_API_TOKEN",
  "VITE_PRINTIFY_TOKEN",
  "VITE_PRINTIFY_WEBHOOK_SECRET",
  "VITE_ADMIN_EMAIL",
  "VITE_ADMIN_PASS",
  "VITE_WEBHOOK_SECRET",
  "VITE_SECRET",
] as const;

/**
 * Fail the build if a privileged credential would be shipped to the browser.
 *
 * Two checks:
 *  1. At config time — a `VITE_`-prefixed secret is refused outright. The
 *     prefix alone guarantees the value is inlined.
 *  2. At emit time — the VALUE of every privileged secret that happens to be
 *     in the build environment is scanned for in the generated bundle. Checking
 *     values rather than names means the public Supabase anon key and the
 *     VAPID public key are unaffected, so there are no false positives, and a
 *     secret leaked under any name is still caught.
 */
function forbidSecretsInBundle(): Plugin {
  const values = FORBIDDEN_VALUES.map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 12);

  return {
    name: "huda:forbid-secrets-in-bundle",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        const source = chunk.type === "chunk" ? chunk.code : chunk.source;
        if (typeof source !== "string") continue;
        for (const secret of values) {
          if (source.includes(secret)) {
            this.error(
              `Refusing to build: ${fileName} contains a privileged credential. ` +
                `Secrets must never be in a client bundle.`,
            );
          }
        }
        if (/\bVITE_ADMIN_(PASS|EMAIL)\b/.test(source)) {
          this.error(
            `Refusing to build: ${fileName} references VITE_ADMIN_PASS / VITE_ADMIN_EMAIL. ` +
              `Admin access is Supabase Auth + profiles.role = 'admin'; there is no password variable.`,
          );
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Only a `VITE_`-prefixed secret is refused outright: the prefix alone
  // guarantees the value is inlined into the public bundle.
  //
  // A server-side secret being PRESENT in the build environment is normal —
  // Vercel exposes project environment variables to the build — and is not by
  // itself a leak. Whether it reaches the browser is decided by the
  // emit-time value scan below, which is the check that actually matters.
  const present = FORBIDDEN_VITE_NAMES.filter((name) => process.env[name]);
  if (present.length) {
    throw new Error(
      `Refusing to build: ${present.join(", ")} must not be set in the build environment. ` +
        `Every VITE_ variable is inlined into the public JS bundle, so a secret behind that ` +
        `prefix is a guaranteed leak. Store it as a server-side secret instead — a Supabase ` +
        `Edge Function secret, or a table the Edge Function reads (see supabase/PRINTIFY_SETUP.md).`,
    );
  }

  return {
    server: {
      port: 8080,
      // Dev-only tunnel sharing; never applied to production builds.
      ...(mode === "development"
        ? { allowedHosts: [".trycloudflare.com"] }
        : {}),
    },
    // Vite 8 resolves tsconfig `paths` natively; the vite-tsconfig-paths plugin
    // now only emits a deprecation warning on every dev/build.
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      tailwindcss(),
      tanstackStart({ server: { entry: "server" } }),
      nitro(),
      viteReact(),
      forbidSecretsInBundle(),
    ],
  };
});
