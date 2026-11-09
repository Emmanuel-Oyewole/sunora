/** The caller's identity from a verified access token. Plain data, so it can cross a service boundary. */
export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  role: 'USER' | 'ADMIN';
}
