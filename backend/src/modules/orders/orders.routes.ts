import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { getTenantIdFromRequest } from '../../utils/tenant';
import { getIo } from '../../utils/socket';
import { UserRole } from '@prisma/client';

export const ordersRouter = Router();

// Get all orders for tenant (with filters)
ordersRouter.get('/', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { status, type, page = '1', limit = '20', search } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = { tenantId };

    if (status) {
      where.status = status;
    }

    if (type) {
      where.type = type;
    }

    if (search) {
      where.OR = [
        { orderNumber: { contains: search as string } },
        { customerName: { contains: search as string } },
        { customerPhone: { contains: search as string } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take,
        include: {
          items: {
            include: {
              item: true,
            },
          },
          table: true,
          createdBy: {
            select: { name: true, role: true },
          },
          payments: true,
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

// Get single order by ID or order number
ordersRouter.get('/:idOrNumber', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { idOrNumber } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        tenantId,
        OR: [
          { id: idOrNumber },
          { orderNumber: idOrNumber },
        ],
      },
      include: {
        items: {
          include: {
            item: true,
          },
        },
        table: true,
        createdBy: {
          select: { name: true, role: true },
        },
        payments: true,
        shift: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new order (POS checkout)
ordersRouter.post('/', authenticate, requireRole([UserRole.CASHIER, UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const userId = req.user!.id;
    
    const {
      type,
      tableId,
      customerId,
      customerName,
      customerPhone,
      customerAddress,
      items,
      subtotal,
      discount = 0,
      serviceCharge = 0,
      vat,
      total,
      payments,
      notes,
      shiftId,
      isParked = false,
    } = req.body;

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order must have at least one item' });
    }

    if (!subtotal || !vat || !total) {
      return res.status(400).json({ error: 'Missing price calculations' });
    }

    // Generate order number
    const existingOrdersCount = await prisma.order.count({
      where: { tenantId },
    });
    const orderNumber = `P-${String(existingOrdersCount + 1).padStart(4, '0')}`;

    // Start transaction
    const order = await prisma.$transaction(async (tx) => {
      // Create order
      const createdOrder = await tx.order.create({
        data: {
          tenantId,
          orderNumber,
          type,
          status: isParked ? 'PARKED' : (payments && payments.length > 0 ? 'PAID' : 'AWAITING_PAYMENT'),
          tableId,
          customerId,
          customerName,
          customerPhone,
          customerAddress,
          createdById: userId,
          shiftId,
          items: {
            create: items.map((item: any) => ({
              itemId: item.itemId,
              itemName: item.itemName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              modifiers: item.modifiers,
              notes: item.notes,
              lineDiscount: item.lineDiscount || 0,
              station: item.station,
            })),
          },
          subtotal,
          discount,
          serviceCharge,
          vat,
          total,
          notes,
          paidAt: payments && payments.length > 0 ? new Date() : null,
        },
        include: {
          items: true,
        },
      });

      // Create payments if provided
      if (payments && payments.length > 0) {
        await tx.payment.createMany({
          data: payments.map((p: any) => ({
            orderId: createdOrder.id,
            method: p.method,
            amount: p.amount,
            status: 'COMPLETED',
            metadata: p.metadata,
          })),
        });

        // Deduct inventory for each item
        for (const orderItem of createdOrder.items) {
          const recipes = await tx.recipe.findMany({
            where: { itemId: orderItem.itemId },
            include: { ingredient: true },
          });

          for (const recipe of recipes) {
            const totalQuantity = recipe.quantity * orderItem.quantity;
            
            await tx.ingredient.update({
              where: { id: recipe.ingredientId },
              data: {
                currentStock: {
                  decrement: totalQuantity,
                },
              },
            });

            await tx.stockMovement.create({
              data: {
                tenantId,
                ingredientId: recipe.ingredientId,
                type: 'ORDER_DEDUCTION',
                quantity: -totalQuantity,
                reference: createdOrder.orderNumber,
                reason: `Order ${createdOrder.orderNumber}`,
                performedBy: userId,
              },
            });
          }
        }
      }

      return createdOrder;
    });

    // Emit socket event
    getIo().to(`${tenantId}:all`).emit('order:created', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      type,
      status: order.status,
      total,
      createdAt: order.createdAt,
    });

    if (order.status === 'PAID') {
      getIo().to(`${tenantId}:kitchen`).emit('kitchen:new-order', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        type,
        items: order.items,
        notes,
        createdAt: order.createdAt,
      });
    }

    res.status(201).json(order);
  } catch (error: any) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update order status
ordersRouter.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { status } = req.body;

    const order = await prisma.order.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: { status },
    });

    getIo().to(`${tenantId}:all`).emit('order:status-changed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Park/Resume order
ordersRouter.patch('/:id/park', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { park, cartData } = req.body;

    const order = await prisma.order.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: park ? 'PARKED' : 'PENDING',
        parkedCart: park ? cartData : null,
      },
    });

    getIo().to(`${tenantId}:pos`).emit('order:parker-updated', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      isParked: park,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel/Void order
ordersRouter.patch('/:id/cancel', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { reason } = req.body;

    const order = await prisma.order.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status === 'PAID' || order.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Cannot cancel a paid/completed order. Use refund instead.' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        notes: reason ? `${order.notes || ''}\n[Cancelled: ${reason}]` : order.notes,
      },
    });

    getIo().to(`${tenantId}:all`).emit('order:cancelled', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      reason,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Refund order
ordersRouter.post('/:id/refund', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { reason, amount, refundMethod } = req.body;

    const order = await prisma.order.findUnique({
      where: { id, tenantId },
      include: { payments: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'PAID' && order.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Can only refund paid orders' });
    }

    const refundAmount = amount || order.total;

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: refundAmount >= order.total ? 'REFUNDED' : 'COMPLETED',
      },
    });

    await prisma.payment.create({
      data: {
        orderId: id,
        method: refundMethod || 'CASH',
        amount: -refundAmount,
        status: 'REFUNDED',
        metadata: { reason, refundedBy: req.user!.id, refundedAt: new Date().toISOString() },
      },
    });

    getIo().to(`${tenantId}:all`).emit('order:refunded', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: refundAmount,
      reason,
    });

    res.json({ success: true, order: updatedOrder });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get parked orders
ordersRouter.get('/parked', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const parkedOrders = await prisma.order.findMany({
      where: {
        tenantId,
        status: 'PARKED',
      },
      include: {
        items: true,
        createdBy: {
          select: { name: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json(parkedOrders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get today's orders summary
ordersRouter.get('/summary/today', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalOrders, totalRevenue, ordersByType, ordersByStatus] = await Promise.all([
      prisma.order.count({
        where: {
          tenantId,
          createdAt: { gte: today },
          status: { not: 'CANCELLED' },
        },
      }),
      prisma.order.aggregate({
        where: {
          tenantId,
          createdAt: { gte: today },
          status: { not: 'CANCELLED' },
        },
        _sum: { total: true },
      }),
      prisma.order.groupBy({
        by: ['type'],
        where: {
          tenantId,
          createdAt: { gte: today },
          status: { not: 'CANCELLED' },
        },
        _count: true,
      }),
      prisma.order.groupBy({
        by: ['status'],
        where: {
          tenantId,
          createdAt: { gte: today },
        },
        _count: true,
      }),
    ]);

    res.json({
      totalOrders,
      totalRevenue: totalRevenue._sum.total || 0,
      ordersByType: ordersByType.reduce((acc, curr) => ({ ...acc, [curr.type]: curr._count }), {}),
      ordersByStatus: ordersByStatus.reduce((acc, curr) => ({ ...acc, [curr.status]: curr._count }), {}),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
