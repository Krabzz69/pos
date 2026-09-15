import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env';
import { prisma } from '../config/database';
import { UserRole } from '@prisma/client';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    tenantId: string;
    email: string;
    role: UserRole;
    name: string;
  };
}

/**
 * Verify JWT access token and attach user to request
 */
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      tenantId: string;
      role: UserRole;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        tenantId: true,
        email: true,
        role: true,
        name: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    // Verify tenant matches
    if (user.tenantId !== decoded.tenantId) {
      res.status(401).json({ error: 'Tenant mismatch' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    next(error);
  }
};

/**
 * Require specific role(s) to access endpoint
 */
export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

/**
 * Ensure tenant isolation - verify resource belongs to authenticated user's tenant
 */
export const ensureTenantIsolation = <T extends { tenantId: string }>(resource: T | null, req: AuthRequest): resource is T => {
  if (!resource) {
    return false;
  }
  return resource.tenantId === req.user?.tenantId;
};
