import { Router, Request } from 'express';
import http from 'http';
import cors from 'cors';
import express from 'express';
import { prisma } from './config/database';
import { authRouter } from './modules/auth/auth.routes';
import { tenantsRouter } from './modules/tenants/tenants.routes';
import { menuRouter } from './modules/menu/menu.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { setupSocketIO } from './utils/socket';
import { PORT, NODE_ENV } from './config/env';

const app = express();
const server = http.createServer(app);

// Setup Socket.IO
const io = setupSocketIO(server);
app.set('io', io);

// Middleware
app.use(cors({
  origin: NODE_ENV === 'production' ? false : true,
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/menu', menuRouter);
app.use('/api/inventory', inventoryRouter);

// Payment webhook endpoint (for MCB Juice / Peach Payments)
app.post('/api/webhooks/payments/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const payload = req.body;
  const signature = req.headers['x-signature'] as string;

  console.log(`Payment webhook received for tenant ${tenantId}`);
  
  // TODO: Verify signature based on payment provider
  // TODO: Process payment and update order status
  // TODO: Emit socket event to POS

  res.status(200).json({ received: true });
});

// Error handling middleware
app.use((err: any, req: Request, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`WebSocket server ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    prisma.$disconnect();
    process.exit(0);
  });
});

export default app;
