export const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
export const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';
export const PORT = parseInt(process.env.PORT || '3150', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';

// Encryption key for payment credentials (should be 32 bytes in production)
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
