### Fixed
- **Codex world-model queries resolve relative repository paths from the project root** (GH 2158): shared queries now use the runtime's explicit root instead of the trajectory database directory, restoring checkout-lag reporting for relative nested repositories. Claude path resolution and absolute repository paths keep their existing behavior.
