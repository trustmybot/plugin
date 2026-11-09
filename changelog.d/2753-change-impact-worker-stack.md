### Fixed
- **A failed Change impact request logs where it failed** (GH 2753): when `GET /api/insights/change-impact` hit an error inside its worker thread, the dashboard's terminal showed only a main-thread stack. It now prints the stack from inside the worker, where the computation failed. The 500 response body is unchanged and never carries the stack.
