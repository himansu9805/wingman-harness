# AGENTS.md

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->
Astryx v0.7.4 · 173 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->

## Web styling and icons

Use Lucide React for application icons. Custom styles use `stylex.create` and Astryx `xstyle` props (or `stylex.props` on native elements), compiled by `@stylexjs/unplugin` in Vite. This compiler is now configured; the generated setup note above about no StyleX compiler is superseded. Keep design tokens for spacing and typography. Node component tests load `tests/stylex-register.mjs` to compile StyleX macros as well.

## Source ownership

- `src/app/` composes features and owns application navigation and the sidebar.
- `src/features/chat/` owns conversation APIs, streaming, transcript models, approvals, delegation display, and chat components.
- `src/features/schedules/` owns task APIs, scheduling state, schedule formatting, and task components.
- Each feature uses `api/` for server access, `model/` for hooks and pure state transformations, and `components/` for presentation.
- `src/shared/contracts/` holds server payload types used across features. `src/shared/api/` holds shared connection configuration and request errors. Shared code must not import features or application code.
- Features must not import application code or sibling feature internals. Coordinate features through `app/` callbacks and shared contracts. Models and API modules must not import presentation components.
- Import the owning module directly; do not add forwarding modules at old paths or broad barrel exports.
- Keep `src/main.tsx` and the CLI-generated `src/astryx-themes.js` at their existing integration paths.
- `tests/architecture.test.mjs` checks dependency boundaries; existing behavior tests remain in `tests/` and import feature modules directly.
