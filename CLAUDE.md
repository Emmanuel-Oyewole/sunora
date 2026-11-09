@AGENTS.md

## Claude Code specific
- Use plan mode before changes that touch the Prisma schema, a module's public API, or the generation lifecycle.
- Before editing behaviour, read the relevant spec section in `docs/` and name it in your plan.
- Finish by running the typecheck, lint and test commands for each app you changed, and report failures as they are.
  Do not report success on a partial run.