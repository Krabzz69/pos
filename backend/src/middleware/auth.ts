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
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
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
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    // Verify tenant matches
    if (user.tenantId !== decoded.tenantId) {
      return res.status(401).json({ error: 'Tenant mismatch' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(error);
  }
};

/**
 * Require specific role(s) to access endpoint
 */
export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
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
