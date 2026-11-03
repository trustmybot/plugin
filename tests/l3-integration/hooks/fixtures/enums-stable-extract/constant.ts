import { insertAudit } from './audit.js';
import { IMPORTED_EVENT, ALIASED_EVENT as RENAMED_EVENT } from './lib/events.js';
import { REEXPORTED_EVENT } from './lib/barrel.js';
import { UNRESOLVABLE_EVENT } from './lib/missing.js';

const LOCAL_EVENT: string = 'local_event';

export function write(db: unknown, eventType: string): void {
  insertAudit(db, { from_node: 'bro', event_type: IMPORTED_EVENT, summary: 's' });
  insertAudit(db, { from_node: 'bro', event_type: RENAMED_EVENT, summary: 's' });
  insertAudit(db, { from_node: 'bro', event_type: LOCAL_EVENT, summary: 's' });
  insertAudit(db, { from_node: 'bro', event_type: REEXPORTED_EVENT, summary: 's' });
  insertAudit(db, { from_node: 'bro', event_type: UNRESOLVABLE_EVENT, summary: 's' });
  insertAudit(db, { from_node: 'bro', event_type: eventType, summary: 's' });
}
