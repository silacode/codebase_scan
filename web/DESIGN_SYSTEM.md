# Scan Review UI foundations

Approved Paper file `01M4PMYSG09S0DP0VY19BWYA8P`, token hash `4693999b`. The current direction is cool-white/navy/cobalt with warm risk colors, not the retired teal palette.

- `src/styles/global.css` imports Tailwind v4 and `src/styles/design-tokens.css` (the single semantic token source). Use Tailwind utilities such as `bg-surface`, `text-text-secondary`, `border-border`, `text-primary`. Content caps at `max-w-content` (1200px); mobile side padding is 20px.
- Geist is for UI; Geist Mono is for IDs, paths and commands. Google Fonts falls back to installed/system fonts. Display: 72/76 desktop, report: 44/48 desktop and 32/36 mobile.
- Import used primitives from `src/components/ui`: `Button` (primary/secondary/quiet; pending uses `disabled`), `InputField` (Base UI Field label and associated error), `Checkbox`, `Select` (Base UI portal), `Tabs`, `Accordion`, `Progress`, `Toggle`, `ToggleGroup`, `Badge`, `Notice`, `CopyButton` and `CommandBlock`. Keep new styles in Tailwind markup rather than creating a second token set. Only add a primitive after a real repeated use.
- Base UI owns keyboard and ARIA behaviors. Label inputs and icon buttons, use `role=alert` for errors and status for updates. Icons are static named Lucide imports with `aria-hidden=true` unless the icon itself carries a label; the small scan mark in `components/ui/ScanLogo.tsx` is the only bespoke SVG. Reuse `ScanLogo` rather than embedding its paths in consumers. Keep 44px-class controls on touch screens. Focus uses cobalt. `#root` isolates portals. Reduced motion removes transitions but not status/copy text.
- Commands are text, not executable UI. `CommandBlock` always displays selectable backend text; `CopyButton` announces success only after the clipboard resolves and reports rejection. JSON overrides use a file destination and never enter shell Copy all. Don't invent issue counts or risk claims: the API is authoritative.

Tests: `npm run test:web` owns its Vite server at 5186, stubs scan API responses, and writes screenshots to ignored `test-results/`. `npm run typecheck` includes the browser fixtures and config.
