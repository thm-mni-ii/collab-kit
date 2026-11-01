/** Entry of manage-v1.js: registers <ck-management> and its parts, which work with the ck of v1.js. */

import { Management } from './management.ts';
import { CkAccessCard } from './parts/access-card.ts';
import { CkFold } from './parts/fold.ts';
import { CkForm } from './parts/form.ts';
import { CkGroupDetail } from './parts/group.ts';
import { CkHead } from './parts/head.ts';
import { CkLegend } from './parts/legend.ts';
import { CkRoomDetail } from './parts/room.ts';
import { CkWorkpieceDetail } from './parts/workpiece.ts';

const elements = {
  'ck-management': Management,
  'ck-form': CkForm,
  'ck-fold': CkFold,
  'ck-head': CkHead,
  'ck-access-card': CkAccessCard,
  'ck-legend': CkLegend,
  'ck-room-detail': CkRoomDetail,
  'ck-group-detail': CkGroupDetail,
  'ck-workpiece-detail': CkWorkpieceDetail,
};

// A page that loads the file twice keeps the first, a second definition would throw.
for (const [name, element] of Object.entries(elements)) {
  if (customElements.get(name) === undefined) {
    customElements.define(name, element);
  }
}
