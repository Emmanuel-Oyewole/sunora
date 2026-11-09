export const ACCESS_COOKIE = 'sunora_at';
export const REFRESH_COOKIE = 'sunora_rt';

export const JWT_ISSUER = 'sunora';
export const JWT_AUDIENCE = 'sunora-web';
export const JWT_ALGORITHM = 'HS256';

// Sent only to /auth/*. It's /auth, not /auth/refresh, so logout can read it too.
export const REFRESH_COOKIE_PATH = '/auth';
