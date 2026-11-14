import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig(async ({ command }) => {
  // Dev-only JSX inspector. It stamps a `code-path` attribute on every
  // rendered element (source file:line). Handy locally; in a production
  // build it leaks exact source coordinates into the DOM and adds weight
  // to every element, so it is only loaded for `vite dev`/`serve`.
  const devOnlyPlugins =
    command === "serve"
      ? [(await import("kimi-plugin-inspect-react")).inspectAttr()]
      : []

  return {
    plugins: [
      devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
      ...devOnlyPlugins,
      react(),
    ],
    server: {
      port: 3000,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@contracts": path.resolve(__dirname, "./contracts"),
        "@db": path.resolve(__dirname, "./db"),
        "db": path.resolve(__dirname, "./db"),
      },
    },
    envDir: path.resolve(__dirname),
    build: {
      outDir: path.resolve(__dirname, "dist/public"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Explicit chunking: the entry must stay small and each vendor
          // family keeps its own cache lifespan.
          //  - vendor-react-dom : react-dom + scheduler (~150 KB that the
          //    previous config left inside the entry chunk by listing only
          //    the bare "react-dom" package id, which does not match the
          //    react-dom/client subpath actually imported by main.tsx)
          //  - vendor-react     : react + jsx-runtime
          //  - vendor-react-router
          //  - app-i18n         : the EN/BN dictionary (route-independent,
          //    ~73 KB raw) out of the entry
          manualChunks(id: string) {
            if (!id.includes("node_modules")) {
              if (id.includes("/src/i18n/")) return "app-i18n";
              return undefined;
            }
            if (/node_modules[\\/](react-dom|scheduler)[\\/]/.test(id)) return "vendor-react-dom";
            if (/node_modules[\\/]react-router[\\/]/.test(id)) return "vendor-react-router";
            if (/node_modules[\\/]react[\\/]/.test(id)) return "vendor-react";
            return undefined;
          },
        },
      },
    },
  }
})