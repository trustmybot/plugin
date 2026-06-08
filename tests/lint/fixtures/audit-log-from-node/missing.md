# Fixture: audit_log call missing from_node

This file has an audit_log call without from_node — should trigger lint failure.

audit_log(agent='bro', event_type='branch_id_proposed', summary='Branch created.')
