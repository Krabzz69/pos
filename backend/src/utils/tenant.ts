import { Request } from 'express';
import { JwtPayload } from 'jsonwebtoken';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: (JwtPayload & { userId: string; tenantId: string; role: string }) | null;
    }
  }
}

/**
 * Extract tenant ID from request
 * Priority: query param > header > decoded token
 */
export function getTenantIdFromRequest(req: Request): string {
  // Try query parameter first
  if (req.query.tenantId) {
    return req.query.tenantId as string;
  }

  // Try header
  if (req.headers['x-tenant-id']) {
    return req.headers['x-tenant-id'] as string;
  }

  // Try from decoded JWT token
  if (req.user && (req.user as any).tenantId) {
    return (req.user as any).tenantId;
  }

  throw new Error('Tenant ID not found in request');
}

/**
 * Get user ID from request
 */
export function getUserIdFromRequest(req: Request): string {
  if (!req.user || !(req.user as any).userId) {
    throw new Error('User ID not found in request');
  }
  return (req.user as any).userId;
}

/**
 * Get user role from request
 */
export function getRoleFromRequest(req: Request): string {
  if (!req.user || !(req.user as any).role) {
    throw new Error('User role not found in request');
  }
  return (req.user as any).role;
}

/**
 * Generate order number with prefix and sequence
 */
export function generateOrderNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Calculate VAT amount from subtotal
 */
export function calculateVAT(subtotal: number, vatRate: number): number {
  return Math.round(subtotal * (vatRate / 100));
}

/**
 * Calculate service charge
 */
export function calculateServiceCharge(subtotal: number, rate: number): number {
  return Math.round(subtotal * (rate / 100));
}

/**
 * Format money for display (cents to currency string)
 */
export function formatMoney(cents: number, currency: string = 'MUR'): string {
  const amount = cents / 100;
  return `${amount.toFixed(2)} ${currency}`;
}
