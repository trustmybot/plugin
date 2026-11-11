### Added
- **The world model now indexes Python** (GH 3032): `/scan` records each `.py` file's classes, methods, functions and module-level constants, and links its imports, calls and class instantiations to the files and symbols they reach, so `world_model_search` and `world_model_symbol` answer for Python code too.
