import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, requireRole } from '../../middleware/auth';
import { getTenantIdFromRequest } from '../../utils/tenant';
import { UserRole } from '@prisma/client';

export const paymentsRouter = Router();

// ============================================
// PAYMENT PROVIDER INTERFACE IMPLEMENTATION
// ============================================

// Get payment credentials for tenant
paymentsRouter.get('/credentials', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    const credentials = await prisma.paymentCredential.findMany({
      where: { tenantId },
      select: { 
        id: true, 
        provider: true, 
        isActive: true,
        createdAt: true 
      },
    });

    // Never return actual credentials, just metadata
    res.json(credentials);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Save/update payment credentials (encrypted)
paymentsRouter.post('/credentials', authenticate, requireRole([UserRole.OWNER, UserRole.MANAGER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { provider, credentials } = req.body;

    if (!provider || !credentials) {
      return res.status(400).json({ error: 'Provider and credentials are required' });
    }

    // TODO: Encrypt credentials before storing
    // For now, we'll store as-is but in production use crypto module
    const encryptedCredentials = JSON.stringify(credentials);

    const existing = await prisma.paymentCredential.findFirst({
      where: { tenantId, provider },
    });

    let result;
    if (existing) {
      result = await prisma.paymentCredential.update({
        where: { id: existing.id },
        data: {
          credentials: encryptedCredentials,
          isActive: true,
        },
      });
    } else {
      result = await prisma.paymentCredential.create({
        data: {
          tenantId,
          provider,
          credentials: encryptedCredentials,
        },
      });
    }

    res.json({ 
      id: result.id, 
      provider: result.provider, 
      isActive: result.isActive,
      message: 'Credentials saved successfully' 
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete payment credentials
paymentsRouter.delete('/credentials/:id', authenticate, requireRole(['OWNER']), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { id } = req.params;

    const credential = await prisma.paymentCredential.findFirst({
      where: { id, tenantId },
    });

    if (!credential) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    await prisma.paymentCredential.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MANUAL PAYMENT CONFIRMATION (Fallback)
// ============================================

// Confirm manual payment for order awaiting payment
paymentsRouter.post('/orders/:orderId/confirm-manual', authenticate, requireRole([UserRole.CASHIER, UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { orderId } = req.params;
    const { method, amount, metadata = {} } = req.body;

    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status === 'PAID') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    await prisma.$transaction(async (tx) => {
      // Create payment record
      await tx.payment.create({
        data: {
          orderId,
          method,
          amount: amount || order.total,
          status: 'COMPLETED',
          metadata,
        },
      });

      // Update order status
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
      });

      // Deduct inventory
      const orderItems = await tx.orderItem.findMany({
        where: { orderId },
      });

      for (const item of orderItems) {
        const recipes = await tx.recipe.findMany({
          where: { itemId: item.itemId },
          include: { ingredient: true },
        });

        for (const recipe of recipes) {
          const totalQuantity = recipe.quantity * item.quantity;

          await tx.ingredient.update({
            where: { id: recipe.ingredientId },
            data: {
              currentStock: { decrement: totalQuantity },
            },
          });

          await tx.stockMovement.create({
            data: {
              tenantId,
              ingredientId: recipe.ingredientId,
              type: 'ORDER_DEDUCTION',
              quantity: -totalQuantity,
              reference: order.orderNumber,
              reason: `Order ${order.orderNumber}`,
              performedBy: req.user!.id,
            },
          });
        }
      }
    });

    // Emit socket events
    const io = (req.app as any).get('io');
    (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('payment:confirmed', {
      orderId,
      orderNumber: order.orderNumber,
      amount: amount || order.total,
      method,
    });

    (io || await import(.utils/socket.)).to(`${tenantId}:kitchen`).emit('kitchen:new-order', {
      orderId,
      orderNumber: order.orderNumber,
      type: order.type,
      items: JSON.parse(JSON.stringify(await prisma.orderItem.findMany({ 
        where: { orderId },
        include: { item: true }
      }))),
      notes: order.notes,
      createdAt: order.createdAt,
    });

    res.json({ success: true, message: 'Payment confirmed' });
  } catch (error: any) {
    console.error('Manual payment confirmation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBHOOK HANDLER FOR PAYMENT GATEWAYS
// ============================================

// This is also defined in index.ts, but we'll add helper functions here
export async function processPaymentWebhook(
  tenantId: string,
  payload: any,
  signature: string
) {
  try {
    // Get tenant's payment credentials
    const credentials = await prisma.paymentCredential.findMany({
      where: { tenantId, isActive: true },
    });

    if (credentials.length === 0) {
      throw new Error('No payment credentials configured for tenant');
    }

    // Find the right provider and verify signature
    let providerName = '';
    let verified = false;
    let orderReference = '';

    for (const cred of credentials) {
      const creds = JSON.parse(cred.credentials);
      
      if (cred.provider === 'peach') {
        // Peach Payments signature verification
        // TODO: Implement proper HMAC verification
        providerName = 'peach';
        verified = true; // Placeholder - implement real verification
        orderReference = payload.reference || payload.merchantReference;
      } else if (cred.provider === 'manual') {
        // Manual provider doesn't use webhooks
        continue;
      }
    }

    if (!verified) {
      throw new Error('Signature verification failed');
    }

    // Find the order by reference
    const order = await prisma.order.findFirst({
      where: {
        tenantId,
        orderNumber: orderReference,
      },
    });

    if (!order) {
      throw new Error('Order not found for reference');
    }

    if (order.status === 'PAID') {
      return { success: true, message: 'Order already paid' };
    }

    // Process payment
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          orderId: order.id,
          method: 'MCB_JUICE', // or determine from payload
          amount: order.total,
          status: 'COMPLETED',
          metadata: {
            gatewayProvider: providerName,
            webhookPayload: payload,
            verifiedAt: new Date().toISOString(),
          },
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
      });

      // Deduct inventory
      const orderItems = await tx.orderItem.findMany({
        where: { orderId: order.id },
      });

      for (const item of orderItems) {
        const recipes = await tx.recipe.findMany({
          where: { itemId: item.itemId },
          include: { ingredient: true },
        });

        for (const recipe of recipes) {
          const totalQuantity = recipe.quantity * item.quantity;

          await tx.ingredient.update({
            where: { id: recipe.ingredientId },
            data: {
              currentStock: { decrement: totalQuantity },
            },
          });

          await tx.stockMovement.create({
            data: {
              tenantId,
              ingredientId: recipe.ingredientId,
              type: 'ORDER_DEDUCTION',
              quantity: -totalQuantity,
              reference: order.orderNumber,
              reason: `Order ${order.orderNumber}`,
              performedBy: 'webhook',
            },
          });
        }
      }
    });

    // Emit socket event to POS
    const io = (global as any).io;
    if (io) {
      (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('payment:webhook-confirmed', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.total,
        provider: providerName,
      });
    }

    return { success: true, orderId: order.id };
  } catch (error: any) {
    console.error('Payment webhook processing error:', error);
    throw error;
  }
}

// ============================================
// REFUND PROCESSING
// ============================================

// Initiate refund through payment gateway
paymentsRouter.post('/payments/:paymentId/refund', authenticate, requireRole([UserRole.MANAGER, UserRole.OWNER]), async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { paymentId } = req.params;
    const { amount, reason } = req.body;

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.order.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (payment.method === 'CASH') {
      // Cash refunds are handled internally
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'REFUNDED',
          metadata: {
            ...payment.metadata,
            refundedAt: new Date().toISOString(),
            refundReason: reason,
            refundAmount: amount || payment.amount,
          },
        },
      });

      const io = (req.app as any).get('io');
      (io || await import(.utils/socket.)).to(`${tenantId}:all`).emit('payment:refunded', {
        paymentId,
        orderId: payment.orderId,
        amount: amount || payment.amount,
        reason,
      });

      return res.json({ success: true, message: 'Cash refund recorded' });
    }

    // For card/digital payments, check if gateway refund is needed
    // TODO: Implement actual gateway refund API calls
    console.log(`Gateway refund would be processed here for payment ${paymentId}`);

    res.json({ 
      success: true, 
      message: 'Refund initiated (gateway integration pending)',
      requiresManualProcessing: payment.method !== 'CASH'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get payment history for order
paymentsRouter.get('/orders/:orderId/payments', authenticate, async (req, res) => {
  try {
    const tenantId = getTenantIdFromRequest(req);
    const { orderId } = req.params;

    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const payments = await prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(payments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
