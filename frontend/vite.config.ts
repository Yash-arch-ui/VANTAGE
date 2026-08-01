// Explicit build wiring.
//
// This project was forked from a Lovable-generated app whose entire build
// (router plugin, tailwind, nitro, path aliases, env injection) lived inside
// @lovable.dev/vite-tanstack-config — an opaque dependency that also shipped
// their error-reporting client. Everything it did is spelled out here instead.
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

// Nitro's build target. Vercel is the deploy target; a container build sets
// SERVER_PRESET=node-server.
const preset = process.env.SERVER_PRESET ?? "vercel";

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // Route TanStack Start's bundled server entry through src/server.ts,
      // which unwraps the 500s h3 would otherwise swallow.
      server: { entry: "server" },
    }),
    nitro({ preset }),
    viteReact(),
  ],
  server: {
    port: 3000,
    fs: {
      // config/contracts.ts imports contracts/deployments.json from the repo
      // root so the UI cannot drift from what Foundry actually deployed.
      allow: [".."],
    },
  },
  resolve: {
    // React and the TanStack packages must resolve to a single copy — two
    // instances of either produce hook errors that are miserable to debug.
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
  },
});
