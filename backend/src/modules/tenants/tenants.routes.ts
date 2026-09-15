import { Router, Request } from 'express';
import { prisma } from '../../config/database';
import { authenticate, AuthRequest, requireRole } from '../../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { UserRole } from '@prisma/client';

export const tenantsRouter = Router();

// All tenant routes require authentication
tenantsRouter.use(authenticate);

/**
 * GET /api/tenants/my
 * Get current tenant info
 */
tenantsRouter.get('/my', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: {
      id: true,
      name: true,
      subdomain: true,
      slug: true,
      status: true,
      plan: true,
      settings: true,
      createdAt: true,
    },
  });

  res.json({ tenant });
});

/**
 * GET /api/tenants/settings
 * Get tenant settings
 */
tenantsRouter.get('/settings', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { settings: true },
  });

  res.json({ settings: tenant?.settings || {} });
});

/**
 * PUT /api/tenants/settings
 * Update tenant settings (owner/manager only)
 */
tenantsRouter.put('/settings', authenticate, requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { settings } = req.body;

  const tenant = await prisma.tenant.update({
    where: { id: req.user.tenantId },
    data: { settings },
    select: {
      id: true,
      name: true,
      settings: true,
    },
  });

  res.json({ tenant });
});

/**
 * GET /api/tenants/stats
 * Get basic tenant statistics
 */
tenantsRouter.get('/stats', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const [userCount, itemCount, orderCount] = await Promise.all([
    prisma.user.count({
      where: { tenantId: req.user.tenantId, isActive: true },
    }),
    prisma.menuItem.count({
      where: { tenantId: req.user.tenantId },
    }),
    prisma.order.count({
      where: { tenantId: req.user.tenantId },
    }),
  ]);

  res.json({
    stats: {
      users: userCount,
      menuItems: itemCount,
      orders: orderCount,
    },
  });
});
