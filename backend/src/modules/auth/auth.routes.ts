import { Router } from 'express';
import { prisma } from '../../config/database';
import { hashPassword, verifyPassword, generatePIN } from '../../utils/auth';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_IN } from '../../config/env';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../../middleware/auth';
import { UserRole, TenantStatus, PlanTier } from '@prisma/client';

export const authRouter = Router();

/**
 * POST /api/auth/register-tenant
 * Create a new tenant (restaurant) with owner user
 * This is for initial setup - in production would be restricted
 */
authRouter.post('/register-tenant', async (req, res) => {
  try {
    const { 
      tenantName, 
      subdomain, 
      slug,
      ownerEmail, 
      ownerPassword, 
      ownerName,
      ownerPhone 
    } = req.body;

    // Validate required fields
    if (!tenantName || !subdomain || !slug || !ownerEmail || !ownerPassword || !ownerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if subdomain or slug already exists
    const existing = await prisma.tenant.findFirst({
      where: { OR: [{ subdomain }, { slug }] },
    });

    if (existing) {
      return res.status(409).json({ error: 'Subdomain or slug already taken' });
    }

    // Hash password and generate PIN
    const passwordHash = await hashPassword(ownerPassword);
    const pin = generatePIN(4);

    // Create tenant with owner user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: uuidv4(),
          name: tenantName,
          subdomain,
          slug,
          status: TenantStatus.TRIAL,
          plan: PlanTier.STARTER,
          settings: {
            vatRate: 15,
            serviceChargeRate: 10,
            currency: 'MUR',
            receiptHeader: '',
            receiptFooter: '',
          },
        },
      });

      const user = await tx.user.create({
        data: {
          id: uuidv4(),
          tenantId: tenant.id,
          email: ownerEmail,
          passwordHash,
          role: UserRole.OWNER,
          pin,
          name: ownerName,
          phone: ownerPhone || null,
        },
      });

      return { tenant, user, pin };
    });

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: result.user.id, tenantId: result.tenant.id, role: result.user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        id: uuidv4(),
        userId: result.user.id,
        token: refreshToken,
        expiresAt,
      },
    });

    res.status(201).json({
      message: 'Tenant and owner created successfully',
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        subdomain: result.tenant.subdomain,
        slug: result.tenant.slug,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        pin: result.pin, // Show PIN once for owner to note down
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Register tenant error:', error);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password, pin } = req.body;

    if (!email && !pin) {
      return res.status(400).json({ error: 'Email or PIN required' });
    }

    if ((!email || !password) && !pin) {
      return res.status(400).json({ error: 'Email and password, or PIN required' });
    }

    // Find user by email or PIN
    const user = await prisma.user.findFirst({
      where: email 
        ? { email }
        : { pin },
      include: { tenant: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password if using email login
    if (email && !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: user.id, tenantId: user.tenantId, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        id: uuidv4(),
        userId: user.id,
        token: refreshToken,
        expiresAt,
      },
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
authRouter.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Generate new access token
    const accessToken = jwt.sign(
      { userId: storedToken.userId, tenantId: storedToken.user.tenantId, role: storedToken.user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ accessToken });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * POST /api/auth/logout
 * Invalidate refresh token
 */
authRouter.post('/logout', async (req: AuthRequest, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken },
      });
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
authRouter.get('/me', async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      phone: true,
      tenant: {
        select: {
          id: true,
          name: true,
          subdomain: true,
          slug: true,
          settings: true,
        },
      },
    },
  });

  res.json({ user });
});
