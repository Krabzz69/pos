# Restaurant SaaS - Backend README

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Docker & Docker Compose (for containerized deployment)

## Quick Start (Development)

### Option 1: Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your database credentials

# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed demo data
npm run prisma:seed

# Start development server
npm run dev
```

Server will be available at `http://localhost:3150`

### Option 2: Docker Compose

```bash
# Build and start all services
docker-compose up -d

# Wait for services to be healthy
docker-compose ps

# Run migrations
docker-compose exec backend npm run prisma:migrate

# Seed demo data
docker-compose exec backend npm run prisma:seed
```

## Demo Credentials

After seeding, use these credentials:

| Role | Email | Password | PIN |
|------|-------|----------|-----|
| Owner | owner@demo.com | owner123 | 1234 |
| Manager | manager@demo.com | manager123 | 5678 |
| Cashier | cashier@demo.com | cashier123 | 9012 |
| Kitchen | kitchen@demo.com | kitchen123 | 3456 |

## API Endpoints

### Authentication
- `POST /api/auth/register-tenant` - Create new tenant
- `POST /api/auth/login` - Login (email/password or PIN)
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Tenants
- `GET /api/tenants/my` - Get current tenant info
- `GET /api/tenants/settings` - Get tenant settings
- `PUT /api/tenants/settings` - Update tenant settings
- `GET /api/tenants/stats` - Get tenant statistics

### Menu
- `GET /api/menu/categories` - Get all categories
- `POST /api/menu/categories` - Create category
- `PUT /api/menu/categories/:id` - Update category
- `DELETE /api/menu/categories/:id` - Soft delete category
- `GET /api/menu/items` - Get all menu items
- `POST /api/menu/items` - Create menu item
- `PUT /api/menu/items/:id` - Update menu item
- `PATCH /api/menu/items/:id/availability` - Toggle availability
- `DELETE /api/menu/items/:id` - Soft delete item

### Inventory
- `GET /api/inventory/ingredients` - Get all ingredients
- `POST /api/inventory/ingredients` - Create ingredient
- `PUT /api/inventory/ingredients/:id` - Update ingredient
- `POST /api/inventory/stock-movement` - Record stock movement
- `GET /api/inventory/movements` - Get movement history
- `GET /api/inventory/low-stock` - Get low stock alerts
- `POST /api/inventory/waste` - Record waste
- `GET /api/inventory/suppliers` - Get suppliers
- `POST /api/inventory/suppliers` - Create supplier
- `GET /api/inventory/recipes/:itemId` - Get recipe
- `POST /api/inventory/recipes` - Create/update recipe

### Webhooks
- `POST /api/webhooks/payments/:tenantId` - Payment gateway webhook

## Socket.IO Events

Connect to `ws://localhost:3150` with JWT token in handshake auth.

### Client → Server
- `join:pos` - Join POS room
- `join:kitchen` - Join kitchen room
- `join:online` - Join online orders room
- `join:admin` - Join admin room

### Server → Client
- `menu:category:created` - New category created
- `menu:category:updated` - Category updated
- `menu:category:deleted` - Category deleted
- `menu:item:created` - New item created
- `menu:item:updated` - Item updated
- `menu:item:availability` - Item availability changed
- `menu:item:deleted` - Item deleted
- `inventory:stock-updated` - Stock level changed
- `inventory:waste-recorded` - Waste logged
- `inventory:recipe-updated` - Recipe updated

## Testing

```bash
# Test health endpoint
curl http://localhost:3150/health

# Login and get token
curl -X POST http://localhost:3150/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@demo.com","password":"owner123"}'

# Get menu categories (replace TOKEN with actual)
curl http://localhost:3150/api/menu/categories \
  -H "Authorization: Bearer TOKEN"
```

## Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── seed.ts          # Seed data
├── src/
│   ├── config/
│   │   ├── database.ts  # Prisma client
│   │   └── env.ts       # Environment config
│   ├── middleware/
│   │   └── auth.ts      # Auth middleware
│   ├── modules/
│   │   ├── auth/        # Authentication
│   │   ├── tenants/     # Tenant management
│   │   ├── menu/        # Menu management
│   │   ├── inventory/   # Inventory & recipes
│   │   ├── orders/      # Orders (TODO)
│   │   ├── kitchen/     # Kitchen display (TODO)
│   │   ├── online/      # Online ordering (TODO)
│   │   ├── payments/    # Payments (TODO)
│   │   └── shifts/      # Shift management (TODO)
│   ├── utils/
│   │   ├── auth.ts      # Password hashing
│   │   ├── encryption.ts# Credential encryption
│   │   ├── helpers.ts   # Utility functions
│   │   └── socket.ts    # Socket.IO setup
│   └── index.ts         # Entry point
├── package.json
├── tsconfig.json
└── Dockerfile
```

## Next Steps

1. **Orders Module** - Implement POS order creation, cart management, payment processing
2. **Kitchen Display** - Real-time order queue, status updates
3. **Online Ordering** - Public menu, guest checkout, delivery zones
4. **Payment Integration** - MCB Juice / Peach Payments webhook handling
5. **Receipt Printing** - ESC/POS thermal printer support
6. **Admin Dashboard** - Reports, analytics, staff management

## Troubleshooting

### Database connection error
Ensure PostgreSQL is running and DATABASE_URL is correct.

### Prisma client not generated
Run `npm run prisma:generate`

### Port already in use
Change PORT in .env file

### WebSocket connection failed
Check that nginx is configured for WebSocket upgrade headers
