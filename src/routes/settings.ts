import { Router } from 'express';
import type { Db } from 'mongodb';

import { may } from '../auth/access.ts';
import {
  findSettings,
  listSettingKeys,
  removeSettings,
  replaceSettings,
  SETTINGS_KEY,
} from '../db/collections/settings.ts';
import type { WorkpieceHub } from '../realtime/index.ts';
import { asObject } from '../utils/input.ts';
import { actorOf, fail } from './http.ts';

/** Settings of the tool by area: every token reads, manage without a place writes. */
export function settingsRoutes(db: Db, hub: WorkpieceHub): Router {
  const routes = Router();

  // A key outside the pattern could not stand in the URL as it is stored.
  routes.param('key', (_request, response, next, raw: string) => {
    if (!SETTINGS_KEY.test(raw)) {
      return fail(response, 400, 'malformed settings key');
    }
    next();
  });

  /** The names of every stored area. */
  routes.get('/settings', async (_request, response) => {
    response.json(await listSettingKeys(db));
  });

  /** The values of an area; one never set reads as empty, so the tool takes its defaults. */
  routes.get('/settings/:key', async (request, response) => {
    response.json((await findSettings(db, request.params['key'] ?? '')) ?? {});
  });

  /** Replaces the values of an area as a whole and tells every listener which one changed. */
  routes.put('/settings/:key', async (request, response) => {
    const actor = actorOf(request);
    const key = request.params['key'] ?? '';

    // Settings hold for the whole instance, so only a right that holds everywhere counts.
    if (!(await may(db, actor, 'manage'))) {
      return fail(response, 403, 'not allowed to change settings');
    }

    // Only the shape is checked, what goes inside is the tool's business.
    const values = asObject(request.body);
    if (values === undefined) {
      return fail(response, 400, 'settings must be an object');
    }

    await replaceSettings(db, key, values, actor.actorId);
    hub.broadcast({ kind: 'settings-changed', key });
    response.json(values);
  });

  /** Removes an area, so the tool falls back on its defaults; a missing one is no mistake. */
  routes.delete('/settings/:key', async (request, response) => {
    const key = request.params['key'] ?? '';

    if (!(await may(db, actorOf(request), 'manage'))) {
      return fail(response, 403, 'not allowed to change settings');
    }

    await removeSettings(db, key);
    hub.broadcast({ kind: 'settings-changed', key });
    response.status(204).end();
  });

  return routes;
}
