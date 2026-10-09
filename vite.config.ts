import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => {
  return {
    server: {
      port: 8080,
      // Dev-only tunnel sharing; never applied to production builds.
      ...(mode === "development"
        ? { allowedHosts: [".trycloudflare.com"] }
        : {}),
    },
    plugins: [
      tailwindcss(),
      tanstackStart({ server: { entry: "server" } }),
      nitro(),
      viteReact(),
      tsConfigPaths(),
    ],
  };
});
