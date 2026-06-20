# Fixture: audit_append call missing from_node

This file has an audit_append call without from_node — should trigger lint failure.

audit_append(agent='bro', event_type='branch_id_proposed', summary='Branch created.')
