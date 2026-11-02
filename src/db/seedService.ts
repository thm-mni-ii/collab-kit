import type { Db } from 'mongodb';

import { RIGHTS } from '../model/right.ts';
import { addMember, createGroup, type GroupRecord } from './collections/groups.ts';
import { setGrant } from './collections/grants.ts';

/** The group that holds the service, named so a person can tell it from the groups of a tool. */
export const SERVICE_GROUP = 'services';

/** Makes the group of services if it is missing, then keeps the service in it with every right. */
export async function seedServiceGroup(db: Db, actorId: string): Promise<void> {
  // Look the group up by name, the one place the service reads a name.
  const found = await db.collection<GroupRecord>('groups').findOne({ name: SERVICE_GROUP });
  const group =
    found ??
    (await createGroup(db, { name: SERVICE_GROUP, createdBy: actorId, members: [actorId] }));

  // An existing group may have lost the service; taking it in again changes nothing if it is there.
  if (found !== null) {
    await addMember(db, group._id, { actorId, addedBy: actorId });
  }

  // Replaced whole, so rights taken away since the last start come back; unchanged, nothing is written.
  await setGrant(db, { groupId: group._id, rights: RIGHTS, setBy: actorId });
}
