import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Hash a password
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a secure random PIN for POS login
 */
export function generatePIN(length: number = 4): string {
  const chars = '0123456789';
  let pin = '';
  for (let i = 0; i < length; i++) {
    pin += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pin;
}
