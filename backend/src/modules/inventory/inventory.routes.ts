import { Router } from 'express';
import { prisma } from '../../config/database';
import { authenticate, AuthRequest, requireRole } from '../../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { UserRole, StockMovementType } from '@prisma/client';
import { emitToTenant } from '../../utils/socket';

export const inventoryRouter = Router();

// All inventory routes require authentication
inventoryRouter.use(authenticate);

/**
 * GET /api/inventory/ingredients
 * Get all ingredients for tenant
 */
inventoryRouter.get('/ingredients', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const ingredients = await prisma.ingredient.findMany({
    where: { tenantId: req.user.tenantId },
    include: {
      supplier: true,
    },
    orderBy: { name: 'asc' },
  });

  // Calculate availability status
  const ingredientsWithStatus = ingredients.map(ing => ({
    ...ing,
    isLowStock: ing.currentStock < ing.lowStockThreshold,
  }));

  res.json({ ingredients: ingredientsWithStatus });
});

/**
 * POST /api/inventory/ingredients
 * Create new ingredient (manager/owner only)
 */
inventoryRouter.post('/ingredients', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { 
    name, 
    unit, 
    currentStock = 0, 
    lowStockThreshold = 10, 
    costPerUnit = 0,
    supplierId 
  } = req.body;

  const ingredient = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: req.user.tenantId,
      name,
      unit,
      currentStock,
      lowStockThreshold,
      costPerUnit,
      supplierId,
    },
  });

  res.status(201).json({ ingredient });
});

/**
 * PUT /api/inventory/ingredients/:id
 * Update ingredient
 */
inventoryRouter.put('/ingredients/:id', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.params;
  const { name, unit, lowStockThreshold, costPerUnit, supplierId } = req.body;

  const ingredient = await prisma.ingredient.update({
    where: { 
      id,
      tenantId: req.user.tenantId,
    },
    data: {
      name,
      unit,
      lowStockThreshold,
      costPerUnit,
      supplierId,
    },
  });

  res.json({ ingredient });
});

/**
 * POST /api/inventory/stock-movement
 * Record stock movement (purchase, waste, adjustment)
 */
inventoryRouter.post('/stock-movement', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { 
    ingredientId, 
    type, 
    quantity, 
    reference, 
    reason 
  } = req.body;

  if (!ingredientId || !type || quantity === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify ingredient belongs to tenant
  const ingredient = await prisma.ingredient.findFirst({
    where: { 
      id: ingredientId,
      tenantId: req.user.tenantId,
    },
  });

  if (!ingredient) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }

  // Calculate new stock level
  const stockChange = type === 'PURCHASE' || type === 'RETURN' ? quantity : -quantity;
  const newStock = ingredient.currentStock + stockChange;

  if (newStock < 0) {
    return res.status(400).json({ error: 'Insufficient stock for this operation' });
  }

  // Update stock and create movement record in transaction
  const result = await prisma.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({
      data: {
        id: uuidv4(),
        tenantId: req.user.tenantId,
        ingredientId,
        type,
        quantity: stockChange,
        reference,
        reason,
        performedBy: req.user.id,
      },
    });

    const updatedIngredient = await tx.ingredient.update({
      where: { id: ingredientId },
      data: { currentStock: newStock },
    });

    return { movement, updatedIngredient };
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'inventory:stock-updated', { 
      ingredientId, 
      newStock: result.updatedIngredient.currentStock,
      movement: result.movement,
    });
  }

  res.status(201).json(result);
});

/**
 * GET /api/inventory/movements
 * Get stock movement history
 */
inventoryRouter.get('/movements', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { ingredientId, type, startDate, endDate } = req.query;

  const where: any = { tenantId: req.user.tenantId };

  if (ingredientId) {
    where.ingredientId = ingredientId;
  }

  if (type) {
    where.type = type;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate as string);
    if (endDate) where.createdAt.lte = new Date(endDate as string);
  }

  const movements = await prisma.stockMovement.findMany({
    where,
    include: {
      ingredient: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ movements });
});

/**
 * GET /api/inventory/low-stock
 * Get ingredients below threshold
 */
inventoryRouter.get('/low-stock', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const lowStockIngredients = await prisma.ingredient.findMany({
    where: { 
      tenantId: req.user.tenantId,
      currentStock: {
        lt: prisma.ingredient.fields.lowStockThreshold,
      },
    },
    include: {
      supplier: true,
    },
  });

  res.json({ ingredients: lowStockIngredients });
});

/**
 * POST /api/inventory/waste
 * Record waste/spoilage
 */
inventoryRouter.post('/waste', requireRole(UserRole.OWNER, UserRole.MANAGER, UserRole.KITCHEN), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { ingredientId, quantity, reason } = req.body;

  if (!ingredientId || !quantity || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify ingredient belongs to tenant
  const ingredient = await prisma.ingredient.findFirst({
    where: { 
      id: ingredientId,
      tenantId: req.user.tenantId,
    },
  });

  if (!ingredient) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }

  if (ingredient.currentStock < quantity) {
    return res.status(400).json({ error: 'Insufficient stock' });
  }

  // Create waste log and stock movement in transaction
  const result = await prisma.$transaction(async (tx) => {
    const wasteLog = await tx.wasteLog.create({
      data: {
        id: uuidv4(),
        tenantId: req.user.tenantId,
        ingredientId,
        quantity,
        reason,
        recordedBy: req.user.id,
      },
    });

    await tx.stockMovement.create({
      data: {
        id: uuidv4(),
        tenantId: req.user.tenantId,
        ingredientId,
        type: StockMovementType.WASTE,
        quantity: -quantity,
        reason,
        performedBy: req.user.id,
      },
    });

    await tx.ingredient.update({
      where: { id: ingredientId },
      data: { currentStock: ingredient.currentStock - quantity },
    });

    return { wasteLog };
  });

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'inventory:waste-recorded', { waste: result.wasteLog });
  }

  res.status(201).json(result);
});

/**
 * GET /api/inventory/suppliers
 * Get all suppliers for tenant
 */
inventoryRouter.get('/suppliers', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const suppliers = await prisma.supplier.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { name: 'asc' },
  });

  res.json({ suppliers });
});

/**
 * POST /api/inventory/suppliers
 * Create new supplier
 */
inventoryRouter.post('/suppliers', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { name, contactName, phone, email, address } = req.body;

  const supplier = await prisma.supplier.create({
    data: {
      id: uuidv4(),
      tenantId: req.user.tenantId,
      name,
      contactName,
      phone,
      email,
      address,
    },
  });

  res.status(201).json({ supplier });
});

/**
 * GET /api/inventory/recipes/:itemId
 * Get recipe for a menu item
 */
inventoryRouter.get('/recipes/:itemId', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { itemId } = req.params;

  const recipes = await prisma.recipe.findMany({
    where: { 
      itemId,
      tenantId: req.user.tenantId,
    },
    include: {
      ingredient: true,
      item: true,
    },
  });

  res.json({ recipes });
});

/**
 * POST /api/inventory/recipes
 * Create or update recipe (BOM) for menu item
 */
inventoryRouter.post('/recipes', requireRole(UserRole.OWNER, UserRole.MANAGER), async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { itemId, ingredients } = req.body;
  // ingredients: [{ingredientId, quantity, unit}]

  if (!itemId || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Delete existing recipes and create new ones in transaction
  const result = await prisma.$transaction(async (tx) => {
    await tx.recipe.deleteMany({
      where: { itemId, tenantId: req.user.tenantId },
    });

    const recipes = await Promise.all(
      ingredients.map((ing: any) =>
        tx.recipe.create({
          data: {
            id: uuidv4(),
            tenantId: req.user.tenantId,
            itemId,
            ingredientId: ing.ingredientId,
            quantity: ing.quantity,
            unit: ing.unit,
          },
        })
      )
    );

    return { recipes };
  });

  // Recalculate availability for this item
  const availabilityResult = await checkItemAvailability(itemId, req.user.tenantId);

  // Emit socket event
  const io = (req.app as any).get('io');
  if (io) {
    emitToTenant(io, req.user.tenantId, 'inventory:recipe-updated', { 
      itemId, 
      recipes: result.recipes,
      availability: availabilityResult,
    });
  }

  res.json(result);
});

/**
 * Helper function to check if an item can be made with current stock
 */
async function checkItemAvailability(itemId: string, tenantId: string) {
  const recipes = await prisma.recipe.findMany({
    where: { itemId, tenantId },
    include: { ingredient: true },
  });

  if (recipes.length === 0) {
    return { available: true, limitingIngredient: null };
  }

  for (const recipe of recipes) {
    if (recipe.ingredient.currentStock < recipe.quantity) {
      return { 
        available: false, 
        limitingIngredient: {
          id: recipe.ingredient.id,
          name: recipe.ingredient.name,
          required: recipe.quantity,
          available: recipe.ingredient.currentStock,
        },
      };
    }
  }

  return { available: true, limitingIngredient: null };
}
