import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Tests import the package by its public name, the way a customer does.
    alias: {
      "@dialgem/client/react": fileURLToPath(new URL("./src/react.ts", import.meta.url)),
      "@dialgem/client": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
})
