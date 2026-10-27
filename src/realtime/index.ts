// The only way into src/realtime/ from outside; only tests of a single module import it directly.
export { unitsIn } from './conflicts/units.ts';
export { attachGateway, type Gateway } from './connection/gateway.ts';
export { forkWorkpiece, mergeWorkpiece } from './forks/forks.ts';
export { createWorkpieceHub } from './hub/hub.ts';
export { deleterOf, readDocAt, readStateAt } from './hub/persistence.ts';
export type { Connection, WorkpieceHub } from './hub/types.ts';
