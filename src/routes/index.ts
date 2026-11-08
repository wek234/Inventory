import type { FastifyInstance } from 'fastify';
import { itemRoutes } from './items.js';
import { attachmentRoutes } from './attachments.js';
import { treeRoutes } from './trees.js';
import { miscRoutes } from './misc.js';
import { importRoutes } from './import.js';
import { adminRoutes } from './admin.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(miscRoutes);
  await app.register(itemRoutes);
  await app.register(attachmentRoutes);
  await app.register(treeRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);
}
