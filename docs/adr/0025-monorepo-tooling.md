# ADR-0025: Monorepo tooling and TypeScript module setup

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** Phase 1 scaffold; tech_impl §1, §3, §14; builds on ADR-0001, ADR-0002

## Context
The specs name pnpm workspaces, TypeScript, Vitest and k6, but not versions, the module system, or how
workspace packages import each other in dev, test and production.

## Decision
- **Runtime:** Node.js `>=24` (developed on Node 26). Pure ESM (`"type": "module"`). pnpm 11 workspaces over
  `apps/*`, `packages/*`, `examples/*`.
- **Pinned toolchain:** TypeScript **6.0.3**, ESLint 10 + typescript-eslint 8 (`strictTypeChecked` +
  `stylisticTypeChecked`, `eslint-config-prettier`), Prettier 3, Vitest 5. TypeScript 7 (the native Go
  compiler) isn't used yet because typescript-eslint supports only `<6.1`; revisit when it does.
- **Compiler strictness** (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`.
- **Source-first packages:** relative imports use real `.ts` extensions, and `erasableSyntaxOnly` bans enums,
  namespaces and parameter properties. Node 26 can therefore run the source directly with built-in type stripping, and
  `rewriteRelativeImportExtensions` turns `.ts` into `.js` in emitted output. No tsx or ts-node.
- **Package exports:** each package exports `"@pulsegate/source": "./src/index.ts"` ahead of
  `types`/`default` → `./dist`. Root `tsconfig.json` (`customConditions`), Vitest and `node --conditions=@pulsegate/source`
  resolve the source; production and `tsc -p tsconfig.build.json` (which clears `customConditions`) use `dist`.
- **One root config for each tool:** a single `tsconfig.json` typechecks everything with `noEmit`; per-package
  `tsconfig.build.json` emits `dist`; one `vitest.config.ts` and one `eslint.config.js` at the root. Tests live
  next to the code as `src/**/*.test.ts`, with cross-package suites in `tests/`.
- Markdown (specs, ADRs) is excluded from Prettier, because it is hand-formatted.

## Alternatives considered
- **TypeScript project references (`tsc -b`)** — incremental builds, but every package needs `composite` setup and
  a build before typechecking. Not worth it at this size.
- **tsx / ts-node for dev** — an extra dependency and loader that Node 26 no longer needs.
- **Extension-less imports with `moduleResolution: bundler`** — doesn't match how Node resolves ESM at runtime.

## Consequences
- `pnpm check` (format, lint, typecheck, test) is the gate before commits and in CI.
- Packages must be built (`pnpm build`, topological) before running from `dist`; dev and tests never need a build.
- Cross-package resolution through the `@pulsegate/source` condition is configured but first exercised once
  `apps/gateway` depends on `@pulsegate/shared`.
