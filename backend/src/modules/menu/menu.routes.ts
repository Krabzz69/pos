import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, AuthRequest, requireRole } from '../../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { UserRole } from '@prisma/client';
import { emitToTenant } from '../../utils/socket';

export const menuRouter = Router();

// All menu routes require authentication
menuRouter.use(authenticate);

/**
 * GET /api/menu/categories
 * Get all categories for tenant
 */
menuRouter.get('/categories', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const categories = await prisma.category.findMany({
    where: { tenantId: req.user.tenantId },
    include: {
      items: {
        where: { isAvailable: true },
        include: {
          variants: true,
          modifiers: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { sortOrder: 'asc' },
  });

  res.json({ categories });
});

/**
 * POST /api/menu/categories
 * Create new category (manager/owner only)
 */
menuRouter.post('/categories', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { name, description, sortOrder = 0 } = req.body;

  const category = await prisma.category.create({
    data: {
      id: uuidv4(),
      tenantId: req.user.tenantId,
      name,
      description,
      sortOrder,
    },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:category:created', { category });
  }

  res.status(201).json({ category });
});

/**
 * PUT /api/menu/categories/:id
 * Update category
 */
menuRouter.put('/categories/:id', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;
  const { name, description, sortOrder, isAvailable, schedule } = req.body;

  const category = await prisma.category.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: {
      name,
      description,
      sortOrder,
      isAvailable,
      schedule,
    },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:category:updated', { category });
  }

  res.json({ category });
});

/**
 * DELETE /api/menu/categories/:id
 * Soft delete category
 */
menuRouter.delete('/categories/:id', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;

  await prisma.category.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: { isAvailable: false },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:category:deleted', { categoryId: id });
  }

  res.json({ message: 'Category deleted' });
});

/**
 * GET /api/menu/items
 * Get all menu items for tenant
 */
menuRouter.get('/items', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { categoryId, available } = req.query;

  const where: any = { tenantId: req.user.tenantId };
  
  if (categoryId) {
    where.categoryId = categoryId;
  }
  
  if (available !== undefined) {
    where.isAvailable = available === 'true';
  }

  const items = await prisma.menuItem.findMany({
    where,
    include: {
      category: true,
      variants: true,
      modifiers: true,
      recipes: {
        include: { ingredient: true },
      },
    },
    orderBy: { sortOrder: 'asc' },
  });

  res.json({ items });
});

/**
 * POST /api/menu/items
 * Create new menu item
 */
menuRouter.post('/items', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { 
    categoryId, 
    name, 
    description, 
    price, 
    photoUrl, 
    sortOrder = 0,
    prepTimeMinutes = 10,
  } = req.body;

  const item = await prisma.menuItem.create({
    data: {
      id: uuidv4(),
      tenantId: req.user.tenantId,
      categoryId,
      name,
      description,
      price, // in cents
      photoUrl,
      sortOrder,
      prepTimeMinutes,
    },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:item:created', { item });
  }

  res.status(201).json({ item });
});

/**
 * PUT /api/menu/items/:id
 * Update menu item
 */
menuRouter.put('/items/:id', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;
  const { 
    name, 
    description, 
    price, 
    photoUrl, 
    sortOrder,
    prepTimeMinutes,
    manualOverride,
  } = req.body;

  const item = await prisma.menuItem.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: {
      name,
      description,
      price,
      photoUrl,
      sortOrder,
      prepTimeMinutes,
      manualOverride,
    },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:item:updated', { item });
  }

  res.json({ item });
});

/**
 * PATCH /api/menu/items/:id/availability
 * Toggle item availability (quick toggle for POS)
 */
menuRouter.patch('/items/:id/availability', requireRole(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER, UserRole.KITCHEN), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;
  const { isAvailable, manualOverride } = req.body;

  const item = await prisma.menuItem.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: {
      isAvailable,
      manualOverride,
    },
  });

  // Emit socket event to all tenant rooms
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:item:availability', { 
      itemId: id, 
      isAvailable: item.isAvailable,
      manualOverride: item.manualOverride,
    });
  }

  res.json({ item });
});

/**
 * DELETE /api/menu/items/:id
 * Soft delete menu item
 */
menuRouter.delete('/items/:id', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;

  await prisma.menuItem.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: { isAvailable: false },
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'menu:item:deleted', { itemId: id });
  }

  res.json({ message: 'Item deleted' });
});
