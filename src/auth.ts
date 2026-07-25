/**
 * Authentication utilities: session tokens (HMAC-SHA256 signed) and Google OAuth helpers.
 */

export interface SessionPayload {
  userId: string;
  email: string;
  exp: number;
}

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ENCODER = new TextEncoder();

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createSessionToken(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string
): Promise<string> {
  const full: SessionPayload = {
    ...payload,
    exp: Date.now() + SESSION_DURATION_MS,
  };
  const payloadStr = JSON.stringify(full);
  const payloadB64 = toBase64Url(ENCODER.encode(payloadStr));

  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENCODER.encode(payloadB64));
  const sigB64 = toBase64Url(sig);

  return `${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;
  const key = await getSigningKey(secret);

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sigB64),
    ENCODER.encode(payloadB64)
  );
  if (!valid) return null;

  try {
    const payloadStr = new TextDecoder().decode(fromBase64Url(payloadB64));
    const payload: SessionPayload = JSON.parse(payloadStr);
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [];
  for (let s = 0; s < 3; s++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      const bytes = new Uint8Array(1);
      crypto.getRandomValues(bytes);
      seg += chars[bytes[0] % chars.length];
    }
    segments.push(seg);
  }
  return segments.join('-');
}

export function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(token));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Google OAuth helpers
export interface GoogleUser {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  picture: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export async function findOrCreateGoogleUser(
  db: D1Database,
  googleUser: GoogleUser,
  adminEmail: string
): Promise<AuthenticatedUser> {
  const existingUser = await db.prepare('SELECT * FROM users WHERE google_id = ?')
    .bind(googleUser.id)
    .first<AuthenticatedUser>();

  if (existingUser) return existingUser;

  const userId = generateId();
  const isAdmin = adminEmail && googleUser.email === adminEmail ? 1 : 0;

  await db.prepare(
    `INSERT INTO users (id, google_id, email, display_name, avatar_url, is_admin)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      userId,
      googleUser.id,
      googleUser.email,
      googleUser.name || googleUser.email,
      googleUser.picture,
      isAdmin
    )
    .run();

  return { id: userId, email: googleUser.email };
}

export function getGoogleAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`Google OAuth error: ${data.error || 'no access token'}`);
  }
  return data.access_token;
}

export async function getGoogleUser(accessToken: string): Promise<GoogleUser> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Google API error: ${res.status}`);
  }

  const user = (await res.json()) as GoogleUser;
  if (!user.email || !user.verified_email) {
    throw new Error('Google account must have a verified email address');
  }

  return user;
}
