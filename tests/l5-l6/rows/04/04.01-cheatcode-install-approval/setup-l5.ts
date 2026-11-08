// Cheatcode-install L5 isolation: seed a deterministic marketplace-install
// fixture at the project-root file cheatcode_install reads by default, so no
// live web / real marketplace call is ever made. The {installed, version}
// object stands in for the marketplace result; the attachment + audit records
// the install writes are computed the same way regardless, so the fixture only
// enriches the reported version.
import { setupArgs, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
writeFile(project, '.tmb-cheatcode-install-fixture.json', '{ "installed": true, "version": "1.4.0", "error": null }\n');
