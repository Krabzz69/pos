import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/auth';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create demo tenant (restaurant)
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-restaurant' },
    update: {},
    create: {
      id: uuidv4(),
      name: 'Demo Restaurant',
      subdomain: 'demo',
      slug: 'demo-restaurant',
      status: 'ACTIVE',
      plan: 'PROFESSIONAL',
      settings: {
        vatRate: 15,
        serviceChargeRate: 10,
        currency: 'MUR',
        receiptHeader: 'Demo Restaurant\n123 Main Street\nPort Louis, Mauritius',
        receiptFooter: 'Thank you for your visit!',
      },
    },
  });

  console.log(`Created tenant: ${tenant.name}`);

  // Create owner user
  const ownerPassword = await hashPassword('owner123');
  const owner = await prisma.user.upsert({
    where: { email: 'owner@demo.com' },
    update: {},
    create: {
      id: uuidv4(),
      tenantId: tenant.id,
      email: 'owner@demo.com',
      passwordHash: ownerPassword,
      role: 'OWNER',
      pin: '1234',
      name: 'Restaurant Owner',
      phone: '+230 5555 1234',
    },
  });

  console.log(`Created owner: ${owner.email} (PIN: 1234)`);

  // Create manager user
  const managerPassword = await hashPassword('manager123');
  const manager = await prisma.user.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      email: 'manager@demo.com',
      passwordHash: managerPassword,
      role: 'MANAGER',
      pin: '5678',
      name: 'Restaurant Manager',
      phone: '+230 5555 5678',
    },
  });

  // Create cashier user
  const cashierPassword = await hashPassword('cashier123');
  const cashier = await prisma.user.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      email: 'cashier@demo.com',
      passwordHash: cashierPassword,
      role: 'CASHIER',
      pin: '9012',
      name: 'John Cashier',
    },
  });

  // Create kitchen user
  const kitchenPassword = await hashPassword('kitchen123');
  const kitchen = await prisma.user.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      email: 'kitchen@demo.com',
      passwordHash: kitchenPassword,
      role: 'KITCHEN',
      pin: '3456',
      name: 'Kitchen Staff',
    },
  });

  console.log('Created staff users');

  // Create tables
  const tables = await Promise.all([
    prisma.table.upsert({
      where: { tenantId_number: { tenantId: tenant.id, number: '1' } },
      update: {},
      create: {
        id: uuidv4(),
        tenantId: tenant.id,
        number: '1',
        capacity: 4,
        section: 'Indoor',
      },
    }),
    prisma.table.upsert({
      where: { tenantId_number: { tenantId: tenant.id, number: '2' } },
      update: {},
      create: {
        id: uuidv4(),
        tenantId: tenant.id,
        number: '2',
        capacity: 4,
        section: 'Indoor',
      },
    }),
    prisma.table.upsert({
      where: { tenantId_number: { tenantId: tenant.id, number: '3' } },
      update: {},
      create: {
        id: uuidv4(),
        tenantId: tenant.id,
        number: '3',
        capacity: 6,
        section: 'Outdoor',
      },
    }),
  ]);

  console.log('Created tables');

  // Create categories
  const burgersCategory = await prisma.category.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Burgers',
      description: 'Fresh handmade burgers',
      sortOrder: 1,
    },
  });

  const drinksCategory = await prisma.category.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Drinks',
      description: 'Cold beverages',
      sortOrder: 2,
    },
  });

  const sidesCategory = await prisma.category.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Sides',
      description: 'Perfect accompaniments',
      sortOrder: 3,
    },
  });

  console.log('Created categories');

  // Create ingredients
  const beef = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Beef Patty',
      unit: 'pcs',
      currentStock: 50,
      lowStockThreshold: 20,
      costPerUnit: 15000, // 150 MUR per patty
    },
  });

  const bun = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Burger Bun',
      unit: 'pcs',
      currentStock: 60,
      lowStockThreshold: 25,
      costPerUnit: 5000, // 50 MUR per bun
    },
  });

  const cheese = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Cheese Slice',
      unit: 'pcs',
      currentStock: 40,
      lowStockThreshold: 20,
      costPerUnit: 3000, // 30 MUR per slice
    },
  });

  const fries = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Frozen Fries',
      unit: 'g',
      currentStock: 5000,
      lowStockThreshold: 1000,
      costPerUnit: 500, // 5 MUR per 10g
    },
  });

  const coke = await prisma.ingredient.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Coca Cola Can',
      unit: 'pcs',
      currentStock: 100,
      lowStockThreshold: 30,
      costPerUnit: 2500, // 25 MUR per can
    },
  });

  console.log('Created ingredients');

  // Create menu items
  const classicBurger = await prisma.menuItem.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      categoryId: burgersCategory.id,
      name: 'Classic Burger',
      description: 'Juicy beef patty with fresh lettuce and tomato',
      price: 29900, // 299 MUR
      photoUrl: '/images/classic-burger.jpg',
      prepTimeMinutes: 10,
    },
  });

  const cheeseBurger = await prisma.menuItem.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      categoryId: burgersCategory.id,
      name: 'Cheese Burger',
      description: 'Classic burger with melted cheese',
      price: 34900, // 349 MUR
      photoUrl: '/images/cheese-burger.jpg',
      prepTimeMinutes: 10,
    },
  });

  const frenchFries = await prisma.menuItem.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      categoryId: sidesCategory.id,
      name: 'French Fries',
      description: 'Crispy golden fries',
      price: 12900, // 129 MUR
      photoUrl: '/images/fries.jpg',
      prepTimeMinutes: 5,
    },
  });

  const cocaCola = await prisma.menuItem.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      categoryId: drinksCategory.id,
      name: 'Coca Cola',
      description: 'Chilled can 330ml',
      price: 5000, // 50 MUR
      photoUrl: '/images/coke.jpg',
      prepTimeMinutes: 1,
    },
  });

  console.log('Created menu items');

  // Create recipes (BOM)
  await prisma.recipe.createMany({
    data: [
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: classicBurger.id,
        ingredientId: beef.id,
        quantity: 1,
        unit: 'pcs',
      },
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: classicBurger.id,
        ingredientId: bun.id,
        quantity: 1,
        unit: 'pcs',
      },
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: cheeseBurger.id,
        ingredientId: beef.id,
        quantity: 1,
        unit: 'pcs',
      },
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: cheeseBurger.id,
        ingredientId: bun.id,
        quantity: 1,
        unit: 'pcs',
      },
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: cheeseBurger.id,
        ingredientId: cheese.id,
        quantity: 1,
        unit: 'pcs',
      },
      {
        id: uuidv4(),
        tenantId: tenant.id,
        itemId: frenchFries.id,
        ingredientId: fries.id,
        quantity: 150,
        unit: 'g',
      },
    ],
  });

  console.log('Created recipes');

  // Create delivery zones
  await prisma.deliveryZone.create({
    data: {
      id: uuidv4(),
      tenantId: tenant.id,
      name: 'Port Louis Central',
      polygon: { type: 'Polygon', coordinates: [] }, // Simplified for demo
      fee: 5000, // 50 MUR
      minimumOrder: 50000, // 500 MUR
      estimatedTime: 30,
    },
  });

  console.log('Created delivery zones');

  console.log('\n✅ Seeding completed successfully!');
  console.log('\n📋 Demo Credentials:');
  console.log('   Owner: owner@demo.com / owner123 (PIN: 1234)');
  console.log('   Manager: manager@demo.com / manager123 (PIN: 5678)');
  console.log('   Cashier: cashier@demo.com / cashier123 (PIN: 9012)');
  console.log('   Kitchen: kitchen@demo.com / kitchen123 (PIN: 3456)');
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
