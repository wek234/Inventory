import type { FastifyInstance } from 'fastify';
import { itemRoutes } from './items.js';
import { attachmentRoutes } from './attachments.js';
import { treeRoutes } from './trees.js';
import { miscRoutes } from './misc.js';
import { importRoutes } from './import.js';
import { adminRoutes } from './admin.js';
import { securityRoutes } from './security.js';
import { featureRoutes } from './features.js';
import { apiRoutes } from './api.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(miscRoutes);
  await app.register(itemRoutes);
  await app.register(attachmentRoutes);
  await app.register(treeRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);
  await app.register(securityRoutes);
  await app.register(featureRoutes);
  await app.register(apiRoutes, { prefix: '/api/v1' });
}
