# Sunora API (NestJS)

Root `AGENTS.md` rules also apply. This file adds API-specific rules.

## Module layout
```
src/modules/<name>/
  <name>.module.ts  <name>.controller.ts  <name>.service.ts  <name>.repository.ts
  dto/  events/  index.ts      <- index.ts is the module's public API
src/common/   decorators, filters, shared event contracts (no business logic)
src/infra/    Prisma and other shared plumbing
src/config/   env validation (fails the boot on missing or inconsistent config)
```
Modules: auth, users, conversations, messages, generations, ai-provider, usage, mail, health.

## Module boundaries (the most important section)
- Import another module only through its `index.ts`. Never import its repository, controller or internals.
- A repository is the only code that queries its module's tables, and it is never exported.
  Other modules call the owning module's service.
- Reference other modules' data by ID. No cross-module joins.
  (Token tables in auth and users are the one deliberate exception: they are one identity unit.)
- Cross-module side effects use events from `src/common/events/`. The emitter and the listener never import each other.
- Never use `forwardRef()`. A circular dependency means the design needs an event or a third module. Ask.

## Conventions
- DTOs are classes with `class-validator` decorators. Interfaces vanish at runtime.
  The global `ValidationPipe` uses `whitelist`, `forbidNonWhitelisted` and `transform`.
- Controllers stay thin: parse input, call a service, shape the response. No business logic.
- Throw Nest `HttpException` subclasses only at the HTTP edge (controllers, guards). Services throw
  domain errors or the exceptions already used in the module.
- Read configuration through a typed config service (see `AuthConfig`), never `process.env` in business code.
- Log with Nest's `Logger`, never `console.log`.
- Every route is protected by the global JWT guard. Mark public routes with `@Public()`.
  Health routes (`/health/live`, `/health/ready`) must be `@Public()`.
- Keep the event loop free. CPU-heavy work (hashing aside) goes to a worker thread or is deferred.
- Never hold a database connection open for the length of a stream. Query, release, stream, then write back.

## Database (Prisma)
- Schema changes go through `prisma migrate dev`. Never edit an applied migration.
- Do not return password hashes or token hashes from a module's public methods.
- Atomic state changes (token claims, status transitions) use a conditional `updateMany` and check the count,
  not read-then-write.
- Prisma 7 generates the client to a custom path. Import from that path, not `@prisma/client`.

## Testing
- Unit tests sit next to the file as `*.spec.ts`. End-to-end tests live in `test/*.e2e-spec.ts` (supertest).
- Build tests with `Test.createTestingModule`. Mock at the boundary (repositories, the AI provider, mail provider), not your own services.
- Always `await app.close()` in `afterAll`, or Jest hangs.
- Every protected route needs a cross-user access test and an unauthenticated (401) test.
- Generation features need tests for: terminal states, client disconnect, refresh recovery, partial output kept,
  provider failure and timeout, and a deliberate restart-during-generation case.

## Docker and build
- Email templates (`src/modules/mail/templates/**`) must be listed under `assets` in `nest-cli.json`,
  or the app refuses to boot in the built image.
- `argon2` is a native module. If the image fails with a missing binding, do not use `--ignore-scripts` on the production install.
- Run as the non-root `node` user. Pin the Node version.