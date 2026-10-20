import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Environment variables that must never be present at build time, and whose
 * values must never reach a client bundle.
 *
 * The store has three privileged secrets: the Supabase service-role key, the
 * Printify Personal Access Token, and the Supabase Edge Function secrets. All
 * three are server-side only. The Printify token in particular authorises real
 * production orders that are charged to the merchant card, so leaking it into
 * the browser would be a direct financial exposure.
 */
const FORBIDDEN_AT_BUILD = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "PRINTIFY_API_TOKEN",
  "PRINTIFY_TOKEN",
  "PRINTIFY_WEBHOOK_SECRET",
  "VITE_ADMIN_EMAIL",
  "VITE_ADMIN_PASS",
  "PUSH_WEBHOOK_SECRET",
  "VAPID_PRIVATE_KEY",
] as const;

/**
 * Fail the build if a privileged credential would be shipped to the browser.
 *
 * Two checks:
 *  1. At config time — a forbidden variable being present in the build
 *     environment is itself the mistake, because it means the operator copied a
 *     secret into a build-time slot.
 *  2. At emit time — the *value* of any forbidden variable that is somehow set
 *     is scanned for in the generated client bundle. Checking values rather
 *     than names means the public Supabase anon key and the VAPID public key
 *     are unaffected, so there are no false positives.
 */
function forbidSecretsInBundle(): Plugin {
  const values = FORBIDDEN_AT_BUILD.map((name) => process.env[name])
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
  const present = FORBIDDEN_AT_BUILD.filter((name) => process.env[name]);
  if (present.length) {
    throw new Error(
      `Refusing to build: ${present.join(", ")} must not be set in the build environment. ` +
        `Every VITE_ variable is inlined into the public JS bundle, and a privileged secret there is a security incident. ` +
        `Store these as Supabase Edge Function secrets instead (see supabase/PRINTIFY_SETUP.md).`,
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
