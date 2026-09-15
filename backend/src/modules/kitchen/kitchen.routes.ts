import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { getTenantIdFromRequest } from '../../utils/tenant';
import { io } from '../../utils/socket';
import { UserRole } from '@prisma/client';

export const kitchenRouter = Router();

// Get all kitchen orders (active only)
kitchenRouter.get('/orders', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { station, status } = req.query;

    const where: any = {
      tenantId,
      status: {
        in: ['PAID', 'PREPARING', 'READY'],
      },
    };

    if (station) {
      where.items = {
        some: {
          station: station as string,
        },
      };
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            item: true,
          },
        },
        table: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Calculate wait time and color coding
    const ordersWithTiming = orders.map(order => {
      const minutesSinceOrder = Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60000);
      let urgency = 'green';
      if (minutesSinceOrder > 10) urgency = 'red';
      else if (minutesSinceOrder > 5) urgency = 'amber';

      return {
        ...order,
        minutesSinceOrder,
        urgency,
      };
    });

    res.json(ordersWithTiming);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update order item status (New -> Preparing -> Ready)
kitchenRouter.patch('/orders/:orderId/items/:itemId/status', authenticate, requireRole([UserRole.KITCHEN, UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { orderId, itemId } = req.params;
    const { status } = req.body;

    const orderItem = await prisma.orderItem.findFirst({
      where: {
        id: itemId,
        order: {
          id: orderId,
          tenantId,
        },
      },
    });

    if (!orderItem) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    const updatedItem = await prisma.orderItem.update({
      where: { id: itemId },
      data: { status },
    });

    // Check if all items are ready to update order status
    if (status === 'READY') {
      const allItems = await prisma.orderItem.findMany({
        where: { orderId },
      });

      const allReady = allItems.every(item => item.status === 'READY' || item.status === 'COMPLETED');
      
      if (allReady) {
        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'READY' },
        });

        (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('kitchen:order-ready', {
          orderId,
          orderNumber: orderItem.orderId,
        });
      }
    }

    (io || await import(.utils/socket.)).to(`${tenantId}:kitchen`).emit('kitchen:item-status-updated', {
      orderId,
      itemId,
      status,
    });

    res.json(updatedItem);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update entire order status
kitchenRouter.patch('/orders/:orderId/status', authenticate, requireRole([UserRole.KITCHEN, UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { orderId } = req.params;
    const { status } = req.body;

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        tenantId,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: { 
        status,
        ...(status === 'PREPARING' ? { preparingAt: new Date() } : {}),
        ...(status === 'READY' ? { readyAt: new Date() } : {}),
      },
    });

    // Update all items to match order status
    await prisma.orderItem.updateMany({
      where: { orderId },
      data: { 
        status: status === 'PREPARING' ? 'PREPARING' : status === 'READY' ? 'READY' : undefined,
      },
    });

    (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('kitchen:order-status-updated', {
      orderId,
      orderNumber: order.orderNumber,
      status,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get stations configuration
kitchenRouter.get('/stations', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    
    // Get unique stations from menu items
    const stations = await prisma.menuItem.findMany({
      where: { tenantId },
      select: { id: true },
    });

    // In a real app, this would come from tenant settings
    const defaultStations = [
      { id: 'grill', name: 'Grill Station' },
      { id: 'fryer', name: 'Fryer Station' },
      { id: 'drinks', name: 'Drinks Station' },
      { id: 'cold', name: 'Cold Prep' },
    ];

    res.json(defaultStations);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get order details for kitchen view
kitchenRouter.get('/orders/:id', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        tenantId,
      },
      include: {
        items: {
          include: {
            item: true,
          },
        },
        table: true,
        createdBy: {
          select: { name: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const minutesSinceOrder = Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60000);
    let urgency = 'green';
    if (minutesSinceOrder > 10) urgency = 'red';
    else if (minutesSinceOrder > 5) urgency = 'amber';

    res.json({
      ...order,
      minutesSinceOrder,
      urgency,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Mark order as completed (after customer receives)
kitchenRouter.post('/orders/:orderId/complete', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { orderId } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        tenantId,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('kitchen:order-completed', {
      orderId,
      orderNumber: order.orderNumber,
    });

    res.json(updatedOrder);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
