import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Shipped to browsers through the customer's own bundler, which minifies. An unminified vendor
  // package keeps stack traces readable in a support ticket.
  minify: false,
  splitting: false,
  treeshake: true,
  // The hook is a separate entry so a page that does not use React never loads it.
  external: ["react"],
})
