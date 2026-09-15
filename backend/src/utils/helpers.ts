/**
 * Convert amount in cents to MUR currency string
 */
export function formatCurrency(cents: number): string {
  const mur = cents / 100;
  return new Intl.NumberFormat('en-MU', {
    style: 'currency',
    currency: 'MUR',
  }).format(mur);
}

/**
 * Generate order number with prefix and zero-padding
 */
export function generateOrderNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Parse order number to extract prefix and sequence
 */
export function parseOrderNumber(orderNumber: string): { prefix: string; sequence: number } | null {
  const match = orderNumber.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return {
    prefix: match[1],
    sequence: parseInt(match[2], 10),
  };
}

/**
 * Calculate VAT from amount (Mauritius standard rate is 15%)
 */
export function calculateVAT(amount: number, vatRate: number = 15): number {
  return Math.round((amount * vatRate) / 100);
}

/**
 * Calculate service charge from amount
 */
export function calculateServiceCharge(amount: number, rate: number = 10): number {
  return Math.round((amount * rate) / 100);
}

/**
 * Round to nearest 5 cents (common rounding rule)
 */
export function roundToNearestFive(cents: number): number {
  return Math.round(cents / 5) * 5;
}
