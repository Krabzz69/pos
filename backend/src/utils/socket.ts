import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env';
import { prisma } from '../config/database';

interface AuthSocket extends Socket {
  userId?: string;
  tenantId?: string;
}

export let io: Server | null = null;

export function setupSocketIO(server: any) {
  io = new Server(server, {
    cors: {
      origin: process.env.NODE_ENV === 'production' ? false : true,
      credentials: true,
    },
  });

  // Middleware for socket authentication
  io.use(async (socket: AuthSocket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as {
        userId: string;
        tenantId: string;
      };

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, tenantId: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return next(new Error('User not found or inactive'));
      }

      socket.userId = decoded.userId;
      socket.tenantId = decoded.tenantId;
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthSocket) => {
    console.log(`Socket connected: ${socket.id} for tenant ${socket.tenantId}`);

    // Join tenant-specific rooms
    if (socket.tenantId) {
      socket.join(`${socket.tenantId}:all`);
    }

    // Join specific module rooms
    socket.on('join:pos', () => {
      if (socket.tenantId) {
        socket.join(`${socket.tenantId}:pos`);
        console.log(`Socket ${socket.id} joined POS room for tenant ${socket.tenantId}`);
      }
    });

    socket.on('join:kitchen', () => {
      if (socket.tenantId) {
        socket.join(`${socket.tenantId}:kitchen`);
        console.log(`Socket ${socket.id} joined Kitchen room for tenant ${socket.tenantId}`);
      }
    });

    socket.on('join:online', () => {
      if (socket.tenantId) {
        socket.join(`${socket.tenantId}:online`);
      }
    });

    socket.on('join:admin', () => {
      if (socket.tenantId) {
        socket.join(`${socket.tenantId}:admin`);
      }
    });

    // Leave all rooms on disconnect
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

// Helper function to emit events to tenant rooms
export function emitToTenant(io: Server, tenantId: string, event: string, data: any, room?: string) {
  const targetRoom = room ? `${tenantId}:${room}` : `${tenantId}:all`;
  io.to(targetRoom).emit(event, data);
}
