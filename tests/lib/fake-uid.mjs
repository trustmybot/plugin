// Test-only preload (NODE_OPTIONS=--import <this file>): the uid the
// containment-guard l3 suite and the hooks parity test give `id -u` through a
// PATH shim, so /tmp/claude-<uid> never covers their sandbox.
export const FAKE_UID = 4242424;
process.getuid = () => FAKE_UID;
