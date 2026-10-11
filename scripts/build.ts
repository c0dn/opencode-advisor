import { fileURLToPath, URL } from "node:url"
import { build, write } from "bun"
import solidPlugin from "@opentui/solid/bun-plugin"

// OpenCode compiles Solid JSX only outside node_modules, so installed copies load this compiled TUI entry.
const result = await build({
  entrypoints: [fileURLToPath(new URL("../tui.ts", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist", import.meta.url)),
  naming: "tui.js",
  format: "esm",
  target: "bun",
  packages: "external",
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const item of result.logs) console.error(item)
  process.exit(1)
}

await write(fileURLToPath(new URL("../dist/package.json", import.meta.url)), '{"type":"module"}\n')
