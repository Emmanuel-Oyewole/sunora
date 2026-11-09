# Sunora Web (Next.js)

Root `AGENTS.md` rules also apply. The design contract is `docs/sunora-front-end.md` (SUNORA-FE-001).

## Source of truth
- Colours, typography, spacing, motion: use the tokens in SUNORA-FE-001 section 4. Do not invent values.
- Screens and states: SUNORA-FE-001 section 6 and 7. Every screen implements loading, empty, error,
  interrupted and success states where the spec lists them.
- Stack (spec section 5.1): Tailwind CSS, shadcn/ui primitives, Lucide icons, Sonner toasts.
  Use shadcn/ui for buttons, inputs, dialogs, menus, tooltips, sheets, sidebar, skeletons and forms.
  Ask before adding any other UI library.
- Sonner is for short-lived confirmations only. Important errors, interrupted responses and validation
  failures must stay visible on the relevant screen, not only in a toast.
- Journey behaviour and acceptance criteria: `docs/sunora-user-journey.md`.

## Boundaries
- Never import from `apps/api`. Share contracts through a deliberate shared package only, after asking.
- The backend owns persistence, generation status, recovery state, titles, access control and usage limits.
  The frontend must never decide on its own that a generation completed, a conversation was saved or a
  deletion succeeded. It renders what the API returns (spec section 11).
- After a refresh, query or reconnect to the existing generation. Never resubmit the prompt.
- `NEXT_PUBLIC_*` values are bundled into the browser. Never put secrets in them.
  They are baked in at build time, so they must be passed as a build argument in Docker.

## Next.js specifics
- Default to Server Components. Add `'use client'` only for state, effects, event handlers or browser APIs,
  and keep client components small and at the leaves.
- `cacheComponents` is enabled. Anything that calls the API must be dynamic (inside `<Suspense>`) or explicitly uncached.
  A cached fetch to the API runs during `next build`, and the build fails when the API is not running.
- Server-side calls to the API use `API_INTERNAL_URL` (`http://api:3001` in Compose). Browser calls use `NEXT_PUBLIC_API_URL`.
- Auth is cookie-based. Never store tokens in `localStorage` or `sessionStorage`.
  Server Components forward the incoming `cookie` header to the API and use `cache: 'no-store'`
  so one user's session is never cached for another.
- Calls from the browser send `credentials: 'include'`. On a 401, attempt one refresh via `POST /auth/refresh`, then retry once.
  If that fails, go to sign-in. Never loop.
- Streaming client: native `EventSource` cannot send custom headers or a POST body. The streaming approach is an
  open decision (architecture spec section 9). Ask before choosing one.

## Rendering AI output
- AI responses are untrusted input. Model output must never become executable HTML. Render Markdown with a
  sanitizing pipeline and never use `dangerouslySetInnerHTML` on it.
- The Markdown renderer is still an open decision (spec section 5.3: evaluate streaming, code highlighting,
  tables, accessibility, security). Ask before choosing one. Once chosen, use exactly one; never add a second.
- The renderer must handle progressively arriving text, and must not replace partly rendered content with a
  generic loading screen.
- Code blocks, tables and long messages must stay readable at mobile width.

## UI quality bar
- Light and dark themes, with the system preference as the default. Desktop and mobile layouts.
- Use real `<button>`, `<a>` and `<label>` elements. Icon-only buttons need an `aria-label`.
  Keyboard navigation and visible focus are required (SUNORA-FE-001 section 8.2).
- Text contrast meets WCAG AA.
- Do not disable an interactive control while a request is in flight without showing why. Prevent duplicate submissions.

## Testing
- Unit and component tests: Vitest + React Testing Library, as `*.test.ts(x)` next to the file.
  Query by role and accessible name, not CSS classes.
- Vitest cannot render async Server Components. Cover those with Playwright (`e2e/`).
  Extract logic from server components into plain functions so it can be unit tested.
- Mock the API at the network boundary. Never call the real API or an AI provider from a unit test.
- Cover the spec's recovery states: refresh during generation, interrupted generation, retry.

## Docker
- `output: "standalone"` is required in `next.config.ts` for the production image. Do not remove it.
- The `public/` folder must exist, or the image build fails.
