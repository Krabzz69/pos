import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { getTenantIdFromRequest } from '../../utils/tenant';
import { getIo } from '../../utils/socket';
import { UserRole } from '@prisma/client';

export const adminRouter = Router();

// ============================================
// DASHBOARD
// ============================================

adminRouter.get('/dashboard/today', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      totalOrders,
      totalRevenue,
      ordersByType,
      ordersByStatus,
      topSellers,
      hourlyBreakdown,
      liveOrders,
      onlineOrderCount,
      onlineRevenue,
    ] = await Promise.all([
      // Total POS orders today
      prisma.order.count({
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
          status: { not: 'CANCELLED' },
        },
      }),
      // Total revenue today
      prisma.order.aggregate({
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
          status: { not: 'CANCELLED' },
        },
        _sum: { total: true },
      }),
      // Orders by type
      prisma.order.groupBy({
        by: ['type'],
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
          status: { not: 'CANCELLED' },
        },
        _count: true,
      }),
      // Orders by status
      prisma.order.groupBy({
        by: ['status'],
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
        },
        _count: true,
      }),
      // Top selling items
      prisma.orderItem.groupBy({
        by: ['itemId', 'itemName'],
        where: {
          order: {
            tenantId,
            createdAt: { gte: today, lt: tomorrow },
            status: { not: 'CANCELLED' },
          },
        },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 10,
      }),
      // Hourly breakdown
      prisma.$queryRaw`
        SELECT 
          EXTRACT(HOUR FROM "createdAt") as hour,
          COUNT(*) as count,
          SUM(total) as revenue
        FROM "Order"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" >= ${today}
          AND "createdAt" < ${tomorrow}
          AND "status" != 'CANCELLED'
        GROUP BY EXTRACT(HOUR FROM "createdAt")
        ORDER BY hour
      `,
      // Live orders (active now)
      prisma.order.findMany({
        where: {
          tenantId,
          status: { in: ['PENDING', 'AWAITING_PAYMENT', 'PAID', 'PREPARING', 'READY'] },
        },
        include: {
          items: { select: { itemName: true, quantity: true } },
          table: { select: { number: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      // Online orders today
      prisma.onlineOrder.count({
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
          status: { not: 'CANCELLED' },
        },
      }),
      // Online revenue
      prisma.onlineOrder.aggregate({
        where: {
          tenantId,
          createdAt: { gte: today, lt: tomorrow },
          status: { not: 'CANCELLED' },
        },
        _sum: { total: true },
      }),
    ]);

    res.json({
      summary: {
        totalOrders,
        totalRevenue: totalRevenue._sum.total || 0,
        averageTicket: totalOrders > 0 ? (totalRevenue._sum.total || 0) / totalOrders : 0,
        onlineOrders: onlineOrderCount,
        onlineRevenue: onlineRevenue._sum.total || 0,
        posOrders: totalOrders,
        posRevenue: totalRevenue._sum.total || 0,
      },
      ordersByType: ordersByType.reduce((acc, curr) => ({ ...acc, [curr.type]: curr._count }), {}),
      ordersByStatus: ordersByStatus.reduce((acc, curr) => ({ ...acc, [curr.status]: curr._count }), {}),
      topSellers: topSellers.map(s => ({
        itemId: s.itemId,
        itemName: s.itemName,
        quantitySold: s._sum.quantity || 0,
      })),
      hourlyBreakdown: hourlyBreakdown,
      liveOrders,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ORDERS MANAGEMENT
// ============================================

adminRouter.get('/orders', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { 
      startDate, 
      endDate, 
      type, 
      status, 
      paymentMethod, 
      createdByName,
      page = '1', 
      limit = '50' 
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = { tenantId };

    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    }

    if (type) where.type = type;
    if (status) where.status = status;
    if (createdByName) {
      where.createdBy = {
        name: { contains: createdByName as string, mode: 'insensitive' },
      };
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take,
        include: {
          items: { select: { itemName: true, quantity: true, unitPrice: true } },
          createdBy: { select: { name: true, role: true } },
          payments: true,
          table: { select: { number: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.count({ where }),
    ]);

    res.json({ orders, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/orders/:id/receipt', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          include: { item: true },
        },
        payments: true,
        createdBy: { select: { name: true } },
        table: true,
        shift: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Generate structured receipt data
    const receipt = {
      tenantId: order.tenantId,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      type: order.type,
      tableNumber: order.table?.number,
      cashier: order.createdBy.name,
      items: order.items.map(item => ({
        name: item.itemName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        modifiers: item.modifiers,
        notes: item.notes,
        lineTotal: (item.unitPrice * item.quantity) - item.lineDiscount,
      })),
      subtotal: order.subtotal,
      discount: order.discount,
      serviceCharge: order.serviceCharge,
      vat: order.vat,
      total: order.total,
      payments: order.payments.map(p => ({
        method: p.method,
        amount: p.amount,
        status: p.status,
      })),
      changeDue: order.payments
        .filter(p => p.status === 'COMPLETED')
        .reduce((sum, p) => sum + p.amount, 0) - order.total,
    };

    res.json(receipt);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MENU MANAGEMENT
// ============================================

adminRouter.get('/menu/full', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const categories = await prisma.category.findMany({
      where: { tenantId },
      include: {
        items: {
          include: {
            variants: true,
            modifiers: true,
            recipes: {
              include: { ingredient: true },
            },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/menu/items', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const {
      categoryId,
      name,
      description,
      price,
      photoUrl,
      prepTimeMinutes,
      variants,
      modifiers,
      recipes,
    } = req.body;

    const item = await prisma.menuItem.create({
      data: {
        tenantId,
        categoryId,
        name,
        description,
        price,
        photoUrl,
        prepTimeMinutes: prepTimeMinutes || 10,
        variants: variants ? { create: variants } : undefined,
        modifiers: modifiers ? { create: modifiers } : undefined,
        recipes: recipes ? { create: recipes } : undefined,
      },
      include: {
        variants: true,
        modifiers: true,
        recipes: { include: { ingredient: true } },
      },
    });

    // Emit socket event for real-time menu update
    getIo().to(`${tenantId}:all`).emit('menu:item-created', {
      itemId: item.id,
      name: item.name,
      price: item.price,
    });

    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put('/menu/items/:id', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const {
      name,
      description,
      price,
      photoUrl,
      prepTimeMinutes,
      isAvailable,
      manualOverride,
      sortOrder,
    } = req.body;

    const item = await prisma.menuItem.update({
      where: { id, tenantId },
      data: {
        name,
        description,
        price,
        photoUrl,
        prepTimeMinutes,
        isAvailable,
        manualOverride,
        sortOrder,
      },
    });

    getIo().to(`${tenantId}:all`).emit('menu:item-updated', {
      itemId: item.id,
      name: item.name,
      price: item.price,
      isAvailable: item.isAvailable,
    });

    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.delete('/menu/items/:id', authenticate, requireRole([UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    await prisma.menuItem.delete({
      where: { id, tenantId },
    });

    getIo().to(`${tenantId}:all`).emit('menu:item-deleted', { itemId: id });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INVENTORY MANAGEMENT
// ============================================

adminRouter.get('/inventory', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const ingredients = await prisma.ingredient.findMany({
      where: { tenantId },
      include: {
        supplier: { select: { name: true, phone: true } },
        _count: { select: { recipes: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Calculate availability status
    const inventoryWithStatus = ingredients.map(ing => ({
      ...ing,
      isLowStock: ing.currentStock < ing.lowStockThreshold,
      affectsItems: ing._count.recipes,
    }));

    res.json(inventoryWithStatus);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/inventory/ingredients', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const {
      name,
      unit,
      currentStock,
      lowStockThreshold,
      costPerUnit,
      supplierId,
    } = req.body;

    const ingredient = await prisma.ingredient.create({
      data: {
        tenantId,
        name,
        unit,
        currentStock,
        lowStockThreshold,
        costPerUnit,
        supplierId,
      },
    });

    getIo().to(`${tenantId}:all`).emit('inventory:ingredient-added', {
      ingredientId: ingredient.id,
      name: ingredient.name,
      currentStock: ingredient.currentStock,
    });

    res.json(ingredient);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.patch('/inventory/ingredients/:id/adjust', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { adjustment, reason, performedBy } = req.body;

    const ingredient = await prisma.ingredient.findUnique({
      where: { id, tenantId },
    });

    if (!ingredient) {
      return res.status(404).json({ error: 'Ingredient not found' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedIng = await tx.ingredient.update({
        where: { id },
        data: {
          currentStock: { increment: adjustment },
        },
      });

      await tx.stockMovement.create({
        data: {
          tenantId,
          ingredientId: id,
          type: 'STOCK_TAKE_ADJUSTMENT',
          quantity: adjustment,
          reason,
          performedBy: performedBy || req.user!.id,
        },
      });

      return updatedIng;
    });

    getIo().to(`${tenantId}:all`).emit('inventory:stock-adjusted', {
      ingredientId: id,
      newStock: updated.currentStock,
      adjustment,
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/inventory/waste', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { ingredientId, quantity, reason } = req.body;

    const wasteLog = await prisma.$transaction(async (tx) => {
      const log = await tx.wasteLog.create({
        data: {
          tenantId,
          ingredientId,
          quantity,
          reason,
          recordedBy: req.user!.id,
        },
      });

      await tx.ingredient.update({
        where: { id: ingredientId },
        data: { currentStock: { decrement: quantity } },
      });

      await tx.stockMovement.create({
        data: {
          tenantId,
          ingredientId,
          type: 'WASTE',
          quantity: -quantity,
          reason: `Waste: ${reason}`,
          performedBy: req.user!.id,
        },
      });

      return log;
    });

    getIo().to(`${tenantId}:all`).emit('inventory:waste-recorded', {
      ingredientId,
      quantity,
    });

    res.json(wasteLog);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/inventory/movements', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { ingredientId, type, page = '1', limit = '50' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = { tenantId };
    if (ingredientId) where.ingredientId = ingredientId;
    if (type) where.type = type;

    const movements = await prisma.stockMovement.findMany({
      where,
      skip,
      take,
      include: {
        ingredient: { select: { name: true, unit: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.stockMovement.count({ where });

    res.json({ movements, total, page: parseInt(page as string) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STAFF MANAGEMENT
// ============================================

adminRouter.get('/staff', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const users = await prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        pin: true,
        phone: true,
        isActive: true,
        createdAt: true,
        _count: { select: { orders: true, shifts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(users);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/staff', authenticate, requireRole([UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { email, password, name, role, pin, phone } = req.body;

    // Check if email already exists for this tenant
    const existing = await prisma.user.findFirst({
      where: { tenantId, email },
    });

    if (existing) {
      return res.status(400).json({ error: 'Email already registered for this restaurant' });
    }

    // Simple hash (use bcrypt in production)
    const passwordHash = Buffer.from(password).toString('base64');

    const user = await prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash,
        name,
        role,
        pin,
        phone,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        pin: true,
      },
    });

    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.patch('/staff/:id', authenticate, requireRole([UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { name, role, pin, phone, isActive } = req.body;

    const user = await prisma.user.update({
      where: { id, tenantId },
      data: { name, role, pin, phone, isActive },
      select: {
        id: true,
        name: true,
        role: true,
        pin: true,
        isActive: true,
      },
    });

    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// REPORTS
// ============================================

adminRouter.get('/reports/z-report', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { date } = req.query;

    const reportDate = date ? new Date(date as string) : new Date();
    reportDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(reportDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const [orders, payments, shifts] = await Promise.all([
      prisma.order.findMany({
        where: {
          tenantId,
          createdAt: { gte: reportDate, lt: nextDay },
          status: { not: 'CANCELLED' },
        },
        include: {
          createdBy: { select: { name: true } },
          payments: true,
        },
      }),
      prisma.payment.findMany({
        where: {
          order: {
            tenantId,
            createdAt: { gte: reportDate, lt: nextDay },
          },
        },
      }),
      prisma.shift.findMany({
        where: {
          tenantId,
          openedAt: { gte: reportDate, lt: nextDay },
        },
        include: {
          user: { select: { name: true } },
        },
      }),
    ]);

    const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);
    const totalDiscount = orders.reduce((sum, o) => sum + o.discount, 0);
    const totalVat = orders.reduce((sum, o) => sum + o.vat, 0);

    const paymentSummary = payments.reduce((acc, p) => {
      acc[p.method] = (acc[p.method] || 0) + p.amount;
      return acc;
    }, {} as Record<string, number>);

    res.json({
      reportDate: reportDate.toISOString(),
      generatedAt: new Date().toISOString(),
      summary: {
        totalOrders: orders.length,
        totalRevenue,
        totalDiscount,
        totalVat,
        netRevenue: totalRevenue - totalVat,
      },
      paymentSummary,
      ordersByType: orders.reduce((acc, o) => {
        acc[o.type] = (acc[o.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      shifts: shifts.map(s => ({
        user: s.user.name,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        openingBalance: s.openingBalance,
        closingBalance: s.closingBalance,
        overShort: s.overShort,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/reports/sales-by-item', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate as string) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate as string) : new Date();
    end.setHours(23, 59, 59, 999);

    const sales = await prisma.orderItem.groupBy({
      by: ['itemId', 'itemName'],
      where: {
        order: {
          tenantId,
          createdAt: { gte: start, lte: end },
          status: { not: 'CANCELLED' },
        },
      },
      _sum: { 
        quantity: true, 
        lineDiscount: true 
      },
      having: {
        itemId: { not: null },
      },
      orderBy: { _sum: { quantity: 'desc' } },
    });

    res.json(sales.map(s => ({
      itemId: s.itemId,
      itemName: s.itemName,
      quantitySold: s._sum.quantity || 0,
      totalDiscount: s._sum.lineDiscount || 0,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SETTINGS
// ============================================

adminRouter.get('/settings', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        subdomain: true,
        slug: true,
        settings: true,
        plan: true,
      },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json(tenant);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put('/settings', authenticate, requireRole([UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { name, settings } = req.body;

    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        name,
        settings: settings || {},
      },
    });

    res.json(tenant);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
