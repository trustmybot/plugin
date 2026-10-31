const url = 'https://example.test'; const event_type = 'after_url_event';
const glob = '**/*.ts'; const eventType = 'after_glob_event';
const pattern = /['"\/]/; const nested = `${url ? `https://${glob}` : ''}`; auditMilestone(db, 'after_regex_event');
