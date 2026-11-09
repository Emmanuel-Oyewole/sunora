// Public API of the identity module. Other modules import only from here.
export { IdentityModule } from './identity.module.js';
export { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
export { CurrentUser } from './auth/current-user.decorator.js';
export type { AuthenticatedUser } from './contracts/authenticated-user.js';
