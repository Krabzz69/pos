import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { getTenantIdFromRequest } from '../../utils/tenant';
import { getIo } from '../../utils/socket';
import { UserRole } from '@prisma/client';

export const onlineRouter = Router();

// ============================================
// PUBLIC ENDPOINTS (no auth required)
// ============================================

// Get public menu for online ordering
onlineRouter.get('/menu/:tenantSlug', async (req, res) => {
  try {
    const { tenantSlug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      include: {
        categories: {
          where: { isAvailable: true },
          include: {
            items: {
              where: { isAvailable: true },
              include: {
                variants: true,
                modifiers: true,
              },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    res.json({
      restaurant: {
        name: tenant.name,
        slug: tenant.slug,
        settings: tenant.settings,
      },
      categories: tenant.categories,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get delivery zones
onlineRouter.get('/delivery-zones/:tenantSlug', async (req, res) => {
  try {
    const { tenantSlug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const zones = await prisma.deliveryZone.findMany({
      where: {
        tenantId: tenant.id,
        isActive: true,
      },
    });

    res.json(zones);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create online order (guest checkout)
onlineRouter.post('/orders/:tenantSlug', async (req, res) => {
  try {
    const { tenantSlug } = req.params;
    const {
      type,
      customerName,
      customerPhone,
      customerEmail,
      customerAddress,
      requestedTime,
      deliveryZoneId,
      items,
      subtotal,
      discount = 0,
      serviceCharge = 0,
      vat,
      total,
      paymentMethod,
      notes,
    } = req.body;

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order must have at least one item' });
    }

    // Generate order number (separate sequence from POS)
    const existingOnlineOrdersCount = await prisma.onlineOrder.count({
      where: { tenantId: tenant.id },
    });
    const orderNumber = `W-${String(existingOnlineOrdersCount + 1).padStart(4, '0')}`;

    // Calculate delivery fee if applicable
    let deliveryFee = 0;
    if (type === 'DELIVERY' && deliveryZoneId) {
      const zone = await prisma.deliveryZone.findUnique({
        where: { id: deliveryZoneId },
      });
      if (zone) {
        deliveryFee = zone.fee;
        
        // Check minimum order
        if (subtotal < zone.minimumOrder) {
          return res.status(400).json({ 
            error: `Minimum order for this zone is ${zone.minimumOrder / 100} ${tenant.settings?.currency || 'MUR'}` 
          });
        }
      }
    }

    const onlineOrder = await prisma.$transaction(async (tx) => {
      // Create online order
      const createdOrder = await tx.onlineOrder.create({
        data: {
          tenantId: tenant.id,
          orderNumber,
          status: 'RECEIVED',
          type,
          customerName,
          customerPhone,
          customerEmail,
          customerAddress,
          requestedTime: requestedTime ? new Date(requestedTime) : null,
          deliveryZoneId: type === 'DELIVERY' ? deliveryZoneId : null,
          deliveryFee,
          items: {
            create: items.map((item: any) => ({
              itemId: item.itemId,
              itemName: item.itemName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              modifiers: item.modifiers,
              notes: item.notes,
              lineDiscount: item.lineDiscount || 0,
            })),
          },
          subtotal,
          discount,
          serviceCharge,
          vat,
          total: total + deliveryFee,
          paymentMethod,
          paymentStatus: paymentMethod === 'CASH' ? 'PENDING' : 'PENDING',
          notes,
        },
        include: {
          items: true,
        },
      });

      return createdOrder;
    });

    // Emit socket event to POS and kitchen
    getIo().to(`${tenant.id}:all`).emit('online-order:new', {
      orderId: onlineOrder.id,
      orderNumber: onlineOrder.orderNumber,
      type,
      customerName,
      total: onlineOrder.total,
      createdAt: onlineOrder.createdAt,
    });

    res.status(201).json(onlineOrder);
  } catch (error: any) {
    console.error('Error creating online order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get order status page (public)
onlineRouter.get('/order-status/:tenantSlug/:orderNumber', async (req, res) => {
  try {
    const { tenantSlug, orderNumber } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const order = await prisma.onlineOrder.findFirst({
      where: {
        tenantId: tenant.id,
        orderNumber,
      },
      include: {
        items: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Only show limited info for privacy
    res.json({
      orderNumber: order.orderNumber,
      status: order.status,
      type: order.type,
      customerName: order.customerName,
      total: order.total,
      createdAt: order.createdAt,
      acceptedAt: order.acceptedAt,
      preparingAt: order.preparingAt,
      readyAt: order.readyAt,
      dispatchedAt: order.dispatchedAt,
      completedAt: order.completedAt,
      items: order.items.map(item => ({
        itemName: item.itemName,
        quantity: item.quantity,
        notes: item.notes,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROTECTED ENDPOINTS (restaurant staff)
// ============================================

// Get all online orders
onlineRouter.get('/orders', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { status, page = '1', limit = '20' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = { tenantId };

    if (status) {
      where.status = status;
    }

    const [orders, total] = await Promise.all([
      prisma.onlineOrder.findMany({
        where,
        skip,
        take,
        include: {
          items: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.onlineOrder.count({ where }),
    ]);

    res.json({ orders, total, page: parseInt(page as string), totalPages: Math.ceil(total / take) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Accept online order
onlineRouter.post('/orders/:id/accept', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const order = await prisma.onlineOrder.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'RECEIVED') {
      return res.status(400).json({ error: 'Only pending orders can be accepted' });
    }

    const updatedOrder = await prisma.onlineOrder.update({
      where: { id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    // Push to kitchen display
    getIo().to(`${tenantId}:kitchen`).emit('kitchen:new-online-order', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      type: order.type,
      items: JSON.parse(JSON.stringify(await prisma.onlineOrderItem.findMany({ where: { orderId: id } }))),
      notes: order.notes,
      createdAt: order.createdAt,
    });

    // Print ticket notification
    getIo().to(`${tenantId}:pos`).emit('online-order:accepted-print', {
      orderNumber: order.orderNumber,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reject online order
onlineRouter.post('/orders/:id/reject', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { reason, autoRefund = false } = req.body;

    const order = await prisma.onlineOrder.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'RECEIVED') {
      return res.status(400).json({ error: 'Only pending orders can be rejected' });
    }

    const updatedOrder = await prisma.onlineOrder.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
      },
    });

    // Handle refund if payment was made
    if (order.paymentMethod !== 'CASH' && autoRefund) {
      // TODO: Trigger refund via payment gateway
      console.log(`Auto-refund triggered for order ${order.orderNumber}`);
    }

    getIo().to(`${tenantId}:all`).emit('online-order:rejected', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      reason,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update online order status
onlineRouter.patch('/orders/:id/status', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;
    const { status } = req.body;

    const order = await prisma.onlineOrder.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updateData: any = { status };

    // Add timestamps based on status
    if (status === 'PREPARING') updateData.preparingAt = new Date();
    if (status === 'READY') updateData.readyAt = new Date();
    if (status === 'OUT_FOR_DELIVERY') updateData.dispatchedAt = new Date();
    if (status === 'COMPLETED') updateData.completedAt = new Date();

    const updatedOrder = await prisma.onlineOrder.update({
      where: { id },
      data: updateData,
    });

    getIo().to(`${tenantId}:all`).emit('online-order:status-updated', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single online order details
onlineRouter.get('/orders/:id', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const order = await prisma.onlineOrder.findUnique({
      where: { id, tenantId },
      include: {
        items: true,
        deliveryZone: true,
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

// Mark online order as paid (for cash on delivery/pickup)
onlineRouter.post('/orders/:id/mark-paid', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const order = await prisma.onlineOrder.findUnique({
      where: { id, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.paymentMethod !== 'CASH') {
      return res.status(400).json({ error: 'Only cash orders can be marked as paid' });
    }

    const updatedOrder = await prisma.onlineOrder.update({
      where: { id },
      data: {
        paymentStatus: 'COMPLETED',
      },
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
