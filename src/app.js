import Fastify from 'fastify';
import { BRUTE_FORCE } from './config.js';
import { createRepository } from './db.js';
import { createBruteForceGuard } from './bruteForce.js';
import { createPinHasher } from './security.js';
import acessoRoutes from './routes/acesso.js';
import adminRoutes from './routes/admin.js';

/**
 * Builds the Fastify app. Takes an already-open database so tests can pass an in-memory one.
 * `now` is injectable so tests can move the brute-force clock.
 */
export function buildApp({ config, db, logger = false, now = Date.now }) {
  const app = Fastify({
    logger: logger && {
      ...logger,
      // Belt and braces: request bodies are not logged by default, but never let secrets through.
      redact: ['req.headers.authorization', 'req.headers["x-device-key"]', 'req.body.senha', 'req.body.pin'],
    },
  });

  const repo = createRepository(db);
  const hashPin = createPinHasher(config.pinPepper);
  const guard = createBruteForceGuard({ ...BRUTE_FORCE, now });
  app.addHook('onClose', async () => guard.stop());

  app.setErrorHandler((err, request, reply) => {
    if (err.validation) {
      return reply.code(400).send({ erro: 'requisicao_invalida' });
    }
    if (err.statusCode >= 400 && err.statusCode < 500) {
      // Malformed JSON (400), body too large (413), wrong Content-Type (415)... all "deny" for the ESP32.
      return reply.code(err.statusCode).send({ erro: 'requisicao_invalida' });
    }
    request.log.error({ err }, 'unexpected error');
    return reply.code(500).send({ erro: 'erro_interno' });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ erro: 'nao_encontrado' }));

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.register(acessoRoutes, { config, repo, hashPin, guard });
  app.register(adminRoutes, { prefix: '/api', config, repo, hashPin });

  return app;
}
