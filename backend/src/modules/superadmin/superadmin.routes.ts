import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { UserRole } from '@prisma/client';

export const superadminRouter = Router();

// ============================================
// TENANT MANAGEMENT
// ============================================

superadminRouter.get('/tenants', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { status, plan, page = '1', limit = '50' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = {};
    if (status) where.status = status;
    if (plan) where.plan = plan;

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take,
        include: {
          _count: {
            select: {
              users: true,
              orders: true,
              onlineOrders: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.tenant.count({ where }),
    ]);

    res.json({ tenants, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

superadminRouter.post('/tenants', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { name, subdomain, slug, plan = 'FREE', settings = {} } = req.body;

    // Check for existing subdomain or slug
    const existing = await prisma.tenant.findFirst({
      where: {
        OR: [{ subdomain }, { slug }],
      },
    });

    if (existing) {
      return res.status(400).json({ 
        error: 'Subdomain or slug already exists' 
      });
    }

    const tenant = await prisma.tenant.create({
      data: {
        name,
        subdomain,
        slug,
        plan,
        settings,
        status: 'TRIAL',
      },
    });

    // Create owner user
    const { ownerEmail, ownerName, ownerPassword } = req.body;
    if (ownerEmail && ownerName && ownerPassword) {
      const passwordHash = Buffer.from(ownerPassword).toString('base64');
      
      await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: ownerEmail,
          passwordHash,
          name: ownerName,
          role: UserRole.OWNER,
        },
      });
    }

    res.json(tenant);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

superadminRouter.patch('/tenants/:id', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, plan, settings } = req.body;

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        status,
        plan,
        settings,
      },
    });

    res.json(tenant);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

superadminRouter.delete('/tenants/:id', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete by setting status to EXPIRED
    await prisma.tenant.update({
      where: { id },
      data: { status: 'EXPIRED' },
    });

    res.json({ success: true, message: 'Tenant suspended' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMPERSONATE TENANT (for support)
// ============================================

superadminRouter.post('/tenants/:id/impersonate', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const tenant = await prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, subdomain: true },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Log the impersonation
    await prisma.auditLog.create({
      data: {
        tenantId: id,
        userId: req.user!.id,
        action: 'SUPERADMIN_IMPERSONATION',
        entityType: 'Tenant',
        entityId: id,
        changes: { reason },
        ipAddress: req.ip,
      },
    });

    // Generate a temporary token for impersonation
    const jwt = require('jsonwebtoken');
    const impersonationToken = jwt.sign(
      {
        id: req.user!.id,
        tenantId: id,
        role: UserRole.SUPERADMIN,
        impersonating: true,
      },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '1h' }
    );

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
      },
      token: impersonationToken,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PLATFORM STATS
// ============================================

superadminRouter.get('/stats', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const [
      totalTenants,
      activeTenants,
      totalUsers,
      totalOrdersToday,
      totalRevenueToday,
      totalOnlineOrdersToday,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count(),
      (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return prisma.order.count({
          where: { createdAt: { gte: today } },
        });
      })(),
      (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return prisma.order.aggregate({
          where: { createdAt: { gte: today } },
          _sum: { total: true },
        });
      })(),
      (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return prisma.onlineOrder.count({
          where: { createdAt: { gte: today } },
        });
      })(),
    ]);

    res.json({
      tenants: {
        total: totalTenants,
        active: activeTenants,
        suspended: totalTenants - activeTenants,
      },
      users: totalUsers,
      orders: {
        today: totalOrdersToday,
        onlineToday: totalOnlineOrdersToday,
      },
      revenue: {
        today: (totalRevenueToday as any)._sum.total || 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PLATFORM INVOICES
// ============================================

superadminRouter.get('/invoices', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { status, period, page = '1', limit = '50' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = {};
    if (status) where.status = status;
    if (period) where.period = period;

    const [invoices, total] = await Promise.all([
      prisma.platformInvoice.findMany({
        where,
        skip,
        take,
        include: {
          tenant: { select: { name: true, subdomain: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.platformInvoice.count({ where }),
    ]);

    res.json({ invoices, total, page: parseInt(page as string) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

superadminRouter.post('/invoices', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { tenantId, amount, period } = req.body;

    const invoice = await prisma.platformInvoice.create({
      data: {
        tenantId,
        amount,
        period,
      },
    });

    res.json(invoice);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

superadminRouter.patch('/invoices/:id/status', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const invoice = await prisma.platformInvoice.update({
      where: { id },
      data: { status },
    });

    res.json(invoice);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AUDIT LOGS
// ============================================

superadminRouter.get('/audit-logs', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const { tenantId, action, page = '1', limit = '50' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      skip,
      take,
      include: {
        user: { select: { name: true, email: true } },
        tenant: { select: { name: true, subdomain: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.auditLog.count({ where });

    res.json({ logs, total, page: parseInt(page as string) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

superadminRouter.get('/health', authenticate, requireRole([UserRole.SUPERADMIN]), async (req, res) => {
  try {
    const dbCheck = await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbCheck ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    });
  } catch (error: any) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message 
    });
  }
});
