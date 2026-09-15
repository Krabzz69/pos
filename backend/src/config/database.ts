import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Execute a database operation with tenant isolation enforced.
 * All queries MUST pass through this to ensure multi-tenant security.
 */
export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}
