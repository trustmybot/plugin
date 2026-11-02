var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/db.ts
import { readFileSync } from "node:fs";
function openDb(path) {
  return readFileSync(path, "utf8");
}

// src/index.ts
var db = openDb(process.argv[2]);
export {
  db
};
//# sourceMappingURL=index.js.map
