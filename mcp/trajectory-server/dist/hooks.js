var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err2) => function __init() {
  if (err2) throw err2[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err2 = [e], e;
  }
};
var __export = (target, all) => {
  for (var name3 in all)
    __defProp(target, name3, { get: all[name3], enumerable: true });
};

// node_modules/.bun/web-tree-sitter@0.25.10/node_modules/web-tree-sitter/tree-sitter.js
var tree_sitter_exports = {};
__export(tree_sitter_exports, {
  CaptureQuantifier: () => CaptureQuantifier,
  LANGUAGE_VERSION: () => LANGUAGE_VERSION,
  Language: () => Language,
  LookaheadIterator: () => LookaheadIterator,
  MIN_COMPATIBLE_VERSION: () => MIN_COMPATIBLE_VERSION,
  Node: () => Node,
  Parser: () => Parser,
  Query: () => Query,
  Tree: () => Tree,
  TreeCursor: () => TreeCursor
});
function assertInternal(x) {
  if (x !== INTERNAL) throw new Error("Illegal constructor");
}
function isPoint(point) {
  return !!point && typeof point.row === "number" && typeof point.column === "number";
}
function setModule(module2) {
  C = module2;
}
function getText(tree, startIndex, endIndex, startPosition) {
  const length = endIndex - startIndex;
  let result = tree.textCallback(startIndex, startPosition);
  if (result) {
    startIndex += result.length;
    while (startIndex < endIndex) {
      const string = tree.textCallback(startIndex, startPosition);
      if (string && string.length > 0) {
        startIndex += string.length;
        result += string;
      } else {
        break;
      }
    }
    if (startIndex > endIndex) {
      result = result.slice(0, length);
    }
  }
  return result ?? "";
}
function unmarshalCaptures(query, tree, address, patternIndex, result) {
  for (let i2 = 0, n = result.length; i2 < n; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
function marshalNode(node, index3 = 0) {
  let address = TRANSFER_BUFFER + index3 * SIZE_OF_NODE;
  C.setValue(address, node.id, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.row, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.column, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node[0], "i32");
}
function unmarshalNode(tree, address = TRANSFER_BUFFER) {
  const id = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  if (id === 0) return null;
  const index3 = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index3,
    startPosition: { row, column },
    other
  });
  return result;
}
function marshalTreeCursor(cursor, address = TRANSFER_BUFFER) {
  C.setValue(address + 0 * SIZE_OF_INT, cursor[0], "i32");
  C.setValue(address + 1 * SIZE_OF_INT, cursor[1], "i32");
  C.setValue(address + 2 * SIZE_OF_INT, cursor[2], "i32");
  C.setValue(address + 3 * SIZE_OF_INT, cursor[3], "i32");
}
function unmarshalTreeCursor(cursor) {
  cursor[0] = C.getValue(TRANSFER_BUFFER + 0 * SIZE_OF_INT, "i32");
  cursor[1] = C.getValue(TRANSFER_BUFFER + 1 * SIZE_OF_INT, "i32");
  cursor[2] = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
  cursor[3] = C.getValue(TRANSFER_BUFFER + 3 * SIZE_OF_INT, "i32");
}
function marshalPoint(address, point) {
  C.setValue(address, point.row, "i32");
  C.setValue(address + SIZE_OF_INT, point.column, "i32");
}
function unmarshalPoint(address) {
  const result = {
    row: C.getValue(address, "i32") >>> 0,
    column: C.getValue(address + SIZE_OF_INT, "i32") >>> 0
  };
  return result;
}
function marshalRange(address, range) {
  marshalPoint(address, range.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, range.endPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, range.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, range.endIndex, "i32");
  address += SIZE_OF_INT;
}
function unmarshalRange(address) {
  const result = {};
  result.startPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.endPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.startIndex = C.getValue(address, "i32") >>> 0;
  address += SIZE_OF_INT;
  result.endIndex = C.getValue(address, "i32") >>> 0;
  return result;
}
function marshalEdit(edit, address = TRANSFER_BUFFER) {
  marshalPoint(address, edit.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.oldEndPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.newEndPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, edit.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.oldEndIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.newEndIndex, "i32");
  address += SIZE_OF_INT;
}
function unmarshalLanguageMetadata(address) {
  const major_version = C.getValue(address, "i32");
  const minor_version = C.getValue(address += SIZE_OF_INT, "i32");
  const patch_version = C.getValue(address += SIZE_OF_INT, "i32");
  return { major_version, minor_version, patch_version };
}
function parseAnyPredicate(steps, index3, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}`
    );
  }
  if (!isCaptureStep(steps[1])) {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}"`
    );
  }
  const isPositive = operator === "eq?" || operator === "any-eq?";
  const matchAll = !operator.startsWith("any-");
  if (isCaptureStep(steps[2])) {
    const captureName1 = steps[1].name;
    const captureName2 = steps[2].name;
    textPredicates[index3].push((captures) => {
      const nodes1 = [];
      const nodes2 = [];
      for (const c of captures) {
        if (c.name === captureName1) nodes1.push(c.node);
        if (c.name === captureName2) nodes2.push(c.node);
      }
      const compare = /* @__PURE__ */ __name((n1, n2, positive) => {
        return positive ? n1.text === n2.text : n1.text !== n2.text;
      }, "compare");
      return matchAll ? nodes1.every((n1) => nodes2.some((n2) => compare(n1, n2, isPositive))) : nodes1.some((n1) => nodes2.some((n2) => compare(n1, n2, isPositive)));
    });
  } else {
    const captureName = steps[1].name;
    const stringValue = steps[2].value;
    const matches = /* @__PURE__ */ __name((n) => n.text === stringValue, "matches");
    const doesNotMatch = /* @__PURE__ */ __name((n) => n.text !== stringValue, "doesNotMatch");
    textPredicates[index3].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName) nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
function parseMatchPredicate(steps, index3, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  if (steps[2].type !== "string") {
    throw new Error(
      `Second argument of \`#${operator}\` predicate must be a string. Got @${steps[2].name}.`
    );
  }
  const isPositive = operator === "match?" || operator === "any-match?";
  const matchAll = !operator.startsWith("any-");
  const captureName = steps[1].name;
  const regex = new RegExp(steps[2].value);
  textPredicates[index3].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    const test = /* @__PURE__ */ __name((text, positive) => {
      return positive ? regex.test(text) : !regex.test(text);
    }, "test");
    if (nodes.length === 0) return !isPositive;
    return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
  });
}
function parseAnyOfPredicate(steps, index3, operator, textPredicates) {
  if (steps.length < 2) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected at least 1. Got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  const isPositive = operator === "any-of?";
  const captureName = steps[1].name;
  const stringSteps = steps.slice(2);
  if (!stringSteps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const values = stringSteps.map((s) => s.value);
  textPredicates[index3].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    if (nodes.length === 0) return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
function parseIsPredicate(steps, index3, operator, assertedProperties, refutedProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`
    );
  }
  if (!steps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const properties = operator === "is?" ? assertedProperties : refutedProperties;
  if (!properties[index3]) properties[index3] = {};
  properties[index3][steps[1].value] = steps[2]?.value ?? null;
}
function parseSetDirective(steps, index3, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index3]) setProperties[index3] = {};
  setProperties[index3][steps[1].value] = steps[2]?.value ?? null;
}
function parsePattern(index3, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
  if (stepType === PREDICATE_STEP_TYPE_CAPTURE) {
    const name22 = captureNames[stepValueId];
    steps.push({ type: "capture", name: name22 });
  } else if (stepType === PREDICATE_STEP_TYPE_STRING) {
    steps.push({ type: "string", value: stringValues[stepValueId] });
  } else if (steps.length > 0) {
    if (steps[0].type !== "string") {
      throw new Error("Predicates must begin with a literal value");
    }
    const operator = steps[0].value;
    switch (operator) {
      case "any-not-eq?":
      case "not-eq?":
      case "any-eq?":
      case "eq?":
        parseAnyPredicate(steps, index3, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index3, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index3, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index3, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index3, setProperties);
        break;
      default:
        predicates[index3].push({ operator, operands: steps.slice(1) });
    }
    steps.length = 0;
  }
}
async function initializeBinding(moduleOptions) {
  if (!Module3) {
    Module3 = await tree_sitter_default(moduleOptions);
  }
  return Module3;
}
function checkModule() {
  return !!Module3;
}
var __defProp2, __name, SIZE_OF_SHORT, SIZE_OF_INT, SIZE_OF_CURSOR, SIZE_OF_NODE, SIZE_OF_POINT, SIZE_OF_RANGE, ZERO_POINT, INTERNAL, C, LookaheadIterator, Tree, TreeCursor, Node, PREDICATE_STEP_TYPE_CAPTURE, PREDICATE_STEP_TYPE_STRING, QUERY_WORD_REGEX, CaptureQuantifier, isCaptureStep, isStringStep, QueryErrorKind, QueryError, Query, LANGUAGE_FUNCTION_REGEX, Language, Module2, tree_sitter_default, Module3, TRANSFER_BUFFER, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser;
var init_tree_sitter = __esm({
  "node_modules/.bun/web-tree-sitter@0.25.10/node_modules/web-tree-sitter/tree-sitter.js"() {
    __defProp2 = Object.defineProperty;
    __name = (target, value) => __defProp2(target, "name", { value, configurable: true });
    SIZE_OF_SHORT = 2;
    SIZE_OF_INT = 4;
    SIZE_OF_CURSOR = 4 * SIZE_OF_INT;
    SIZE_OF_NODE = 5 * SIZE_OF_INT;
    SIZE_OF_POINT = 2 * SIZE_OF_INT;
    SIZE_OF_RANGE = 2 * SIZE_OF_INT + 2 * SIZE_OF_POINT;
    ZERO_POINT = { row: 0, column: 0 };
    INTERNAL = /* @__PURE__ */ Symbol("INTERNAL");
    __name(assertInternal, "assertInternal");
    __name(isPoint, "isPoint");
    __name(setModule, "setModule");
    LookaheadIterator = class {
      static {
        __name(this, "LookaheadIterator");
      }
      /** @internal */
      [0] = 0;
      // Internal handle for WASM
      /** @internal */
      language;
      /** @internal */
      constructor(internal, address, language) {
        assertInternal(internal);
        this[0] = address;
        this.language = language;
      }
      /** Get the current symbol of the lookahead iterator. */
      get currentTypeId() {
        return C._ts_lookahead_iterator_current_symbol(this[0]);
      }
      /** Get the current symbol name of the lookahead iterator. */
      get currentType() {
        return this.language.types[this.currentTypeId] || "ERROR";
      }
      /** Delete the lookahead iterator, freeing its resources. */
      delete() {
        C._ts_lookahead_iterator_delete(this[0]);
        this[0] = 0;
      }
      /**
       * Reset the lookahead iterator.
       *
       * This returns `true` if the language was set successfully and `false`
       * otherwise.
       */
      reset(language, stateId) {
        if (C._ts_lookahead_iterator_reset(this[0], language[0], stateId)) {
          this.language = language;
          return true;
        }
        return false;
      }
      /**
       * Reset the lookahead iterator to another state.
       *
       * This returns `true` if the iterator was reset to the given state and
       * `false` otherwise.
       */
      resetState(stateId) {
        return Boolean(C._ts_lookahead_iterator_reset_state(this[0], stateId));
      }
      /**
       * Returns an iterator that iterates over the symbols of the lookahead iterator.
       *
       * The iterator will yield the current symbol name as a string for each step
       * until there are no more symbols to iterate over.
       */
      [Symbol.iterator]() {
        return {
          next: /* @__PURE__ */ __name(() => {
            if (C._ts_lookahead_iterator_next(this[0])) {
              return { done: false, value: this.currentType };
            }
            return { done: true, value: "" };
          }, "next")
        };
      }
    };
    __name(getText, "getText");
    Tree = class _Tree {
      static {
        __name(this, "Tree");
      }
      /** @internal */
      [0] = 0;
      // Internal handle for WASM
      /** @internal */
      textCallback;
      /** The language that was used to parse the syntax tree. */
      language;
      /** @internal */
      constructor(internal, address, language, textCallback) {
        assertInternal(internal);
        this[0] = address;
        this.language = language;
        this.textCallback = textCallback;
      }
      /** Create a shallow copy of the syntax tree. This is very fast. */
      copy() {
        const address = C._ts_tree_copy(this[0]);
        return new _Tree(INTERNAL, address, this.language, this.textCallback);
      }
      /** Delete the syntax tree, freeing its resources. */
      delete() {
        C._ts_tree_delete(this[0]);
        this[0] = 0;
      }
      /** Get the root node of the syntax tree. */
      get rootNode() {
        C._ts_tree_root_node_wasm(this[0]);
        return unmarshalNode(this);
      }
      /**
       * Get the root node of the syntax tree, but with its position shifted
       * forward by the given offset.
       */
      rootNodeWithOffset(offsetBytes, offsetExtent) {
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, offsetBytes, "i32");
        marshalPoint(address + SIZE_OF_INT, offsetExtent);
        C._ts_tree_root_node_with_offset_wasm(this[0]);
        return unmarshalNode(this);
      }
      /**
       * Edit the syntax tree to keep it in sync with source code that has been
       * edited.
       *
       * You must describe the edit both in terms of byte offsets and in terms of
       * row/column coordinates.
       */
      edit(edit) {
        marshalEdit(edit);
        C._ts_tree_edit_wasm(this[0]);
      }
      /** Create a new {@link TreeCursor} starting from the root of the tree. */
      walk() {
        return this.rootNode.walk();
      }
      /**
       * Compare this old edited syntax tree to a new syntax tree representing
       * the same document, returning a sequence of ranges whose syntactic
       * structure has changed.
       *
       * For this to work correctly, this syntax tree must have been edited such
       * that its ranges match up to the new tree. Generally, you'll want to
       * call this method right after calling one of the [`Parser::parse`]
       * functions. Call it on the old tree that was passed to parse, and
       * pass the new tree that was returned from `parse`.
       */
      getChangedRanges(other) {
        if (!(other instanceof _Tree)) {
          throw new TypeError("Argument must be a Tree");
        }
        C._ts_tree_get_changed_ranges_wasm(this[0], other[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result;
      }
      /** Get the included ranges that were used to parse the syntax tree. */
      getIncludedRanges() {
        C._ts_tree_included_ranges_wasm(this[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result;
      }
    };
    TreeCursor = class _TreeCursor {
      static {
        __name(this, "TreeCursor");
      }
      /** @internal */
      // @ts-expect-error: never read
      [0] = 0;
      // Internal handle for Wasm
      /** @internal */
      // @ts-expect-error: never read
      [1] = 0;
      // Internal handle for Wasm
      /** @internal */
      // @ts-expect-error: never read
      [2] = 0;
      // Internal handle for Wasm
      /** @internal */
      // @ts-expect-error: never read
      [3] = 0;
      // Internal handle for Wasm
      /** @internal */
      tree;
      /** @internal */
      constructor(internal, tree) {
        assertInternal(internal);
        this.tree = tree;
        unmarshalTreeCursor(this);
      }
      /** Creates a deep copy of the tree cursor. This allocates new memory. */
      copy() {
        const copy = new _TreeCursor(INTERNAL, this.tree);
        C._ts_tree_cursor_copy_wasm(this.tree[0]);
        unmarshalTreeCursor(copy);
        return copy;
      }
      /** Delete the tree cursor, freeing its resources. */
      delete() {
        marshalTreeCursor(this);
        C._ts_tree_cursor_delete_wasm(this.tree[0]);
        this[0] = this[1] = this[2] = 0;
      }
      /** Get the tree cursor's current {@link Node}. */
      get currentNode() {
        marshalTreeCursor(this);
        C._ts_tree_cursor_current_node_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /**
       * Get the numerical field id of this tree cursor's current node.
       *
       * See also {@link TreeCursor#currentFieldName}.
       */
      get currentFieldId() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_field_id_wasm(this.tree[0]);
      }
      /** Get the field name of this tree cursor's current node. */
      get currentFieldName() {
        return this.tree.language.fields[this.currentFieldId];
      }
      /**
       * Get the depth of the cursor's current node relative to the original
       * node that the cursor was constructed with.
       */
      get currentDepth() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_depth_wasm(this.tree[0]);
      }
      /**
       * Get the index of the cursor's current node out of all of the
       * descendants of the original node that the cursor was constructed with.
       */
      get currentDescendantIndex() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_descendant_index_wasm(this.tree[0]);
      }
      /** Get the type of the cursor's current node. */
      get nodeType() {
        return this.tree.language.types[this.nodeTypeId] || "ERROR";
      }
      /** Get the type id of the cursor's current node. */
      get nodeTypeId() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_node_type_id_wasm(this.tree[0]);
      }
      /** Get the state id of the cursor's current node. */
      get nodeStateId() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_node_state_id_wasm(this.tree[0]);
      }
      /** Get the id of the cursor's current node. */
      get nodeId() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_node_id_wasm(this.tree[0]);
      }
      /**
       * Check if the cursor's current node is *named*.
       *
       * Named nodes correspond to named rules in the grammar, whereas
       * *anonymous* nodes correspond to string literals in the grammar.
       */
      get nodeIsNamed() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_node_is_named_wasm(this.tree[0]) === 1;
      }
      /**
       * Check if the cursor's current node is *missing*.
       *
       * Missing nodes are inserted by the parser in order to recover from
       * certain kinds of syntax errors.
       */
      get nodeIsMissing() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_current_node_is_missing_wasm(this.tree[0]) === 1;
      }
      /** Get the string content of the cursor's current node. */
      get nodeText() {
        marshalTreeCursor(this);
        const startIndex = C._ts_tree_cursor_start_index_wasm(this.tree[0]);
        const endIndex = C._ts_tree_cursor_end_index_wasm(this.tree[0]);
        C._ts_tree_cursor_start_position_wasm(this.tree[0]);
        const startPosition = unmarshalPoint(TRANSFER_BUFFER);
        return getText(this.tree, startIndex, endIndex, startPosition);
      }
      /** Get the start position of the cursor's current node. */
      get startPosition() {
        marshalTreeCursor(this);
        C._ts_tree_cursor_start_position_wasm(this.tree[0]);
        return unmarshalPoint(TRANSFER_BUFFER);
      }
      /** Get the end position of the cursor's current node. */
      get endPosition() {
        marshalTreeCursor(this);
        C._ts_tree_cursor_end_position_wasm(this.tree[0]);
        return unmarshalPoint(TRANSFER_BUFFER);
      }
      /** Get the start index of the cursor's current node. */
      get startIndex() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_start_index_wasm(this.tree[0]);
      }
      /** Get the end index of the cursor's current node. */
      get endIndex() {
        marshalTreeCursor(this);
        return C._ts_tree_cursor_end_index_wasm(this.tree[0]);
      }
      /**
       * Move this cursor to the first child of its current node.
       *
       * This returns `true` if the cursor successfully moved, and returns
       * `false` if there were no children.
       */
      gotoFirstChild() {
        marshalTreeCursor(this);
        const result = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move this cursor to the last child of its current node.
       *
       * This returns `true` if the cursor successfully moved, and returns
       * `false` if there were no children.
       *
       * Note that this function may be slower than
       * {@link TreeCursor#gotoFirstChild} because it needs to
       * iterate through all the children to compute the child's position.
       */
      gotoLastChild() {
        marshalTreeCursor(this);
        const result = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move this cursor to the parent of its current node.
       *
       * This returns `true` if the cursor successfully moved, and returns
       * `false` if there was no parent node (the cursor was already on the
       * root node).
       *
       * Note that the node the cursor was constructed with is considered the root
       * of the cursor, and the cursor cannot walk outside this node.
       */
      gotoParent() {
        marshalTreeCursor(this);
        const result = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move this cursor to the next sibling of its current node.
       *
       * This returns `true` if the cursor successfully moved, and returns
       * `false` if there was no next sibling node.
       *
       * Note that the node the cursor was constructed with is considered the root
       * of the cursor, and the cursor cannot walk outside this node.
       */
      gotoNextSibling() {
        marshalTreeCursor(this);
        const result = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move this cursor to the previous sibling of its current node.
       *
       * This returns `true` if the cursor successfully moved, and returns
       * `false` if there was no previous sibling node.
       *
       * Note that this function may be slower than
       * {@link TreeCursor#gotoNextSibling} due to how node
       * positions are stored. In the worst case, this will need to iterate
       * through all the children up to the previous sibling node to recalculate
       * its position. Also note that the node the cursor was constructed with is
       * considered the root of the cursor, and the cursor cannot walk outside this node.
       */
      gotoPreviousSibling() {
        marshalTreeCursor(this);
        const result = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move the cursor to the node that is the nth descendant of
       * the original node that the cursor was constructed with, where
       * zero represents the original node itself.
       */
      gotoDescendant(goalDescendantIndex) {
        marshalTreeCursor(this);
        C._ts_tree_cursor_goto_descendant_wasm(this.tree[0], goalDescendantIndex);
        unmarshalTreeCursor(this);
      }
      /**
       * Move this cursor to the first child of its current node that contains or
       * starts after the given byte offset.
       *
       * This returns `true` if the cursor successfully moved to a child node, and returns
       * `false` if no such child was found.
       */
      gotoFirstChildForIndex(goalIndex) {
        marshalTreeCursor(this);
        C.setValue(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalIndex, "i32");
        const result = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Move this cursor to the first child of its current node that contains or
       * starts after the given byte offset.
       *
       * This returns the index of the child node if one was found, and returns
       * `null` if no such child was found.
       */
      gotoFirstChildForPosition(goalPosition) {
        marshalTreeCursor(this);
        marshalPoint(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalPosition);
        const result = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result === 1;
      }
      /**
       * Re-initialize this tree cursor to start at the original node that the
       * cursor was constructed with.
       */
      reset(node) {
        marshalNode(node);
        marshalTreeCursor(this, TRANSFER_BUFFER + SIZE_OF_NODE);
        C._ts_tree_cursor_reset_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
      }
      /**
       * Re-initialize a tree cursor to the same position as another cursor.
       *
       * Unlike {@link TreeCursor#reset}, this will not lose parent
       * information and allows reusing already created cursors.
       */
      resetTo(cursor) {
        marshalTreeCursor(this, TRANSFER_BUFFER);
        marshalTreeCursor(cursor, TRANSFER_BUFFER + SIZE_OF_CURSOR);
        C._ts_tree_cursor_reset_to_wasm(this.tree[0], cursor.tree[0]);
        unmarshalTreeCursor(this);
      }
    };
    Node = class {
      static {
        __name(this, "Node");
      }
      /** @internal */
      // @ts-expect-error: never read
      [0] = 0;
      // Internal handle for Wasm
      /** @internal */
      _children;
      /** @internal */
      _namedChildren;
      /** @internal */
      constructor(internal, {
        id,
        tree,
        startIndex,
        startPosition,
        other
      }) {
        assertInternal(internal);
        this[0] = other;
        this.id = id;
        this.tree = tree;
        this.startIndex = startIndex;
        this.startPosition = startPosition;
      }
      /**
       * The numeric id for this node that is unique.
       *
       * Within a given syntax tree, no two nodes have the same id. However:
       *
       * * If a new tree is created based on an older tree, and a node from the old tree is reused in
       *   the process, then that node will have the same id in both trees.
       *
       * * A node not marked as having changes does not guarantee it was reused.
       *
       * * If a node is marked as having changed in the old tree, it will not be reused.
       */
      id;
      /** The byte index where this node starts. */
      startIndex;
      /** The position where this node starts. */
      startPosition;
      /** The tree that this node belongs to. */
      tree;
      /** Get this node's type as a numerical id. */
      get typeId() {
        marshalNode(this);
        return C._ts_node_symbol_wasm(this.tree[0]);
      }
      /**
       * Get the node's type as a numerical id as it appears in the grammar,
       * ignoring aliases.
       */
      get grammarId() {
        marshalNode(this);
        return C._ts_node_grammar_symbol_wasm(this.tree[0]);
      }
      /** Get this node's type as a string. */
      get type() {
        return this.tree.language.types[this.typeId] || "ERROR";
      }
      /**
       * Get this node's symbol name as it appears in the grammar, ignoring
       * aliases as a string.
       */
      get grammarType() {
        return this.tree.language.types[this.grammarId] || "ERROR";
      }
      /**
       * Check if this node is *named*.
       *
       * Named nodes correspond to named rules in the grammar, whereas
       * *anonymous* nodes correspond to string literals in the grammar.
       */
      get isNamed() {
        marshalNode(this);
        return C._ts_node_is_named_wasm(this.tree[0]) === 1;
      }
      /**
       * Check if this node is *extra*.
       *
       * Extra nodes represent things like comments, which are not required
       * by the grammar, but can appear anywhere.
       */
      get isExtra() {
        marshalNode(this);
        return C._ts_node_is_extra_wasm(this.tree[0]) === 1;
      }
      /**
       * Check if this node represents a syntax error.
       *
       * Syntax errors represent parts of the code that could not be incorporated
       * into a valid syntax tree.
       */
      get isError() {
        marshalNode(this);
        return C._ts_node_is_error_wasm(this.tree[0]) === 1;
      }
      /**
       * Check if this node is *missing*.
       *
       * Missing nodes are inserted by the parser in order to recover from
       * certain kinds of syntax errors.
       */
      get isMissing() {
        marshalNode(this);
        return C._ts_node_is_missing_wasm(this.tree[0]) === 1;
      }
      /** Check if this node has been edited. */
      get hasChanges() {
        marshalNode(this);
        return C._ts_node_has_changes_wasm(this.tree[0]) === 1;
      }
      /**
       * Check if this node represents a syntax error or contains any syntax
       * errors anywhere within it.
       */
      get hasError() {
        marshalNode(this);
        return C._ts_node_has_error_wasm(this.tree[0]) === 1;
      }
      /** Get the byte index where this node ends. */
      get endIndex() {
        marshalNode(this);
        return C._ts_node_end_index_wasm(this.tree[0]);
      }
      /** Get the position where this node ends. */
      get endPosition() {
        marshalNode(this);
        C._ts_node_end_point_wasm(this.tree[0]);
        return unmarshalPoint(TRANSFER_BUFFER);
      }
      /** Get the string content of this node. */
      get text() {
        return getText(this.tree, this.startIndex, this.endIndex, this.startPosition);
      }
      /** Get this node's parse state. */
      get parseState() {
        marshalNode(this);
        return C._ts_node_parse_state_wasm(this.tree[0]);
      }
      /** Get the parse state after this node. */
      get nextParseState() {
        marshalNode(this);
        return C._ts_node_next_parse_state_wasm(this.tree[0]);
      }
      /** Check if this node is equal to another node. */
      equals(other) {
        return this.tree === other.tree && this.id === other.id;
      }
      /**
       * Get the node's child at the given index, where zero represents the first child.
       *
       * This method is fairly fast, but its cost is technically log(n), so if
       * you might be iterating over a long list of children, you should use
       * {@link Node#children} instead.
       */
      child(index3) {
        marshalNode(this);
        C._ts_node_child_wasm(this.tree[0], index3);
        return unmarshalNode(this.tree);
      }
      /**
       * Get this node's *named* child at the given index.
       *
       * See also {@link Node#isNamed}.
       * This method is fairly fast, but its cost is technically log(n), so if
       * you might be iterating over a long list of children, you should use
       * {@link Node#namedChildren} instead.
       */
      namedChild(index3) {
        marshalNode(this);
        C._ts_node_named_child_wasm(this.tree[0], index3);
        return unmarshalNode(this.tree);
      }
      /**
       * Get this node's child with the given numerical field id.
       *
       * See also {@link Node#childForFieldName}. You can
       * convert a field name to an id using {@link Language#fieldIdForName}.
       */
      childForFieldId(fieldId) {
        marshalNode(this);
        C._ts_node_child_by_field_id_wasm(this.tree[0], fieldId);
        return unmarshalNode(this.tree);
      }
      /**
       * Get the first child with the given field name.
       *
       * If multiple children may have the same field name, access them using
       * {@link Node#childrenForFieldName}.
       */
      childForFieldName(fieldName) {
        const fieldId = this.tree.language.fields.indexOf(fieldName);
        if (fieldId !== -1) return this.childForFieldId(fieldId);
        return null;
      }
      /** Get the field name of this node's child at the given index. */
      fieldNameForChild(index3) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index3);
        if (!address) return null;
        return C.AsciiToString(address);
      }
      /** Get the field name of this node's named child at the given index. */
      fieldNameForNamedChild(index3) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index3);
        if (!address) return null;
        return C.AsciiToString(address);
      }
      /**
       * Get an array of this node's children with a given field name.
       *
       * See also {@link Node#children}.
       */
      childrenForFieldName(fieldName) {
        const fieldId = this.tree.language.fields.indexOf(fieldName);
        if (fieldId !== -1 && fieldId !== 0) return this.childrenForFieldId(fieldId);
        return [];
      }
      /**
        * Get an array of this node's children with a given field id.
        *
        * See also {@link Node#childrenForFieldName}.
        */
      childrenForFieldId(fieldId) {
        marshalNode(this);
        C._ts_node_children_by_field_id_wasm(this.tree[0], fieldId);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
          C._free(buffer);
        }
        return result;
      }
      /** Get the node's first child that contains or starts after the given byte offset. */
      firstChildForIndex(index3) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index3, "i32");
        C._ts_node_first_child_for_byte_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the node's first named child that contains or starts after the given byte offset. */
      firstNamedChildForIndex(index3) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index3, "i32");
        C._ts_node_first_named_child_for_byte_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get this node's number of children. */
      get childCount() {
        marshalNode(this);
        return C._ts_node_child_count_wasm(this.tree[0]);
      }
      /**
       * Get this node's number of *named* children.
       *
       * See also {@link Node#isNamed}.
       */
      get namedChildCount() {
        marshalNode(this);
        return C._ts_node_named_child_count_wasm(this.tree[0]);
      }
      /** Get this node's first child. */
      get firstChild() {
        return this.child(0);
      }
      /**
       * Get this node's first named child.
       *
       * See also {@link Node#isNamed}.
       */
      get firstNamedChild() {
        return this.namedChild(0);
      }
      /** Get this node's last child. */
      get lastChild() {
        return this.child(this.childCount - 1);
      }
      /**
       * Get this node's last named child.
       *
       * See also {@link Node#isNamed}.
       */
      get lastNamedChild() {
        return this.namedChild(this.namedChildCount - 1);
      }
      /**
       * Iterate over this node's children.
       *
       * If you're walking the tree recursively, you may want to use the
       * {@link TreeCursor} APIs directly instead.
       */
      get children() {
        if (!this._children) {
          marshalNode(this);
          C._ts_node_children_wasm(this.tree[0]);
          const count = C.getValue(TRANSFER_BUFFER, "i32");
          const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
          this._children = new Array(count);
          if (count > 0) {
            let address = buffer;
            for (let i2 = 0; i2 < count; i2++) {
              this._children[i2] = unmarshalNode(this.tree, address);
              address += SIZE_OF_NODE;
            }
            C._free(buffer);
          }
        }
        return this._children;
      }
      /**
       * Iterate over this node's named children.
       *
       * See also {@link Node#children}.
       */
      get namedChildren() {
        if (!this._namedChildren) {
          marshalNode(this);
          C._ts_node_named_children_wasm(this.tree[0]);
          const count = C.getValue(TRANSFER_BUFFER, "i32");
          const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
          this._namedChildren = new Array(count);
          if (count > 0) {
            let address = buffer;
            for (let i2 = 0; i2 < count; i2++) {
              this._namedChildren[i2] = unmarshalNode(this.tree, address);
              address += SIZE_OF_NODE;
            }
            C._free(buffer);
          }
        }
        return this._namedChildren;
      }
      /**
       * Get the descendants of this node that are the given type, or in the given types array.
       *
       * The types array should contain node type strings, which can be retrieved from {@link Language#types}.
       *
       * Additionally, a `startPosition` and `endPosition` can be passed in to restrict the search to a byte range.
       */
      descendantsOfType(types, startPosition = ZERO_POINT, endPosition = ZERO_POINT) {
        if (!Array.isArray(types)) types = [types];
        const symbols = [];
        const typesBySymbol = this.tree.language.types;
        for (const node_type of types) {
          if (node_type == "ERROR") {
            symbols.push(65535);
          }
        }
        for (let i2 = 0, n = typesBySymbol.length; i2 < n; i2++) {
          if (types.includes(typesBySymbol[i2])) {
            symbols.push(i2);
          }
        }
        const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
        for (let i2 = 0, n = symbols.length; i2 < n; i2++) {
          C.setValue(symbolsAddress + i2 * SIZE_OF_INT, symbols[i2], "i32");
        }
        marshalNode(this);
        C._ts_node_descendants_of_type_wasm(
          this.tree[0],
          symbolsAddress,
          symbols.length,
          startPosition.row,
          startPosition.column,
          endPosition.row,
          endPosition.column
        );
        const descendantCount = C.getValue(TRANSFER_BUFFER, "i32");
        const descendantAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(descendantCount);
        if (descendantCount > 0) {
          let address = descendantAddress;
          for (let i2 = 0; i2 < descendantCount; i2++) {
            result[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
        }
        C._free(descendantAddress);
        C._free(symbolsAddress);
        return result;
      }
      /** Get this node's next sibling. */
      get nextSibling() {
        marshalNode(this);
        C._ts_node_next_sibling_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get this node's previous sibling. */
      get previousSibling() {
        marshalNode(this);
        C._ts_node_prev_sibling_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /**
       * Get this node's next *named* sibling.
       *
       * See also {@link Node#isNamed}.
       */
      get nextNamedSibling() {
        marshalNode(this);
        C._ts_node_next_named_sibling_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /**
       * Get this node's previous *named* sibling.
       *
       * See also {@link Node#isNamed}.
       */
      get previousNamedSibling() {
        marshalNode(this);
        C._ts_node_prev_named_sibling_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the node's number of descendants, including one for the node itself. */
      get descendantCount() {
        marshalNode(this);
        return C._ts_node_descendant_count_wasm(this.tree[0]);
      }
      /**
       * Get this node's immediate parent.
       * Prefer {@link Node#childWithDescendant} for iterating over this node's ancestors.
       */
      get parent() {
        marshalNode(this);
        C._ts_node_parent_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /**
       * Get the node that contains `descendant`.
       *
       * Note that this can return `descendant` itself.
       */
      childWithDescendant(descendant) {
        marshalNode(this);
        marshalNode(descendant, 1);
        C._ts_node_child_with_descendant_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the smallest node within this node that spans the given byte range. */
      descendantForIndex(start2, end = start2) {
        if (typeof start2 !== "number" || typeof end !== "number") {
          throw new Error("Arguments must be numbers");
        }
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, start2, "i32");
        C.setValue(address + SIZE_OF_INT, end, "i32");
        C._ts_node_descendant_for_index_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the smallest named node within this node that spans the given byte range. */
      namedDescendantForIndex(start2, end = start2) {
        if (typeof start2 !== "number" || typeof end !== "number") {
          throw new Error("Arguments must be numbers");
        }
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, start2, "i32");
        C.setValue(address + SIZE_OF_INT, end, "i32");
        C._ts_node_named_descendant_for_index_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the smallest node within this node that spans the given point range. */
      descendantForPosition(start2, end = start2) {
        if (!isPoint(start2) || !isPoint(end)) {
          throw new Error("Arguments must be {row, column} objects");
        }
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        marshalPoint(address, start2);
        marshalPoint(address + SIZE_OF_POINT, end);
        C._ts_node_descendant_for_position_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the smallest named node within this node that spans the given point range. */
      namedDescendantForPosition(start2, end = start2) {
        if (!isPoint(start2) || !isPoint(end)) {
          throw new Error("Arguments must be {row, column} objects");
        }
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        marshalPoint(address, start2);
        marshalPoint(address + SIZE_OF_POINT, end);
        C._ts_node_named_descendant_for_position_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /**
       * Create a new {@link TreeCursor} starting from this node.
       *
       * Note that the given node is considered the root of the cursor,
       * and the cursor cannot walk outside this node.
       */
      walk() {
        marshalNode(this);
        C._ts_tree_cursor_new_wasm(this.tree[0]);
        return new TreeCursor(INTERNAL, this.tree);
      }
      /**
       * Edit this node to keep it in-sync with source code that has been edited.
       *
       * This function is only rarely needed. When you edit a syntax tree with
       * the {@link Tree#edit} method, all of the nodes that you retrieve from
       * the tree afterward will already reflect the edit. You only need to
       * use {@link Node#edit} when you have a specific {@link Node} instance that
       * you want to keep and continue to use after an edit.
       */
      edit(edit) {
        if (this.startIndex >= edit.oldEndIndex) {
          this.startIndex = edit.newEndIndex + (this.startIndex - edit.oldEndIndex);
          let subbedPointRow;
          let subbedPointColumn;
          if (this.startPosition.row > edit.oldEndPosition.row) {
            subbedPointRow = this.startPosition.row - edit.oldEndPosition.row;
            subbedPointColumn = this.startPosition.column;
          } else {
            subbedPointRow = 0;
            subbedPointColumn = this.startPosition.column;
            if (this.startPosition.column >= edit.oldEndPosition.column) {
              subbedPointColumn = this.startPosition.column - edit.oldEndPosition.column;
            }
          }
          if (subbedPointRow > 0) {
            this.startPosition.row += subbedPointRow;
            this.startPosition.column = subbedPointColumn;
          } else {
            this.startPosition.column += subbedPointColumn;
          }
        } else if (this.startIndex > edit.startIndex) {
          this.startIndex = edit.newEndIndex;
          this.startPosition.row = edit.newEndPosition.row;
          this.startPosition.column = edit.newEndPosition.column;
        }
      }
      /** Get the S-expression representation of this node. */
      toString() {
        marshalNode(this);
        const address = C._ts_node_to_string_wasm(this.tree[0]);
        const result = C.AsciiToString(address);
        C._free(address);
        return result;
      }
    };
    __name(unmarshalCaptures, "unmarshalCaptures");
    __name(marshalNode, "marshalNode");
    __name(unmarshalNode, "unmarshalNode");
    __name(marshalTreeCursor, "marshalTreeCursor");
    __name(unmarshalTreeCursor, "unmarshalTreeCursor");
    __name(marshalPoint, "marshalPoint");
    __name(unmarshalPoint, "unmarshalPoint");
    __name(marshalRange, "marshalRange");
    __name(unmarshalRange, "unmarshalRange");
    __name(marshalEdit, "marshalEdit");
    __name(unmarshalLanguageMetadata, "unmarshalLanguageMetadata");
    PREDICATE_STEP_TYPE_CAPTURE = 1;
    PREDICATE_STEP_TYPE_STRING = 2;
    QUERY_WORD_REGEX = /[\w-]+/g;
    CaptureQuantifier = {
      Zero: 0,
      ZeroOrOne: 1,
      ZeroOrMore: 2,
      One: 3,
      OneOrMore: 4
    };
    isCaptureStep = /* @__PURE__ */ __name((step) => step.type === "capture", "isCaptureStep");
    isStringStep = /* @__PURE__ */ __name((step) => step.type === "string", "isStringStep");
    QueryErrorKind = {
      Syntax: 1,
      NodeName: 2,
      FieldName: 3,
      CaptureName: 4,
      PatternStructure: 5
    };
    QueryError = class _QueryError extends Error {
      constructor(kind, info2, index3, length) {
        super(_QueryError.formatMessage(kind, info2));
        this.kind = kind;
        this.info = info2;
        this.index = index3;
        this.length = length;
        this.name = "QueryError";
      }
      static {
        __name(this, "QueryError");
      }
      /** Formats an error message based on the error kind and info */
      static formatMessage(kind, info2) {
        switch (kind) {
          case QueryErrorKind.NodeName:
            return `Bad node name '${info2.word}'`;
          case QueryErrorKind.FieldName:
            return `Bad field name '${info2.word}'`;
          case QueryErrorKind.CaptureName:
            return `Bad capture name @${info2.word}`;
          case QueryErrorKind.PatternStructure:
            return `Bad pattern structure at offset ${info2.suffix}`;
          case QueryErrorKind.Syntax:
            return `Bad syntax at offset ${info2.suffix}`;
        }
      }
    };
    __name(parseAnyPredicate, "parseAnyPredicate");
    __name(parseMatchPredicate, "parseMatchPredicate");
    __name(parseAnyOfPredicate, "parseAnyOfPredicate");
    __name(parseIsPredicate, "parseIsPredicate");
    __name(parseSetDirective, "parseSetDirective");
    __name(parsePattern, "parsePattern");
    Query = class {
      static {
        __name(this, "Query");
      }
      /** @internal */
      [0] = 0;
      // Internal handle for WASM
      /** @internal */
      exceededMatchLimit;
      /** @internal */
      textPredicates;
      /** The names of the captures used in the query. */
      captureNames;
      /** The quantifiers of the captures used in the query. */
      captureQuantifiers;
      /**
       * The other user-defined predicates associated with the given index.
       *
       * This includes predicates with operators other than:
       * - `match?`
       * - `eq?` and `not-eq?`
       * - `any-of?` and `not-any-of?`
       * - `is?` and `is-not?`
       * - `set!`
       */
      predicates;
      /** The properties for predicates with the operator `set!`. */
      setProperties;
      /** The properties for predicates with the operator `is?`. */
      assertedProperties;
      /** The properties for predicates with the operator `is-not?`. */
      refutedProperties;
      /** The maximum number of in-progress matches for this cursor. */
      matchLimit;
      /**
       * Create a new query from a string containing one or more S-expression
       * patterns.
       *
       * The query is associated with a particular language, and can only be run
       * on syntax nodes parsed with that language. References to Queries can be
       * shared between multiple threads.
       *
       * @link {@see https://tree-sitter.github.io/tree-sitter/using-parsers/queries}
       */
      constructor(language, source) {
        const sourceLength = C.lengthBytesUTF8(source);
        const sourceAddress = C._malloc(sourceLength + 1);
        C.stringToUTF8(source, sourceAddress, sourceLength + 1);
        const address = C._ts_query_new(
          language[0],
          sourceAddress,
          sourceLength,
          TRANSFER_BUFFER,
          TRANSFER_BUFFER + SIZE_OF_INT
        );
        if (!address) {
          const errorId = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
          const errorByte = C.getValue(TRANSFER_BUFFER, "i32");
          const errorIndex = C.UTF8ToString(sourceAddress, errorByte).length;
          const suffix = source.slice(errorIndex, errorIndex + 100).split("\n")[0];
          const word = suffix.match(QUERY_WORD_REGEX)?.[0] ?? "";
          C._free(sourceAddress);
          switch (errorId) {
            case QueryErrorKind.Syntax:
              throw new QueryError(QueryErrorKind.Syntax, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
            case QueryErrorKind.NodeName:
              throw new QueryError(errorId, { word }, errorIndex, word.length);
            case QueryErrorKind.FieldName:
              throw new QueryError(errorId, { word }, errorIndex, word.length);
            case QueryErrorKind.CaptureName:
              throw new QueryError(errorId, { word }, errorIndex, word.length);
            case QueryErrorKind.PatternStructure:
              throw new QueryError(errorId, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
          }
        }
        const stringCount = C._ts_query_string_count(address);
        const captureCount = C._ts_query_capture_count(address);
        const patternCount = C._ts_query_pattern_count(address);
        const captureNames = new Array(captureCount);
        const captureQuantifiers = new Array(patternCount);
        const stringValues = new Array(stringCount);
        for (let i2 = 0; i2 < captureCount; i2++) {
          const nameAddress = C._ts_query_capture_name_for_id(
            address,
            i2,
            TRANSFER_BUFFER
          );
          const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
          captureNames[i2] = C.UTF8ToString(nameAddress, nameLength);
        }
        for (let i2 = 0; i2 < patternCount; i2++) {
          const captureQuantifiersArray = new Array(captureCount);
          for (let j = 0; j < captureCount; j++) {
            const quantifier = C._ts_query_capture_quantifier_for_id(address, i2, j);
            captureQuantifiersArray[j] = quantifier;
          }
          captureQuantifiers[i2] = captureQuantifiersArray;
        }
        for (let i2 = 0; i2 < stringCount; i2++) {
          const valueAddress = C._ts_query_string_value_for_id(
            address,
            i2,
            TRANSFER_BUFFER
          );
          const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
          stringValues[i2] = C.UTF8ToString(valueAddress, nameLength);
        }
        const setProperties = new Array(patternCount);
        const assertedProperties = new Array(patternCount);
        const refutedProperties = new Array(patternCount);
        const predicates = new Array(patternCount);
        const textPredicates = new Array(patternCount);
        for (let i2 = 0; i2 < patternCount; i2++) {
          const predicatesAddress = C._ts_query_predicates_for_pattern(address, i2, TRANSFER_BUFFER);
          const stepCount = C.getValue(TRANSFER_BUFFER, "i32");
          predicates[i2] = [];
          textPredicates[i2] = [];
          const steps = new Array();
          let stepAddress = predicatesAddress;
          for (let j = 0; j < stepCount; j++) {
            const stepType = C.getValue(stepAddress, "i32");
            stepAddress += SIZE_OF_INT;
            const stepValueId = C.getValue(stepAddress, "i32");
            stepAddress += SIZE_OF_INT;
            parsePattern(
              i2,
              stepType,
              stepValueId,
              captureNames,
              stringValues,
              steps,
              textPredicates,
              predicates,
              setProperties,
              assertedProperties,
              refutedProperties
            );
          }
          Object.freeze(textPredicates[i2]);
          Object.freeze(predicates[i2]);
          Object.freeze(setProperties[i2]);
          Object.freeze(assertedProperties[i2]);
          Object.freeze(refutedProperties[i2]);
        }
        C._free(sourceAddress);
        this[0] = address;
        this.captureNames = captureNames;
        this.captureQuantifiers = captureQuantifiers;
        this.textPredicates = textPredicates;
        this.predicates = predicates;
        this.setProperties = setProperties;
        this.assertedProperties = assertedProperties;
        this.refutedProperties = refutedProperties;
        this.exceededMatchLimit = false;
      }
      /** Delete the query, freeing its resources. */
      delete() {
        C._ts_query_delete(this[0]);
        this[0] = 0;
      }
      /**
       * Iterate over all of the matches in the order that they were found.
       *
       * Each match contains the index of the pattern that matched, and a list of
       * captures. Because multiple patterns can match the same set of nodes,
       * one match may contain captures that appear *before* some of the
       * captures from a previous match.
       *
       * @param {Node} node - The node to execute the query on.
       *
       * @param {QueryOptions} options - Options for query execution.
       */
      matches(node, options = {}) {
        const startPosition = options.startPosition ?? ZERO_POINT;
        const endPosition = options.endPosition ?? ZERO_POINT;
        const startIndex = options.startIndex ?? 0;
        const endIndex = options.endIndex ?? 0;
        const matchLimit = options.matchLimit ?? 4294967295;
        const maxStartDepth = options.maxStartDepth ?? 4294967295;
        const timeoutMicros = options.timeoutMicros ?? 0;
        const progressCallback = options.progressCallback;
        if (typeof matchLimit !== "number") {
          throw new Error("Arguments must be numbers");
        }
        this.matchLimit = matchLimit;
        if (endIndex !== 0 && startIndex > endIndex) {
          throw new Error("`startIndex` cannot be greater than `endIndex`");
        }
        if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
          throw new Error("`startPosition` cannot be greater than `endPosition`");
        }
        if (progressCallback) {
          C.currentQueryProgressCallback = progressCallback;
        }
        marshalNode(node);
        C._ts_query_matches_wasm(
          this[0],
          node.tree[0],
          startPosition.row,
          startPosition.column,
          endPosition.row,
          endPosition.column,
          startIndex,
          endIndex,
          matchLimit,
          maxStartDepth,
          timeoutMicros
        );
        const rawCount = C.getValue(TRANSFER_BUFFER, "i32");
        const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
        const result = new Array(rawCount);
        this.exceededMatchLimit = Boolean(didExceedMatchLimit);
        let filteredCount = 0;
        let address = startAddress;
        for (let i2 = 0; i2 < rawCount; i2++) {
          const patternIndex = C.getValue(address, "i32");
          address += SIZE_OF_INT;
          const captureCount = C.getValue(address, "i32");
          address += SIZE_OF_INT;
          const captures = new Array(captureCount);
          address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
          if (this.textPredicates[patternIndex].every((p) => p(captures))) {
            result[filteredCount] = { pattern: patternIndex, patternIndex, captures };
            const setProperties = this.setProperties[patternIndex];
            result[filteredCount].setProperties = setProperties;
            const assertedProperties = this.assertedProperties[patternIndex];
            result[filteredCount].assertedProperties = assertedProperties;
            const refutedProperties = this.refutedProperties[patternIndex];
            result[filteredCount].refutedProperties = refutedProperties;
            filteredCount++;
          }
        }
        result.length = filteredCount;
        C._free(startAddress);
        C.currentQueryProgressCallback = null;
        return result;
      }
      /**
       * Iterate over all of the individual captures in the order that they
       * appear.
       *
       * This is useful if you don't care about which pattern matched, and just
       * want a single, ordered sequence of captures.
       *
       * @param {Node} node - The node to execute the query on.
       *
       * @param {QueryOptions} options - Options for query execution.
       */
      captures(node, options = {}) {
        const startPosition = options.startPosition ?? ZERO_POINT;
        const endPosition = options.endPosition ?? ZERO_POINT;
        const startIndex = options.startIndex ?? 0;
        const endIndex = options.endIndex ?? 0;
        const matchLimit = options.matchLimit ?? 4294967295;
        const maxStartDepth = options.maxStartDepth ?? 4294967295;
        const timeoutMicros = options.timeoutMicros ?? 0;
        const progressCallback = options.progressCallback;
        if (typeof matchLimit !== "number") {
          throw new Error("Arguments must be numbers");
        }
        this.matchLimit = matchLimit;
        if (endIndex !== 0 && startIndex > endIndex) {
          throw new Error("`startIndex` cannot be greater than `endIndex`");
        }
        if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
          throw new Error("`startPosition` cannot be greater than `endPosition`");
        }
        if (progressCallback) {
          C.currentQueryProgressCallback = progressCallback;
        }
        marshalNode(node);
        C._ts_query_captures_wasm(
          this[0],
          node.tree[0],
          startPosition.row,
          startPosition.column,
          endPosition.row,
          endPosition.column,
          startIndex,
          endIndex,
          matchLimit,
          maxStartDepth,
          timeoutMicros
        );
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
        const result = new Array();
        this.exceededMatchLimit = Boolean(didExceedMatchLimit);
        const captures = new Array();
        let address = startAddress;
        for (let i2 = 0; i2 < count; i2++) {
          const patternIndex = C.getValue(address, "i32");
          address += SIZE_OF_INT;
          const captureCount = C.getValue(address, "i32");
          address += SIZE_OF_INT;
          const captureIndex = C.getValue(address, "i32");
          address += SIZE_OF_INT;
          captures.length = captureCount;
          address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
          if (this.textPredicates[patternIndex].every((p) => p(captures))) {
            const capture2 = captures[captureIndex];
            const setProperties = this.setProperties[patternIndex];
            capture2.setProperties = setProperties;
            const assertedProperties = this.assertedProperties[patternIndex];
            capture2.assertedProperties = assertedProperties;
            const refutedProperties = this.refutedProperties[patternIndex];
            capture2.refutedProperties = refutedProperties;
            result.push(capture2);
          }
        }
        C._free(startAddress);
        C.currentQueryProgressCallback = null;
        return result;
      }
      /** Get the predicates for a given pattern. */
      predicatesForPattern(patternIndex) {
        return this.predicates[patternIndex];
      }
      /**
       * Disable a certain capture within a query.
       *
       * This prevents the capture from being returned in matches, and also
       * avoids any resource usage associated with recording the capture.
       */
      disableCapture(captureName) {
        const captureNameLength = C.lengthBytesUTF8(captureName);
        const captureNameAddress = C._malloc(captureNameLength + 1);
        C.stringToUTF8(captureName, captureNameAddress, captureNameLength + 1);
        C._ts_query_disable_capture(this[0], captureNameAddress, captureNameLength);
        C._free(captureNameAddress);
      }
      /**
       * Disable a certain pattern within a query.
       *
       * This prevents the pattern from matching, and also avoids any resource
       * usage associated with the pattern. This throws an error if the pattern
       * index is out of bounds.
       */
      disablePattern(patternIndex) {
        if (patternIndex >= this.predicates.length) {
          throw new Error(
            `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
          );
        }
        C._ts_query_disable_pattern(this[0], patternIndex);
      }
      /**
       * Check if, on its last execution, this cursor exceeded its maximum number
       * of in-progress matches.
       */
      didExceedMatchLimit() {
        return this.exceededMatchLimit;
      }
      /** Get the byte offset where the given pattern starts in the query's source. */
      startIndexForPattern(patternIndex) {
        if (patternIndex >= this.predicates.length) {
          throw new Error(
            `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
          );
        }
        return C._ts_query_start_byte_for_pattern(this[0], patternIndex);
      }
      /** Get the byte offset where the given pattern ends in the query's source. */
      endIndexForPattern(patternIndex) {
        if (patternIndex >= this.predicates.length) {
          throw new Error(
            `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
          );
        }
        return C._ts_query_end_byte_for_pattern(this[0], patternIndex);
      }
      /** Get the number of patterns in the query. */
      patternCount() {
        return C._ts_query_pattern_count(this[0]);
      }
      /** Get the index for a given capture name. */
      captureIndexForName(captureName) {
        return this.captureNames.indexOf(captureName);
      }
      /** Check if a given pattern within a query has a single root node. */
      isPatternRooted(patternIndex) {
        return C._ts_query_is_pattern_rooted(this[0], patternIndex) === 1;
      }
      /** Check if a given pattern within a query has a single root node. */
      isPatternNonLocal(patternIndex) {
        return C._ts_query_is_pattern_non_local(this[0], patternIndex) === 1;
      }
      /**
       * Check if a given step in a query is 'definite'.
       *
       * A query step is 'definite' if its parent pattern will be guaranteed to
       * match successfully once it reaches the step.
       */
      isPatternGuaranteedAtStep(byteIndex) {
        return C._ts_query_is_pattern_guaranteed_at_step(this[0], byteIndex) === 1;
      }
    };
    LANGUAGE_FUNCTION_REGEX = /^tree_sitter_\w+$/;
    Language = class _Language {
      static {
        __name(this, "Language");
      }
      /** @internal */
      [0] = 0;
      // Internal handle for WASM
      /**
       * A list of all node types in the language. The index of each type in this
       * array is its node type id.
       */
      types;
      /**
       * A list of all field names in the language. The index of each field name in
       * this array is its field id.
       */
      fields;
      /** @internal */
      constructor(internal, address) {
        assertInternal(internal);
        this[0] = address;
        this.types = new Array(C._ts_language_symbol_count(this[0]));
        for (let i2 = 0, n = this.types.length; i2 < n; i2++) {
          if (C._ts_language_symbol_type(this[0], i2) < 2) {
            this.types[i2] = C.UTF8ToString(C._ts_language_symbol_name(this[0], i2));
          }
        }
        this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
        for (let i2 = 0, n = this.fields.length; i2 < n; i2++) {
          const fieldName = C._ts_language_field_name_for_id(this[0], i2);
          if (fieldName !== 0) {
            this.fields[i2] = C.UTF8ToString(fieldName);
          } else {
            this.fields[i2] = null;
          }
        }
      }
      /**
       * Gets the name of the language.
       */
      get name() {
        const ptr = C._ts_language_name(this[0]);
        if (ptr === 0) return null;
        return C.UTF8ToString(ptr);
      }
      /**
       * @deprecated since version 0.25.0, use {@link Language#abiVersion} instead
       * Gets the version of the language.
       */
      get version() {
        return C._ts_language_version(this[0]);
      }
      /**
       * Gets the ABI version of the language.
       */
      get abiVersion() {
        return C._ts_language_abi_version(this[0]);
      }
      /**
      * Get the metadata for this language. This information is generated by the
      * CLI, and relies on the language author providing the correct metadata in
      * the language's `tree-sitter.json` file.
      */
      get metadata() {
        C._ts_language_metadata(this[0]);
        const length = C.getValue(TRANSFER_BUFFER, "i32");
        const address = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        if (length === 0) return null;
        return unmarshalLanguageMetadata(address);
      }
      /**
       * Gets the number of fields in the language.
       */
      get fieldCount() {
        return this.fields.length - 1;
      }
      /**
       * Gets the number of states in the language.
       */
      get stateCount() {
        return C._ts_language_state_count(this[0]);
      }
      /**
       * Get the field id for a field name.
       */
      fieldIdForName(fieldName) {
        const result = this.fields.indexOf(fieldName);
        return result !== -1 ? result : null;
      }
      /**
       * Get the field name for a field id.
       */
      fieldNameForId(fieldId) {
        return this.fields[fieldId] ?? null;
      }
      /**
       * Get the node type id for a node type name.
       */
      idForNodeType(type, named) {
        const typeLength = C.lengthBytesUTF8(type);
        const typeAddress = C._malloc(typeLength + 1);
        C.stringToUTF8(type, typeAddress, typeLength + 1);
        const result = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named ? 1 : 0);
        C._free(typeAddress);
        return result || null;
      }
      /**
       * Gets the number of node types in the language.
       */
      get nodeTypeCount() {
        return C._ts_language_symbol_count(this[0]);
      }
      /**
       * Get the node type name for a node type id.
       */
      nodeTypeForId(typeId) {
        const name22 = C._ts_language_symbol_name(this[0], typeId);
        return name22 ? C.UTF8ToString(name22) : null;
      }
      /**
       * Check if a node type is named.
       *
       * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html#named-vs-anonymous-nodes}
       */
      nodeTypeIsNamed(typeId) {
        return C._ts_language_type_is_named_wasm(this[0], typeId) ? true : false;
      }
      /**
       * Check if a node type is visible.
       */
      nodeTypeIsVisible(typeId) {
        return C._ts_language_type_is_visible_wasm(this[0], typeId) ? true : false;
      }
      /**
       * Get the supertypes ids of this language.
       *
       * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types.html?highlight=supertype#supertype-nodes}
       */
      get supertypes() {
        C._ts_language_supertypes_wasm(this[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = C.getValue(address, "i16");
            address += SIZE_OF_SHORT;
          }
        }
        return result;
      }
      /**
       * Get the subtype ids for a given supertype node id.
       */
      subtypes(supertype) {
        C._ts_language_subtypes_wasm(this[0], supertype);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = C.getValue(address, "i16");
            address += SIZE_OF_SHORT;
          }
        }
        return result;
      }
      /**
       * Get the next state id for a given state id and node type id.
       */
      nextState(stateId, typeId) {
        return C._ts_language_next_state(this[0], stateId, typeId);
      }
      /**
       * Create a new lookahead iterator for this language and parse state.
       *
       * This returns `null` if state is invalid for this language.
       *
       * Iterating {@link LookaheadIterator} will yield valid symbols in the given
       * parse state. Newly created lookahead iterators will return the `ERROR`
       * symbol from {@link LookaheadIterator#currentType}.
       *
       * Lookahead iterators can be useful for generating suggestions and improving
       * syntax error diagnostics. To get symbols valid in an `ERROR` node, use the
       * lookahead iterator on its first leaf node state. For `MISSING` nodes, a
       * lookahead iterator created on the previous non-extra leaf node may be
       * appropriate.
       */
      lookaheadIterator(stateId) {
        const address = C._ts_lookahead_iterator_new(this[0], stateId);
        if (address) return new LookaheadIterator(INTERNAL, address, this);
        return null;
      }
      /**
       * @deprecated since version 0.25.0, call `new` on a {@link Query} instead
       *
       * Create a new query from a string containing one or more S-expression
       * patterns.
       *
       * The query is associated with a particular language, and can only be run
       * on syntax nodes parsed with that language. References to Queries can be
       * shared between multiple threads.
       *
       * @link {@see https://tree-sitter.github.io/tree-sitter/using-parsers/queries}
       */
      query(source) {
        console.warn("Language.query is deprecated. Use new Query(language, source) instead.");
        return new Query(this, source);
      }
      /**
       * Load a language from a WebAssembly module.
       * The module can be provided as a path to a file or as a buffer.
       */
      static async load(input) {
        let bytes;
        if (input instanceof Uint8Array) {
          bytes = Promise.resolve(input);
        } else {
          if (globalThis.process?.versions.node) {
            const fs2 = await import("fs/promises");
            bytes = fs2.readFile(input);
          } else {
            bytes = fetch(input).then((response) => response.arrayBuffer().then((buffer) => {
              if (response.ok) {
                return new Uint8Array(buffer);
              } else {
                const body2 = new TextDecoder("utf-8").decode(buffer);
                throw new Error(`Language.load failed with status ${response.status}.

${body2}`);
              }
            }));
          }
        }
        const mod = await C.loadWebAssemblyModule(await bytes, { loadAsync: true });
        const symbolNames = Object.keys(mod);
        const functionName = symbolNames.find((key2) => LANGUAGE_FUNCTION_REGEX.test(key2) && !key2.includes("external_scanner_"));
        if (!functionName) {
          console.log(`Couldn't find language function in WASM file. Symbols:
${JSON.stringify(symbolNames, null, 2)}`);
          throw new Error("Language.load failed: no language function found in WASM file");
        }
        const languageAddress = mod[functionName]();
        return new _Language(INTERNAL, languageAddress);
      }
    };
    Module2 = (() => {
      var _scriptName = import.meta.url;
      return async function(moduleArg = {}) {
        var moduleRtn;
        var Module = moduleArg;
        var readyPromiseResolve, readyPromiseReject;
        var readyPromise = new Promise((resolve3, reject) => {
          readyPromiseResolve = resolve3;
          readyPromiseReject = reject;
        });
        var ENVIRONMENT_IS_WEB = typeof window == "object";
        var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
        var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
        var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
        if (ENVIRONMENT_IS_NODE) {
          const { createRequire: createRequire2 } = await import("module");
          var require = createRequire2(import.meta.url);
        }
        Module.currentQueryProgressCallback = null;
        Module.currentProgressCallback = null;
        Module.currentLogCallback = null;
        Module.currentParseCallback = null;
        var moduleOverrides = Object.assign({}, Module);
        var arguments_ = [];
        var thisProgram = "./this.program";
        var quit_ = /* @__PURE__ */ __name((status, toThrow) => {
          throw toThrow;
        }, "quit_");
        var scriptDirectory = "";
        function locateFile(path) {
          if (Module["locateFile"]) {
            return Module["locateFile"](path, scriptDirectory);
          }
          return scriptDirectory + path;
        }
        __name(locateFile, "locateFile");
        var readAsync, readBinary;
        if (ENVIRONMENT_IS_NODE) {
          var fs = require("fs");
          var nodePath = require("path");
          if (!import.meta.url.startsWith("data:")) {
            scriptDirectory = nodePath.dirname(require("url").fileURLToPath(import.meta.url)) + "/";
          }
          readBinary = /* @__PURE__ */ __name((filename) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename);
            return ret;
          }, "readBinary");
          readAsync = /* @__PURE__ */ __name(async (filename, binary2 = true) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename, binary2 ? void 0 : "utf8");
            return ret;
          }, "readAsync");
          if (!Module["thisProgram"] && process.argv.length > 1) {
            thisProgram = process.argv[1].replace(/\\/g, "/");
          }
          arguments_ = process.argv.slice(2);
          quit_ = /* @__PURE__ */ __name((status, toThrow) => {
            process.exitCode = status;
            throw toThrow;
          }, "quit_");
        } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
          if (ENVIRONMENT_IS_WORKER) {
            scriptDirectory = self.location.href;
          } else if (typeof document != "undefined" && document.currentScript) {
            scriptDirectory = document.currentScript.src;
          }
          if (_scriptName) {
            scriptDirectory = _scriptName;
          }
          if (scriptDirectory.startsWith("blob:")) {
            scriptDirectory = "";
          } else {
            scriptDirectory = scriptDirectory.slice(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
          }
          {
            if (ENVIRONMENT_IS_WORKER) {
              readBinary = /* @__PURE__ */ __name((url) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.responseType = "arraybuffer";
                xhr.send(null);
                return new Uint8Array(
                  /** @type{!ArrayBuffer} */
                  xhr.response
                );
              }, "readBinary");
            }
            readAsync = /* @__PURE__ */ __name(async (url) => {
              if (isFileURI(url)) {
                return new Promise((resolve3, reject) => {
                  var xhr = new XMLHttpRequest();
                  xhr.open("GET", url, true);
                  xhr.responseType = "arraybuffer";
                  xhr.onload = () => {
                    if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                      resolve3(xhr.response);
                      return;
                    }
                    reject(xhr.status);
                  };
                  xhr.onerror = reject;
                  xhr.send(null);
                });
              }
              var response = await fetch(url, {
                credentials: "same-origin"
              });
              if (response.ok) {
                return response.arrayBuffer();
              }
              throw new Error(response.status + " : " + response.url);
            }, "readAsync");
          }
        } else {
        }
        var out = Module["print"] || console.log.bind(console);
        var err = Module["printErr"] || console.error.bind(console);
        Object.assign(Module, moduleOverrides);
        moduleOverrides = null;
        if (Module["arguments"]) arguments_ = Module["arguments"];
        if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
        var dynamicLibraries = Module["dynamicLibraries"] || [];
        var wasmBinary = Module["wasmBinary"];
        var wasmMemory;
        var ABORT = false;
        var EXITSTATUS;
        function assert(condition, text) {
          if (!condition) {
            abort(text);
          }
        }
        __name(assert, "assert");
        var HEAP, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAP64, HEAPU64, HEAPF64;
        var HEAP_DATA_VIEW;
        var runtimeInitialized = false;
        var isFileURI = /* @__PURE__ */ __name((filename) => filename.startsWith("file://"), "isFileURI");
        function updateMemoryViews() {
          var b = wasmMemory.buffer;
          Module["HEAP_DATA_VIEW"] = HEAP_DATA_VIEW = new DataView(b);
          Module["HEAP8"] = HEAP8 = new Int8Array(b);
          Module["HEAP16"] = HEAP16 = new Int16Array(b);
          Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
          Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
          Module["HEAP32"] = HEAP32 = new Int32Array(b);
          Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
          Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
          Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
          Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
          Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
        }
        __name(updateMemoryViews, "updateMemoryViews");
        if (Module["wasmMemory"]) {
          wasmMemory = Module["wasmMemory"];
        } else {
          var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
          wasmMemory = new WebAssembly.Memory({
            "initial": INITIAL_MEMORY / 65536,
            // In theory we should not need to emit the maximum if we want "unlimited"
            // or 4GB of memory, but VMs error on that atm, see
            // https://github.com/emscripten-core/emscripten/issues/14130
            // And in the pthreads case we definitely need to emit a maximum. So
            // always emit one.
            "maximum": 32768
          });
        }
        updateMemoryViews();
        var __RELOC_FUNCS__ = [];
        function preRun() {
          if (Module["preRun"]) {
            if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
            while (Module["preRun"].length) {
              addOnPreRun(Module["preRun"].shift());
            }
          }
          callRuntimeCallbacks(onPreRuns);
        }
        __name(preRun, "preRun");
        function initRuntime() {
          runtimeInitialized = true;
          callRuntimeCallbacks(__RELOC_FUNCS__);
          wasmExports["__wasm_call_ctors"]();
          callRuntimeCallbacks(onPostCtors);
        }
        __name(initRuntime, "initRuntime");
        function preMain() {
        }
        __name(preMain, "preMain");
        function postRun() {
          if (Module["postRun"]) {
            if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
            while (Module["postRun"].length) {
              addOnPostRun(Module["postRun"].shift());
            }
          }
          callRuntimeCallbacks(onPostRuns);
        }
        __name(postRun, "postRun");
        var runDependencies = 0;
        var dependenciesFulfilled = null;
        function getUniqueRunDependency(id) {
          return id;
        }
        __name(getUniqueRunDependency, "getUniqueRunDependency");
        function addRunDependency(id) {
          runDependencies++;
          Module["monitorRunDependencies"]?.(runDependencies);
        }
        __name(addRunDependency, "addRunDependency");
        function removeRunDependency(id) {
          runDependencies--;
          Module["monitorRunDependencies"]?.(runDependencies);
          if (runDependencies == 0) {
            if (dependenciesFulfilled) {
              var callback = dependenciesFulfilled;
              dependenciesFulfilled = null;
              callback();
            }
          }
        }
        __name(removeRunDependency, "removeRunDependency");
        function abort(what) {
          Module["onAbort"]?.(what);
          what = "Aborted(" + what + ")";
          err(what);
          ABORT = true;
          what += ". Build with -sASSERTIONS for more info.";
          var e = new WebAssembly.RuntimeError(what);
          readyPromiseReject(e);
          throw e;
        }
        __name(abort, "abort");
        var wasmBinaryFile;
        function findWasmBinary() {
          if (Module["locateFile"]) {
            return locateFile("tree-sitter.wasm");
          }
          return new URL("tree-sitter.wasm", import.meta.url).href;
        }
        __name(findWasmBinary, "findWasmBinary");
        function getBinarySync(file) {
          if (file == wasmBinaryFile && wasmBinary) {
            return new Uint8Array(wasmBinary);
          }
          if (readBinary) {
            return readBinary(file);
          }
          throw "both async and sync fetching of the wasm failed";
        }
        __name(getBinarySync, "getBinarySync");
        async function getWasmBinary(binaryFile) {
          if (!wasmBinary) {
            try {
              var response = await readAsync(binaryFile);
              return new Uint8Array(response);
            } catch {
            }
          }
          return getBinarySync(binaryFile);
        }
        __name(getWasmBinary, "getWasmBinary");
        async function instantiateArrayBuffer(binaryFile, imports) {
          try {
            var binary2 = await getWasmBinary(binaryFile);
            var instance2 = await WebAssembly.instantiate(binary2, imports);
            return instance2;
          } catch (reason) {
            err(`failed to asynchronously prepare wasm: ${reason}`);
            abort(reason);
          }
        }
        __name(instantiateArrayBuffer, "instantiateArrayBuffer");
        async function instantiateAsync(binary2, binaryFile, imports) {
          if (!binary2 && typeof WebAssembly.instantiateStreaming == "function" && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
            try {
              var response = fetch(binaryFile, {
                credentials: "same-origin"
              });
              var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
              return instantiationResult;
            } catch (reason) {
              err(`wasm streaming compile failed: ${reason}`);
              err("falling back to ArrayBuffer instantiation");
            }
          }
          return instantiateArrayBuffer(binaryFile, imports);
        }
        __name(instantiateAsync, "instantiateAsync");
        function getWasmImports() {
          return {
            "env": wasmImports,
            "wasi_snapshot_preview1": wasmImports,
            "GOT.mem": new Proxy(wasmImports, GOTHandler),
            "GOT.func": new Proxy(wasmImports, GOTHandler)
          };
        }
        __name(getWasmImports, "getWasmImports");
        async function createWasm() {
          function receiveInstance(instance2, module2) {
            wasmExports = instance2.exports;
            wasmExports = relocateExports(wasmExports, 1024);
            var metadata2 = getDylinkMetadata(module2);
            if (metadata2.neededDynlibs) {
              dynamicLibraries = metadata2.neededDynlibs.concat(dynamicLibraries);
            }
            mergeLibSymbols(wasmExports, "main");
            LDSO.init();
            loadDylibs();
            __RELOC_FUNCS__.push(wasmExports["__wasm_apply_data_relocs"]);
            removeRunDependency("wasm-instantiate");
            return wasmExports;
          }
          __name(receiveInstance, "receiveInstance");
          addRunDependency("wasm-instantiate");
          function receiveInstantiationResult(result2) {
            return receiveInstance(result2["instance"], result2["module"]);
          }
          __name(receiveInstantiationResult, "receiveInstantiationResult");
          var info2 = getWasmImports();
          if (Module["instantiateWasm"]) {
            return new Promise((resolve3, reject) => {
              Module["instantiateWasm"](info2, (mod, inst) => {
                receiveInstance(mod, inst);
                resolve3(mod.exports);
              });
            });
          }
          wasmBinaryFile ??= findWasmBinary();
          try {
            var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info2);
            var exports = receiveInstantiationResult(result);
            return exports;
          } catch (e) {
            readyPromiseReject(e);
            return Promise.reject(e);
          }
        }
        __name(createWasm, "createWasm");
        var ASM_CONSTS = {};
        class ExitStatus {
          static {
            __name(this, "ExitStatus");
          }
          name = "ExitStatus";
          constructor(status) {
            this.message = `Program terminated with exit(${status})`;
            this.status = status;
          }
        }
        var GOT = {};
        var currentModuleWeakSymbols = /* @__PURE__ */ new Set([]);
        var GOTHandler = {
          get(obj, symName) {
            var rtn = GOT[symName];
            if (!rtn) {
              rtn = GOT[symName] = new WebAssembly.Global({
                "value": "i32",
                "mutable": true
              });
            }
            if (!currentModuleWeakSymbols.has(symName)) {
              rtn.required = true;
            }
            return rtn;
          }
        };
        var LE_HEAP_LOAD_F32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat32(byteOffset, true), "LE_HEAP_LOAD_F32");
        var LE_HEAP_LOAD_F64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat64(byteOffset, true), "LE_HEAP_LOAD_F64");
        var LE_HEAP_LOAD_I16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt16(byteOffset, true), "LE_HEAP_LOAD_I16");
        var LE_HEAP_LOAD_I32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt32(byteOffset, true), "LE_HEAP_LOAD_I32");
        var LE_HEAP_LOAD_U16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint16(byteOffset, true), "LE_HEAP_LOAD_U16");
        var LE_HEAP_LOAD_U32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint32(byteOffset, true), "LE_HEAP_LOAD_U32");
        var LE_HEAP_STORE_F32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat32(byteOffset, value, true), "LE_HEAP_STORE_F32");
        var LE_HEAP_STORE_F64 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat64(byteOffset, value, true), "LE_HEAP_STORE_F64");
        var LE_HEAP_STORE_I16 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt16(byteOffset, value, true), "LE_HEAP_STORE_I16");
        var LE_HEAP_STORE_I32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt32(byteOffset, value, true), "LE_HEAP_STORE_I32");
        var LE_HEAP_STORE_U16 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setUint16(byteOffset, value, true), "LE_HEAP_STORE_U16");
        var LE_HEAP_STORE_U32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setUint32(byteOffset, value, true), "LE_HEAP_STORE_U32");
        var callRuntimeCallbacks = /* @__PURE__ */ __name((callbacks) => {
          while (callbacks.length > 0) {
            callbacks.shift()(Module);
          }
        }, "callRuntimeCallbacks");
        var onPostRuns = [];
        var addOnPostRun = /* @__PURE__ */ __name((cb) => onPostRuns.unshift(cb), "addOnPostRun");
        var onPreRuns = [];
        var addOnPreRun = /* @__PURE__ */ __name((cb) => onPreRuns.unshift(cb), "addOnPreRun");
        var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
        var UTF8ArrayToString = /* @__PURE__ */ __name((heapOrArray, idx = 0, maxBytesToRead = NaN) => {
          var endIdx = idx + maxBytesToRead;
          var endPtr = idx;
          while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
          if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
            return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
          }
          var str = "";
          while (idx < endPtr) {
            var u0 = heapOrArray[idx++];
            if (!(u0 & 128)) {
              str += String.fromCharCode(u0);
              continue;
            }
            var u1 = heapOrArray[idx++] & 63;
            if ((u0 & 224) == 192) {
              str += String.fromCharCode((u0 & 31) << 6 | u1);
              continue;
            }
            var u2 = heapOrArray[idx++] & 63;
            if ((u0 & 240) == 224) {
              u0 = (u0 & 15) << 12 | u1 << 6 | u2;
            } else {
              u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
            }
            if (u0 < 65536) {
              str += String.fromCharCode(u0);
            } else {
              var ch = u0 - 65536;
              str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
            }
          }
          return str;
        }, "UTF8ArrayToString");
        var getDylinkMetadata = /* @__PURE__ */ __name((binary2) => {
          var offset = 0;
          var end = 0;
          function getU8() {
            return binary2[offset++];
          }
          __name(getU8, "getU8");
          function getLEB() {
            var ret = 0;
            var mul = 1;
            while (1) {
              var byte = binary2[offset++];
              ret += (byte & 127) * mul;
              mul *= 128;
              if (!(byte & 128)) break;
            }
            return ret;
          }
          __name(getLEB, "getLEB");
          function getString() {
            var len = getLEB();
            offset += len;
            return UTF8ArrayToString(binary2, offset - len, len);
          }
          __name(getString, "getString");
          function failIf(condition, message) {
            if (condition) throw new Error(message);
          }
          __name(failIf, "failIf");
          var name22 = "dylink.0";
          if (binary2 instanceof WebAssembly.Module) {
            var dylinkSection = WebAssembly.Module.customSections(binary2, name22);
            if (dylinkSection.length === 0) {
              name22 = "dylink";
              dylinkSection = WebAssembly.Module.customSections(binary2, name22);
            }
            failIf(dylinkSection.length === 0, "need dylink section");
            binary2 = new Uint8Array(dylinkSection[0]);
            end = binary2.length;
          } else {
            var int32View = new Uint32Array(new Uint8Array(binary2.subarray(0, 24)).buffer);
            var magicNumberFound = int32View[0] == 1836278016 || int32View[0] == 6386541;
            failIf(!magicNumberFound, "need to see wasm magic number");
            failIf(binary2[8] !== 0, "need the dylink section to be first");
            offset = 9;
            var section_size = getLEB();
            end = offset + section_size;
            name22 = getString();
          }
          var customSection = {
            neededDynlibs: [],
            tlsExports: /* @__PURE__ */ new Set(),
            weakImports: /* @__PURE__ */ new Set()
          };
          if (name22 == "dylink") {
            customSection.memorySize = getLEB();
            customSection.memoryAlign = getLEB();
            customSection.tableSize = getLEB();
            customSection.tableAlign = getLEB();
            var neededDynlibsCount = getLEB();
            for (var i2 = 0; i2 < neededDynlibsCount; ++i2) {
              var libname = getString();
              customSection.neededDynlibs.push(libname);
            }
          } else {
            failIf(name22 !== "dylink.0");
            var WASM_DYLINK_MEM_INFO = 1;
            var WASM_DYLINK_NEEDED = 2;
            var WASM_DYLINK_EXPORT_INFO = 3;
            var WASM_DYLINK_IMPORT_INFO = 4;
            var WASM_SYMBOL_TLS = 256;
            var WASM_SYMBOL_BINDING_MASK = 3;
            var WASM_SYMBOL_BINDING_WEAK = 1;
            while (offset < end) {
              var subsectionType = getU8();
              var subsectionSize = getLEB();
              if (subsectionType === WASM_DYLINK_MEM_INFO) {
                customSection.memorySize = getLEB();
                customSection.memoryAlign = getLEB();
                customSection.tableSize = getLEB();
                customSection.tableAlign = getLEB();
              } else if (subsectionType === WASM_DYLINK_NEEDED) {
                var neededDynlibsCount = getLEB();
                for (var i2 = 0; i2 < neededDynlibsCount; ++i2) {
                  libname = getString();
                  customSection.neededDynlibs.push(libname);
                }
              } else if (subsectionType === WASM_DYLINK_EXPORT_INFO) {
                var count = getLEB();
                while (count--) {
                  var symname = getString();
                  var flags2 = getLEB();
                  if (flags2 & WASM_SYMBOL_TLS) {
                    customSection.tlsExports.add(symname);
                  }
                }
              } else if (subsectionType === WASM_DYLINK_IMPORT_INFO) {
                var count = getLEB();
                while (count--) {
                  var modname = getString();
                  var symname = getString();
                  var flags2 = getLEB();
                  if ((flags2 & WASM_SYMBOL_BINDING_MASK) == WASM_SYMBOL_BINDING_WEAK) {
                    customSection.weakImports.add(symname);
                  }
                }
              } else {
                offset += subsectionSize;
              }
            }
          }
          return customSection;
        }, "getDylinkMetadata");
        function getValue(ptr, type = "i8") {
          if (type.endsWith("*")) type = "*";
          switch (type) {
            case "i1":
              return HEAP8[ptr];
            case "i8":
              return HEAP8[ptr];
            case "i16":
              return LE_HEAP_LOAD_I16((ptr >> 1) * 2);
            case "i32":
              return LE_HEAP_LOAD_I32((ptr >> 2) * 4);
            case "i64":
              return HEAP64[ptr >> 3];
            case "float":
              return LE_HEAP_LOAD_F32((ptr >> 2) * 4);
            case "double":
              return LE_HEAP_LOAD_F64((ptr >> 3) * 8);
            case "*":
              return LE_HEAP_LOAD_U32((ptr >> 2) * 4);
            default:
              abort(`invalid type for getValue: ${type}`);
          }
        }
        __name(getValue, "getValue");
        var newDSO = /* @__PURE__ */ __name((name22, handle2, syms) => {
          var dso = {
            refcount: Infinity,
            name: name22,
            exports: syms,
            global: true
          };
          LDSO.loadedLibsByName[name22] = dso;
          if (handle2 != void 0) {
            LDSO.loadedLibsByHandle[handle2] = dso;
          }
          return dso;
        }, "newDSO");
        var LDSO = {
          loadedLibsByName: {},
          loadedLibsByHandle: {},
          init() {
            newDSO("__main__", 0, wasmImports);
          }
        };
        var ___heap_base = 78224;
        var alignMemory = /* @__PURE__ */ __name((size, alignment) => Math.ceil(size / alignment) * alignment, "alignMemory");
        var getMemory = /* @__PURE__ */ __name((size) => {
          if (runtimeInitialized) {
            return _calloc(size, 1);
          }
          var ret = ___heap_base;
          var end = ret + alignMemory(size, 16);
          ___heap_base = end;
          GOT["__heap_base"].value = end;
          return ret;
        }, "getMemory");
        var isInternalSym = /* @__PURE__ */ __name((symName) => ["__cpp_exception", "__c_longjmp", "__wasm_apply_data_relocs", "__dso_handle", "__tls_size", "__tls_align", "__set_stack_limits", "_emscripten_tls_init", "__wasm_init_tls", "__wasm_call_ctors", "__start_em_asm", "__stop_em_asm", "__start_em_js", "__stop_em_js"].includes(symName) || symName.startsWith("__em_js__"), "isInternalSym");
        var uleb128Encode = /* @__PURE__ */ __name((n, target) => {
          if (n < 128) {
            target.push(n);
          } else {
            target.push(n % 128 | 128, n >> 7);
          }
        }, "uleb128Encode");
        var sigToWasmTypes = /* @__PURE__ */ __name((sig) => {
          var typeNames = {
            "i": "i32",
            "j": "i64",
            "f": "f32",
            "d": "f64",
            "e": "externref",
            "p": "i32"
          };
          var type = {
            parameters: [],
            results: sig[0] == "v" ? [] : [typeNames[sig[0]]]
          };
          for (var i2 = 1; i2 < sig.length; ++i2) {
            type.parameters.push(typeNames[sig[i2]]);
          }
          return type;
        }, "sigToWasmTypes");
        var generateFuncType = /* @__PURE__ */ __name((sig, target) => {
          var sigRet = sig.slice(0, 1);
          var sigParam = sig.slice(1);
          var typeCodes = {
            "i": 127,
            // i32
            "p": 127,
            // i32
            "j": 126,
            // i64
            "f": 125,
            // f32
            "d": 124,
            // f64
            "e": 111
          };
          target.push(96);
          uleb128Encode(sigParam.length, target);
          for (var i2 = 0; i2 < sigParam.length; ++i2) {
            target.push(typeCodes[sigParam[i2]]);
          }
          if (sigRet == "v") {
            target.push(0);
          } else {
            target.push(1, typeCodes[sigRet]);
          }
        }, "generateFuncType");
        var convertJsFunctionToWasm = /* @__PURE__ */ __name((func2, sig) => {
          if (typeof WebAssembly.Function == "function") {
            return new WebAssembly.Function(sigToWasmTypes(sig), func2);
          }
          var typeSectionBody = [1];
          generateFuncType(sig, typeSectionBody);
          var bytes = [
            0,
            97,
            115,
            109,
            // magic ("\0asm")
            1,
            0,
            0,
            0,
            // version: 1
            1
          ];
          uleb128Encode(typeSectionBody.length, bytes);
          bytes.push(...typeSectionBody);
          bytes.push(
            2,
            7,
            // import section
            // (import "e" "f" (func 0 (type 0)))
            1,
            1,
            101,
            1,
            102,
            0,
            0,
            7,
            5,
            // export section
            // (export "f" (func 0 (type 0)))
            1,
            1,
            102,
            0,
            0
          );
          var module2 = new WebAssembly.Module(new Uint8Array(bytes));
          var instance2 = new WebAssembly.Instance(module2, {
            "e": {
              "f": func2
            }
          });
          var wrappedFunc = instance2.exports["f"];
          return wrappedFunc;
        }, "convertJsFunctionToWasm");
        var wasmTableMirror = [];
        var wasmTable = new WebAssembly.Table({
          "initial": 31,
          "element": "anyfunc"
        });
        var getWasmTableEntry = /* @__PURE__ */ __name((funcPtr) => {
          var func2 = wasmTableMirror[funcPtr];
          if (!func2) {
            if (funcPtr >= wasmTableMirror.length) wasmTableMirror.length = funcPtr + 1;
            wasmTableMirror[funcPtr] = func2 = wasmTable.get(funcPtr);
          }
          return func2;
        }, "getWasmTableEntry");
        var updateTableMap = /* @__PURE__ */ __name((offset, count) => {
          if (functionsInTableMap) {
            for (var i2 = offset; i2 < offset + count; i2++) {
              var item = getWasmTableEntry(i2);
              if (item) {
                functionsInTableMap.set(item, i2);
              }
            }
          }
        }, "updateTableMap");
        var functionsInTableMap;
        var getFunctionAddress = /* @__PURE__ */ __name((func2) => {
          if (!functionsInTableMap) {
            functionsInTableMap = /* @__PURE__ */ new WeakMap();
            updateTableMap(0, wasmTable.length);
          }
          return functionsInTableMap.get(func2) || 0;
        }, "getFunctionAddress");
        var freeTableIndexes = [];
        var getEmptyTableSlot = /* @__PURE__ */ __name(() => {
          if (freeTableIndexes.length) {
            return freeTableIndexes.pop();
          }
          try {
            wasmTable.grow(1);
          } catch (err2) {
            if (!(err2 instanceof RangeError)) {
              throw err2;
            }
            throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
          }
          return wasmTable.length - 1;
        }, "getEmptyTableSlot");
        var setWasmTableEntry = /* @__PURE__ */ __name((idx, func2) => {
          wasmTable.set(idx, func2);
          wasmTableMirror[idx] = wasmTable.get(idx);
        }, "setWasmTableEntry");
        var addFunction = /* @__PURE__ */ __name((func2, sig) => {
          var rtn = getFunctionAddress(func2);
          if (rtn) {
            return rtn;
          }
          var ret = getEmptyTableSlot();
          try {
            setWasmTableEntry(ret, func2);
          } catch (err2) {
            if (!(err2 instanceof TypeError)) {
              throw err2;
            }
            var wrapped = convertJsFunctionToWasm(func2, sig);
            setWasmTableEntry(ret, wrapped);
          }
          functionsInTableMap.set(func2, ret);
          return ret;
        }, "addFunction");
        var updateGOT = /* @__PURE__ */ __name((exports, replace) => {
          for (var symName in exports) {
            if (isInternalSym(symName)) {
              continue;
            }
            var value = exports[symName];
            GOT[symName] ||= new WebAssembly.Global({
              "value": "i32",
              "mutable": true
            });
            if (replace || GOT[symName].value == 0) {
              if (typeof value == "function") {
                GOT[symName].value = addFunction(value);
              } else if (typeof value == "number") {
                GOT[symName].value = value;
              } else {
                err(`unhandled export type for '${symName}': ${typeof value}`);
              }
            }
          }
        }, "updateGOT");
        var relocateExports = /* @__PURE__ */ __name((exports, memoryBase2, replace) => {
          var relocated = {};
          for (var e in exports) {
            var value = exports[e];
            if (typeof value == "object") {
              value = value.value;
            }
            if (typeof value == "number") {
              value += memoryBase2;
            }
            relocated[e] = value;
          }
          updateGOT(relocated, replace);
          return relocated;
        }, "relocateExports");
        var isSymbolDefined = /* @__PURE__ */ __name((symName) => {
          var existing = wasmImports[symName];
          if (!existing || existing.stub) {
            return false;
          }
          return true;
        }, "isSymbolDefined");
        var dynCall = /* @__PURE__ */ __name((sig, ptr, args2 = []) => {
          var rtn = getWasmTableEntry(ptr)(...args2);
          return rtn;
        }, "dynCall");
        var stackSave = /* @__PURE__ */ __name(() => _emscripten_stack_get_current(), "stackSave");
        var stackRestore = /* @__PURE__ */ __name((val) => __emscripten_stack_restore(val), "stackRestore");
        var createInvokeFunction = /* @__PURE__ */ __name((sig) => (ptr, ...args2) => {
          var sp = stackSave();
          try {
            return dynCall(sig, ptr, args2);
          } catch (e) {
            stackRestore(sp);
            if (e !== e + 0) throw e;
            _setThrew(1, 0);
            if (sig[0] == "j") return 0n;
          }
        }, "createInvokeFunction");
        var resolveGlobalSymbol = /* @__PURE__ */ __name((symName, direct = false) => {
          var sym;
          if (isSymbolDefined(symName)) {
            sym = wasmImports[symName];
          } else if (symName.startsWith("invoke_")) {
            sym = wasmImports[symName] = createInvokeFunction(symName.split("_")[1]);
          }
          return {
            sym,
            name: symName
          };
        }, "resolveGlobalSymbol");
        var onPostCtors = [];
        var addOnPostCtor = /* @__PURE__ */ __name((cb) => onPostCtors.unshift(cb), "addOnPostCtor");
        var UTF8ToString = /* @__PURE__ */ __name((ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "", "UTF8ToString");
        var loadWebAssemblyModule = /* @__PURE__ */ __name((binary, flags, libName, localScope, handle) => {
          var metadata = getDylinkMetadata(binary);
          currentModuleWeakSymbols = metadata.weakImports;
          function loadModule() {
            var memAlign = Math.pow(2, metadata.memoryAlign);
            var memoryBase = metadata.memorySize ? alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
            var tableBase = metadata.tableSize ? wasmTable.length : 0;
            if (handle) {
              HEAP8[handle + 8] = 1;
              LE_HEAP_STORE_U32((handle + 12 >> 2) * 4, memoryBase);
              LE_HEAP_STORE_I32((handle + 16 >> 2) * 4, metadata.memorySize);
              LE_HEAP_STORE_U32((handle + 20 >> 2) * 4, tableBase);
              LE_HEAP_STORE_I32((handle + 24 >> 2) * 4, metadata.tableSize);
            }
            if (metadata.tableSize) {
              wasmTable.grow(metadata.tableSize);
            }
            var moduleExports;
            function resolveSymbol(sym) {
              var resolved = resolveGlobalSymbol(sym).sym;
              if (!resolved && localScope) {
                resolved = localScope[sym];
              }
              if (!resolved) {
                resolved = moduleExports[sym];
              }
              return resolved;
            }
            __name(resolveSymbol, "resolveSymbol");
            var proxyHandler = {
              get(stubs, prop) {
                switch (prop) {
                  case "__memory_base":
                    return memoryBase;
                  case "__table_base":
                    return tableBase;
                }
                if (prop in wasmImports && !wasmImports[prop].stub) {
                  var res = wasmImports[prop];
                  return res;
                }
                if (!(prop in stubs)) {
                  var resolved;
                  stubs[prop] = (...args2) => {
                    resolved ||= resolveSymbol(prop);
                    return resolved(...args2);
                  };
                }
                return stubs[prop];
              }
            };
            var proxy = new Proxy({}, proxyHandler);
            var info = {
              "GOT.mem": new Proxy({}, GOTHandler),
              "GOT.func": new Proxy({}, GOTHandler),
              "env": proxy,
              "wasi_snapshot_preview1": proxy
            };
            function postInstantiation(module, instance) {
              updateTableMap(tableBase, metadata.tableSize);
              moduleExports = relocateExports(instance.exports, memoryBase);
              if (!flags.allowUndefined) {
                reportUndefinedSymbols();
              }
              function addEmAsm(addr, body) {
                var args = [];
                var arity = 0;
                for (; arity < 16; arity++) {
                  if (body.indexOf("$" + arity) != -1) {
                    args.push("$" + arity);
                  } else {
                    break;
                  }
                }
                args = args.join(",");
                var func = `(${args}) => { ${body} };`;
                ASM_CONSTS[start] = eval(func);
              }
              __name(addEmAsm, "addEmAsm");
              if ("__start_em_asm" in moduleExports) {
                var start = moduleExports["__start_em_asm"];
                var stop = moduleExports["__stop_em_asm"];
                while (start < stop) {
                  var jsString = UTF8ToString(start);
                  addEmAsm(start, jsString);
                  start = HEAPU8.indexOf(0, start) + 1;
                }
              }
              function addEmJs(name, cSig, body) {
                var jsArgs = [];
                cSig = cSig.slice(1, -1);
                if (cSig != "void") {
                  cSig = cSig.split(",");
                  for (var i in cSig) {
                    var jsArg = cSig[i].split(" ").pop();
                    jsArgs.push(jsArg.replace("*", ""));
                  }
                }
                var func = `(${jsArgs}) => ${body};`;
                moduleExports[name] = eval(func);
              }
              __name(addEmJs, "addEmJs");
              for (var name in moduleExports) {
                if (name.startsWith("__em_js__")) {
                  var start = moduleExports[name];
                  var jsString = UTF8ToString(start);
                  var parts = jsString.split("<::>");
                  addEmJs(name.replace("__em_js__", ""), parts[0], parts[1]);
                  delete moduleExports[name];
                }
              }
              var applyRelocs = moduleExports["__wasm_apply_data_relocs"];
              if (applyRelocs) {
                if (runtimeInitialized) {
                  applyRelocs();
                } else {
                  __RELOC_FUNCS__.push(applyRelocs);
                }
              }
              var init = moduleExports["__wasm_call_ctors"];
              if (init) {
                if (runtimeInitialized) {
                  init();
                } else {
                  addOnPostCtor(init);
                }
              }
              return moduleExports;
            }
            __name(postInstantiation, "postInstantiation");
            if (flags.loadAsync) {
              if (binary instanceof WebAssembly.Module) {
                var instance = new WebAssembly.Instance(binary, info);
                return Promise.resolve(postInstantiation(binary, instance));
              }
              return WebAssembly.instantiate(binary, info).then((result) => postInstantiation(result.module, result.instance));
            }
            var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
            var instance = new WebAssembly.Instance(module, info);
            return postInstantiation(module, instance);
          }
          __name(loadModule, "loadModule");
          if (flags.loadAsync) {
            return metadata.neededDynlibs.reduce((chain2, dynNeeded) => chain2.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
          }
          metadata.neededDynlibs.forEach((needed) => loadDynamicLibrary(needed, flags, localScope));
          return loadModule();
        }, "loadWebAssemblyModule");
        var mergeLibSymbols = /* @__PURE__ */ __name((exports, libName2) => {
          for (var [sym, exp] of Object.entries(exports)) {
            const setImport = /* @__PURE__ */ __name((target) => {
              if (!isSymbolDefined(target)) {
                wasmImports[target] = exp;
              }
            }, "setImport");
            setImport(sym);
            const main_alias = "__main_argc_argv";
            if (sym == "main") {
              setImport(main_alias);
            }
            if (sym == main_alias) {
              setImport("main");
            }
          }
        }, "mergeLibSymbols");
        var asyncLoad = /* @__PURE__ */ __name(async (url) => {
          var arrayBuffer = await readAsync(url);
          return new Uint8Array(arrayBuffer);
        }, "asyncLoad");
        function loadDynamicLibrary(libName2, flags2 = {
          global: true,
          nodelete: true
        }, localScope2, handle2) {
          var dso = LDSO.loadedLibsByName[libName2];
          if (dso) {
            if (!flags2.global) {
              if (localScope2) {
                Object.assign(localScope2, dso.exports);
              }
            } else if (!dso.global) {
              dso.global = true;
              mergeLibSymbols(dso.exports, libName2);
            }
            if (flags2.nodelete && dso.refcount !== Infinity) {
              dso.refcount = Infinity;
            }
            dso.refcount++;
            if (handle2) {
              LDSO.loadedLibsByHandle[handle2] = dso;
            }
            return flags2.loadAsync ? Promise.resolve(true) : true;
          }
          dso = newDSO(libName2, handle2, "loading");
          dso.refcount = flags2.nodelete ? Infinity : 1;
          dso.global = flags2.global;
          function loadLibData() {
            if (handle2) {
              var data = LE_HEAP_LOAD_U32((handle2 + 28 >> 2) * 4);
              var dataSize = LE_HEAP_LOAD_U32((handle2 + 32 >> 2) * 4);
              if (data && dataSize) {
                var libData = HEAP8.slice(data, data + dataSize);
                return flags2.loadAsync ? Promise.resolve(libData) : libData;
              }
            }
            var libFile = locateFile(libName2);
            if (flags2.loadAsync) {
              return asyncLoad(libFile);
            }
            if (!readBinary) {
              throw new Error(`${libFile}: file not found, and synchronous loading of external files is not available`);
            }
            return readBinary(libFile);
          }
          __name(loadLibData, "loadLibData");
          function getExports() {
            if (flags2.loadAsync) {
              return loadLibData().then((libData) => loadWebAssemblyModule(libData, flags2, libName2, localScope2, handle2));
            }
            return loadWebAssemblyModule(loadLibData(), flags2, libName2, localScope2, handle2);
          }
          __name(getExports, "getExports");
          function moduleLoaded(exports) {
            if (dso.global) {
              mergeLibSymbols(exports, libName2);
            } else if (localScope2) {
              Object.assign(localScope2, exports);
            }
            dso.exports = exports;
          }
          __name(moduleLoaded, "moduleLoaded");
          if (flags2.loadAsync) {
            return getExports().then((exports) => {
              moduleLoaded(exports);
              return true;
            });
          }
          moduleLoaded(getExports());
          return true;
        }
        __name(loadDynamicLibrary, "loadDynamicLibrary");
        var reportUndefinedSymbols = /* @__PURE__ */ __name(() => {
          for (var [symName, entry] of Object.entries(GOT)) {
            if (entry.value == 0) {
              var value = resolveGlobalSymbol(symName, true).sym;
              if (!value && !entry.required) {
                continue;
              }
              if (typeof value == "function") {
                entry.value = addFunction(value, value.sig);
              } else if (typeof value == "number") {
                entry.value = value;
              } else {
                throw new Error(`bad export type for '${symName}': ${typeof value}`);
              }
            }
          }
        }, "reportUndefinedSymbols");
        var loadDylibs = /* @__PURE__ */ __name(() => {
          if (!dynamicLibraries.length) {
            reportUndefinedSymbols();
            return;
          }
          addRunDependency("loadDylibs");
          dynamicLibraries.reduce((chain2, lib) => chain2.then(() => loadDynamicLibrary(lib, {
            loadAsync: true,
            global: true,
            nodelete: true,
            allowUndefined: true
          })), Promise.resolve()).then(() => {
            reportUndefinedSymbols();
            removeRunDependency("loadDylibs");
          });
        }, "loadDylibs");
        var noExitRuntime = Module["noExitRuntime"] || true;
        function setValue(ptr, value, type = "i8") {
          if (type.endsWith("*")) type = "*";
          switch (type) {
            case "i1":
              HEAP8[ptr] = value;
              break;
            case "i8":
              HEAP8[ptr] = value;
              break;
            case "i16":
              LE_HEAP_STORE_I16((ptr >> 1) * 2, value);
              break;
            case "i32":
              LE_HEAP_STORE_I32((ptr >> 2) * 4, value);
              break;
            case "i64":
              HEAP64[ptr >> 3] = BigInt(value);
              break;
            case "float":
              LE_HEAP_STORE_F32((ptr >> 2) * 4, value);
              break;
            case "double":
              LE_HEAP_STORE_F64((ptr >> 3) * 8, value);
              break;
            case "*":
              LE_HEAP_STORE_U32((ptr >> 2) * 4, value);
              break;
            default:
              abort(`invalid type for setValue: ${type}`);
          }
        }
        __name(setValue, "setValue");
        var ___memory_base = new WebAssembly.Global({
          "value": "i32",
          "mutable": false
        }, 1024);
        var ___stack_pointer = new WebAssembly.Global({
          "value": "i32",
          "mutable": true
        }, 78224);
        var ___table_base = new WebAssembly.Global({
          "value": "i32",
          "mutable": false
        }, 1);
        var __abort_js = /* @__PURE__ */ __name(() => abort(""), "__abort_js");
        __abort_js.sig = "v";
        var _emscripten_get_now = /* @__PURE__ */ __name(() => performance.now(), "_emscripten_get_now");
        _emscripten_get_now.sig = "d";
        var _emscripten_date_now = /* @__PURE__ */ __name(() => Date.now(), "_emscripten_date_now");
        _emscripten_date_now.sig = "d";
        var nowIsMonotonic = 1;
        var checkWasiClock = /* @__PURE__ */ __name((clock_id) => clock_id >= 0 && clock_id <= 3, "checkWasiClock");
        var INT53_MAX = 9007199254740992;
        var INT53_MIN = -9007199254740992;
        var bigintToI53Checked = /* @__PURE__ */ __name((num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num), "bigintToI53Checked");
        function _clock_time_get(clk_id, ignored_precision, ptime) {
          ignored_precision = bigintToI53Checked(ignored_precision);
          if (!checkWasiClock(clk_id)) {
            return 28;
          }
          var now;
          if (clk_id === 0) {
            now = _emscripten_date_now();
          } else if (nowIsMonotonic) {
            now = _emscripten_get_now();
          } else {
            return 52;
          }
          var nsec = Math.round(now * 1e3 * 1e3);
          HEAP64[ptime >> 3] = BigInt(nsec);
          return 0;
        }
        __name(_clock_time_get, "_clock_time_get");
        _clock_time_get.sig = "iijp";
        var getHeapMax = /* @__PURE__ */ __name(() => (
          // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
          // full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
          // for any code that deals with heap sizes, which would require special
          // casing all heap size related code to treat 0 specially.
          2147483648
        ), "getHeapMax");
        var growMemory = /* @__PURE__ */ __name((size) => {
          var b = wasmMemory.buffer;
          var pages = (size - b.byteLength + 65535) / 65536 | 0;
          try {
            wasmMemory.grow(pages);
            updateMemoryViews();
            return 1;
          } catch (e) {
          }
        }, "growMemory");
        var _emscripten_resize_heap = /* @__PURE__ */ __name((requestedSize) => {
          var oldSize = HEAPU8.length;
          requestedSize >>>= 0;
          var maxHeapSize = getHeapMax();
          if (requestedSize > maxHeapSize) {
            return false;
          }
          for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
            var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
            overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
            var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
            var replacement = growMemory(newSize);
            if (replacement) {
              return true;
            }
          }
          return false;
        }, "_emscripten_resize_heap");
        _emscripten_resize_heap.sig = "ip";
        var _fd_close = /* @__PURE__ */ __name((fd) => 52, "_fd_close");
        _fd_close.sig = "ii";
        function _fd_seek(fd, offset, whence, newOffset) {
          offset = bigintToI53Checked(offset);
          return 70;
        }
        __name(_fd_seek, "_fd_seek");
        _fd_seek.sig = "iijip";
        var printCharBuffers = [null, [], []];
        var printChar = /* @__PURE__ */ __name((stream, curr) => {
          var buffer = printCharBuffers[stream];
          if (curr === 0 || curr === 10) {
            (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
            buffer.length = 0;
          } else {
            buffer.push(curr);
          }
        }, "printChar");
        var flush_NO_FILESYSTEM = /* @__PURE__ */ __name(() => {
          if (printCharBuffers[1].length) printChar(1, 10);
          if (printCharBuffers[2].length) printChar(2, 10);
        }, "flush_NO_FILESYSTEM");
        var SYSCALLS = {
          varargs: void 0,
          getStr(ptr) {
            var ret = UTF8ToString(ptr);
            return ret;
          }
        };
        var _fd_write = /* @__PURE__ */ __name((fd, iov, iovcnt, pnum) => {
          var num = 0;
          for (var i2 = 0; i2 < iovcnt; i2++) {
            var ptr = LE_HEAP_LOAD_U32((iov >> 2) * 4);
            var len = LE_HEAP_LOAD_U32((iov + 4 >> 2) * 4);
            iov += 8;
            for (var j = 0; j < len; j++) {
              printChar(fd, HEAPU8[ptr + j]);
            }
            num += len;
          }
          LE_HEAP_STORE_U32((pnum >> 2) * 4, num);
          return 0;
        }, "_fd_write");
        _fd_write.sig = "iippp";
        function _tree_sitter_log_callback(isLexMessage, messageAddress) {
          if (Module.currentLogCallback) {
            const message = UTF8ToString(messageAddress);
            Module.currentLogCallback(message, isLexMessage !== 0);
          }
        }
        __name(_tree_sitter_log_callback, "_tree_sitter_log_callback");
        function _tree_sitter_parse_callback(inputBufferAddress, index3, row, column, lengthAddress) {
          const INPUT_BUFFER_SIZE = 10 * 1024;
          const string = Module.currentParseCallback(index3, {
            row,
            column
          });
          if (typeof string === "string") {
            setValue(lengthAddress, string.length, "i32");
            stringToUTF16(string, inputBufferAddress, INPUT_BUFFER_SIZE);
          } else {
            setValue(lengthAddress, 0, "i32");
          }
        }
        __name(_tree_sitter_parse_callback, "_tree_sitter_parse_callback");
        function _tree_sitter_progress_callback(currentOffset, hasError) {
          if (Module.currentProgressCallback) {
            return Module.currentProgressCallback({
              currentOffset,
              hasError
            });
          }
          return false;
        }
        __name(_tree_sitter_progress_callback, "_tree_sitter_progress_callback");
        function _tree_sitter_query_progress_callback(currentOffset) {
          if (Module.currentQueryProgressCallback) {
            return Module.currentQueryProgressCallback({
              currentOffset
            });
          }
          return false;
        }
        __name(_tree_sitter_query_progress_callback, "_tree_sitter_query_progress_callback");
        var runtimeKeepaliveCounter = 0;
        var keepRuntimeAlive = /* @__PURE__ */ __name(() => noExitRuntime || runtimeKeepaliveCounter > 0, "keepRuntimeAlive");
        var _proc_exit = /* @__PURE__ */ __name((code) => {
          EXITSTATUS = code;
          if (!keepRuntimeAlive()) {
            Module["onExit"]?.(code);
            ABORT = true;
          }
          quit_(code, new ExitStatus(code));
        }, "_proc_exit");
        _proc_exit.sig = "vi";
        var exitJS = /* @__PURE__ */ __name((status, implicit) => {
          EXITSTATUS = status;
          _proc_exit(status);
        }, "exitJS");
        var handleException = /* @__PURE__ */ __name((e) => {
          if (e instanceof ExitStatus || e == "unwind") {
            return EXITSTATUS;
          }
          quit_(1, e);
        }, "handleException");
        var lengthBytesUTF8 = /* @__PURE__ */ __name((str) => {
          var len = 0;
          for (var i2 = 0; i2 < str.length; ++i2) {
            var c = str.charCodeAt(i2);
            if (c <= 127) {
              len++;
            } else if (c <= 2047) {
              len += 2;
            } else if (c >= 55296 && c <= 57343) {
              len += 4;
              ++i2;
            } else {
              len += 3;
            }
          }
          return len;
        }, "lengthBytesUTF8");
        var stringToUTF8Array = /* @__PURE__ */ __name((str, heap, outIdx, maxBytesToWrite) => {
          if (!(maxBytesToWrite > 0)) return 0;
          var startIdx = outIdx;
          var endIdx = outIdx + maxBytesToWrite - 1;
          for (var i2 = 0; i2 < str.length; ++i2) {
            var u = str.charCodeAt(i2);
            if (u >= 55296 && u <= 57343) {
              var u1 = str.charCodeAt(++i2);
              u = 65536 + ((u & 1023) << 10) | u1 & 1023;
            }
            if (u <= 127) {
              if (outIdx >= endIdx) break;
              heap[outIdx++] = u;
            } else if (u <= 2047) {
              if (outIdx + 1 >= endIdx) break;
              heap[outIdx++] = 192 | u >> 6;
              heap[outIdx++] = 128 | u & 63;
            } else if (u <= 65535) {
              if (outIdx + 2 >= endIdx) break;
              heap[outIdx++] = 224 | u >> 12;
              heap[outIdx++] = 128 | u >> 6 & 63;
              heap[outIdx++] = 128 | u & 63;
            } else {
              if (outIdx + 3 >= endIdx) break;
              heap[outIdx++] = 240 | u >> 18;
              heap[outIdx++] = 128 | u >> 12 & 63;
              heap[outIdx++] = 128 | u >> 6 & 63;
              heap[outIdx++] = 128 | u & 63;
            }
          }
          heap[outIdx] = 0;
          return outIdx - startIdx;
        }, "stringToUTF8Array");
        var stringToUTF8 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite), "stringToUTF8");
        var stackAlloc = /* @__PURE__ */ __name((sz) => __emscripten_stack_alloc(sz), "stackAlloc");
        var stringToUTF8OnStack = /* @__PURE__ */ __name((str) => {
          var size = lengthBytesUTF8(str) + 1;
          var ret = stackAlloc(size);
          stringToUTF8(str, ret, size);
          return ret;
        }, "stringToUTF8OnStack");
        var AsciiToString = /* @__PURE__ */ __name((ptr) => {
          var str = "";
          while (1) {
            var ch = HEAPU8[ptr++];
            if (!ch) return str;
            str += String.fromCharCode(ch);
          }
        }, "AsciiToString");
        var stringToUTF16 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => {
          maxBytesToWrite ??= 2147483647;
          if (maxBytesToWrite < 2) return 0;
          maxBytesToWrite -= 2;
          var startPtr = outPtr;
          var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
          for (var i2 = 0; i2 < numCharsToWrite; ++i2) {
            var codeUnit = str.charCodeAt(i2);
            LE_HEAP_STORE_I16((outPtr >> 1) * 2, codeUnit);
            outPtr += 2;
          }
          LE_HEAP_STORE_I16((outPtr >> 1) * 2, 0);
          return outPtr - startPtr;
        }, "stringToUTF16");
        var wasmImports = {
          /** @export */
          __heap_base: ___heap_base,
          /** @export */
          __indirect_function_table: wasmTable,
          /** @export */
          __memory_base: ___memory_base,
          /** @export */
          __stack_pointer: ___stack_pointer,
          /** @export */
          __table_base: ___table_base,
          /** @export */
          _abort_js: __abort_js,
          /** @export */
          clock_time_get: _clock_time_get,
          /** @export */
          emscripten_resize_heap: _emscripten_resize_heap,
          /** @export */
          fd_close: _fd_close,
          /** @export */
          fd_seek: _fd_seek,
          /** @export */
          fd_write: _fd_write,
          /** @export */
          memory: wasmMemory,
          /** @export */
          tree_sitter_log_callback: _tree_sitter_log_callback,
          /** @export */
          tree_sitter_parse_callback: _tree_sitter_parse_callback,
          /** @export */
          tree_sitter_progress_callback: _tree_sitter_progress_callback,
          /** @export */
          tree_sitter_query_progress_callback: _tree_sitter_query_progress_callback
        };
        var wasmExports = await createWasm();
        var ___wasm_call_ctors = wasmExports["__wasm_call_ctors"];
        var _malloc = Module["_malloc"] = wasmExports["malloc"];
        var _calloc = Module["_calloc"] = wasmExports["calloc"];
        var _realloc = Module["_realloc"] = wasmExports["realloc"];
        var _free = Module["_free"] = wasmExports["free"];
        var _memcmp = Module["_memcmp"] = wasmExports["memcmp"];
        var _ts_language_symbol_count = Module["_ts_language_symbol_count"] = wasmExports["ts_language_symbol_count"];
        var _ts_language_state_count = Module["_ts_language_state_count"] = wasmExports["ts_language_state_count"];
        var _ts_language_version = Module["_ts_language_version"] = wasmExports["ts_language_version"];
        var _ts_language_abi_version = Module["_ts_language_abi_version"] = wasmExports["ts_language_abi_version"];
        var _ts_language_metadata = Module["_ts_language_metadata"] = wasmExports["ts_language_metadata"];
        var _ts_language_name = Module["_ts_language_name"] = wasmExports["ts_language_name"];
        var _ts_language_field_count = Module["_ts_language_field_count"] = wasmExports["ts_language_field_count"];
        var _ts_language_next_state = Module["_ts_language_next_state"] = wasmExports["ts_language_next_state"];
        var _ts_language_symbol_name = Module["_ts_language_symbol_name"] = wasmExports["ts_language_symbol_name"];
        var _ts_language_symbol_for_name = Module["_ts_language_symbol_for_name"] = wasmExports["ts_language_symbol_for_name"];
        var _strncmp = Module["_strncmp"] = wasmExports["strncmp"];
        var _ts_language_symbol_type = Module["_ts_language_symbol_type"] = wasmExports["ts_language_symbol_type"];
        var _ts_language_field_name_for_id = Module["_ts_language_field_name_for_id"] = wasmExports["ts_language_field_name_for_id"];
        var _ts_lookahead_iterator_new = Module["_ts_lookahead_iterator_new"] = wasmExports["ts_lookahead_iterator_new"];
        var _ts_lookahead_iterator_delete = Module["_ts_lookahead_iterator_delete"] = wasmExports["ts_lookahead_iterator_delete"];
        var _ts_lookahead_iterator_reset_state = Module["_ts_lookahead_iterator_reset_state"] = wasmExports["ts_lookahead_iterator_reset_state"];
        var _ts_lookahead_iterator_reset = Module["_ts_lookahead_iterator_reset"] = wasmExports["ts_lookahead_iterator_reset"];
        var _ts_lookahead_iterator_next = Module["_ts_lookahead_iterator_next"] = wasmExports["ts_lookahead_iterator_next"];
        var _ts_lookahead_iterator_current_symbol = Module["_ts_lookahead_iterator_current_symbol"] = wasmExports["ts_lookahead_iterator_current_symbol"];
        var _ts_parser_delete = Module["_ts_parser_delete"] = wasmExports["ts_parser_delete"];
        var _ts_parser_reset = Module["_ts_parser_reset"] = wasmExports["ts_parser_reset"];
        var _ts_parser_set_language = Module["_ts_parser_set_language"] = wasmExports["ts_parser_set_language"];
        var _ts_parser_timeout_micros = Module["_ts_parser_timeout_micros"] = wasmExports["ts_parser_timeout_micros"];
        var _ts_parser_set_timeout_micros = Module["_ts_parser_set_timeout_micros"] = wasmExports["ts_parser_set_timeout_micros"];
        var _ts_parser_set_included_ranges = Module["_ts_parser_set_included_ranges"] = wasmExports["ts_parser_set_included_ranges"];
        var _ts_query_new = Module["_ts_query_new"] = wasmExports["ts_query_new"];
        var _ts_query_delete = Module["_ts_query_delete"] = wasmExports["ts_query_delete"];
        var _iswspace = Module["_iswspace"] = wasmExports["iswspace"];
        var _iswalnum = Module["_iswalnum"] = wasmExports["iswalnum"];
        var _ts_query_pattern_count = Module["_ts_query_pattern_count"] = wasmExports["ts_query_pattern_count"];
        var _ts_query_capture_count = Module["_ts_query_capture_count"] = wasmExports["ts_query_capture_count"];
        var _ts_query_string_count = Module["_ts_query_string_count"] = wasmExports["ts_query_string_count"];
        var _ts_query_capture_name_for_id = Module["_ts_query_capture_name_for_id"] = wasmExports["ts_query_capture_name_for_id"];
        var _ts_query_capture_quantifier_for_id = Module["_ts_query_capture_quantifier_for_id"] = wasmExports["ts_query_capture_quantifier_for_id"];
        var _ts_query_string_value_for_id = Module["_ts_query_string_value_for_id"] = wasmExports["ts_query_string_value_for_id"];
        var _ts_query_predicates_for_pattern = Module["_ts_query_predicates_for_pattern"] = wasmExports["ts_query_predicates_for_pattern"];
        var _ts_query_start_byte_for_pattern = Module["_ts_query_start_byte_for_pattern"] = wasmExports["ts_query_start_byte_for_pattern"];
        var _ts_query_end_byte_for_pattern = Module["_ts_query_end_byte_for_pattern"] = wasmExports["ts_query_end_byte_for_pattern"];
        var _ts_query_is_pattern_rooted = Module["_ts_query_is_pattern_rooted"] = wasmExports["ts_query_is_pattern_rooted"];
        var _ts_query_is_pattern_non_local = Module["_ts_query_is_pattern_non_local"] = wasmExports["ts_query_is_pattern_non_local"];
        var _ts_query_is_pattern_guaranteed_at_step = Module["_ts_query_is_pattern_guaranteed_at_step"] = wasmExports["ts_query_is_pattern_guaranteed_at_step"];
        var _ts_query_disable_capture = Module["_ts_query_disable_capture"] = wasmExports["ts_query_disable_capture"];
        var _ts_query_disable_pattern = Module["_ts_query_disable_pattern"] = wasmExports["ts_query_disable_pattern"];
        var _ts_tree_copy = Module["_ts_tree_copy"] = wasmExports["ts_tree_copy"];
        var _ts_tree_delete = Module["_ts_tree_delete"] = wasmExports["ts_tree_delete"];
        var _ts_init = Module["_ts_init"] = wasmExports["ts_init"];
        var _ts_parser_new_wasm = Module["_ts_parser_new_wasm"] = wasmExports["ts_parser_new_wasm"];
        var _ts_parser_enable_logger_wasm = Module["_ts_parser_enable_logger_wasm"] = wasmExports["ts_parser_enable_logger_wasm"];
        var _ts_parser_parse_wasm = Module["_ts_parser_parse_wasm"] = wasmExports["ts_parser_parse_wasm"];
        var _ts_parser_included_ranges_wasm = Module["_ts_parser_included_ranges_wasm"] = wasmExports["ts_parser_included_ranges_wasm"];
        var _ts_language_type_is_named_wasm = Module["_ts_language_type_is_named_wasm"] = wasmExports["ts_language_type_is_named_wasm"];
        var _ts_language_type_is_visible_wasm = Module["_ts_language_type_is_visible_wasm"] = wasmExports["ts_language_type_is_visible_wasm"];
        var _ts_language_supertypes_wasm = Module["_ts_language_supertypes_wasm"] = wasmExports["ts_language_supertypes_wasm"];
        var _ts_language_subtypes_wasm = Module["_ts_language_subtypes_wasm"] = wasmExports["ts_language_subtypes_wasm"];
        var _ts_tree_root_node_wasm = Module["_ts_tree_root_node_wasm"] = wasmExports["ts_tree_root_node_wasm"];
        var _ts_tree_root_node_with_offset_wasm = Module["_ts_tree_root_node_with_offset_wasm"] = wasmExports["ts_tree_root_node_with_offset_wasm"];
        var _ts_tree_edit_wasm = Module["_ts_tree_edit_wasm"] = wasmExports["ts_tree_edit_wasm"];
        var _ts_tree_included_ranges_wasm = Module["_ts_tree_included_ranges_wasm"] = wasmExports["ts_tree_included_ranges_wasm"];
        var _ts_tree_get_changed_ranges_wasm = Module["_ts_tree_get_changed_ranges_wasm"] = wasmExports["ts_tree_get_changed_ranges_wasm"];
        var _ts_tree_cursor_new_wasm = Module["_ts_tree_cursor_new_wasm"] = wasmExports["ts_tree_cursor_new_wasm"];
        var _ts_tree_cursor_copy_wasm = Module["_ts_tree_cursor_copy_wasm"] = wasmExports["ts_tree_cursor_copy_wasm"];
        var _ts_tree_cursor_delete_wasm = Module["_ts_tree_cursor_delete_wasm"] = wasmExports["ts_tree_cursor_delete_wasm"];
        var _ts_tree_cursor_reset_wasm = Module["_ts_tree_cursor_reset_wasm"] = wasmExports["ts_tree_cursor_reset_wasm"];
        var _ts_tree_cursor_reset_to_wasm = Module["_ts_tree_cursor_reset_to_wasm"] = wasmExports["ts_tree_cursor_reset_to_wasm"];
        var _ts_tree_cursor_goto_first_child_wasm = Module["_ts_tree_cursor_goto_first_child_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_wasm"];
        var _ts_tree_cursor_goto_last_child_wasm = Module["_ts_tree_cursor_goto_last_child_wasm"] = wasmExports["ts_tree_cursor_goto_last_child_wasm"];
        var _ts_tree_cursor_goto_first_child_for_index_wasm = Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_index_wasm"];
        var _ts_tree_cursor_goto_first_child_for_position_wasm = Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_position_wasm"];
        var _ts_tree_cursor_goto_next_sibling_wasm = Module["_ts_tree_cursor_goto_next_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_next_sibling_wasm"];
        var _ts_tree_cursor_goto_previous_sibling_wasm = Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_previous_sibling_wasm"];
        var _ts_tree_cursor_goto_descendant_wasm = Module["_ts_tree_cursor_goto_descendant_wasm"] = wasmExports["ts_tree_cursor_goto_descendant_wasm"];
        var _ts_tree_cursor_goto_parent_wasm = Module["_ts_tree_cursor_goto_parent_wasm"] = wasmExports["ts_tree_cursor_goto_parent_wasm"];
        var _ts_tree_cursor_current_node_type_id_wasm = Module["_ts_tree_cursor_current_node_type_id_wasm"] = wasmExports["ts_tree_cursor_current_node_type_id_wasm"];
        var _ts_tree_cursor_current_node_state_id_wasm = Module["_ts_tree_cursor_current_node_state_id_wasm"] = wasmExports["ts_tree_cursor_current_node_state_id_wasm"];
        var _ts_tree_cursor_current_node_is_named_wasm = Module["_ts_tree_cursor_current_node_is_named_wasm"] = wasmExports["ts_tree_cursor_current_node_is_named_wasm"];
        var _ts_tree_cursor_current_node_is_missing_wasm = Module["_ts_tree_cursor_current_node_is_missing_wasm"] = wasmExports["ts_tree_cursor_current_node_is_missing_wasm"];
        var _ts_tree_cursor_current_node_id_wasm = Module["_ts_tree_cursor_current_node_id_wasm"] = wasmExports["ts_tree_cursor_current_node_id_wasm"];
        var _ts_tree_cursor_start_position_wasm = Module["_ts_tree_cursor_start_position_wasm"] = wasmExports["ts_tree_cursor_start_position_wasm"];
        var _ts_tree_cursor_end_position_wasm = Module["_ts_tree_cursor_end_position_wasm"] = wasmExports["ts_tree_cursor_end_position_wasm"];
        var _ts_tree_cursor_start_index_wasm = Module["_ts_tree_cursor_start_index_wasm"] = wasmExports["ts_tree_cursor_start_index_wasm"];
        var _ts_tree_cursor_end_index_wasm = Module["_ts_tree_cursor_end_index_wasm"] = wasmExports["ts_tree_cursor_end_index_wasm"];
        var _ts_tree_cursor_current_field_id_wasm = Module["_ts_tree_cursor_current_field_id_wasm"] = wasmExports["ts_tree_cursor_current_field_id_wasm"];
        var _ts_tree_cursor_current_depth_wasm = Module["_ts_tree_cursor_current_depth_wasm"] = wasmExports["ts_tree_cursor_current_depth_wasm"];
        var _ts_tree_cursor_current_descendant_index_wasm = Module["_ts_tree_cursor_current_descendant_index_wasm"] = wasmExports["ts_tree_cursor_current_descendant_index_wasm"];
        var _ts_tree_cursor_current_node_wasm = Module["_ts_tree_cursor_current_node_wasm"] = wasmExports["ts_tree_cursor_current_node_wasm"];
        var _ts_node_symbol_wasm = Module["_ts_node_symbol_wasm"] = wasmExports["ts_node_symbol_wasm"];
        var _ts_node_field_name_for_child_wasm = Module["_ts_node_field_name_for_child_wasm"] = wasmExports["ts_node_field_name_for_child_wasm"];
        var _ts_node_field_name_for_named_child_wasm = Module["_ts_node_field_name_for_named_child_wasm"] = wasmExports["ts_node_field_name_for_named_child_wasm"];
        var _ts_node_children_by_field_id_wasm = Module["_ts_node_children_by_field_id_wasm"] = wasmExports["ts_node_children_by_field_id_wasm"];
        var _ts_node_first_child_for_byte_wasm = Module["_ts_node_first_child_for_byte_wasm"] = wasmExports["ts_node_first_child_for_byte_wasm"];
        var _ts_node_first_named_child_for_byte_wasm = Module["_ts_node_first_named_child_for_byte_wasm"] = wasmExports["ts_node_first_named_child_for_byte_wasm"];
        var _ts_node_grammar_symbol_wasm = Module["_ts_node_grammar_symbol_wasm"] = wasmExports["ts_node_grammar_symbol_wasm"];
        var _ts_node_child_count_wasm = Module["_ts_node_child_count_wasm"] = wasmExports["ts_node_child_count_wasm"];
        var _ts_node_named_child_count_wasm = Module["_ts_node_named_child_count_wasm"] = wasmExports["ts_node_named_child_count_wasm"];
        var _ts_node_child_wasm = Module["_ts_node_child_wasm"] = wasmExports["ts_node_child_wasm"];
        var _ts_node_named_child_wasm = Module["_ts_node_named_child_wasm"] = wasmExports["ts_node_named_child_wasm"];
        var _ts_node_child_by_field_id_wasm = Module["_ts_node_child_by_field_id_wasm"] = wasmExports["ts_node_child_by_field_id_wasm"];
        var _ts_node_next_sibling_wasm = Module["_ts_node_next_sibling_wasm"] = wasmExports["ts_node_next_sibling_wasm"];
        var _ts_node_prev_sibling_wasm = Module["_ts_node_prev_sibling_wasm"] = wasmExports["ts_node_prev_sibling_wasm"];
        var _ts_node_next_named_sibling_wasm = Module["_ts_node_next_named_sibling_wasm"] = wasmExports["ts_node_next_named_sibling_wasm"];
        var _ts_node_prev_named_sibling_wasm = Module["_ts_node_prev_named_sibling_wasm"] = wasmExports["ts_node_prev_named_sibling_wasm"];
        var _ts_node_descendant_count_wasm = Module["_ts_node_descendant_count_wasm"] = wasmExports["ts_node_descendant_count_wasm"];
        var _ts_node_parent_wasm = Module["_ts_node_parent_wasm"] = wasmExports["ts_node_parent_wasm"];
        var _ts_node_child_with_descendant_wasm = Module["_ts_node_child_with_descendant_wasm"] = wasmExports["ts_node_child_with_descendant_wasm"];
        var _ts_node_descendant_for_index_wasm = Module["_ts_node_descendant_for_index_wasm"] = wasmExports["ts_node_descendant_for_index_wasm"];
        var _ts_node_named_descendant_for_index_wasm = Module["_ts_node_named_descendant_for_index_wasm"] = wasmExports["ts_node_named_descendant_for_index_wasm"];
        var _ts_node_descendant_for_position_wasm = Module["_ts_node_descendant_for_position_wasm"] = wasmExports["ts_node_descendant_for_position_wasm"];
        var _ts_node_named_descendant_for_position_wasm = Module["_ts_node_named_descendant_for_position_wasm"] = wasmExports["ts_node_named_descendant_for_position_wasm"];
        var _ts_node_start_point_wasm = Module["_ts_node_start_point_wasm"] = wasmExports["ts_node_start_point_wasm"];
        var _ts_node_end_point_wasm = Module["_ts_node_end_point_wasm"] = wasmExports["ts_node_end_point_wasm"];
        var _ts_node_start_index_wasm = Module["_ts_node_start_index_wasm"] = wasmExports["ts_node_start_index_wasm"];
        var _ts_node_end_index_wasm = Module["_ts_node_end_index_wasm"] = wasmExports["ts_node_end_index_wasm"];
        var _ts_node_to_string_wasm = Module["_ts_node_to_string_wasm"] = wasmExports["ts_node_to_string_wasm"];
        var _ts_node_children_wasm = Module["_ts_node_children_wasm"] = wasmExports["ts_node_children_wasm"];
        var _ts_node_named_children_wasm = Module["_ts_node_named_children_wasm"] = wasmExports["ts_node_named_children_wasm"];
        var _ts_node_descendants_of_type_wasm = Module["_ts_node_descendants_of_type_wasm"] = wasmExports["ts_node_descendants_of_type_wasm"];
        var _ts_node_is_named_wasm = Module["_ts_node_is_named_wasm"] = wasmExports["ts_node_is_named_wasm"];
        var _ts_node_has_changes_wasm = Module["_ts_node_has_changes_wasm"] = wasmExports["ts_node_has_changes_wasm"];
        var _ts_node_has_error_wasm = Module["_ts_node_has_error_wasm"] = wasmExports["ts_node_has_error_wasm"];
        var _ts_node_is_error_wasm = Module["_ts_node_is_error_wasm"] = wasmExports["ts_node_is_error_wasm"];
        var _ts_node_is_missing_wasm = Module["_ts_node_is_missing_wasm"] = wasmExports["ts_node_is_missing_wasm"];
        var _ts_node_is_extra_wasm = Module["_ts_node_is_extra_wasm"] = wasmExports["ts_node_is_extra_wasm"];
        var _ts_node_parse_state_wasm = Module["_ts_node_parse_state_wasm"] = wasmExports["ts_node_parse_state_wasm"];
        var _ts_node_next_parse_state_wasm = Module["_ts_node_next_parse_state_wasm"] = wasmExports["ts_node_next_parse_state_wasm"];
        var _ts_query_matches_wasm = Module["_ts_query_matches_wasm"] = wasmExports["ts_query_matches_wasm"];
        var _ts_query_captures_wasm = Module["_ts_query_captures_wasm"] = wasmExports["ts_query_captures_wasm"];
        var _memset = Module["_memset"] = wasmExports["memset"];
        var _memcpy = Module["_memcpy"] = wasmExports["memcpy"];
        var _memmove = Module["_memmove"] = wasmExports["memmove"];
        var _iswalpha = Module["_iswalpha"] = wasmExports["iswalpha"];
        var _iswblank = Module["_iswblank"] = wasmExports["iswblank"];
        var _iswdigit = Module["_iswdigit"] = wasmExports["iswdigit"];
        var _iswlower = Module["_iswlower"] = wasmExports["iswlower"];
        var _iswupper = Module["_iswupper"] = wasmExports["iswupper"];
        var _iswxdigit = Module["_iswxdigit"] = wasmExports["iswxdigit"];
        var _memchr = Module["_memchr"] = wasmExports["memchr"];
        var _strlen = Module["_strlen"] = wasmExports["strlen"];
        var _strcmp = Module["_strcmp"] = wasmExports["strcmp"];
        var _strncat = Module["_strncat"] = wasmExports["strncat"];
        var _strncpy = Module["_strncpy"] = wasmExports["strncpy"];
        var _towlower = Module["_towlower"] = wasmExports["towlower"];
        var _towupper = Module["_towupper"] = wasmExports["towupper"];
        var _setThrew = wasmExports["setThrew"];
        var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
        var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
        var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
        var ___wasm_apply_data_relocs = wasmExports["__wasm_apply_data_relocs"];
        Module["setValue"] = setValue;
        Module["getValue"] = getValue;
        Module["UTF8ToString"] = UTF8ToString;
        Module["stringToUTF8"] = stringToUTF8;
        Module["lengthBytesUTF8"] = lengthBytesUTF8;
        Module["AsciiToString"] = AsciiToString;
        Module["stringToUTF16"] = stringToUTF16;
        Module["loadWebAssemblyModule"] = loadWebAssemblyModule;
        function callMain(args2 = []) {
          var entryFunction = resolveGlobalSymbol("main").sym;
          if (!entryFunction) return;
          args2.unshift(thisProgram);
          var argc = args2.length;
          var argv = stackAlloc((argc + 1) * 4);
          var argv_ptr = argv;
          args2.forEach((arg) => {
            LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, stringToUTF8OnStack(arg));
            argv_ptr += 4;
          });
          LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, 0);
          try {
            var ret = entryFunction(argc, argv);
            exitJS(
              ret,
              /* implicit = */
              true
            );
            return ret;
          } catch (e) {
            return handleException(e);
          }
        }
        __name(callMain, "callMain");
        function run(args2 = arguments_) {
          if (runDependencies > 0) {
            dependenciesFulfilled = run;
            return;
          }
          preRun();
          if (runDependencies > 0) {
            dependenciesFulfilled = run;
            return;
          }
          function doRun() {
            Module["calledRun"] = true;
            if (ABORT) return;
            initRuntime();
            preMain();
            readyPromiseResolve(Module);
            Module["onRuntimeInitialized"]?.();
            var noInitialRun = Module["noInitialRun"];
            if (!noInitialRun) callMain(args2);
            postRun();
          }
          __name(doRun, "doRun");
          if (Module["setStatus"]) {
            Module["setStatus"]("Running...");
            setTimeout(() => {
              setTimeout(() => Module["setStatus"](""), 1);
              doRun();
            }, 1);
          } else {
            doRun();
          }
        }
        __name(run, "run");
        if (Module["preInit"]) {
          if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
          while (Module["preInit"].length > 0) {
            Module["preInit"].pop()();
          }
        }
        run();
        moduleRtn = readyPromise;
        return moduleRtn;
      };
    })();
    tree_sitter_default = Module2;
    Module3 = null;
    __name(initializeBinding, "initializeBinding");
    __name(checkModule, "checkModule");
    Parser = class {
      static {
        __name(this, "Parser");
      }
      /** @internal */
      [0] = 0;
      // Internal handle for WASM
      /** @internal */
      [1] = 0;
      // Internal handle for WASM
      /** @internal */
      logCallback = null;
      /** The parser's current language. */
      language = null;
      /**
       * This must always be called before creating a Parser.
       *
       * You can optionally pass in options to configure the WASM module, the most common
       * one being `locateFile` to help the module find the `.wasm` file.
       */
      static async init(moduleOptions) {
        setModule(await initializeBinding(moduleOptions));
        TRANSFER_BUFFER = C._ts_init();
        LANGUAGE_VERSION = C.getValue(TRANSFER_BUFFER, "i32");
        MIN_COMPATIBLE_VERSION = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      }
      /**
       * Create a new parser.
       */
      constructor() {
        this.initialize();
      }
      /** @internal */
      initialize() {
        if (!checkModule()) {
          throw new Error("cannot construct a Parser before calling `init()`");
        }
        C._ts_parser_new_wasm();
        this[0] = C.getValue(TRANSFER_BUFFER, "i32");
        this[1] = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      }
      /** Delete the parser, freeing its resources. */
      delete() {
        C._ts_parser_delete(this[0]);
        C._free(this[1]);
        this[0] = 0;
        this[1] = 0;
      }
      /**
       * Set the language that the parser should use for parsing.
       *
       * If the language was not successfully assigned, an error will be thrown.
       * This happens if the language was generated with an incompatible
       * version of the Tree-sitter CLI. Check the language's version using
       * {@link Language#version} and compare it to this library's
       * {@link LANGUAGE_VERSION} and {@link MIN_COMPATIBLE_VERSION} constants.
       */
      setLanguage(language) {
        let address;
        if (!language) {
          address = 0;
          this.language = null;
        } else if (language.constructor === Language) {
          address = language[0];
          const version = C._ts_language_version(address);
          if (version < MIN_COMPATIBLE_VERSION || LANGUAGE_VERSION < version) {
            throw new Error(
              `Incompatible language version ${version}. Compatibility range ${MIN_COMPATIBLE_VERSION} through ${LANGUAGE_VERSION}.`
            );
          }
          this.language = language;
        } else {
          throw new Error("Argument must be a Language");
        }
        C._ts_parser_set_language(this[0], address);
        return this;
      }
      /**
       * Parse a slice of UTF8 text.
       *
       * @param {string | ParseCallback} callback - The UTF8-encoded text to parse or a callback function.
       *
       * @param {Tree | null} [oldTree] - A previous syntax tree parsed from the same document. If the text of the
       *   document has changed since `oldTree` was created, then you must edit `oldTree` to match
       *   the new text using {@link Tree#edit}.
       *
       * @param {ParseOptions} [options] - Options for parsing the text.
       *  This can be used to set the included ranges, or a progress callback.
       *
       * @returns {Tree | null} A {@link Tree} if parsing succeeded, or `null` if:
       *  - The parser has not yet had a language assigned with {@link Parser#setLanguage}.
       *  - The progress callback returned true.
       */
      parse(callback, oldTree, options) {
        if (typeof callback === "string") {
          C.currentParseCallback = (index3) => callback.slice(index3);
        } else if (typeof callback === "function") {
          C.currentParseCallback = callback;
        } else {
          throw new Error("Argument must be a string or a function");
        }
        if (options?.progressCallback) {
          C.currentProgressCallback = options.progressCallback;
        } else {
          C.currentProgressCallback = null;
        }
        if (this.logCallback) {
          C.currentLogCallback = this.logCallback;
          C._ts_parser_enable_logger_wasm(this[0], 1);
        } else {
          C.currentLogCallback = null;
          C._ts_parser_enable_logger_wasm(this[0], 0);
        }
        let rangeCount = 0;
        let rangeAddress = 0;
        if (options?.includedRanges) {
          rangeCount = options.includedRanges.length;
          rangeAddress = C._calloc(rangeCount, SIZE_OF_RANGE);
          let address = rangeAddress;
          for (let i2 = 0; i2 < rangeCount; i2++) {
            marshalRange(address, options.includedRanges[i2]);
            address += SIZE_OF_RANGE;
          }
        }
        const treeAddress = C._ts_parser_parse_wasm(
          this[0],
          this[1],
          oldTree ? oldTree[0] : 0,
          rangeAddress,
          rangeCount
        );
        if (!treeAddress) {
          C.currentParseCallback = null;
          C.currentLogCallback = null;
          C.currentProgressCallback = null;
          return null;
        }
        if (!this.language) {
          throw new Error("Parser must have a language to parse");
        }
        const result = new Tree(INTERNAL, treeAddress, this.language, C.currentParseCallback);
        C.currentParseCallback = null;
        C.currentLogCallback = null;
        C.currentProgressCallback = null;
        return result;
      }
      /**
       * Instruct the parser to start the next parse from the beginning.
       *
       * If the parser previously failed because of a timeout, cancellation,
       * or callback, then by default, it will resume where it left off on the
       * next call to {@link Parser#parse} or other parsing functions.
       * If you don't want to resume, and instead intend to use this parser to
       * parse some other document, you must call `reset` first.
       */
      reset() {
        C._ts_parser_reset(this[0]);
      }
      /** Get the ranges of text that the parser will include when parsing. */
      getIncludedRanges() {
        C._ts_parser_included_ranges_wasm(this[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result;
      }
      /**
       * @deprecated since version 0.25.0, prefer passing a progress callback to {@link Parser#parse}
       *
       * Get the duration in microseconds that parsing is allowed to take.
       *
       * This is set via {@link Parser#setTimeoutMicros}.
       */
      getTimeoutMicros() {
        return C._ts_parser_timeout_micros(this[0]);
      }
      /**
       * @deprecated since version 0.25.0, prefer passing a progress callback to {@link Parser#parse}
       *
       * Set the maximum duration in microseconds that parsing should be allowed
       * to take before halting.
       *
       * If parsing takes longer than this, it will halt early, returning `null`.
       * See {@link Parser#parse} for more information.
       */
      setTimeoutMicros(timeout) {
        C._ts_parser_set_timeout_micros(this[0], 0, timeout);
      }
      /** Set the logging callback that a parser should use during parsing. */
      setLogger(callback) {
        if (!callback) {
          this.logCallback = null;
        } else if (typeof callback !== "function") {
          throw new Error("Logger callback must be a function");
        } else {
          this.logCallback = callback;
        }
        return this;
      }
      /** Get the parser's current logger. */
      getLogger() {
        return this.logCallback;
      }
    };
  }
});

// src/parsing/loader.ts
var loader_exports = {};
__export(loader_exports, {
  loadParser: () => loadParser,
  loadParsers: () => loadParsers,
  parserLoadCount: () => parserLoadCount,
  wasmDir: () => wasmDir
});
import { existsSync as existsSync5 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function parserLoadCount() {
  return loads;
}
function wasmDir() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  for (const dir of [join4(here, "parsing"), here]) {
    if (existsSync5(join4(dir, RUNTIME_WASM))) return dir;
  }
  throw new Error(`tree-sitter runtime not found: no ${RUNTIME_WASM} in ${join4(here, "parsing")} or ${here}`);
}
function memo(promise, forget) {
  promise.catch(forget);
  return promise;
}
function loadRuntime() {
  runtime ??= memo(
    (async () => {
      const dir = wasmDir();
      const mod = await Promise.resolve().then(() => (init_tree_sitter(), tree_sitter_exports));
      await mod.Parser.init({ locateFile: (file) => join4(dir, file) });
      return mod;
    })(),
    () => {
      runtime = null;
    }
  );
  return runtime;
}
function loadParser(name3) {
  let parser2 = grammars.get(name3);
  if (!parser2) {
    parser2 = memo(
      (async () => {
        const { Parser: Parser2, Language: Language2 } = await loadRuntime();
        const p = new Parser2();
        p.setLanguage(await Language2.load(join4(wasmDir(), GRAMMAR_WASM[name3])));
        return p;
      })(),
      () => grammars.delete(name3)
    );
    grammars.set(name3, parser2);
  }
  return parser2;
}
async function load() {
  const parsers = {};
  for (const name3 of INDEXED) parsers[name3] = await loadParser(name3);
  loads++;
  return parsers;
}
function loadParsers() {
  if (!pending) {
    pending = load();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
var RUNTIME_WASM, GRAMMAR_WASM, INDEXED, pending, loads, runtime, grammars;
var init_loader = __esm({
  "src/parsing/loader.ts"() {
    "use strict";
    RUNTIME_WASM = "tree-sitter.wasm";
    GRAMMAR_WASM = {
      typescript: "tree-sitter-typescript.wasm",
      tsx: "tree-sitter-tsx.wasm",
      javascript: "tree-sitter-javascript.wasm",
      bash: "tree-sitter-bash.wasm",
      python: "tree-sitter-python.wasm"
    };
    INDEXED = ["typescript", "tsx", "javascript", "bash"];
    pending = null;
    loads = 0;
    runtime = null;
    grammars = /* @__PURE__ */ new Map();
  }
});

// src/hooks/index.ts
import { readFileSync as readFileSync6 } from "node:fs";

// src/hooks/ensure-mcp-deps-installed.ts
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync as readFileSync2,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "node:path";
import { pathToFileURL } from "node:url";

// src/hooks/gate.ts
var ALLOW = Object.freeze({ stdout: "", code: 0 });

// src/runtime-deps.ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
var TRANSFORMERS_VERSION = "3.8.1";
var TRANSFORMERS_PACKAGE = "@huggingface/transformers";
var EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function runtimeDepsKey(platform = process.platform, arch = process.arch, version = TRANSFORMERS_VERSION) {
  return `${version}-${platform}-${arch}`;
}
function runtimeDepsRoot(dataDir = process.env.CLAUDE_PLUGIN_DATA, key2 = runtimeDepsKey()) {
  return dataDir ? join(dataDir, "deps", key2) : void 0;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readPackageJson(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return isObject(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function pinnedTransformersVersion(manifestDir) {
  const deps = readPackageJson(manifestDir)?.["dependencies"];
  const pin = isObject(deps) ? deps[TRANSFORMERS_PACKAGE] : void 0;
  return typeof pin === "string" && EXACT_VERSION.test(pin) ? pin : void 0;
}
function rootExport(exportsField) {
  if (!isObject(exportsField)) return exportsField;
  const subpaths = Object.keys(exportsField).some((k) => k.startsWith("."));
  return subpaths ? exportsField["."] : exportsField;
}
function nodeImportDefault(entry) {
  if (!isObject(entry)) return void 0;
  const node = entry["node"];
  if (!isObject(node)) return void 0;
  const imp = node["import"];
  if (typeof imp === "string") return imp;
  if (!isObject(imp)) return void 0;
  const target = imp["default"];
  return typeof target === "string" ? target : void 0;
}
function transformersPackageDir(root) {
  return join(root, "node_modules", TRANSFORMERS_PACKAGE);
}
function transformersVersion(root) {
  const version = readPackageJson(transformersPackageDir(root))?.["version"];
  return typeof version === "string" ? version : void 0;
}
function transformersEsmEntry(root) {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.["exports"]));
  if (!target) return void 0;
  const entry = resolve(pkgDir, target);
  return existsSync(entry) ? entry : void 0;
}

// src/hooks/ensure-mcp-deps-installed.ts
var GATE_NAME = "ensure-mcp-deps-installed";
var INSTALL_FLAG = "--install";
var LOCK_TOKEN_ENV = "TMB_MCP_DEPS_LOCK_TOKEN";
var MCP_REL = join2("mcp", "trajectory-server");
var LOCK_STALE_DEFAULT_MIN = 15;
var RECLAIM_MUTEX_STALE_MS = 3e4;
var LOCK_OWNER = "owner";
var STAGING_STALE_MS = 60 * 60 * 1e3;
var INSTALLED_AT = ".installed-at";
var STAGING_PREFIX = ".staging-";
var LEGACY_INSTALLERS = [
  { name: "bun", args: ["install", "--production", "--ignore-scripts", "--no-save"] },
  { name: "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"] }
];
var DATA_INSTALLERS = [
  { name: "bun", args: ["install", "--frozen-lockfile", "--production", "--ignore-scripts"] },
  { name: "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] }
];
function context(env) {
  if (env.TMB_SKIP_MCP_DEPS_INSTALL === "1") return void 0;
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (!root) return void 0;
  const mcpDir = join2(root, MCP_REL);
  if (!isFile(join2(mcpDir, "package.json"))) return void 0;
  const dataDir = env.CLAUDE_PLUGIN_DATA ?? "";
  const legacyReason = process.platform === "win32" ? "win32 has no symlink bridge yet" : dataDir === "" ? "CLAUDE_PLUGIN_DATA is unset" : "";
  return { env, root, mcpDir, legacy: legacyReason !== "", legacyReason, dataDir };
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isRealDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function onPath(name3, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join2(dir, name3);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return void 0;
}
function findInstaller(env, installers) {
  for (const installer of installers) {
    const path = onPath(installer.name, env);
    if (path) return { ...installer, path };
  }
  return void 0;
}
function commandLine(installer) {
  return [installer.name, ...installer.args].join(" ");
}
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function bareSpecifierVersion(mcpDir) {
  let resolved;
  try {
    resolved = createRequire(join2(mcpDir, "package.json")).resolve(TRANSFORMERS_PACKAGE);
  } catch {
    return void 0;
  }
  for (let dir = dirname(resolved); dirname(dir) !== dir; dir = dirname(dir)) {
    const pkg = readJson(join2(dir, "package.json"));
    if (pkg?.["name"] === TRANSFORMERS_PACKAGE) {
      return typeof pkg["version"] === "string" ? pkg["version"] : void 0;
    }
  }
  return void 0;
}
function isValidInstall(dir, version = TRANSFORMERS_VERSION) {
  return isFile(join2(dir, INSTALLED_AT)) && transformersVersion(dir) === version && transformersEsmEntry(dir) !== void 0;
}
function depsDir(dataDir) {
  return join2(dataDir, "deps");
}
function swapSymlink(target, link) {
  const tmp = `${link}.tmb-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}
function pointCurrent(dataDir, key2) {
  const link = join2(depsDir(dataDir), "current");
  let existing;
  try {
    existing = readlinkSync(link);
  } catch {
    existing = void 0;
  }
  if (existing !== key2) swapSymlink(key2, link);
}
function ensureBridge(root, dataDir, rule = "any-symlink", key2 = runtimeDepsKey()) {
  const link = join2(root, "node_modules", TRANSFORMERS_PACKAGE);
  const target = join2(depsDir(dataDir), key2, "node_modules", TRANSFORMERS_PACKAGE);
  let existing;
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return false;
    existing = readlinkSync(link);
  } catch {
    existing = void 0;
  }
  if (existing === target) return true;
  if (existing !== void 0 && rule === "own-symlink" && !isWithin(resolve2(depsDir(dataDir)), resolve2(dirname(link), existing))) {
    return false;
  }
  mkdirSync(dirname(link), { recursive: true });
  swapSymlink(target, link);
  return true;
}
function staleMinutes(env) {
  const raw = env.TMB_MCP_DEPS_LOCK_STALE_MIN ?? "";
  return /^[0-9]+$/.test(raw) ? Number(raw) : LOCK_STALE_DEFAULT_MIN;
}
function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return void 0;
  }
}
function isStaleLock(lock, staleMin) {
  const age = ageMs(lock);
  return age === void 0 || age > staleMin * 6e4;
}
function claimLock(lock) {
  try {
    mkdirSync(lock);
  } catch {
    return void 0;
  }
  const token = randomUUID();
  try {
    writeFileSync(join2(lock, LOCK_OWNER), token);
  } catch {
    rmSync(lock, { recursive: true, force: true });
    return void 0;
  }
  return token;
}
function reclaimLock(lock, staleMin) {
  const mutex = `${lock}.reclaim`;
  try {
    mkdirSync(mutex);
  } catch {
    const age = ageMs(mutex);
    if (age !== void 0 && age > RECLAIM_MUTEX_STALE_MS) rmSync(mutex, { recursive: true, force: true });
    return void 0;
  }
  try {
    if (!isStaleLock(lock, staleMin)) return void 0;
    rmSync(lock, { recursive: true, force: true });
    return claimLock(lock);
  } finally {
    try {
      rmdirSync(mutex);
    } catch {
    }
  }
}
function takeLock(lock, staleMin) {
  try {
    mkdirSync(dirname(lock), { recursive: true });
  } catch {
    return void 0;
  }
  return claimLock(lock) ?? (isStaleLock(lock, staleMin) ? reclaimLock(lock, staleMin) : void 0);
}
function releaseLock(lock, token) {
  if (!token) return false;
  let owner;
  try {
    owner = readFileSync2(join2(lock, LOCK_OWNER), "utf8");
  } catch {
    return false;
  }
  if (owner !== token) return false;
  rmSync(lock, { recursive: true, force: true });
  return true;
}
function lockPath(ctx) {
  return ctx.legacy ? join2(ctx.mcpDir, ".deps-install.lock") : join2(depsDir(ctx.dataDir), ".install.lock");
}
function pluginName(root) {
  const name3 = readJson(join2(root, ".claude-plugin", "plugin.json"))?.["name"];
  return typeof name3 === "string" && name3 !== "" ? name3 : "tmb";
}
function probeDb(db, env) {
  if (!isFile(db)) return "stale";
  const sqlite = onPath("sqlite3", env);
  if (!sqlite) return "current";
  const r = spawnSync(sqlite, ["-readonly", "-cmd", ".timeout 1500", db, "SELECT name FROM pragma_table_info('tasks');"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (r.status !== 0) return "error";
  return r.stdout.includes("prompt_bearing") ? "current" : "stale";
}
function resolveDb(env, root) {
  const override = env.TRAJECTORY_DB_PATH;
  if (override) return isFile(override) ? override : void 0;
  const name3 = pluginName(root);
  const location = (dir) => join2(dir, ".claude", name3, "trajectory.db");
  if (env.TMB_FORBID_LIVE_SYNC === "1" || env.TMB_TEST_RUN_ID) {
    if (!env.CLAUDE_PROJECT_DIR) return void 0;
    const candidate = location(env.CLAUDE_PROJECT_DIR);
    return isFile(candidate) ? candidate : void 0;
  }
  const start2 = env.CLAUDE_PROJECT_DIR || process.cwd();
  const home = env.HOME;
  let outermost;
  for (let dir = start2; dir !== "" && dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start2 !== home) break;
    const candidate = location(dir);
    if (!isFile(candidate) || probeDb(candidate, env) === "stale") continue;
    outermost = candidate;
    if (isFile(join2(dirname(candidate), "standalone")) || isRealDir(join2(dirname(candidate), "standalone"))) break;
  }
  return outermost;
}
function installLog(ctx) {
  const db = resolveDb(ctx.env, ctx.root);
  if (!db) return { env: ctx.env };
  const state = dirname(db);
  try {
    mkdirSync(join2(state, "logs"), { recursive: true });
  } catch {
    return { env: ctx.env };
  }
  return {
    path: join2(state, "logs", "mcp-deps-install.log"),
    env: {
      ...ctx.env,
      BUN_INSTALL_CACHE_DIR: ctx.env.BUN_INSTALL_CACHE_DIR || join2(state, "cache", "bun"),
      npm_config_cache: ctx.env.npm_config_cache || join2(state, "cache", "npm")
    }
  };
}
function notice(message) {
  const out2 = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } };
  return { stdout: `${JSON.stringify(out2)}
`, code: 0 };
}
function noInstallerNotice(ctx, hooksEntry) {
  const manual = ctx.legacy ? `cd "${ctx.mcpDir}" && ${commandLine(LEGACY_INSTALLERS[0])}` : `CLAUDE_PLUGIN_ROOT="${ctx.root}" CLAUDE_PLUGIN_DATA="${ctx.dataDir}" node "${hooksEntry}" ${GATE_NAME} ${INSTALL_FLAG} (it installs into ${runtimeDepsRoot(ctx.dataDir)})`;
  return notice(`\u{1F4E6} Semantic search is degraded: the MCP server's @huggingface/transformers is not installed and neither bun nor npm is on PATH. Install one and restart Claude Code, or run: ${manual}`);
}
function startWorker(hooksEntry, log, token) {
  const fd = log.path ? openSync(log.path, "a") : void 0;
  const stdio = fd === void 0 ? "ignore" : ["ignore", fd, fd];
  try {
    const child = spawn(process.execPath, [hooksEntry, GATE_NAME, INSTALL_FLAG], {
      detached: true,
      stdio,
      env: { ...log.env, [LOCK_TOKEN_ENV]: token }
    });
    child.on("error", () => void 0);
    child.unref();
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function ensureDeps(env) {
  const ctx = context(env);
  if (!ctx) return ALLOW;
  const key2 = runtimeDepsKey();
  const installDir = ctx.legacy ? void 0 : runtimeDepsRoot(ctx.dataDir, key2);
  if (bareSpecifierVersion(ctx.mcpDir) === TRANSFORMERS_VERSION) {
    if (installDir && isValidInstall(installDir)) ensureBridge(ctx.root, ctx.dataDir, "own-symlink", key2);
    return ALLOW;
  }
  if (installDir && isValidInstall(installDir)) {
    pointCurrent(ctx.dataDir, key2);
    ensureBridge(ctx.root, ctx.dataDir, "any-symlink", key2);
    return ALLOW;
  }
  const hooksEntry = resolve2(process.argv[1] ?? "");
  const installer = findInstaller(env, ctx.legacy ? LEGACY_INSTALLERS : DATA_INSTALLERS);
  if (!installer) return noInstallerNotice(ctx, hooksEntry);
  const lock = lockPath(ctx);
  const token = takeLock(lock, staleMinutes(env));
  if (!token) return ALLOW;
  const log = installLog(ctx);
  try {
    startWorker(hooksEntry, log, token);
  } catch {
    releaseLock(lock, token);
  }
  const logNote = log.path ? ` Log: ${log.path}` : "";
  return notice(`\u{1F4E6} Installing the MCP server's @huggingface/transformers in the background (${installer.name}); semantic search runs on FTS until then and embeddings go live on the next Claude Code restart.${logNote}`);
}
var ensureMcpDepsInstalled = (_payload, env) => {
  try {
    return ensureDeps(env);
  } catch {
    return ALLOW;
  }
};
function stdoutLogger(message) {
  writeSync(1, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${GATE_NAME}: ${message}
`);
}
function treeBytes(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name3) => sum + treeBytes(join2(path, name3)), 0);
}
function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function packageDir(nodeModules, name3) {
  try {
    return realpathSync(join2(nodeModules, name3));
  } catch {
    return void 0;
  }
}
function removeAllBut(dir, keep) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name3 of names) {
    if (!keep.includes(name3)) rmSync(join2(dir, name3), { recursive: true, force: true });
  }
}
function removePackage(nodeModules, name3) {
  const real = packageDir(nodeModules, name3);
  if (real) rmSync(real, { recursive: true, force: true });
  rmSync(join2(nodeModules, name3), { recursive: true, force: true });
}
function pruneRuntimeDeps(root, platform, arch) {
  const nodeModules = join2(root, "node_modules");
  const ort = packageDir(nodeModules, "onnxruntime-node");
  if (ort) {
    const napi = join2(ort, "bin", "napi-v3");
    removeAllBut(napi, [platform]);
    removeAllBut(join2(napi, platform), [arch]);
  }
  removePackage(nodeModules, "onnxruntime-web");
  const transformers = packageDir(nodeModules, TRANSFORMERS_PACKAGE);
  if (transformers) {
    removeAllBut(join2(transformers, "dist"), ["transformers.node.mjs", "transformers.node.cjs"]);
    rmSync(join2(transformers, "src"), { recursive: true, force: true });
    rmSync(join2(transformers, "types"), { recursive: true, force: true });
  }
}
function writeSharpStub(root) {
  const sharp = join2(root, "node_modules", "sharp");
  rmSync(sharp, { recursive: true, force: true });
  mkdirSync(sharp, { recursive: true });
  for (const file of ["package.json", "index.js"]) copyFileSync(join2(root, "sharp-stub", file), join2(sharp, file));
}
function installProblem(dir, env, stdio) {
  const entry = transformersEsmEntry(dir);
  if (!entry) return `${TRANSFORMERS_PACKAGE} has no ESM entry under ${dir}`;
  const version = transformersVersion(dir);
  if (version !== TRANSFORMERS_VERSION) return `${TRANSFORMERS_PACKAGE} is ${version}, expected ${TRANSFORMERS_VERSION}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
    env,
    stdio
  });
  if (r.error) return `import check failed: ${r.error.message}`;
  return r.status === 0 ? void 0 : `import check exited ${r.status ?? r.signal}`;
}
function installedAtMs(dir) {
  try {
    const ms = Date.parse(readFileSync2(join2(dir, INSTALLED_AT), "utf8").trim());
    return Number.isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}
function promote(staging, final) {
  const aside = `${staging}-old`;
  const hadFinal = isRealDir(final);
  if (hadFinal) renameSync(final, aside);
  try {
    renameSync(staging, final);
  } catch (err2) {
    if (hadFinal) renameSync(aside, final);
    throw err2;
  }
  if (hadFinal) rmSync(aside, { recursive: true, force: true });
}
function cacheParent(root) {
  const parent = dirname(resolve2(root));
  const cache = dirname(dirname(parent));
  return basename(cache) === "cache" && basename(dirname(cache)) === "plugins" ? parent : void 0;
}
function versionDirs(root) {
  const parent = cacheParent(root);
  if (!parent) return [];
  return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join2(parent, e.name));
}
function referencedKeys(deps, root) {
  const keys = /* @__PURE__ */ new Set();
  const realDeps = realpathSync(deps);
  const links = [join2(deps, "current"), ...versionDirs(root).map((v) => join2(v, "node_modules", TRANSFORMERS_PACKAGE))];
  for (const link of links) {
    let real;
    try {
      real = realpathSync(link);
    } catch {
      continue;
    }
    if (!isWithin(realDeps, real)) continue;
    const first = relative(realDeps, real).split(sep)[0];
    if (first) keys.add(first);
  }
  return keys;
}
function collectGarbage(deps, key2, root, log) {
  const entries = readdirSync(deps, { withFileTypes: true });
  const referenced = referencedKeys(deps, root);
  const others = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== key2).map((e) => ({ name: e.name, at: installedAtMs(join2(deps, e.name)) })).sort((a, b) => b.at - a.at);
  for (const old of others.slice(1)) {
    if (referenced.has(old.name)) continue;
    rmSync(join2(deps, old.name), { recursive: true, force: true });
    log(`removed old key ${old.name}`);
  }
  for (const e of entries) {
    if (!e.name.startsWith(STAGING_PREFIX)) continue;
    const path = join2(deps, e.name);
    try {
      if (Date.now() - lstatSync(path).mtimeMs <= STAGING_STALE_MS) continue;
    } catch {
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    log(`removed stale ${e.name}`);
  }
}
function onlyEntry(dir, name3) {
  if (!isRealDir(dir)) return false;
  const entries = readdirSync(dir);
  return entries.length === 1 && entries[0] === name3;
}
function isBridgeOnly(nodeModules, dataDir) {
  const [scope, name3] = TRANSFORMERS_PACKAGE.split("/");
  const link = join2(nodeModules, scope, name3);
  try {
    if (!onlyEntry(nodeModules, scope) || !onlyEntry(join2(nodeModules, scope), name3)) return false;
    if (!lstatSync(link).isSymbolicLink()) return false;
    return isWithin(resolve2(depsDir(dataDir)), resolve2(dirname(link), readlinkSync(link)));
  } catch {
    return false;
  }
}
function linkTarget(link) {
  try {
    return readlinkSync(link);
  } catch {
    return void 0;
  }
}
function cleanupSiblings(root, dataDir, platform, arch, log) {
  const self2 = resolve2(root);
  for (const version of versionDirs(root)) {
    if (version === self2) continue;
    const rootNodeModules = join2(version, "node_modules");
    const bridgeOnly = isBridgeOnly(rootNodeModules, dataDir);
    let replaced = false;
    for (const nodeModules of [rootNodeModules, join2(version, MCP_REL, "node_modules")]) {
      if (bridgeOnly && nodeModules === rootNodeModules) continue;
      if (!isRealDir(nodeModules)) continue;
      rmSync(nodeModules, { recursive: true, force: true });
      log(`removed ${nodeModules}`);
      replaced = true;
    }
    if (!replaced && !bridgeOnly) continue;
    const pin = pinnedTransformersVersion(join2(version, MCP_REL, "runtime-deps"));
    const key2 = pin === void 0 ? "" : runtimeDepsKey(platform, arch, pin);
    if (pin === void 0 || !isValidInstall(join2(depsDir(dataDir), key2), pin)) {
      const state = bridgeOnly ? "with its bridge as is" : "unbridged";
      log(`left ${version} ${state}: no valid install for its pin ${pin ?? "(unreadable)"}`);
      continue;
    }
    if (!bridgeOnly) {
      if (ensureBridge(version, dataDir, "any-symlink", key2)) log(`bridged ${version} \u2192 ${key2}`);
      continue;
    }
    const link = join2(rootNodeModules, TRANSFORMERS_PACKAGE);
    const before2 = linkTarget(link);
    if (ensureBridge(version, dataDir, "own-symlink", key2) && linkTarget(link) !== before2) {
      log(`re-pointed ${version} \u2192 ${key2}`);
    }
  }
}
function installRuntimeDeps(opts) {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const log = opts.log ?? stdoutLogger;
  const stdio = ["ignore", opts.stdio ?? "inherit", opts.stdio ?? "inherit"];
  const key2 = runtimeDepsKey(platform, arch);
  const deps = depsDir(opts.dataDir);
  const staging = join2(deps, `${STAGING_PREFIX}${key2}-${process.pid}`);
  const manifest = join2(opts.root, MCP_REL, "runtime-deps");
  let rc = 1;
  try {
    mkdirSync(deps, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(manifest, staging, { recursive: true });
    log(`staged ${manifest} in ${staging}`);
    const installer = findInstaller(opts.env, DATA_INSTALLERS);
    if (!installer) throw new Error("neither bun nor npm is on PATH");
    log(`${commandLine(installer)} in ${staging}`);
    const r = spawnSync(installer.path, installer.args, { cwd: staging, env: opts.env, stdio });
    log(`${installer.name} exit ${r.status ?? r.signal}`);
    if (r.error || r.status !== 0) throw new Error(`${installer.name} install failed${r.error ? `: ${r.error.message}` : ""}`);
    writeSharpStub(staging);
    log(`wrote the sharp stub; node_modules ${megabytes(treeBytes(join2(staging, "node_modules")))} before prune`);
    pruneRuntimeDeps(staging, platform, arch);
    log(`pruned to ${platform}/${arch}; node_modules ${megabytes(treeBytes(join2(staging, "node_modules")))}`);
    const problem = installProblem(staging, opts.env, stdio);
    if (problem) throw new Error(problem);
    log(`checked ${TRANSFORMERS_PACKAGE}@${TRANSFORMERS_VERSION}`);
    writeFileSync(join2(staging, INSTALLED_AT), `${(opts.now ?? (() => /* @__PURE__ */ new Date()))().toISOString()}
`);
    promote(staging, join2(deps, key2));
    log(`installed ${join2(deps, key2)}`);
    pointCurrent(opts.dataDir, key2);
    log(`current \u2192 ${key2}`);
    if (ensureBridge(opts.root, opts.dataDir, "any-symlink", key2)) log(`bridged ${opts.root} \u2192 ${key2}`);
    cleanupSiblings(opts.root, opts.dataDir, platform, arch, log);
    collectGarbage(deps, key2, opts.root, log);
    rc = 0;
  } catch (err2) {
    log(`failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
    rmSync(staging, { recursive: true, force: true });
  }
  log(`exit ${rc}`);
  return rc;
}
function legacyInstall(ctx, log) {
  log(`${ctx.legacyReason}: installing into ${ctx.mcpDir}`);
  const installer = findInstaller(ctx.env, LEGACY_INSTALLERS);
  if (!installer) {
    log("neither bun nor npm is on PATH");
    return 1;
  }
  log(`${commandLine(installer)} in ${ctx.mcpDir}`);
  const r = spawnSync(installer.path, installer.args, { cwd: ctx.mcpDir, env: ctx.env, stdio: ["ignore", "inherit", "inherit"] });
  const rc = r.status ?? 1;
  log(`exit ${rc}`);
  return rc;
}
function runInstallWorker(env) {
  const ctx = context(env);
  if (!ctx) return 0;
  const lock = lockPath(ctx);
  const token = env[LOCK_TOKEN_ENV] || takeLock(lock, staleMinutes(env));
  if (!token) {
    stdoutLogger(`another install holds ${lock}; not installing`);
    return 1;
  }
  try {
    return ctx.legacy ? legacyInstall(ctx, stdoutLogger) : installRuntimeDeps({ root: ctx.root, dataDir: ctx.dataDir, env });
  } finally {
    releaseLock(lock, token);
  }
}

// src/hooks/lib/project-env.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, realpathSync as realpathSync2, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join3 } from "node:path";
var TMB_STATE_HOST_DIR = ".claude";
var TMB_DB_FILENAME = "trajectory.db";
var DEFAULT_PLUGIN_NAME = "tmb";
function posixDirname(path) {
  if (path === "") return ".";
  let p = path.replace(/\/+$/, "");
  if (p === "") return "/";
  const slash = p.lastIndexOf("/");
  if (slash < 0) return ".";
  p = p.slice(0, slash).replace(/\/+$/, "");
  return p === "" ? "/" : p;
}
function posixBasename(path) {
  if (path === "") return "";
  const p = path.replace(/\/+$/, "");
  if (p === "") return "/";
  return p.slice(p.lastIndexOf("/") + 1);
}
function jqRawText(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
function pluginName2(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  if (root === "") return DEFAULT_PLUGIN_NAME;
  const manifest = `${root}/.claude-plugin/plugin.json`;
  let text;
  try {
    if (!statSync2(manifest).isFile()) return DEFAULT_PLUGIN_NAME;
    text = readFileSync3(manifest, "utf8");
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_PLUGIN_NAME;
    const name3 = parsed.name;
    return name3 === void 0 || name3 === null || name3 === false ? DEFAULT_PLUGIN_NAME : jqRawText(name3);
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
}
function claudeProjectDir(env = process.env) {
  return env.CLAUDE_PROJECT_DIR ?? "";
}
function homeDir(env = process.env) {
  return env.HOME ?? "";
}
function sameDir(a, b) {
  try {
    return realpathSync2(a) === realpathSync2(b);
  } catch {
    return false;
  }
}
function shellPwd(env = process.env) {
  const cwd = process.cwd();
  const pwd = env.PWD ?? "";
  return pwd !== "" && isAbsolute2(pwd) && sameDir(pwd, cwd) ? pwd : cwd;
}
function installRoot(fromDir) {
  let dir = fromDir;
  for (; ; ) {
    try {
      if (statSync2(join3(dir, ".claude-plugin", "plugin.json")).isFile()) return dir;
    } catch {
    }
    const parent = posixDirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function ctypeUtf8(env = process.env) {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
  return /(^|\.)utf-?8$/i.test(locale) && !locale.includes("/") && existsSync2(`/usr/share/locale/${locale}/LC_CTYPE`);
}

// src/hooks/askuserquestion-length-lint.ts
var LABEL_MAX_WORDS = 5;
var DESC_MAX_WORDS = 15;
var PREVIEW_MAX_LINES = 4;
var JqError = class extends Error {
};
function isObject2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function jqField(v, key2) {
  if (v === null) return null;
  if (!isObject2(v)) throw new JqError(`cannot index ${typeof v} with "${key2}"`);
  return Object.hasOwn(v, key2) ? v[key2] : null;
}
function jqAlt(v, fallback) {
  return v === null || v === false ? fallback : v;
}
function jqEach(v) {
  if (Array.isArray(v)) return v;
  if (isObject2(v)) return Object.values(v);
  throw new JqError(`cannot iterate over ${typeof v}`);
}
function jqItems(get) {
  try {
    return jqEach(get());
  } catch (err2) {
    if (err2 instanceof JqError) return [];
    throw err2;
  }
}
function jqRaw(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function shellCapture(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}
function fieldText(option, key2) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(option, key2), "")));
  } catch (err2) {
    if (err2 instanceof JqError) return "";
    throw err2;
  }
}
function wordCount(text, nbsp) {
  const separators = nbsp ? /[ \t\n\v\f\r ]+/ : /[ \t\n\v\f\r]+/;
  return text.split(separators).filter((word) => word !== "").length;
}
function lineCount(text) {
  return text === "" ? 0 : text.split("\n").length;
}
function toolName(payload) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(payload, "tool_name"), "")));
  } catch (err2) {
    if (err2 instanceof JqError) return "";
    throw err2;
  }
}
function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return void 0;
  }
}
var askuserquestionLengthLint = (payload, env) => {
  const input = parsePayload(payload);
  if (input === void 0 || toolName(input) !== "AskUserQuestion") return ALLOW;
  const nbsp = ctypeUtf8(env);
  const warnings = [];
  const questions = jqItems(() => jqAlt(jqField(jqField(input, "tool_input"), "questions"), []));
  questions.forEach((question, q) => {
    const options = jqItems(() => jqAlt(jqField(question, "options"), []));
    options.forEach((option, o) => {
      const labelWords = wordCount(fieldText(option, "label"), nbsp);
      const descWords = wordCount(fieldText(option, "description"), nbsp);
      const previewLines = lineCount(fieldText(option, "preview"));
      if (labelWords > LABEL_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} label is ${labelWords} words (target \u2264${LABEL_MAX_WORDS})`);
      }
      if (descWords > DESC_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} description is ${descWords} words (target \u2264${DESC_MAX_WORDS})`);
      }
      if (previewLines > PREVIEW_MAX_LINES) {
        warnings.push(`q${q}.opt${o} preview is ${previewLines} lines (target \u2264${PREVIEW_MAX_LINES})`);
      }
    });
  });
  if (warnings.length === 0) return ALLOW;
  const message = [
    "AskUserQuestion brevity violations (per feedback_ask_user_question.md):",
    ...warnings.map((w) => `  - ${w}`)
  ].join("\n") + "\n\nTargets: label <=5 words, description <=15 words, preview <=4 lines. See #96.";
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } };
  return { stdout: `${JSON.stringify(output)}
`, code: 0 };
};

// src/hooks/containment-guard.ts
import { lstatSync as lstatSync4, statSync as statSync8 } from "node:fs";

// src/hooks/lib/agent-context.ts
import { existsSync as existsSync4, lstatSync as lstatSync2, readlinkSync as readlinkSync2, statSync as statSync4 } from "node:fs";

// src/hooks/lib/jq.ts
function valueEnd(text, start2) {
  const first = text[start2];
  if (first === '"') {
    let i3 = start2 + 1;
    while (i3 < text.length) {
      if (text[i3] === "\\") i3 += 2;
      else if (text[i3] === '"') return i3 + 1;
      else i3 += 1;
    }
    return -1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let i3 = start2;
    while (i3 < text.length) {
      const ch = text[i3];
      if (ch === '"') {
        const end = valueEnd(text, i3);
        if (end < 0) return -1;
        i3 = end;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i3 + 1;
      }
      i3 += 1;
    }
    return -1;
  }
  let i2 = start2;
  while (i2 < text.length && !/[\s{}[\]",]/.test(text[i2])) i2 += 1;
  return i2 === start2 ? -1 : i2;
}
function jsonValues(text) {
  const values = [];
  let i2 = 0;
  for (; ; ) {
    while (i2 < text.length && /\s/.test(text[i2])) i2 += 1;
    if (i2 >= text.length) return values;
    const end = valueEnd(text, i2);
    if (end < 0) return values;
    try {
      values.push(JSON.parse(text.slice(i2, end)));
    } catch {
      return values;
    }
    i2 = end;
  }
}
var JqError2 = class extends Error {
};
function index(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError2(`Cannot index ${typeof value}`);
  const v = value[key2];
  return v === void 0 ? null : v;
}
function getPath(value, path) {
  let v = value;
  for (const key2 of path) v = index(v, key2);
  return v;
}
function truthy(v) {
  return v !== null && v !== void 0 && v !== false;
}
function jqAlternatives(text, paths) {
  const out2 = [];
  for (const value of jsonValues(text)) {
    try {
      for (const path of paths) {
        const v = getPath(value, path);
        if (truthy(v)) {
          out2.push(jqRawText(v));
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof JqError2)) throw e;
    }
  }
  return out2.join("\n");
}
function jqContentStrings(text) {
  const out2 = [];
  for (const value of jsonValues(text)) {
    try {
      const v = getPath(value, ["message", "content"]);
      const content = truthy(v) ? v : [];
      out2.push(typeof content === "string" ? content : JSON.stringify(content));
    } catch (e) {
      if (!(e instanceof JqError2)) throw e;
    }
  }
  return out2;
}
function jqCompact(value) {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
}

// src/hooks/lib/db.ts
import { accessSync as accessSync3, closeSync as closeSync2, constants as constants3, existsSync as existsSync3, openSync as openSync2, readFileSync as readFileSync4, readSync, realpathSync as realpathSync3, statSync as statSync3 } from "node:fs";

// src/hooks/lib/role.ts
var CODE_REVIEWER_ROLE = "code-reviewer";
function normalizeRole(raw = "") {
  const colon = raw.indexOf(":");
  return colon < 0 ? raw : raw.slice(colon + 1);
}
function agentRole(input = "") {
  const raw = normalizeRole(jqAlternatives(input, [["agent_type"], ["subagent_type"]]));
  return raw === "" ? "bro" : raw;
}

// src/hooks/lib/sqlite-shell.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { accessSync as accessSync2, constants as constants2 } from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
var KILLED_CODE = 124;
var NOT_FOUND_CODE = 127;
var MAX_BUFFER = 64 * 1024 * 1024;
var nodeSqlite;
function isSqliteExperimentalWarning(warning, rest) {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : opt !== null && typeof opt === "object" && typeof opt.type === "string" ? opt.type : warning instanceof Error ? warning.name : "";
  return type === "ExperimentalWarning" && /sqlite/i.test(message);
}
function loadNodeSqlite() {
  if (nodeSqlite !== void 0) return nodeSqlite;
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const get = process.getBuiltinModule;
    const mod = typeof get === "function" ? get.call(process, "node:sqlite") : void 0;
    nodeSqlite = mod && typeof mod.DatabaseSync === "function" && typeof mod.StatementSync?.prototype?.setReturnArrays === "function" ? mod : null;
  } catch {
    nodeSqlite = null;
  } finally {
    process.emitWarning = original;
  }
  return nodeSqlite;
}
function sqliteBackend(env = process.env) {
  return env.TMB_HOOKS_SQLITE === "cli" || loadNodeSqlite() === null ? "cli" : "node";
}
function onPath2(command, env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    try {
      accessSync2(`${dir === "" ? "." : dir}/${command}`, constants2.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function haveSqlite(env = process.env) {
  return sqliteBackend(env) === "node" || onPath2("sqlite3", env);
}
function sqliteRun(call, env = process.env) {
  const sqlite = sqliteBackend(env) === "node" ? loadNodeSqlite() : null;
  return sqlite ? runNode(sqlite, call) : runCli(call, env);
}
function cliArgs(call) {
  const args2 = [];
  if (call.bail) args2.push("-bail");
  if (call.readonly) args2.push("-readonly");
  args2.push("-cmd", `.timeout ${call.timeoutMs}`, call.target);
  if (call.sql !== void 0) args2.push(call.sql);
  return args2;
}
function runCli(call, env) {
  const r = spawnSync2("sqlite3", cliArgs(call), {
    env,
    input: call.sql === void 0 ? call.script ?? "" : void 0,
    stdio: [call.sql === void 0 ? "pipe" : "ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...call.killAfterMs !== void 0 ? { timeout: call.killAfterMs, killSignal: "SIGKILL" } : {}
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const errno = r.error?.code;
  if (errno === "ENOENT") return { code: NOT_FOUND_CODE, stdout: "", stderr: "sqlite3: command not found\n" };
  if (errno === "ETIMEDOUT" || r.signal === "SIGKILL") return { code: KILLED_CODE, stdout, stderr: "" };
  if (r.error) return { code: 1, stdout, stderr: stderr || `${r.error.message}
` };
  return { code: r.status ?? 1, stdout, stderr };
}
var TOKEN_COLUMN = {
  semi: 0,
  ws: 1,
  other: 2,
  explain: 3,
  create: 4,
  temp: 5,
  trigger: 6,
  end: 7
};
var COMPLETE_TRANS = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5]
];
function isIdChar(ch) {
  if (ch === void 0) return false;
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 128;
}
function keywordKind(word) {
  switch (word.toLowerCase()) {
    case "create":
      return "create";
    case "trigger":
      return "trigger";
    case "temp":
    case "temporary":
      return "temp";
    case "end":
      return "end";
    case "explain":
      return "explain";
    default:
      return "other";
  }
}
function scanSql(sql) {
  const tokens = [];
  let unterminated = false;
  let i2 = 0;
  while (i2 < sql.length) {
    const start2 = i2;
    const ch = sql[i2];
    if (ch === ";") {
      tokens.push({ kind: "semi", start: start2, end: ++i2 });
    } else if (ch === " " || ch === "	" || ch === "\n" || ch === "\f" || ch === "\r") {
      tokens.push({ kind: "ws", start: start2, end: ++i2 });
    } else if (ch === "/" && sql[i2 + 1] === "*") {
      const close = sql.indexOf("*/", i2 + 2);
      if (close < 0) {
        unterminated = true;
        i2 = sql.length;
      } else {
        i2 = close + 2;
      }
      tokens.push({ kind: "ws", start: start2, end: i2 });
    } else if (ch === "-" && sql[i2 + 1] === "-") {
      const nl = sql.indexOf("\n", i2);
      i2 = nl < 0 ? sql.length : nl;
      tokens.push({ kind: "ws", start: start2, end: i2 });
    } else if (ch === "[" || ch === "`" || ch === '"' || ch === "'") {
      const close = sql.indexOf(ch === "[" ? "]" : ch, i2 + 1);
      if (close < 0) {
        unterminated = true;
        i2 = sql.length;
      } else {
        i2 = close + 1;
      }
      tokens.push({ kind: "other", start: start2, end: i2 });
    } else if ((ch === ":" || ch === "@") && isIdChar(sql[i2 + 1])) {
      i2 += 1;
      while (isIdChar(sql[i2])) i2 += 1;
      tokens.push({ kind: "other", start: start2, end: i2, param: sql.slice(start2, i2) });
    } else if (isIdChar(ch)) {
      while (isIdChar(sql[i2])) i2 += 1;
      const word = sql.slice(start2, i2);
      tokens.push(
        word.startsWith("$") && word.length > 1 ? { kind: "other", start: start2, end: i2, param: word } : { kind: keywordKind(word), start: start2, end: i2 }
      );
    } else {
      tokens.push({ kind: "other", start: start2, end: ++i2 });
    }
  }
  return { tokens, unterminated };
}
function sqlComplete(sql) {
  const { tokens, unterminated } = scanSql(sql);
  if (unterminated) return false;
  let state = 0;
  for (const t of tokens) state = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
  return state === 1;
}
function splitStatements(sql) {
  const { tokens } = scanSql(sql);
  const out2 = [];
  let state = 0;
  let begin = 0;
  let dark = false;
  let params = /* @__PURE__ */ new Set();
  const flush = (end) => {
    if (dark) out2.push({ text: sql.slice(begin, end), params: [...params] });
    begin = end;
    dark = false;
    params = /* @__PURE__ */ new Set();
  };
  for (const t of tokens) {
    const next = COMPLETE_TRANS[state][TOKEN_COLUMN[t.kind]];
    if (t.kind !== "ws" && t.kind !== "semi") dark = true;
    if (t.param) params.add(t.param);
    state = next;
    if (t.kind === "semi" && next === 1) flush(t.end);
  }
  flush(sql.length);
  return out2;
}
function formatReal(x) {
  if (x === 0) return "0.0";
  if (Number.isNaN(x)) return "";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  const [mantissa, expText] = x.toExponential(14).split("e");
  const exp = Number(expText);
  const trim2 = (digits) => {
    if (!digits.includes(".")) return `${digits}.0`;
    const t = digits.replace(/0+$/, "");
    return t.endsWith(".") ? `${t}0` : t;
  };
  if (exp < -4 || exp >= 15) {
    return `${trim2(mantissa)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return trim2(x.toFixed(14 - exp));
}
function cutAtNul(text) {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}
function listValue(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return formatReal(v);
  if (typeof v === "string") return cutAtNul(v);
  if (v instanceof Uint8Array) return cutAtNul(Buffer.from(v).toString("utf8"));
  return String(v);
}
function failure(e) {
  const err2 = e;
  const ext = err2 && typeof err2.errcode === "number" ? err2.errcode : 1;
  return {
    code: ext & 255 || 1,
    message: err2 && typeof err2.message === "string" ? err2.message : String(e)
  };
}
function withCode(f) {
  return f.code > 1 ? `${f.message} (${f.code})` : f.message;
}
var Killed = class extends Error {
};
var ShellSession = class {
  db;
  deadline;
  parameters = /* @__PURE__ */ new Map();
  busyMs;
  stdout = "";
  stderr = "";
  constructor(db, timeoutMs, killAfterMs) {
    this.db = db;
    this.busyMs = timeoutMs;
    this.deadline = killAfterMs === void 0 ? Infinity : performance2.now() + killAfterMs;
    this.applyTimeout(timeoutMs);
  }
  applyTimeout(ms) {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
  }
  checkDeadline() {
    if (performance2.now() >= this.deadline) throw new Killed();
  }
  setTimeout(ms) {
    this.busyMs = ms;
    this.applyTimeout(ms);
  }
  beforeStatement() {
    this.checkDeadline();
    if (this.deadline !== Infinity) {
      this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance2.now())));
    }
  }
  /** Runs one statement; null on success, else where and why it failed. */
  run(stmt) {
    this.beforeStatement();
    let prepared;
    try {
      prepared = this.db.prepare(stmt.text);
    } catch (e) {
      this.checkDeadline();
      return { phase: "prepare", failure: failure(e) };
    }
    try {
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const bound = {};
      for (const name3 of stmt.params) {
        if (this.parameters.has(name3)) bound[name3] = this.parameters.get(name3) ?? null;
      }
      const rows = Object.keys(bound).length > 0 ? prepared.iterate(bound) : prepared.iterate();
      let out2 = "";
      for (const row of rows) {
        this.checkDeadline();
        const values = Array.isArray(row) ? row : Object.values(row);
        out2 += `${values.map(listValue).join("|")}
`;
      }
      this.checkDeadline();
      this.stdout += out2;
    } catch (e) {
      this.checkDeadline();
      return { phase: "step", failure: failure(e) };
    }
    return null;
  }
  evalParameter(value) {
    try {
      const prepared = this.db.prepare(`SELECT ${value}`);
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const rows = prepared.all();
      if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
    } catch {
    }
    return value;
  }
  setParameter(name3, value) {
    this.parameters.set(name3, this.evalParameter(value));
  }
  clearParameters() {
    this.parameters.clear();
  }
};
function openSession(sqlite, call) {
  try {
    const db = new sqlite.DatabaseSync(call.target, {
      readOnly: call.readonly,
      enableDoubleQuotedStringLiterals: true,
      enableForeignKeyConstraints: false
    });
    return new ShellSession(db, call.timeoutMs, call.killAfterMs);
  } catch (e) {
    return failure(e);
  }
}
function closeSession(session) {
  try {
    session.db.close();
  } catch {
  }
}
function runNode(sqlite, call) {
  const opened = openSession(sqlite, call);
  if (!(opened instanceof ShellSession)) {
    return {
      code: call.sql !== void 0 ? opened.code : 1,
      stdout: "",
      stderr: `Error: unable to open database "${call.target}": ${opened.message}
`
    };
  }
  try {
    const code = call.sql !== void 0 ? runArgMode(opened, call.sql) : runStdinMode(opened, call.script ?? "", !!call.bail);
    return { code, stdout: opened.stdout, stderr: opened.stderr };
  } catch (e) {
    if (e instanceof Killed) return { code: KILLED_CODE, stdout: opened.stdout, stderr: "" };
    throw e;
  } finally {
    closeSession(opened);
  }
}
function runArgMode(session, sql) {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      session.stderr += `Error: ${failed.phase === "prepare" ? "in prepare" : "stepping"}, ${withCode(failed.failure)}
`;
      return failed.failure.code;
    }
  }
  return 0;
}
var QSS_START = { wait: "", dark: false, semi: false };
function isSpace(ch) {
  return ch === " " || ch === "	" || ch === "\n" || ch === "\v" || ch === "\f" || ch === "\r";
}
function quickscan(line, prev) {
  const q = { ...prev };
  let i2 = 0;
  for (; ; ) {
    if (q.wait === "") {
      let jumped = false;
      while (i2 < line.length) {
        const ch = line[i2++];
        if (isSpace(ch)) continue;
        if (ch === "-" && line[i2] === "-") return q;
        if (ch === ";") {
          q.semi = true;
          continue;
        }
        if (ch === "/" && line[i2] === "*") {
          i2 += 1;
          q.wait = "*";
          jumped = true;
          break;
        }
        if (ch === "[" || ch === "`" || ch === "'" || ch === '"') {
          q.wait = ch === "[" ? "]" : ch;
          q.dark = true;
          q.semi = false;
          jumped = true;
          break;
        }
        q.semi = false;
        q.dark = true;
      }
      if (!jumped) return q;
    } else {
      let jumped = false;
      while (i2 < line.length) {
        const ch = line[i2++];
        if (ch !== q.wait) continue;
        if (q.wait === "*") {
          if (line[i2] !== "/") continue;
          i2 += 1;
        } else if (q.wait !== "]" && line[i2] === q.wait) {
          i2 += 1;
          continue;
        }
        q.wait = "";
        jumped = true;
        break;
      }
      if (!jumped) return q;
    }
  }
}
function plainWhite(q) {
  return q.wait === "" && !q.dark;
}
function semiTerminated(q) {
  return q.wait === "" && q.semi;
}
function inputLines(script) {
  if (script === "") return [];
  const lines2 = script.split("\n");
  if (lines2[lines2.length - 1] === "") lines2.pop();
  return lines2.map((l) => l.endsWith("\r") ? l.slice(0, -1) : l);
}
var BACKSLASH_ESCAPES = {
  a: "\x07",
  b: "\b",
  t: "	",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\"
};
function resolveBackslashes(text) {
  return text.replace(/\\([0-7]{1,3}|.)/gs, (all, esc) => {
    if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return BACKSLASH_ESCAPES[esc] ?? all;
  });
}
function metaArgs(line) {
  const args2 = [];
  let i2 = 1;
  while (i2 < line.length) {
    while (i2 < line.length && isSpace(line[i2])) i2 += 1;
    if (i2 >= line.length) break;
    const delim = line[i2];
    if (delim === "'" || delim === '"') {
      i2 += 1;
      const start2 = i2;
      while (i2 < line.length && line[i2] !== delim) {
        if (line[i2] === "\\" && delim === '"' && i2 + 1 < line.length) i2 += 1;
        i2 += 1;
      }
      const word = line.slice(start2, i2);
      if (i2 < line.length) i2 += 1;
      args2.push(delim === '"' ? resolveBackslashes(word) : word);
    } else {
      const start2 = i2;
      while (i2 < line.length && !isSpace(line[i2])) i2 += 1;
      args2.push(line.slice(start2, i2));
    }
  }
  return args2;
}
function integerValue(text) {
  const m = /^\s*([+-]?\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}
function runMeta(session, line) {
  const args2 = metaArgs(line);
  const cmd = args2[0] ?? "";
  if (cmd === "timeout") {
    session.setTimeout(args2.length >= 2 ? integerValue(args2[1]) : 0);
    return 0;
  }
  if (cmd === "parameter" || cmd === "param") {
    const sub = args2[1] ?? "";
    if ((sub === "clear" || sub === "init") && args2.length === 2) {
      if (sub === "clear") session.clearParameters();
      return 0;
    }
    if (sub === "set" && args2.length === 4) {
      session.setParameter(args2[2], args2[3]);
      return 0;
    }
  }
  session.stderr += `Error: unknown command or invalid arguments:  "${cmd}". Enter ".help" for help
`;
  return 1;
}
function runChunk(session, sql, startLine) {
  for (const stmt of splitStatements(sql)) {
    const failed = session.run(stmt);
    if (failed) {
      const type = failed.phase === "prepare" ? "Parse error" : "Runtime error";
      session.stderr += `${type} near line ${startLine}: ${withCode(failed.failure)}
`;
      return 1;
    }
  }
  return 0;
}
function runStdinMode(session, script, bail) {
  let errors = 0;
  let qss = QSS_START;
  let sql = "";
  let startLine = 0;
  let lineNo = 0;
  for (const line of inputLines(script)) {
    if (errors > 0 && bail) break;
    lineNo += 1;
    qss = quickscan(line, qss);
    if (plainWhite(qss) && sql === "") {
      qss = QSS_START;
      continue;
    }
    if ((line[0] === "." || line[0] === "#") && sql === "") {
      if (line[0] === ".") errors += runMeta(session, line);
      qss = QSS_START;
      continue;
    }
    if (sql === "") {
      sql = line.replace(/^[ \t\n\v\f\r]+/, "");
      startLine = lineNo;
    } else {
      sql += `
${line}`;
    }
    if (sql !== "" && semiTerminated(qss) && sqlComplete(sql)) {
      errors += runChunk(session, sql, startLine);
      sql = "";
      qss = QSS_START;
    } else if (sql !== "" && plainWhite(qss)) {
      sql = "";
      qss = QSS_START;
    }
  }
  if (sql !== "") errors += runChunk(session, sql, startLine);
  return errors > 0 ? 1 : 0;
}

// src/hooks/lib/db.ts
var GATE_READ_ERROR = "__ERR__";
var DEFAULT_READ_TIMEOUT_MS = 1500;
var SQLITE_RO_TIMEOUT_MS = 500;
var CANTOPEN = 14;
function stripTrailingNewlines(text) {
  return text.replace(/\n+$/, "");
}
function isFile2(path) {
  try {
    return statSync3(path).isFile();
  } catch {
    return false;
  }
}
function digitsOr(value, fallback) {
  return value !== void 0 && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}
function readTimeoutMs(env) {
  const raw = env.TMB_DB_WRITE_TIMEOUT_MS;
  return digitsOr(raw === "" ? void 0 : raw, DEFAULT_READ_TIMEOUT_MS);
}
function dbLocation(root, env = process.env) {
  return `${root}/${TMB_STATE_HOST_DIR}/${pluginName2(env)}/${TMB_DB_FILENAME}`;
}
function walCold(db) {
  if (existsSync3(`${db}-shm`)) return false;
  let fd;
  try {
    fd = openSync2(db, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 18);
    return [...buf.subarray(0, n)].join("") === "22";
  } catch {
    return false;
  } finally {
    if (fd !== void 0) closeSync2(fd);
  }
}
function sqliteOnce(ro, ms, target, sql, env) {
  const r = sqliteRun({ target, readonly: ro, timeoutMs: ms, sql }, env);
  return { code: r.code, out: stripTrailingNewlines(r.stdout) };
}
function gateRead(db, sql, env = process.env) {
  const ms = readTimeoutMs(env);
  if (db === "" || !isFile2(db)) return GATE_READ_ERROR;
  const ro = !walCold(db);
  let r = sqliteOnce(ro, ms, db, sql, env);
  if (r.code === CANTOPEN && ro) r = sqliteOnce(false, ms, db, sql, env);
  return r.code === 0 ? r.out : GATE_READ_ERROR;
}
function immutableUri(db, env = process.env) {
  let p = db.startsWith("/") ? db : `${shellPwd(env).replace(/\/$/, "")}/${db}`;
  p = p.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
  return `file:${p}?immutable=1`;
}
function dbReadRo(db, sql, env = process.env) {
  const ms = readTimeoutMs(env);
  if (db === "" || !isFile2(db)) return GATE_READ_ERROR;
  let r;
  if (sqliteBackend(env) === "node" && walCold(db)) {
    r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  } else {
    r = sqliteOnce(true, ms, db, sql, env);
    if (r.code !== 0 && walCold(db)) r = sqliteOnce(true, ms, immutableUri(db, env), sql, env);
  }
  return r.code === 0 ? r.out : GATE_READ_ERROR;
}
function dbProbe(db, env = process.env) {
  if (db === "" || !isFile2(db)) return 1;
  if (!haveSqlite(env)) return 0;
  const cols = dbReadRo(db, "SELECT name FROM pragma_table_info('tasks');", env);
  if (cols === GATE_READ_ERROR) return 2;
  return cols.includes("prompt_bearing") ? 0 : 1;
}
function testFlag(env = process.env) {
  if (env.TMB_FORBID_LIVE_SYNC === "1") return "TMB_FORBID_LIVE_SYNC";
  if ((env.TMB_TEST_RUN_ID ?? "") !== "") return "TMB_TEST_RUN_ID";
  return null;
}
function dbResolve(env = process.env) {
  const explicit = env.TRAJECTORY_DB_PATH ?? "";
  if (explicit !== "") return { path: isFile2(explicit) ? explicit : null, warning: "" };
  const flag = testFlag(env);
  if (flag) {
    const project = claudeProjectDir(env);
    if (project !== "") {
      const candidate = dbLocation(project, env);
      return { path: isFile2(candidate) ? candidate : null, warning: "" };
    }
    return {
      path: null,
      warning: `tmb: trajectory DB unresolved: ${flag} is set and neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is (walk-up discovery disabled)`
    };
  }
  const start2 = claudeProjectDir(env) || shellPwd(env);
  const home = homeDir(env);
  let outermost = "";
  let dir = start2;
  while (dir !== "" && dir !== "/") {
    if (dir === home && start2 !== home) break;
    const candidate = dbLocation(dir, env);
    if (isFile2(candidate) && dbProbe(candidate, env) !== 1) {
      outermost = candidate;
      if (existsSync3(`${posixDirname(candidate)}/standalone`)) break;
    }
    const parent = posixDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: outermost === "" ? null : outermost, warning: "" };
}
var dbPathCache = /* @__PURE__ */ new WeakMap();
function dbPath(env = process.env, onWarning) {
  const cached = dbPathCache.get(env);
  if (cached !== void 0) return cached;
  const r = dbResolve(env);
  if (r.warning !== "" && onWarning) onWarning(r.warning);
  if (r.path !== null) dbPathCache.set(env, r.path);
  return r.path;
}
function realdir(dir) {
  if (dir === "") return "";
  try {
    if (statSync3(dir).isDirectory()) {
      accessSync3(dir, constants3.X_OK);
      return realpathSync3.native(dir);
    }
  } catch {
  }
  return stripTrailingNewlines(dir);
}
function dbProjectRoot(db) {
  if (db === "") return "";
  const host = posixDirname(posixDirname(db));
  return posixBasename(host) === TMB_STATE_HOST_DIR ? posixDirname(host) : "";
}
function repoPathAbs(db, path) {
  if (path.startsWith("/")) return path;
  const root = dbProjectRoot(db);
  return `${root || posixDirname(db)}/${path}`;
}
function projectRoot(env = process.env) {
  const db = dbPath(env);
  const root = db !== null ? dbProjectRoot(db) : "";
  return root || claudeProjectDir(env);
}
function dbState(env = process.env) {
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return "unresolved";
  return gateRead(db, "SELECT count(*) FROM sqlite_master;", env) === GATE_READ_ERROR ? "error" : "ok";
}
function dbUnavailableReason(hook = "", env = process.env) {
  const db = dbPath(env) ?? "<unresolved>";
  return `BLOCKED: trajectory DB unavailable \u2014 ${hook || "hook"} could not read ${db} (read error: busy, corrupt, or unreadable), so it refuses to fail open. Check the trajectory DB and retry.`;
}
function denyDbUnavailable(hook = "", env = process.env) {
  return jqCompact({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: stripTrailingNewlines(dbUnavailableReason(hook || "hook", env))
    }
  });
}
function sqliteRo(db, sql, env = process.env) {
  const out2 = gateRead(db, sql, { ...env, TMB_DB_WRITE_TIMEOUT_MS: String(SQLITE_RO_TIMEOUT_MS) });
  return out2 === GATE_READ_ERROR ? "" : out2;
}
function sweContext(agentType = "") {
  return agentType === "swe" ? "yes" : "no";
}
function sqlInt(value = "") {
  return /^[0-9]+$/.test(value) ? value : "";
}
function sqlQuote(value = "") {
  return stripTrailingNewlines(value.replace(/'/g, "''"));
}
function branchSlug(branch = "") {
  const slash = branch.indexOf("/");
  return slash < 0 ? branch : branch.slice(slash + 1);
}
function callerRun(input, db, env = process.env) {
  if (agentRole(input) !== "swe") return "";
  const agentId = jqAlternatives(input, [["agent_id"]]);
  if (agentId === "") return "";
  return gateRead(
    db,
    `SELECT COALESCE(task_id, '') || '|' || COALESCE(root_dir, '') FROM agent_runs
                        WHERE agent_type = 'swe' AND spawn_id = '${sqlQuote(agentId)}'
                        ORDER BY id DESC LIMIT 1;`,
    env
  );
}
function taskIdFromTranscript(transcript = "") {
  if (transcript === "" || !isFile2(transcript)) return "";
  let text;
  try {
    text = readFileSync4(transcript, "utf8");
  } catch {
    return "";
  }
  for (const line of jqContentStrings(text)) {
    const m = /task_id=([0-9]+)/.exec(line);
    if (m) return sqlInt(m[1]);
  }
  return "";
}

// src/hooks/lib/agent-context.ts
var MAX_LINK_HOPS = 40;
function isFile3(path) {
  try {
    return statSync4(path).isFile();
  } catch {
    return false;
  }
}
function isSymlink(path) {
  try {
    return lstatSync2(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function agentTranscript(input = "") {
  const own = jqAlternatives(input, [["agent_transcript_path"]]);
  if (own !== "" && isFile3(own)) return own;
  const main = jqAlternatives(input, [["transcript_path"]]);
  const id = jqAlternatives(input, [["agent_id"]]);
  if (main === "" || id === "" || !/^[A-Za-z0-9_-]+$/.test(id)) return "";
  const t = `${main.endsWith(".jsonl") ? main.slice(0, -".jsonl".length) : main}/subagents/agent-${id}.jsonl`;
  return isFile3(t) ? t : "";
}
function readFields(row, count) {
  let rest = row.split("\n")[0];
  const fields = [];
  for (let i2 = 0; i2 < count - 1; i2 += 1) {
    const bar = rest.indexOf("|");
    if (bar < 0) {
      fields.push(rest);
      rest = "";
      continue;
    }
    fields.push(rest.slice(0, bar));
    rest = rest.slice(bar + 1);
  }
  if (rest.endsWith("|") && !rest.slice(0, -1).includes("|")) rest = rest.slice(0, -1);
  fields.push(rest);
  return fields;
}
function taskLocation(db, taskId, env = process.env) {
  const none = { repo: "", repoRoot: "", worktree: "" };
  const task = sqlInt(taskId);
  if (task === "") return { code: 1, ...none, missing: "no task_id" };
  const row = gateRead(
    db,
    `
    SELECT COALESCE(t.branch_id, '') || '|' || COALESCE(t.repo, '') || '|'
           || COALESCE(r.name, '') || '|' || COALESCE(r.path, '')
      FROM tasks t
      LEFT JOIN repos r ON r.name = CASE
          WHEN COALESCE(t.repo, '') <> '' THEN t.repo
          WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT name FROM repos)
        END
     WHERE t.id = ${task} LIMIT 1;`,
    env
  );
  if (row === GATE_READ_ERROR) {
    return { code: 2, ...none, missing: `task ${task}: the trajectory DB read failed (tasks/repos)` };
  }
  if (row === "") return { code: 1, ...none, missing: `task ${task} has no tasks row` };
  const [branch, repo, name3, rawPath] = readFields(row, 4);
  if (branch === "") return { code: 1, ...none, missing: `task ${task} has no branch_id` };
  if (name3 === "" || rawPath === "") {
    const missing = repo !== "" ? `task ${task}'s repo '${repo}' has no repos row with a path` : `task ${task} has no repo: tasks.repo is empty and the repos table does not hold exactly one row`;
    return { code: 1, ...none, missing };
  }
  const path = rawPath.startsWith("/") ? rawPath : realdir(repoPathAbs(db, rawPath));
  const repoRoot = path.endsWith("/") ? path.slice(0, -1) : path;
  return {
    code: 0,
    repo: name3,
    repoRoot,
    worktree: `${repoRoot}/.claude/worktrees/${branchSlug(branch)}`,
    missing: ""
  };
}
function agentContext(input = "", db = "", env = process.env) {
  const role = agentRole(input);
  const blank2 = { taskId: "", repo: "", repoRoot: "", worktree: "", missing: "" };
  if (role !== "swe") return { code: 0, role, ...blank2, repoRoot: projectRoot(env) };
  const resolved = db !== "" ? db : dbPath(env) ?? "";
  if (resolved === "") {
    return { code: 3, role, ...blank2, missing: "no trajectory DB resolves (TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)" };
  }
  const transcript = agentTranscript(input);
  let task = taskIdFromTranscript(transcript);
  if (task === "") {
    const run2 = callerRun(input, resolved, env);
    if (run2 === GATE_READ_ERROR) return { code: 2, role, ...blank2, missing: "the trajectory DB read failed (agent_runs)" };
    const bar = run2.indexOf("|");
    task = sqlInt(bar < 0 ? run2 : run2.slice(0, bar));
  }
  if (task === "") {
    const missing = transcript !== "" ? `no task_id: the spawn transcript ${transcript} carries no task_id=<N>` : "no task_id: the payload names no spawn transcript (agent_transcript_path, or transcript_path plus agent_id) and no agent_runs row is bound to this agent_id";
    return { code: 1, role, ...blank2, missing };
  }
  return { role, taskId: task, ...taskLocation(resolved, task, env) };
}
function pathCanonical(path = "") {
  if (!path.startsWith("/")) return path;
  let cur = "";
  let tail = "";
  let rest = path;
  let hops = 0;
  while (rest !== "") {
    rest = rest.startsWith("/") ? rest.slice(1) : rest;
    const slash = rest.indexOf("/");
    const part = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? "" : rest.slice(slash + 1);
    if (part === "" || part === ".") continue;
    if (tail !== "") {
      tail = part === ".." ? tail.slice(0, Math.max(0, tail.lastIndexOf("/"))) : `${tail}/${part}`;
      continue;
    }
    if (part === "..") {
      cur = cur.slice(0, Math.max(0, cur.lastIndexOf("/")));
      continue;
    }
    const here = `${cur}/${part}`;
    if (isSymlink(here) && hops < MAX_LINK_HOPS) {
      hops += 1;
      const link = readlinkSync2(here).replace(/\n+$/, "");
      if (link.startsWith("/")) cur = "";
      rest = `${link}/${rest}`;
      continue;
    }
    if (existsSync4(here)) cur = here;
    else tail = `/${part}`;
  }
  if (cur + tail === "") cur = "/";
  return `${cur}${tail}`;
}

// src/hooks/lib/audit.ts
import { accessSync as accessSync4, constants as constants4, readFileSync as readFileSync5, statSync as statSync5 } from "node:fs";
import { performance as performance3 } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
var WRITE_ATTEMPTS = 2;
var BACKOFF_MS = 200;
var DEFAULT_BUSY_MS = 1500;
var DEFAULT_RUN_BUDGET_MS = 3500;
var BUDGET_SPENT_CODE = 5;
var INVALID_CODE = 2;
var AUDIT_EVENTS_REL = "scripts/hooks/lib/audit-events.txt";
var spentMs = /* @__PURE__ */ new WeakMap();
function digitsOr2(value, fallback) {
  return value !== void 0 && /^[0-9]+$/.test(value) ? Number(value) : fallback;
}
function busyMs(env) {
  return digitsOr2(env.TMB_DB_WRITE_TIMEOUT_MS || void 0, DEFAULT_BUSY_MS);
}
function runBudgetMs(env) {
  return digitsOr2(env.TMB_DB_WRITE_RUN_BUDGET_MS || void 0, DEFAULT_RUN_BUDGET_MS);
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isFile4(path) {
  try {
    return statSync5(path).isFile();
  } catch {
    return false;
  }
}
function defaultCaller() {
  const src = posixBasename(process.argv[2] ?? process.argv[1] ?? "");
  return src.endsWith(".sh") ? src.slice(0, -3) : src;
}
function nowIso(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}
var BUSY_PATTERN = /database is locked|SQLITE_BUSY|database is busy/;
function dbWrite(db, sql, opts = {}) {
  const env = opts.env ?? process.env;
  const caller = opts.caller ?? defaultCaller();
  if (db === "" || !isFile4(db)) {
    return { ok: false, code: 1, stdout: "", error: `tmb_db_write: ${caller}: database not found: ${db || "<empty>"}` };
  }
  const script = `${stripTrailingNewlines(`PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
${sql}
COMMIT;
`)}
`;
  const busy = busyMs(env);
  const budget = runBudgetMs(env);
  const start2 = performance3.now();
  const left = () => budget - (spentMs.get(env) ?? 0) - (performance3.now() - start2);
  let code = BUDGET_SPENT_CODE;
  let err2 = "";
  let stdout = "";
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const remaining = left();
    if (remaining <= 0) {
      err2 = `run budget spent (TMB_DB_WRITE_RUN_BUDGET_MS=${budget})${err2 ? `; last error: ${err2}` : ""}`;
      code = BUDGET_SPENT_CODE;
      break;
    }
    const waitMs = Math.min(busy, Math.ceil(remaining));
    const r = sqliteRun({ target: db, readonly: false, timeoutMs: waitMs, script, bail: true }, env);
    stdout += r.stdout;
    code = r.code;
    err2 = stripTrailingNewlines(r.stderr);
    if (code === 0) break;
    if (!BUSY_PATTERN.test(err2)) break;
    if (attempt < WRITE_ATTEMPTS && left() > BACKOFF_MS) sleepMs(BACKOFF_MS);
  }
  spentMs.set(env, (spentMs.get(env) ?? 0) + (performance3.now() - start2));
  if (code === 0) return { ok: true, code: 0, stdout, error: "" };
  const detail = (err2 || `sqlite3 exited ${code}`).split("\n")[0];
  return { ok: false, code, stdout, error: `tmb_db_write: ${caller}: ${detail}` };
}
function fromNodeValid(fromNode) {
  return fromNode === "system" || /^hook:[a-z0-9-]+$/.test(fromNode);
}
function auditWriter(fromNode) {
  if (fromNode.startsWith("hook:")) return "hook";
  return fromNode === "system" ? "server" : "";
}
function auditEventsFile(env = process.env) {
  const here = posixDirname(fileURLToPath(import.meta.url));
  const root = installRoot(here) ?? env.CLAUDE_PLUGIN_ROOT ?? here;
  return `${root}/${AUDIT_EVENTS_REL}`;
}
function eventWriters(file, eventType) {
  if (eventType === "") return null;
  let text;
  try {
    text = readFileSync5(file, "utf8");
  } catch {
    return null;
  }
  const lines2 = text.split("\n");
  if (lines2[lines2.length - 1] === "") lines2.pop();
  for (const line of lines2) {
    const trimmed = line.replace(/^\t+/, "").replace(/\t+$/, "");
    const tab = trimmed.indexOf("	");
    const ev = tab < 0 ? trimmed : trimmed.slice(0, tab);
    if (ev === eventType) return tab < 0 ? "" : trimmed.slice(tab).replace(/^\t+/, "");
  }
  return null;
}
function readable(file) {
  try {
    accessSync4(file, constants4.R_OK);
    return true;
  } catch {
    return false;
  }
}
function auditWriterCheck(label, eventType, writer, opts = {}) {
  const file = opts.eventsFile ?? auditEventsFile(opts.env);
  if (!readable(file)) {
    return {
      code: 2,
      error: `${label}: audit event list missing or unreadable: ${file} (run npm run build in mcp/trajectory-server)`
    };
  }
  const writers = eventWriters(file, eventType);
  if (writers === null) {
    return {
      code: 2,
      error: `${label}: unknown event_type '${eventType}' (not in ${file}; add it to mcp/trajectory-server/src/audit-events.ts and rebuild)`
    };
  }
  if (`,${writers},`.includes(`,${writer},`)) return { code: 0, error: "" };
  return {
    code: 2,
    error: `${label}: audit_event_not_writable_by_role: '${writer}' may not write '${eventType}' (writers: ${writers})`
  };
}
var DEDUPE_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
function dedupeGuard(eventType, contentJson, paths, opts = {}) {
  const caller = opts.caller ?? defaultCaller();
  if (paths.length === 0) {
    return { code: INVALID_CODE, sql: "", error: `tmb_audit_append: ${caller}: dedupe guard needs at least one json path` };
  }
  const safeContent = sqlQuote(contentJson || "{}");
  let cond = "";
  for (const path of paths) {
    if (!DEDUPE_PATH.test(path)) {
      return { code: INVALID_CODE, sql: "", error: `tmb_audit_append: ${caller}: invalid dedupe json path '${path}'` };
    }
    cond += ` AND json_extract(d.content_json, '${path}') IS json_extract('${safeContent}', '${path}')`;
  }
  return {
    code: 0,
    sql: `NOT EXISTS (SELECT 1 FROM audit d WHERE d.event_type = '${sqlQuote(eventType)}' AND json_valid(d.content_json)${cond})`,
    error: ""
  };
}
function auditSql(row, guardSql = "", opts = {}) {
  const caller = opts.caller ?? defaultCaller();
  const label = `tmb_audit_append: ${caller}`;
  if (!fromNodeValid(row.fromNode)) {
    return { code: INVALID_CODE, sql: "", error: `${label}: invalid from_node '${row.fromNode}' (want hook:<name> or system)` };
  }
  const check = auditWriterCheck(label, row.eventType, auditWriter(row.fromNode), opts);
  if (check.code !== 0) return { code: INVALID_CODE, sql: "", error: check.error };
  const issue = row.issueId === "-1" ? "-1" : sqlInt(row.issueId);
  if (issue === "") return { code: INVALID_CODE, sql: "", error: `${label}: invalid issue_id '${row.issueId}'` };
  const branch = row.branchId === "" ? "NULL" : `'${sqlQuote(row.branchId)}'`;
  const where = guardSql === "" ? "" : ` WHERE ${guardSql}`;
  const sql = `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at) SELECT ${issue}, ${branch}, '${sqlQuote(row.fromNode)}', '${sqlQuote(row.eventType)}', '${sqlQuote(row.summary)}', '${sqlQuote(row.contentJson || "{}")}', (SELECT repo FROM issues WHERE id = ${issue}), '${opts.now ?? nowIso()}'${where};`;
  return { code: 0, sql, error: "" };
}
function auditAppend(db, row, opts = {}) {
  const caller = opts.caller ?? defaultCaller();
  let guard2 = "";
  if (row.dedupePaths && row.dedupePaths.length > 0) {
    const g = dedupeGuard(row.eventType, row.contentJson, row.dedupePaths, { caller });
    if (g.code !== 0) return { ok: false, code: INVALID_CODE, stdout: "", error: g.error };
    guard2 = g.sql;
  }
  const s = auditSql(row, guard2, { ...opts, caller });
  if (s.code !== 0) return { ok: false, code: INVALID_CODE, stdout: "", error: s.error };
  return dbWrite(db, s.sql, { caller, env: opts.env });
}

// src/hooks/cmd-analysis/parser.ts
import { setFlagsFromString } from "node:v8";
var parser = null;
var loads2 = 0;
var programParsers = /* @__PURE__ */ new Map();
var programLoads = /* @__PURE__ */ new Map();
var wanted = /* @__PURE__ */ new Set();
function tierDown() {
  setFlagsFromString("--no-wasm-dynamic-tiering");
  setFlagsFromString("--no-wasm-tier-up");
}
function bashParser() {
  if (!parser) {
    parser = (async () => {
      tierDown();
      const { loadParser: loadParser2 } = await Promise.resolve().then(() => (init_loader(), loader_exports));
      const p = await loadParser2("bash");
      loads2++;
      return p;
    })();
    parser.catch(() => {
      parser = null;
    });
  }
  return parser;
}
function programParser(name3) {
  const p = programParsers.get(name3);
  if (!p) wanted.add(name3);
  return p;
}
async function loadWanted() {
  if (wanted.size === 0) return false;
  const names = [...wanted];
  wanted.clear();
  tierDown();
  const { loadParser: loadParser2 } = await Promise.resolve().then(() => (init_loader(), loader_exports));
  for (const name3 of names) {
    if (programParsers.has(name3)) continue;
    programParsers.set(name3, await loadParser2(name3));
    programLoads.set(name3, (programLoads.get(name3) ?? 0) + 1);
  }
  return true;
}

// src/hooks/cmd-analysis/encode.ts
var NEUTRAL = " 	<>|;&()`";
var ENC = ["", ...Array.from({ length: 12 }, (_, i2) => String.fromCharCode(i2 < 6 ? i2 + 1 : i2 + 8))];
var QO = "\x07";
var QC = "\b";
var JOINER = ENC[12];
var SUB_PO = "";
var SUB_PC = "";
var HD_DATA = "";
var HD_EXP = "";
function plainDollars(text) {
  let m;
  while ((m = text.indexOf("$")) >= 0) {
    text = text.slice(m + 1);
    const braced = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(text);
    const plain = braced ? null : /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (braced) text = text.slice(braced[0].length);
    else if (plain && text[plain[0].length] !== "[") text = text.slice(plain[0].length);
    else return false;
  }
  return true;
}
var DECODE = new Map([
  ...[...NEUTRAL, "\n"].map((c, i2) => [i2 < 10 ? ENC[i2 + 1] : ENC[12], c]),
  [SUB_PO, "("],
  [SUB_PC, ")"]
]);
function decode(text) {
  return text.replace(/[\x01-\x06\x0e-\x11\x13\x15\x16]/g, (c) => DECODE.get(c) ?? c);
}
function neutral(c) {
  if (c === void 0 || c === "" || c === "\n") return ENC[1];
  const k = NEUTRAL.indexOf(c);
  return k >= 0 ? ENC[k + 1] : c;
}
var SPECIAL = /* @__PURE__ */ new Set(["comment", "string", "raw_string", "ansi_c_string", "translated_string", "heredoc_redirect"]);
function bodyText(src, from, end) {
  const lineStart2 = src.lastIndexOf("\n", from.startIndex - 1) + 1;
  const endStart = src.lastIndexOf("\n", end.startIndex - 1) + 1;
  return endStart > lineStart2 ? src.slice(lineStart2, endStart) : "";
}
var plainBody = (body2) => !body2.includes("`") && plainDollars(body2);
function specials(node, out2) {
  if (SPECIAL.has(node.type)) {
    out2.push({ start: node.startIndex, end: node.endIndex, node });
    return out2;
  }
  for (const child of node.children) if (child) specials(child, out2);
  return out2;
}
function substitutions(node, out2) {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "command_substitution" || child.type === "arithmetic_expansion") out2.push(child);
    else substitutions(child, out2);
  }
  return out2;
}
var Encoder = class {
  constructor(src) {
    this.src = src;
  }
  src;
  /** Unquoted text: a backslash escapes the next char. */
  plain(from, to) {
    const { src } = this;
    let out2 = "";
    for (let i2 = from; i2 < to; i2++) {
      const c = src[i2];
      if (c !== "\\") {
        out2 += c;
        continue;
      }
      const next = i2 + 1 < to ? src[i2 + 1] : void 0;
      out2 += neutral(next);
      if (next !== void 0 && next !== "\n") i2++;
    }
    return out2;
  }
  /** Quoted text: every char neutral, a newline the joiner; `escapes` drops a backslash before the char it escapes. */
  quoted(from, to, escapes) {
    const { src } = this;
    let out2 = "";
    for (let i2 = from; i2 < to; i2++) {
      const c = src[i2];
      if (c === "\n") out2 += JOINER;
      else if (escapes && c === "\\") {
        const next = i2 + 1 < to ? src[i2 + 1] : void 0;
        out2 += neutral(next);
        if (next !== void 0 && next !== "\n") i2++;
      } else out2 += neutral(c);
    }
    return out2;
  }
  /** Where a substitution's `$(` or backtick starts: tree-sitter-bash folds the blanks after a preceding expansion into the opener token (`"$(a) $(b)"`). */
  opener(sub) {
    const first = sub.firstChild;
    if (!first) return sub.startIndex;
    const tok = this.src.slice(first.startIndex, first.endIndex);
    return first.startIndex + tok.length - tok.trimStart().length;
  }
  dquoted(node, from, to) {
    let out2 = "";
    let at = from;
    for (const sub of substitutions(node, [])) {
      if (sub.startIndex < from || sub.endIndex > to) continue;
      const start2 = this.opener(sub);
      out2 += this.quoted(at, start2, true);
      const open = this.src.startsWith("$(", start2) ? 2 : 1;
      out2 += QO + this.range(sub, start2 + open, sub.endIndex - 1) + QC;
      at = sub.endIndex;
    }
    return out2 + this.quoted(at, to, true);
  }
  heredoc(node) {
    const kids2 = node.children.filter((c) => c !== null);
    const start2 = kids2.find((c) => c.type === "heredoc_start");
    const body2 = kids2.find((c) => c.type === "heredoc_body");
    const end = kids2.find((c) => c.type === "heredoc_end");
    const word = start2 ? this.src.slice(start2.startIndex, start2.endIndex) : "";
    const delim = word.replace(/['"\\]/g, "");
    const data = /['"\\]/.test(word) || end !== void 0 && plainBody(bodyText(this.src, body2 ?? end, end));
    const rest = [];
    const opEnd = start2 ? start2.endIndex : node.startIndex + 2;
    for (const c of kids2) {
      if (c.startIndex >= opEnd && c !== body2 && c !== end) specials(c, rest);
    }
    const dropFrom = body2?.startIndex ?? end?.startIndex ?? node.endIndex;
    let dropTo = end?.endIndex ?? node.endIndex;
    if (end && this.src[dropTo] === "\n") dropTo++;
    return { text: "<<" + (delim === "" ? "" : data ? HD_DATA : HD_EXP) + delim, skipTo: opEnd, rest: [...rest, { start: dropFrom, end: dropTo, node }] };
  }
  /** One word node, encoded as `range` encodes it inside its command. */
  word(node) {
    return this.spans(specials(node, []), node.startIndex, node.endIndex);
  }
  /** [from, to) of `node`'s source, encoded as unquoted shell text. */
  range(node, from, to) {
    const spans = node.children.filter((c) => c !== null).flatMap((c) => specials(c, [])).filter((s) => s.start >= from && s.end <= to);
    return this.spans(spans, from, to);
  }
  spans(spans, from, to) {
    let out2 = "";
    let at = from;
    const queue = [...spans].sort((a, b) => a.start - b.start);
    while (queue.length) {
      const span = queue.shift();
      if (span.start < at) continue;
      out2 += this.plain(at, span.start);
      const { node } = span;
      if (span.node.type === "heredoc_redirect" && span.start === node.startIndex && span.end === node.endIndex) {
        const h = this.heredoc(node);
        out2 += h.text;
        at = h.skipTo;
        queue.push(...h.rest.filter((s) => s.start >= at && s.end <= to));
        queue.sort((a, b) => a.start - b.start);
        continue;
      }
      at = span.end;
      switch (node.type) {
        case "heredoc_redirect":
        case "comment":
          break;
        case "string":
          out2 += this.dquoted(node, span.start + 1, span.end - 1);
          break;
        case "translated_string":
          out2 += "$" + this.dquoted(node, span.start + 2, span.end - 1);
          break;
        case "raw_string":
          out2 += this.quoted(span.start + 1, span.end - 1, false);
          break;
        case "ansi_c_string":
          out2 += this.quoted(span.start + 2, span.end - 1, true);
          break;
      }
    }
    return out2 + this.plain(at, to);
  }
};
var EXPANSIONS = ["simple_expansion", "expansion", "command_substitution", "arithmetic_expansion", "process_substitution"];
var expands = (node) => node.descendantsOfType(EXPANSIONS).length > 0;
function heldKey(word) {
  return decode(word).replace(/\x07/g, "$(").replace(/\x08/g, ")");
}
function heldWords(encoder, root) {
  const held = /* @__PURE__ */ new Set();
  for (const node of root.descendantsOfType(["command", "herestring_redirect"])) {
    if (!node) continue;
    for (const word of node.namedChildren) {
      if (word && word.type !== "file_redirect" && word.type !== "herestring_redirect" && expands(word)) held.add(heldKey(encoder.word(word)));
    }
  }
  return held;
}
function broken(node) {
  if (node.isError || node.isMissing) return true;
  if (!node.hasError) return false;
  return node.children.some((c) => c !== null && broken(c));
}
function heredocs(src, root) {
  return root.descendantsOfType("heredoc_redirect").flatMap((node) => {
    if (!node) return [];
    const kids2 = node.children.filter((c) => c !== null);
    const start2 = kids2.find((c) => c.type === "heredoc_start");
    const end = kids2.find((c) => c.type === "heredoc_end");
    if (!start2 || !end) return [];
    const bodyNode = kids2.find((c) => c.type === "heredoc_body");
    const from = bodyNode?.startIndex ?? end.startIndex;
    const tabs = kids2.some((c) => c.type === "<<-");
    const lineStart2 = src.lastIndexOf("\n", from - 1) + 1;
    const endStart = src.lastIndexOf("\n", end.startIndex - 1) + 1;
    let lines2 = endStart > lineStart2 ? src.slice(lineStart2, endStart - 1).split("\n") : [];
    if (tabs) lines2 = lines2.map((l) => l.replace(/^\t+/, ""));
    const body2 = lines2.join("\n").replace(/^\t+/, "").replace(/\t+$/, "").replace(/\n+$/, "");
    return [{ delim: src.slice(start2.startIndex, start2.endIndex).replace(/['"\\]/g, ""), body: body2, expands: bodyNode !== void 0 && expands(bodyNode) }];
  });
}
function lineAt(src, at) {
  const end = src.indexOf("\n", at);
  return src.slice(src.lastIndexOf("\n", at - 1) + 1, end < 0 ? src.length : end);
}
function heredocMisread(src, root) {
  return root.descendantsOfType("heredoc_redirect").some((node) => {
    if (!node) return false;
    const kids2 = node.children.filter((c) => c !== null);
    const start2 = kids2.find((c) => c.type === "heredoc_start");
    const end = kids2.find((c) => c.type === "heredoc_end");
    if (!start2 || !end) return true;
    const delim = src.slice(start2.startIndex, start2.endIndex).replace(/['"\\]/g, "");
    const tabs = kids2.some((c) => c.type === "<<-");
    const line = (text) => tabs ? text.replace(/^\t+/, "") : text;
    if (line(lineAt(src, end.startIndex)) !== delim) return true;
    const from = kids2.find((c) => c.type === "heredoc_body")?.startIndex ?? end.startIndex;
    const bodyStart = src.lastIndexOf("\n", from - 1) + 1;
    const endStart = src.lastIndexOf("\n", end.startIndex - 1) + 1;
    return endStart > bodyStart && src.slice(bodyStart, endStart - 1).split("\n").some((l) => line(l) === delim);
  });
}
function encode(parser2, command) {
  const tree = parser2.parse(command);
  if (!tree) return { ok: false };
  try {
    const root = tree.rootNode;
    if (root.hasError || broken(root)) return { ok: false };
    if (command.includes("<<") && heredocMisread(command, root)) return { ok: false };
    const encoder = new Encoder(command);
    const text = encoder.range(root, 0, command.length);
    return { ok: true, text, heredocs: command.includes("<<") ? heredocs(command, root) : [], held: heldWords(encoder, root) };
  } finally {
    tree.delete();
  }
}

// src/hooks/cmd-analysis/lister.ts
import { statSync as statSync6 } from "node:fs";

// src/hooks/cmd-analysis/path.ts
import { existsSync as existsSync6, lstatSync as lstatSync3, readlinkSync as readlinkSync3 } from "node:fs";
var MAX_HOPS = 40;
function isLink(p) {
  try {
    return lstatSync3(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function pathCanonical2(path) {
  if (!path.startsWith("/")) return path;
  let cur = "";
  let tail = "";
  let rest = path;
  let hops = 0;
  while (rest !== "") {
    rest = rest.replace(/^\//, "");
    const slash = rest.indexOf("/");
    const part = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? "" : rest.slice(slash + 1);
    if (part === "" || part === ".") continue;
    if (tail !== "") {
      tail = part === ".." ? tail.replace(/\/[^/]*$/, "") : `${tail}/${part}`;
      continue;
    }
    if (part === "..") {
      cur = cur.replace(/\/[^/]*$/, "");
      continue;
    }
    const next = `${cur}/${part}`;
    if (hops < MAX_HOPS && isLink(next)) {
      hops++;
      const link = readlinkSync3(next);
      if (link.startsWith("/")) cur = "";
      rest = `${link}/${rest}`;
      continue;
    }
    if (existsSync6(next)) cur = next;
    else tail = `/${part}`;
  }
  return cur + tail || "/";
}
function payloadCwd(json, env = process.env) {
  try {
    const cwd = JSON.parse(json)?.cwd;
    if (typeof cwd === "string") {
      const c = cwd.replace(/\n+$/, "");
      if (c !== "") return c;
    }
  } catch {
  }
  return env.PWD ?? "";
}

// src/hooks/cmd-analysis/lister.ts
var NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var SURFACES = ["agents", "skills", "commands", "templates", "rules", ".claude/agents", "CLAUDE.md"];
var PROMPT_FILES = ["CLAUDE.md", "CODEX.md", "CURSOR.md", "GEMINI.md"];
var EXEC_REDIRECT = /^(>|>>|>\||<|<<<|&>|&>>|[0-9]>|[0-9]>>|[0-9]<)$/;
var EXEC_REDIRECT_WORD = /^(>|<|&>|[0-9]>|[0-9]<)/;
var RG_VALUE = /^(-t|--type|-T|--type-not|--type-add|-j|--threads|-d|--max-depth|--max-filesize|--ignore-file|--sort|--sortr|-E|--encoding)$/;
var FD_VALUE = /^(-e|--extension|-t|--type|-d|--max-depth|--min-depth|--exact-depth|-S|--size|--changed-within|--changed-before|-o|--owner|-j|--threads|--max-results|-c|--color|--ignore-file|--and)$/;
var PLACEHOLDER = /\{\}|\{\/\}|\{\/\/\}|\{\.\}|\{\/\.\}/;
var basename2 = (w) => w.replace(/.*\//, "");
var trimSlash = (s) => s.replace(/\/$/, "");
var isDir = (p) => statSync6(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
var isFile5 = (p) => statSync6(p, { throwIfNoEntry: false })?.isFile() ?? false;
var CLASSES = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "!-\\/:-@\\[-`{-~",
  space: " \\t\\n\\v\\f\\r",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f"
};
var escapeRe = (c) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
function bracket(pat, i2) {
  let k = i2 + 1;
  let neg = false;
  if (pat[k] === "!" || pat[k] === "^") {
    neg = true;
    k++;
  }
  let body2 = "";
  let first = true;
  while (k < pat.length) {
    const c = pat[k];
    if (c === "]" && !first) return { re: `[${neg ? "^" : ""}${body2}]`, next: k + 1 };
    first = false;
    if (c === "[" && pat[k + 1] === ":") {
      const end = pat.indexOf(":]", k + 2);
      const cls = end < 0 ? void 0 : CLASSES[pat.slice(k + 2, end)];
      if (cls !== void 0) {
        body2 += cls;
        k = end + 2;
        continue;
      }
    }
    if (c === "\\" && k + 1 < pat.length) {
      body2 += escapeRe(pat[k + 1]);
      k += 2;
      continue;
    }
    if (c === "-" && body2 !== "" && pat[k + 1] !== void 0 && pat[k + 1] !== "]") {
      body2 += "-";
      k++;
      continue;
    }
    body2 += escapeRe(c);
    k++;
  }
  return null;
}
function globRegex(pat, nocase) {
  let re = "";
  for (let i2 = 0; i2 < pat.length; ) {
    const c = pat[i2];
    if (c === "*") {
      re += ".*";
      i2++;
    } else if (c === "?") {
      re += ".";
      i2++;
    } else if (c === "[") {
      const b = bracket(pat, i2);
      if (b) {
        re += b.re;
        i2 = b.next;
      } else {
        re += "\\[";
        i2++;
      }
    } else if (c === "\\" && i2 + 1 < pat.length) {
      re += escapeRe(pat[i2 + 1]);
      i2 += 2;
    } else {
      re += escapeRe(c);
      i2++;
    }
  }
  try {
    return new RegExp(`^${re}$`, nocase ? "is" : "s");
  } catch {
    return /(?!)/;
  }
}
function patMatches(pat, name3) {
  if (pat.startsWith("r:")) return true;
  return globRegex(pat.slice(2), pat.startsWith("i:")).test(name3);
}
function exclCovers(pat, d, sub, v, root, rootc) {
  const e = pat.slice(2);
  const l = trimSlash(v);
  const b = basename2(d);
  let r;
  switch (pat.slice(0, 2)) {
    case "N:":
      return d === "CLAUDE.md" && e === "CLAUDE.md";
    case "P:":
      if (e.endsWith("/**")) r = e.slice(0, -3);
      else if (e.endsWith("/*")) r = e.slice(0, -2);
      else {
        if (d !== "CLAUDE.md") return false;
        r = e;
      }
      break;
    case "R:":
      r = e;
      break;
    case "G:":
      r = trimSlash(e).replace(/\/\*\*$/, "").replace(/\/\*$/, "");
      return r === d;
    case "F:":
    case "Q:":
      r = trimSlash(e).replace(/\/\*\*$/, "");
      return r === d || r === `**/${b}` || r === b && !r.includes("/");
    default:
      return false;
  }
  return r === `*/${b}` || r === `**/${b}` || r === `${l}/${sub}` || r === `./${sub}` || r === `${trimSlash(root)}/${d}` || r === `${trimSlash(rootc)}/${d}`;
}
function isPromptSurfacePath(p, root) {
  if (PROMPT_FILES.includes(basename2(p))) return true;
  let rel = "";
  if (p.startsWith("/")) {
    const abs = pathCanonical2(p);
    if (root !== "") {
      const prefix = trimSlash(pathCanonical2(root)) + "/";
      if (abs.startsWith(prefix)) rel = abs.slice(prefix.length);
    }
  } else rel = p.replace(/^\.\//, "");
  if (rel === "") return p.endsWith(".md") && /\/(agents|skills|commands|templates|rules)\//.test("/" + p.replace(/^\//, ""));
  return /^(agents|skills|commands|templates|rules)\/.*\.md$/s.test(rel) || /^\.claude\/(agents|skills|commands|rules)\/.*\.md$/s.test(rel);
}
function findModel(mode, args2, raw, acts, m) {
  const n = args2.length;
  let k = 0;
  let bad = false;
  let ok = false;
  const prune = [];
  while (k < n) {
    const a = args2[k];
    if (a === "-L") {
      bad = true;
      k++;
    } else if (a === "-H" || a === "-P" || a.startsWith("-O")) k++;
    else if (a === "-D") k += 2;
    else if (a === "--") {
      k++;
      break;
    } else break;
  }
  while (k < n && !/^(-.*|\(|!|,)$/s.test(args2[k])) m.paths.push(args2[k++]);
  while (k < n) {
    const w = args2[k++];
    switch (w) {
      case "-exec":
      case "-execdir":
      case "-ok":
      case "-okdir": {
        if (mode !== "exec") return false;
        const run2 = [];
        let prev = "";
        while (k < n) {
          const x = raw[k++];
          if (x === "" || x === "+" && prev === "{}") break;
          run2.push(x);
          prev = x;
        }
        if (run2.length > 0) acts.push("x" + run2.join(" "));
        break;
      }
      case "-delete":
        if (mode !== "loop") acts.push("d");
        break;
      case "-fprint":
      case "-fprint0":
      case "-fprintf":
      case "-fls":
        if (mode !== "exec") return false;
        acts.push("f" + (raw[k] ?? ""));
        k += w === "-fprintf" ? 2 : 1;
        break;
      case "-printf":
        if (mode !== "exec") return false;
        k++;
        break;
      case "-ls":
        if (mode !== "exec") return false;
        break;
      case "-follow":
        bad = true;
        break;
      case "-name":
        m.pats.push("s:" + (args2[k++] ?? ""));
        break;
      case "-iname":
        m.pats.push("i:" + (args2[k++] ?? ""));
        break;
      case "-regex":
      case "-iregex":
        m.pats.push("r:" + (args2[k++] ?? ""));
        break;
      case "-not":
      case "!": {
        const a = args2[k] ?? "";
        if (a === "-path" || a === "-wholename") {
          m.excl.push("P:" + (args2[k + 1] ?? ""));
          k += 2;
        } else if (a === "-name") {
          m.excl.push("N:" + (args2[k + 1] ?? ""));
          k += 2;
        }
        break;
      }
      case "-path":
      case "-wholename":
      case "-ipath":
        if (args2[k + 1] === "-prune") prune.push("R:" + (args2[k] ?? ""));
        k++;
        break;
      case "-o":
      case "-or":
        ok = true;
        break;
    }
  }
  if (ok) {
    m.excl = [];
    if (mode !== "loop") m.pats = [];
  }
  m.excl.push(...prune);
  if (m.paths.length === 0) m.paths = ["."];
  return !bad;
}
function lsModel(args2, m) {
  for (const w of args2) {
    if (w === "--") continue;
    if (w.startsWith("--")) return false;
    if (w.startsWith("-")) {
      if (/[^1AaBCdFfhimpRrSstuUvXx]/.test(w.slice(1))) return false;
    } else m.paths.push(w);
  }
  if (m.paths.length === 0) m.paths = ["."];
  m.listed = true;
  return true;
}
function gitModel(dir, args2, m) {
  const n = args2.length;
  let k = 0;
  let gdir = dir;
  while (k < n) {
    const a = args2[k];
    if (a === "-C") {
      const p = args2[k + 1] ?? "";
      if (p.startsWith("/")) gdir = p;
      else if (p === "") return false;
      else gdir = `${trimSlash(gdir)}/${p}`;
      k += 2;
    } else if (a === "-c") k += 2;
    else if (a.startsWith("-")) k++;
    else break;
  }
  const sub = args2[k++] ?? "";
  if (sub !== "ls-files" && sub !== "diff") return false;
  let ok = false;
  for (const w of args2.slice(k)) {
    if (w === "--name-only") ok = true;
    else if (/^(--format|--full-name$|--output|--src-prefix|--dst-prefix)/.test(w)) return false;
    else if (w.startsWith("-")) continue;
    else if (w.startsWith(":!") || w.startsWith(":^")) m.excl.push("G:" + w.slice(2));
    else if (w.startsWith(":(exclude)")) m.excl.push("G:" + w.slice(10));
    else if (w.startsWith(":")) return false;
    else m.paths.push(w.startsWith("/") ? w : `${trimSlash(gdir)}/${w}`);
  }
  if (sub !== "ls-files" && !ok) return false;
  if (m.paths.length === 0) m.paths = [gdir];
  m.vals = ["*"];
  m.gdir = gdir;
  return true;
}
function rgModel(args2, m) {
  const n = args2.length;
  let k = 0;
  let ok = false;
  let nocase = false;
  while (k < n) {
    const w = args2[k++];
    if (w === "--files") ok = true;
    else if (/^(-L|--follow|--path-separator.*|--pre|--pre=.*)$/s.test(w)) return false;
    else if (w === "-g" || w === "--glob" || w === "--iglob") {
      const a = args2[k] ?? "";
      if (a.startsWith("!")) {
        if (w !== "--iglob") m.excl.push("Q:" + a.slice(1));
      } else m.pats.push((w === "--iglob" ? "i:" : "s:") + a);
      k++;
    } else if (w === "-i" || w === "--ignore-case" || w === "--glob-case-insensitive") nocase = true;
    else if (RG_VALUE.test(w)) k++;
    else if (!w.startsWith("-")) m.paths.push(w);
  }
  if (!ok) return false;
  if (nocase) {
    m.pats = m.pats.map((p) => "i:" + p.slice(2));
    m.excl = [];
  }
  return true;
}
function fdModel(mode, args2, raw, acts, m) {
  const n = args2.length;
  let k = 0;
  let ok = false;
  let bad = false;
  while (k < n) {
    const w = args2[k++];
    if (w === "-x" || w === "--exec" || w === "-X" || w === "--exec-batch") {
      if (mode !== "exec") return false;
      const run2 = [];
      let hit = false;
      while (k < n) {
        const x = raw[k++];
        if (x === "") break;
        if (PLACEHOLDER.test(x)) hit = true;
        run2.push(x);
      }
      if (!hit) run2.push("{}");
      acts.push("x" + run2.join(" "));
    } else if (/^(--format.*|--path-separator.*|-L|--follow|-l|--list-details|--base-directory.*)$/s.test(w)) bad = true;
    else if (w === "--search-path") m.paths.push(args2[k++] ?? "");
    else if (w === "-E" || w === "--exclude") m.excl.push("F:" + (args2[k++] ?? ""));
    else if (FD_VALUE.test(w)) k++;
    else if (w.startsWith("-")) continue;
    else if (!ok) ok = true;
    else m.paths.push(w);
  }
  return !bad;
}
function listerBind(host, name3, dirtok, mode, words, acts) {
  if (mode === "loop" && (host.root === "" || !NAME.test(name3))) return null;
  const dec2 = mode === "loop" ? words : words.map(decode);
  let dir = "";
  if (dirtok.startsWith("/")) dir = dirtok;
  else if (dirtok === "@") dir = host.cwd;
  else if (dirtok.startsWith("@/") && host.cwd !== "") dir = `${trimSlash(host.cwd)}/${dirtok.slice(2)}`;
  if (dir === "" && mode !== "exec") return null;
  const args2 = [];
  const raw = [];
  let skip = false;
  for (let k = 1; k < words.length; k++) {
    const w = dec2[k] ?? "";
    if (mode === "exec") {
      if (skip) {
        skip = false;
        continue;
      }
      if (EXEC_REDIRECT.test(words[k])) {
        skip = true;
        continue;
      }
      if (EXEC_REDIRECT_WORD.test(words[k])) continue;
      raw.push(words[k]);
    } else {
      if (w === "2>/dev/null") continue;
      if (w === "2>") {
        if (words[k + 1] !== "/dev/null") return null;
        k++;
        continue;
      }
      if (/[<>`]/.test(w)) return null;
    }
    args2.push(w);
  }
  const cmd = basename2(words[0] ?? "");
  if (mode === "exec" && cmd !== "find" && cmd !== "fd" && cmd !== "fdfind") return null;
  const m = { paths: [], vals: [], pats: [], excl: [], gdir: "", listed: false };
  let fine;
  if (cmd === "find") fine = findModel(mode, args2, raw, acts, m);
  else if (cmd === "ls") fine = lsModel(args2, m);
  else if (cmd === "git") fine = gitModel(dir, args2, m);
  else if (cmd === "rg") fine = rgModel(args2, m);
  else if (cmd === "fd" || cmd === "fdfind") fine = fdModel(mode, args2, raw, acts, m);
  else return null;
  if (!fine || dir === "" || host.root === "") return null;
  if (mode === "exec" && acts.length === 0) return null;
  if (!NAME.test(name3)) return null;
  const rootc = host.rootc();
  const rootTrim = trimSlash(rootc);
  let bound = rootc;
  const git2 = cmd === "git";
  if (git2) {
    bound = pathCanonical2(m.gdir);
    if (!(bound + "/").startsWith(rootTrim + "/")) return null;
  }
  if (m.paths.length === 0) m.paths = ["."];
  const vals = m.vals;
  for (const p of m.paths) {
    const exp = host.expand(p);
    if (exp === null) return null;
    for (let v of exp) {
      if (v === "~") v = host.home;
      else if (v.startsWith("~/")) v = `${host.home}/${v.slice(2)}`;
      let w = v.startsWith("/") ? v : `${trimSlash(dir)}/${v}`;
      const glob = w.search(/[*?[]/);
      if (glob >= 0) {
        w = w.slice(0, glob);
        const slash = w.lastIndexOf("/");
        if (slash >= 0) w = w.slice(0, slash);
        if (w === "") w = "/";
      }
      w = pathCanonical2(w);
      if (!(w + "/").startsWith(trimSlash(bound) + "/")) return null;
      if (w.startsWith(rootTrim)) w = w.slice(rootTrim.length);
      const at = git2 ? trimSlash(p) : trimSlash(v);
      if (isPromptSurfacePath(`${rootTrim}${trimSlash(w)}/x.md`, rootc)) vals.push(`${at}/*.md`);
      else if (cmd !== "ls") {
        const rel = w.replace(/^\//, "");
        for (const d of SURFACES) {
          const sub = rel !== "" && d.startsWith(rel + "/") ? d.slice(rel.length + 1) : d;
          if (d === "CLAUDE.md") {
            if (rel !== "" || !isFile5(`${rootTrim}/${d}`)) continue;
          } else if (!isDir(`${rootTrim}/${d}`) || rel !== "" && sub === d) continue;
          if (m.excl.some((e) => exclCovers(e, d, sub, v, host.root, rootc))) continue;
          if (m.pats.length > 0) {
            const names = d === "CLAUDE.md" ? ["CLAUDE.md"] : ["x.md", "SKILL.md", "CLAUDE.md"];
            if (!m.pats.some((pat) => names.some((v2) => patMatches(pat, v2)))) continue;
          }
          vals.push(`${at}/${d === "CLAUDE.md" ? d : `${sub}/*.md`}`);
        }
      }
      if (git2) continue;
      vals.push(v, `${trimSlash(v)}/*`);
      for (const pat of m.pats) {
        const body2 = pat.slice(2);
        if (body2 === "" || body2.includes("/") || body2.startsWith("!")) continue;
        if (PROMPT_FILES.some((f) => patMatches(pat, f))) vals.push(`${trimSlash(v)}/${body2}`);
      }
    }
  }
  if (m.listed) vals.push("*");
  let list = "\n";
  for (const v of vals) if (!list.includes(`
${v}
`)) list += v + "\n";
  const lines2 = list.slice(1).replace(/\n$/, "").split("\n");
  return lines2.length > 16 ? null : lines2;
}

// src/hooks/cmd-analysis/prog-calls.ts
var Q1 = "'";
var PROCOS = /^(system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?)$/;
var HIDMODS = "runpy|code|codeop|doctest|pickle|marshal|shelve|importlib|pydoc|types|inspect";
var MODS = `subprocess|os|builtins|cProfile|profile|pdb|trace|timeit|bdb|sys|${HIDMODS}`;
var PYMODS = new RegExp(`^(${MODS})$`);
var HIDRE = new RegExp(`^(${HIDMODS})$`);
var RUNRE = /^((cProfile|profile)[.](run|runctx)|pdb[.](run|runeval|runctx)|timeit[.](timeit|repeat))$/;
var CLSRE = /^(trace[.]Trace|(cProfile|profile)[.]Profile|pdb[.]Pdb|bdb[.]Bdb|timeit[.]Timer)([.]|$)/;
var MAINRE = /^((timeit|cProfile|profile|trace|pdb)[.]main|pdb[.](set_trace|post_mortem|pm))([.]|$)/;
var WMODS = /^(os|io|shutil|pathlib|zipfile)$/;
var WRECV = /^(os|io|shutil|pathlib[.]Path|zipfile)$/;
var HELDRE = /^(exec|eval|compile|open|__import__|getattr|setattr|delattr|globals|locals|vars|type|breakpoint|input)([.]|$)/;
var DUNRE = /(^|[.])(__subclasses__|__globals__|__code__|__dict__|__class__|__bases__|__mro__)([.]|$)/;
var ALIASRE = new RegExp(`from[ \\t]+(${MODS})[ \\t]+import|import([ \\t][^\\n;]*)?[ \\t,](${MODS})[ \\t]+as[ \\t]`);
var PY_IMPORT_FROM = "(^|[\\n;:])[ \\t]*from[ \\t]+[A-Za-z_][A-Za-z0-9_.]*[ \\t]+import[ \\t]*";
var PY_IMPORT = [
  new RegExp(`${PY_IMPORT_FROM}[(][^)]*[)]`, "y"),
  new RegExp(`${PY_IMPORT_FROM}[^\\n;]*`, "y"),
  /(^|[\n;:])[ \t]*import[ \t]+[^\n;]*/y
];
var PY_IMPORT_ANY = new RegExp(PY_IMPORT.map((r) => r.source).join("|"));
var QQ = `['"]`;
var NODE_IMPORT = new RegExp(
  `((const|let|var)[ \\t]+([A-Za-z_$][A-Za-z0-9_$]*|[{][^}]*[}])[ \\t\\n]*=[ \\t\\n]*require[ \\t]*[(][ \\t]*${QQ}(node:)?child_process${QQ}[ \\t]*[)]|import[ \\t]+[^;\\n]*from[ \\t]*${QQ}(node:)?child_process${QQ})`
);
var NODE_REQUIRE_CHAIN = new RegExp(`require[ \\t]*[(][ \\t]*${QQ}(node:)?child_process${QQ}[ \\t]*[)][ \\t\\n]*[.]`);
var NODE_CP = new RegExp(`${QQ}(node:)?child_process${QQ}`);
var CALLBACK = /^[ \t\n]*(async[ \t\n]+)?(function[^A-Za-z0-9_$]|[(][^()]*[)][ \t\n]*=>|[A-Za-z_$][A-Za-z0-9_$]*[ \t\n]*=>)/;
var RUN_KEYS = ["statement", "cmd", "expression", "expr", "stmt", "setup", "source"];
function substr(s, m, n) {
  const start2 = Math.max(m, 1);
  const end = n === void 0 ? s.length + 1 : Math.min(m + n, s.length + 1);
  return end <= start2 ? "" : s.slice(start2 - 1, end - 1);
}
function index2(s, t) {
  return s.indexOf(t) + 1;
}
function split(s, sep2) {
  if (sep2 === " ") return s.split(/[ \t\n]+/).filter((x) => x !== "");
  return s === "" ? [] : s.split(sep2);
}
var trim = (x) => x.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
function match(s, re) {
  const m = re.exec(s);
  return m ? [m.index + 1, m[0].length] : [0, -1];
}
var key = (t, k) => `${t}${k}`;
var Scanner = class _Scanner {
  constructor(lang) {
    this.lang = lang;
  }
  lang;
  out = [];
  s = "";
  ip = 1;
  d = 0;
  pc = 0;
  anom = false;
  spx = 0;
  nimp = 0;
  nf = 0;
  exeset = false;
  fid = [];
  ftype = [];
  fclose = [];
  isopt = [];
  role = [];
  nat = [];
  fname = [];
  frecv = [];
  frecvv = [];
  np = [];
  frun = [];
  fout = [];
  fcs = [];
  fcn = [];
  atok = [];
  aoth = [];
  alit = [];
  anam = [];
  aargv = [];
  akw = [];
  acode = [];
  alam = [];
  pk = /* @__PURE__ */ new Map();
  pv = /* @__PURE__ */ new Map();
  pn = /* @__PURE__ */ new Map();
  pcd = /* @__PURE__ */ new Map();
  plam = /* @__PURE__ */ new Map();
  kk = /* @__PURE__ */ new Map();
  kv = /* @__PURE__ */ new Map();
  kn = /* @__PURE__ */ new Map();
  kcd = /* @__PURE__ */ new Map();
  klam = /* @__PURE__ */ new Map();
  spbad = 0;
  spai = 0;
  spkind = "";
  spe = 0;
  splist = 0;
  spshell = 0;
  spraw = 0;
  spcw = "";
  spcwh = 0;
  sr = [];
  sq = [];
  snPre = "";
  snLast = "";
  wlast = "";
  wpre = "";
  lastk = "";
  lastv = "";
  rbad = 0;
  nrc = 0;
  rc = [];
  ims = [];
  ime = [];
  fal = /* @__PURE__ */ new Map();
  mal = /* @__PURE__ */ new Map();
  star = /* @__PURE__ */ new Set();
  impd = /* @__PURE__ */ new Set();
  wal = /* @__PURE__ */ new Map();
  wimp = /* @__PURE__ */ new Set();
  wstar = /* @__PURE__ */ new Set();
  get py() {
    return this.lang === "py";
  }
  print(line) {
    this.out.push(line);
  }
  at(k, n = 1) {
    return substr(this.s, k, n);
  }
  fidAt(d) {
    return this.fid[d] ?? 0;
  }
  tok(k, v) {
    if (this.d === 0) return;
    const t = this.fidAt(this.d);
    this.atok[t] = (this.atok[t] ?? 0) + 1;
    this.anam[t] = "";
    if (k === "L") this.alit[t] = v;
    else this.aoth[t] = 1;
  }
  oth() {
    if (this.d > 0) {
      const t = this.fidAt(this.d);
      this.aoth[t] = 1;
      this.anam[t] = "";
    }
  }
  resetarg(t) {
    this.atok[t] = 0;
    this.aoth[t] = 0;
    this.alit[t] = "";
    this.anam[t] = "";
    this.aargv[t] = "";
    this.akw[t] = "";
    this.acode[t] = "";
    this.alam[t] = 0;
  }
  opn(type, cl, name3, rk, rv) {
    const d = ++this.d;
    const nf = ++this.nf;
    this.fid[d] = nf;
    this.ftype[d] = type;
    this.fclose[d] = cl;
    this.fname[nf] = name3;
    this.frecv[nf] = rk;
    this.frecvv[nf] = rv;
    this.np[nf] = 0;
    this.frun[nf] = "";
    this.fout[nf] = 0;
    this.resetarg(nf);
    this.fcs[nf] = type === "group" ? 0 : this.contentstart(name3, rk);
    this.isopt[d] = 0;
    if (this.spx) {
      this.spnest(type, cl, name3);
      return;
    }
    if (type !== "group" && this.isproc(this.canon(name3))) this.spstart(this.canon(name3));
  }
  spnest(type, cl, name3) {
    const { d } = this;
    const pr = this.role[d - 1] ?? "";
    this.role[d] = "ign";
    if (pr === "ign") {
      if (type !== "group" && this.isproc(this.canon(name3))) this.spbad = 1;
      return;
    }
    if (type !== "group" || pr === "key") {
      this.spbad = 1;
      return;
    }
    this.nat[d - 1] = (this.nat[d - 1] ?? 0) + 1;
    if (this.nat[d - 1] > 1) {
      this.spbad = 1;
      return;
    }
    this.nat[d] = 0;
    if (pr === "cmd" && cl !== "}") {
      this.role[d] = "elem";
      this.splist = 1;
    } else if (cl === "}" && (pr === "opt" || pr === "cmd" && (this.lang === "node" || this.lang === "ruby"))) {
      this.role[d] = "key";
      this.isopt[d] = 1;
    } else this.spbad = 1;
  }
  spstart(cn) {
    this.spx = this.d;
    this.spbad = 0;
    this.spai = 1;
    this.spkind = "";
    this.spe = 0;
    this.splist = 0;
    this.spshell = 0;
    this.spraw = 0;
    this.spcw = "";
    this.spcwh = 0;
    this.splitname(cn);
    if (this.py) {
      if (/(^|[.])os$/.test(this.snPre)) this.spkind = this.snLast;
      this.spraw = /^(system|popen|getoutput|getstatusoutput)$/.test(this.snLast) ? 1 : 0;
    } else if (this.lang === "node") {
      this.spkind = this.snLast;
      this.spraw = /^(exec|execSync)$/.test(this.snLast) ? 1 : 0;
    }
    this.slotstart(this.ip);
  }
  slotstart(p) {
    const { spkind, spai } = this;
    let r = "cmd";
    if (this.py) {
      if (/^spawn/.test(spkind)) r = spai === 1 ? "lit" : "cmd";
      else if (/^posix_spawn/.test(spkind)) r = spai <= 2 ? "cmd" : spai === 3 ? "lit" : "none";
      else if (spkind === "popen") r = spai === 1 ? "cmd" : "lit";
      else if (!/^exec/.test(spkind)) r = spai === 1 ? "cmd" : "none";
    } else if (this.lang === "node") {
      if (/^(exec|execSync)$/.test(spkind)) r = spai === 1 ? "cmd" : spai <= 3 ? "opt" : "none";
      else r = spai <= 2 ? "cmd" : spai <= 4 ? "opt" : "none";
      if (r === "opt" || r === "cmd" && spai === 2) {
        if (CALLBACK.test(substr(this.s, p))) r = "ign";
      }
    }
    this.role[this.spx] = r;
    this.nat[this.spx] = 0;
  }
  keyrole(nm) {
    if (this.py) {
      if (nm === "args") return "cmd";
      if (nm === "cwd") return "cwd";
      if (nm === "shell") return "shell";
      if (/^(stdin|stdout|stderr|input|timeout|check|text|capture_output|encoding|errors|universal_newlines|env|bufsize|close_fds|pass_fds|restore_signals|start_new_session|process_group|startupinfo|creationflags|user|group|extra_groups|umask|pipesize)$/.test(
        nm
      ))
        return "ign";
      if (/^(executable|preexec_fn)$/.test(nm)) return "bad";
      return "lit";
    }
    if (this.lang === "node") {
      if (nm === "cwd") return "cwd";
      if (nm === "shell") return "shell";
      if (/^(stdio|env|encoding|timeout|maxBuffer|killSignal|windowsHide|windowsVerbatimArguments|detached|uid|gid|input|signal|serialization|argv0|silent)$/.test(
        nm
      ))
        return "ign";
      if (/^(execArgv|execPath)$/.test(nm)) return "bad";
      return "lit";
    }
    if (nm === "chdir") return "cwd";
    if (/^(in|out|err)$/.test(nm)) return "redir";
    if (/^(unsetenv_others|pgroup|new_pgroup|umask|close_others|exception|rlimit_[a-z]+)$/.test(nm)) return "ign";
    return "lit";
  }
  setkey(nm) {
    let r = this.keyrole(nm);
    if (r === "bad") {
      this.spbad = 1;
      r = "ign";
    }
    this.role[this.d] = r;
    this.nat[this.d] = 0;
  }
  skey(v) {
    let k = this.ip;
    while (/[ \t\n]/.test(this.at(k))) k++;
    if (this.at(k) === ":" && this.at(k + 1) !== ":" && (this.lang === "node" || this.lang === "ruby")) {
      this.setkey(v);
      this.ip = k + 1;
    } else if (this.lang === "ruby" && this.at(k, 2) === "=>") {
      this.role[this.d] = "ign";
      this.ip = k + 2;
    } else this.spbad = 1;
  }
  satom(kind, v) {
    if (!this.spx) return;
    const { d } = this;
    const r = this.role[d] ?? "";
    if (r === "ign") return;
    if (r === "key") {
      this.spbad = 1;
      return;
    }
    this.nat[d] = (this.nat[d] ?? 0) + 1;
    if (this.nat[d] > 1) {
      this.spbad = 1;
      return;
    }
    if (r === "cmd" || r === "elem") {
      if (/^[SNX]$/.test(kind)) {
        this.spe++;
        this.sr[this.spe] = v;
        this.sq[this.spe] = sqt(v);
      } else this.spbad = 1;
    } else if (r === "cwd") {
      if (kind === "S") {
        this.spcw = sqt(v);
        this.spcwh = 1;
      } else if (!(kind === "K" && /^(None|null|undefined|nil)$/.test(v))) this.spbad = 1;
    } else if (r === "shell") {
      if (/^[SNK]$/.test(kind)) {
        if (!/^(False|false|None|null|undefined|nil)$/.test(v)) this.spshell = 1;
      } else this.spbad = 1;
    } else if (r === "redir") {
      if (kind !== "K" && kind !== "N") this.spbad = 1;
    } else if (r === "lit" || r === "opt") {
      if (!/^[SNK]$/.test(kind)) this.spbad = 1;
    } else this.spbad = 1;
  }
  spfin() {
    if (!this.spbad && this.spe > 0) {
      const plain = this.spshell || this.spraw || this.spe === 1 && !this.splist;
      let cmd = "";
      for (let j = 1; j <= this.spe; j++) cmd += (j > 1 ? " " : "") + (plain ? this.sr[j] : this.sq[j]);
      if (this.spcwh) cmd = `cd ${this.spcw} && ${cmd}`;
      this.print("S	" + cmd.replace(/\n/g, ""));
      this.print("W");
    } else this.unres();
    this.spx = 0;
  }
  bt(v, interp) {
    if (interp) this.unres();
    else {
      this.print("S	" + v.replace(/\n/g, ""));
      this.print("W");
    }
    if (this.spx && this.role[this.d] !== "ign") this.spbad = 1;
  }
  qlike(p) {
    const o = this.at(p);
    let c = o;
    if (o === "(") c = ")";
    else if (o === "[") c = "]";
    else if (o === "{") c = "}";
    else if (o === "<") c = ">";
    let dep = 1;
    let v = "";
    let j = p + 1;
    while (j <= this.s.length) {
      const ch = this.at(j);
      if (ch === "\\") {
        v += this.at(j, 2);
        j += 2;
        continue;
      }
      if (ch === c && c !== o) {
        if (--dep === 0) break;
      } else if (ch === c) {
        dep = 0;
        break;
      } else if (ch === o) dep++;
      v += ch;
      j++;
    }
    if (dep) {
      this.anom = true;
      this.ip = this.s.length + 1;
      return;
    }
    this.ip = j + 1;
    this.pc = 0;
    this.bt(v, this.lang === "perl" ? o !== Q1 && /[$@]/.test(v) : index2(v, "#{") > 0);
    this.tok("E", "");
  }
  canon(nm) {
    const al = this.fal.get(nm);
    if (al !== void 0) return al;
    const [st, len] = match(nm, /^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!st) return nm;
    const f = nm.slice(0, len);
    const r = nm.slice(len);
    const m = this.mal.get(f);
    if (m !== void 0) return m + r;
    const ff = this.fal.get(f);
    if (this.py && ff !== void 0 && CLSRE.test(ff)) return ff + r;
    if (this.py && r !== "") {
      for (const g of this.star) if (CLSRE.test(`${g}.${f}`) || `${g}.${f}` === "sys.modules") return `${g}.${f}${r}`;
    }
    if (this.py && r === "") {
      if (this.star.has("subprocess") && /^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(nm))
        return "subprocess." + nm;
      if (this.star.has("os") && (PROCOS.test(nm) || /^f?chdir$/.test(nm))) return "os." + nm;
      for (const g of this.star) {
        const q = `${g}.${nm}`;
        if (RUNRE.test(q) || CLSRE.test(q) || MAINRE.test(q) || q === "sys.modules") return q;
      }
    }
    return nm;
  }
  pyref(nm, cn, ch, k, st, rk) {
    if (this.inimport(st)) return;
    const b = cn.replace(/^(builtins|__builtins__)[.]/, "");
    if (DUNRE.test(cn) || /^sys[.]modules([.]|$)/.test(cn) || MAINRE.test(cn) || /^breakpoint([.]|$)/.test(b)) {
      this.unres();
      return;
    }
    if (ch === "=" && this.at(k + 1) !== "=") return;
    const m = cn.replace(/[.].*$/s, "");
    if (/^(builtins|__builtins__)$/.test(cn) || /(^|[.])__self__([.]|$)/.test(cn) || CLSRE.test(cn) || /^(builtins|__builtins__)[.]__/.test(cn) || this.impd.has(m) && (cn === m || /^[^.]+[.]__/.test(cn)) || RUNRE.test(cn) && ch !== "(")
      this.unres();
    else if (HELDRE.test(b) && (ch !== "(" || /[.]/.test(b))) this.held(b);
    else if (this.wheld(nm, ch, rk) && !this.cbarg(nm, cn)) this.aw();
  }
  wres(nm) {
    const [st, len] = match(nm, /^[A-Za-z_][A-Za-z0-9_]*/);
    if (!st) return nm;
    const w = this.wal.get(nm.slice(0, len));
    return w !== void 0 ? w + nm.slice(len) : nm;
  }
  wq(nm, rk) {
    const [st, len] = match(nm, /^[A-Za-z_][A-Za-z0-9_]*/);
    if (!st) return "";
    const f = nm.slice(0, len);
    const r = nm.slice(len);
    const w = this.wal.get(f);
    if (w !== void 0) return w + r;
    if (this.wimp.has(f) || rk === "M") return nm;
    for (const g of this.wstar) if (g === "pathlib" && f === "Path" || wkind(f, g) !== "") return `${g}.${f}${r}`;
    return "";
  }
  pywriter(nm) {
    this.splitname(nm);
    return WRECV.test(this.snPre) && wkind(this.snLast, this.snPre) !== "";
  }
  wheld(nm, ch, rk) {
    const q = this.wq(nm, rk);
    if (q === "") return false;
    if (/^(io|shutil|pathlib|zipfile)$/.test(q)) return true;
    const a = split(q, ".");
    let p = a[0];
    for (let i2 = 2; i2 <= a.length; i2++) {
      p += "." + a[i2 - 1];
      if ((i2 < a.length || ch !== "(") && this.pywriter(p)) return true;
    }
    return false;
  }
  cbarg(nm, cn) {
    if (this.d === 0 || this.ftype[this.d] !== "call") return false;
    const t = this.fidAt(this.d);
    return this.akw[t] === "copy_function" && /^(dst|mv)$/.test(this.pykind(this.fname[t] ?? "")) && (this.pykind(nm) === "dst" || this.pykind(cn) === "dst");
  }
  pykind(raw) {
    this.splitname(raw);
    this.wlast = this.snLast;
    this.wpre = this.snPre;
    let k = wkind(this.wlast, this.wpre);
    if (k !== "" || !this.py) return k;
    this.splitname(this.wres(raw));
    k = wkind(this.snLast, this.snPre);
    if (k !== "") {
      this.wlast = this.snLast;
      this.wpre = this.snPre;
    }
    return k;
  }
  pycallref(t, cn) {
    const b = cn.replace(/^(builtins|__builtins__)[.]/, "");
    const np = this.np[t] ?? 0;
    if (/^(getattr|setattr|delattr)$/.test(b) && !(np >= 2 && this.pk.get(key(t, 2)) === "L")) this.unres();
    if (/(^|[.])(__import__|import_module)$/.test(this.fname[t] ?? "") && !(np >= 1 && this.pk.get(key(t, 1)) === "L")) this.unres();
    if (/^(globals|locals|vars)$/.test(b)) {
      let k = this.ip + 1;
      while (/[ \t\n\\]/.test(this.at(k))) k++;
      const c = this.at(k);
      if (c === "[" || c === ".") this.unres();
    }
  }
  runcode(k, v, lam, kind) {
    if (kind === "t" && lam) return;
    if (k !== "L" || v === "" || ALIASRE.test(v)) this.rbad = 1;
    else this.rc[++this.nrc] = v;
  }
  runjudge(t, kind) {
    this.rbad = 0;
    this.nrc = 0;
    const np = this.np[t] ?? 0;
    for (let i2 = 1; i2 <= np && i2 <= (kind === "t" ? 2 : 1); i2++) {
      this.runcode(this.pk.get(key(t, i2)) ?? "", this.pcd.get(key(t, i2)) ?? "", this.plam.get(key(t, i2)) ?? 0, kind);
    }
    for (const a of RUN_KEYS) {
      const kt = key(t, a);
      if (this.kk.has(kt)) this.runcode(this.kk.get(kt) ?? "", this.kcd.get(kt) ?? "", this.klam.get(kt) ?? 0, kind);
    }
    if (this.rbad) {
      this.unres();
      return;
    }
    let p = "";
    for (let j = 1; j <= this.nimp; j++) p += this.at(this.ims[j], this.ime[j] - this.ims[j]) + "\n";
    for (let j = 1; j <= this.nrc; j++) this.print("R	" + (p + this.rc[j]).replace(/\n/g, ""));
  }
  procref(cn) {
    this.splitname(cn);
    if (this.py) {
      return cn === "os" || /^subprocess([.]|$)/.test(cn) && !/^(PIPE|STDOUT|DEVNULL|CalledProcessError|TimeoutExpired|SubprocessError|CompletedProcess|list2cmdline)$/.test(this.snLast) || this.snPre === "os" && PROCOS.test(this.snLast);
    }
    if (this.lang === "node") {
      return /^child_process([.]|$)/.test(cn) || /^[?][(][)][.](exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/.test(cn);
    }
    return false;
  }
  inimport(p) {
    for (let j = 1; j <= this.nimp; j++) if (p >= this.ims[j] && p < this.ime[j]) return true;
    return false;
  }
  unres() {
    this.print("W");
    this.print("U");
  }
  aw() {
    this.print("W");
    this.print("H");
  }
  held(nm) {
    if (/^open([.]|$)/.test(nm)) this.aw();
    else this.unres();
  }
  addrange(st, ln) {
    this.nimp++;
    this.ims[this.nimp] = st;
    this.ime[this.nimp] = st + ln;
  }
  static alias(piece) {
    let nm = trim(piece);
    let al = nm;
    if (/[ \t]as[ \t]/.test(nm)) {
      al = al.replace(/^.*[ \t]as[ \t]+/s, "");
      nm = nm.replace(/[ \t].*$/s, "");
    }
    return [nm, al];
  }
  pyimport(text) {
    const m = text.replace(/^[\n;: \t]+/, "");
    if (/^from/.test(m)) {
      const mod = m.replace(/^from[ \t]+/, "").replace(/[ \t].*$/s, "");
      const top = mod.replace(/[.].*$/s, "");
      if (HIDRE.test(top)) {
        this.unres();
        return;
      }
      const x2 = m.replace(/^from[ \t]+[^ \t]+[ \t]+import[ \t]*/, "").replace(/[()\\\n]/g, " ");
      for (const piece of split(x2, ",")) {
        const [nm, al] = _Scanner.alias(piece);
        if (WMODS.test(mod) && nm === "*") this.wstar.add(mod);
        else if (WMODS.test(mod) && nm !== "") this.wal.set(al, `${mod}.${nm}`);
        if (!PYMODS.test(mod)) {
          if (al === "compile") this.fal.set(al, `${mod}.${nm}`);
          continue;
        }
        if (mod === "builtins" && HELDRE.test(nm) && al !== nm) this.held(nm);
        if (nm === "*") this.star.add(mod);
        else if (nm !== "") this.fal.set(al, `${mod}.${nm}`);
      }
      return;
    }
    const x = m.replace(/^import[ \t]+/, "");
    for (const piece of split(x, ",")) {
      const [nm, al] = _Scanner.alias(piece);
      const top = nm.replace(/[.].*$/s, "");
      if (HIDRE.test(top)) this.unres();
      if (PYMODS.test(nm) && !/^(subprocess|os|builtins)$/.test(nm)) this.impd.add(nm);
      if (al !== nm && PYMODS.test(nm)) this.mal.set(al, nm);
      if (al !== nm) this.wal.set(al, nm);
      else this.wimp.add(top);
    }
  }
  nodeimport(m) {
    const ident = (x) => x.replace(/[^A-Za-z0-9_$].*$/s, "");
    if (/^(const|let|var)[ \t]+[A-Za-z_$]/.test(m)) {
      this.mal.set(ident(m.replace(/^(const|let|var)[ \t]+/, "")), "child_process");
      return;
    }
    if (/^import[ \t]*[*]/.test(m)) {
      this.mal.set(ident(m.replace(/^import[ \t]*[*][ \t]*as[ \t]+/, "")), "child_process");
      return;
    }
    if (/^import[ \t]+[A-Za-z_$]/.test(m)) this.mal.set(ident(m.replace(/^import[ \t]+/, "")), "child_process");
    const [st, len] = match(m, /[{][^}]*[}]/);
    if (!st) return;
    for (const piece of split(substr(m, st + 1, len - 2), ",")) {
      let nm = trim(piece);
      let al = nm;
      if (/:/.test(nm)) {
        al = al.replace(/^[^:]*:[ \t\n]*/, "");
        nm = nm.replace(/[ \t\n]*:.*$/s, "");
      } else if (/[ \t]as[ \t]/.test(nm)) {
        al = al.replace(/^.*[ \t]as[ \t]+/s, "");
        nm = nm.replace(/[ \t].*$/s, "");
      }
      if (nm !== "" && al !== "") this.fal.set(al, "child_process." + nm);
    }
  }
  /** The python import statement match at `rest`'s start of a match, leftmost-longest as awk's match(). */
  static pyImportMatch(rest) {
    const at = rest.search(PY_IMPORT_ANY);
    if (at < 0) return [0, -1];
    let len = -1;
    for (const re of PY_IMPORT) {
      re.lastIndex = at;
      const m = re.exec(rest);
      if (m && m[0].length > len) len = m[0].length;
    }
    return [at + 1, len];
  }
  prescan() {
    const { s } = this;
    this.exeset = this.py && /sys[.]executable[ \t]*=[^=]/.test(s) || this.lang === "node" && /process[.]execPath[ \t]*=[^=]/.test(s);
    if (this.py) {
      let off2 = 1;
      while (off2 <= s.length) {
        const [st0, ln] = _Scanner.pyImportMatch(substr(s, off2));
        if (!st0) break;
        const st = off2 + st0 - 1;
        this.addrange(st, ln);
        this.pyimport(substr(s, st, ln));
        off2 = st + (ln > 0 ? ln : 1);
      }
      return;
    }
    if (this.lang !== "node") return;
    let off = 1;
    let seen = 0;
    while (off <= s.length) {
      const [st0, ln] = match(substr(s, off), NODE_IMPORT);
      if (!st0) break;
      const st = off + st0 - 1;
      this.addrange(st, ln);
      this.nodeimport(substr(s, st, ln));
      seen++;
      off = st + (ln > 0 ? ln : 1);
    }
    off = 1;
    while (off <= s.length) {
      const [st0, ln] = match(substr(s, off), NODE_REQUIRE_CHAIN);
      if (!st0) break;
      seen++;
      off += st0 + ln - 1;
    }
    off = 1;
    let cnt = 0;
    while (off <= s.length) {
      const [st0, ln] = match(substr(s, off), NODE_CP);
      if (!st0) break;
      cnt++;
      off += st0 + ln - 1;
    }
    if (cnt > seen) this.unres();
  }
  endarg(t) {
    const atok = this.atok[t] ?? 0;
    const aoth = this.aoth[t] ?? 0;
    const akw = this.akw[t] ?? "";
    if (atok === 0 && !aoth && akw === "") return;
    const k = atok === 1 && !aoth ? "L" : "E";
    const nm = this.anam[t] || (atok === 2 ? this.aargv[t] ?? "" : "");
    if (akw !== "") {
      const kt = key(t, akw);
      this.kk.set(kt, k);
      this.kv.set(kt, this.alit[t] ?? "");
      this.kn.set(kt, nm);
      this.kcd.set(kt, this.acode[t] ?? "");
      this.klam.set(kt, this.alam[t] ?? 0);
    } else {
      const np = this.np[t] = (this.np[t] ?? 0) + 1;
      const kt = key(t, np);
      this.pk.set(kt, k);
      this.pv.set(kt, this.alit[t] ?? "");
      this.pn.set(kt, nm);
      this.pcd.set(kt, this.acode[t] ?? "");
      this.plam.set(kt, this.alam[t] ?? 0);
    }
    this.resetarg(t);
  }
  endone() {
    const t = this.fidAt(this.d);
    const ty = this.ftype[this.d] ?? "";
    this.endarg(t);
    if (this.spx === this.d) this.spfin();
    this.d--;
    this.lastk = "U";
    this.lastv = "";
    if (ty === "call" || ty === "pseudo") {
      this.classify(t);
      const fname = this.fname[t] ?? "";
      const np = this.np[t] ?? 0;
      const pk1 = this.pk.get(key(t, 1)) ?? "";
      const pv1 = this.pv.get(key(t, 1)) ?? "";
      if (ty === "call" && /(^|\.)(Path|PurePath|PosixPath|WindowsPath)$/.test(fname)) {
        this.lastk = np === 1 && pk1 === "L" ? "P" : "PE";
        this.lastv = pv1;
      }
      if (ty === "call" && this.py && /(^|[.])(__import__|import_module)$/.test(fname) && np >= 1 && pk1 === "L" && WMODS.test(pv1)) {
        if (this.at(this.ip + 1) === "." && /[A-Za-z_]/.test(this.at(this.ip + 2))) {
          this.lastk = "M";
          this.lastv = pv1;
        } else this.aw();
      }
      if ((this.frun[t] ?? "") !== "") this.runjudge(t, this.frun[t]);
      if (this.py && ty === "call") this.pycallref(t, this.fcn[t] ?? "");
      const fout = this.fout[t] ?? 0;
      if (fout && ((this.np[t] ?? 0) >= fout || this.kk.has(key(t, "filename")))) this.arg(t, fout, "filename");
    }
    this.tok("E", "");
  }
  endpseudo() {
    while (this.d > 0 && this.ftype[this.d] === "pseudo") this.endone();
    this.pc = 0;
  }
  /** A literal target prints `T<TAB><value>`; a lone name prints `F<TAB><name>` for programs.ts to resolve; anything else prints `F`. */
  hit(k, v, nm = "") {
    this.print("W");
    if (k === "L" && v !== "" && !(this.py && pyesc(v))) this.print("T	" + v);
    else if (k !== "L" && nm !== "") this.print("F	" + nm);
    else this.print("F");
  }
  arg(t, i2, kws) {
    if ((this.np[t] ?? 0) >= i2) {
      const kt = key(t, i2);
      this.hit(this.pk.get(kt) ?? "", this.pv.get(kt) ?? "", this.pn.get(kt) ?? "");
      return;
    }
    for (const a of split(kws, " ")) {
      const kt = key(t, a);
      if (this.kk.has(kt)) {
        this.hit(this.kk.get(kt) ?? "", this.kv.get(kt) ?? "", this.kn.get(kt) ?? "");
        return;
      }
    }
    this.hit("E", "");
  }
  splitname(nm) {
    this.snLast = nm;
    this.snPre = "";
    const at = nm.search(/(\.|::)[^.:]*$/);
    if (at >= 0) {
      this.snPre = nm.slice(0, at);
      this.snLast = nm.slice(at + (nm[at] === ":" ? 2 : 1));
    }
  }
  isproc(nm) {
    this.splitname(nm);
    const { snPre: pre, snLast: last } = this;
    if (this.py) {
      return /(^|\.)subprocess$/.test(pre) && /^(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(last) || pre === "" && /^(check_call|check_output|Popen|getoutput|getstatusoutput)$/.test(last) || /(^|\.)os$/.test(pre) && PROCOS.test(last);
    }
    if (this.lang === "node") {
      return /^(execSync|execFile|execFileSync|spawn|spawnSync|fork)$/.test(last) || last === "exec" && (pre === "" || pre === "?()" || /(^|\.)(child_process|cp|childProcess)$/.test(pre));
    }
    return pre === "" && /^(system|exec|spawn)$/.test(last) || /^(IO\.popen|Open3\.[a-z0-9_]+|Kernel\.(system|exec|spawn)|Process\.spawn)$/.test(nm);
  }
  contentstart(nm, rk) {
    this.splitname(nm);
    const { snPre: pre, snLast: last } = this;
    if (/^(writeFileSync|appendFileSync|writeFile|appendFile|writeSync|outputFile|outputFileSync)$/.test(last)) return 2;
    if (!/^(write|writelines|write_text|write_bytes|binwrite|syswrite)$/.test(last)) return 0;
    if (rk === "P" || rk === "PE") return 1;
    return pre === "" || /(^|[.:])(os|fs|fsp|promises|File|IO)$/.test(pre) ? 2 : 1;
  }
  incontent() {
    for (let k = this.d; k >= 1; k--) {
      const t = this.fidAt(k);
      const fcs = this.fcs[t] ?? 0;
      const akw = this.akw[t] ?? "";
      if (fcs > 0 && (/^(data|text|content|contents|lines|buffer)$/.test(akw) || akw === "" && (this.np[t] ?? 0) + 1 >= fcs)) return true;
    }
    return false;
  }
  perlopen(t) {
    const np = this.np[t] ?? 0;
    if (np < 2) return;
    if (this.pk.get(key(t, 2)) !== "L") {
      if (np >= 3) this.arg(t, 3, "");
      else this.hit("E", "");
      return;
    }
    const r = (this.pv.get(key(t, 2)) ?? "").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (/^(\||-\|)/.test(r) || /\|$/.test(r)) return;
    const [st, len] = match(r, /^(\+<|\+>>|\+>|>>|>|<)/);
    if (!st) return;
    const mm = r.slice(0, len);
    const rest = r.slice(len).replace(/^[ \t]+/, "");
    if (mm === "<" || /^&/.test(rest)) return;
    if (rest === "" || /^:/.test(rest)) {
      if (np >= 3) this.arg(t, 3, "");
      else this.hit("E", "");
      return;
    }
    this.hit("L", rest);
  }
  mode(t, i2) {
    if ((this.np[t] ?? 0) >= i2) return [this.pk.get(key(t, i2)) ?? "", this.pv.get(key(t, i2)) ?? ""];
    const kt = key(t, "mode");
    if (this.kk.has(kt)) return [this.kk.get(kt) ?? "", this.kv.get(kt) ?? ""];
    return null;
  }
  classify(t) {
    const nm = this.fname[t] ?? "";
    let last = nm;
    const at = nm.search(/(\.|::)[^.:]*$/);
    if (at >= 0) last = nm.slice(at + (nm[at] === ":" ? 2 : 1));
    const rk = this.frecv[t] ?? "";
    const np = this.np[t] ?? 0;
    if (rk === "P" || rk === "PE") {
      if (/^(write_text|write_bytes|touch|mkdir|rmdir|unlink|rename|replace|symlink_to|hardlink_to)$/.test(last)) {
        this.hit(rk === "P" ? "L" : "E", this.frecvv[t] ?? "");
        if (last === "rename" || last === "replace") this.arg(t, 1, "target");
      } else if (last === "open") {
        const md = this.mode(t, 1);
        if (!md) return;
        if (md[0] === "L" && !wmode(md[1])) return;
        this.hit(rk === "P" ? "L" : "E", this.frecvv[t] ?? "");
      }
      return;
    }
    const k = this.pykind(nm);
    const pre = this.wpre;
    if (k === "open") {
      if (this.lang === "perl" && pre === "") {
        this.perlopen(t);
        return;
      }
      if (pre !== "" && np === 1 && this.pk.get(key(t, 1)) === "L" && wmode(this.pv.get(key(t, 1)) ?? "")) {
        this.hit("E", "");
        return;
      }
      const md = this.mode(t, 2);
      if (!md) return;
      if (md[0] === "L" && !wmode(md[1])) return;
      this.arg(t, 1, "file path");
    } else if (k === "trunc") this.arg(t, 1, "path");
    else if (k === "zip") {
      const md = this.mode(t, 2);
      if (!md) return;
      if (md[0] === "L" && !wmode(md[1])) return;
      this.arg(t, 1, "file");
    } else if (k === "p1") this.arg(t, 1, "path name file");
    else if (k === "fw") this.arg(t, 1, "");
    else if (k === "wt") this.hit("E", "", this.py && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pre) ? pre : "");
    else if (k === "pn") this.arg(t, 1, "path name");
    else if (k === "dst") this.arg(t, 2, "dst dest");
    else if (k === "mv") {
      this.arg(t, 1, "src");
      this.arg(t, 2, "dst dest");
    }
  }
  str(qc, pfx) {
    const { s } = this;
    const n = s.length;
    let tq = false;
    let closed = false;
    let v = "";
    let j;
    const q3 = qc + qc + qc;
    if (this.py && this.at(this.ip, 3) === q3) {
      tq = true;
      j = this.ip + 3;
    } else j = this.ip + 1;
    while (j <= n) {
      const ch = this.at(j);
      if (ch === "\\") {
        v += this.at(j, 2);
        j += 2;
        continue;
      }
      if (tq && this.at(j, 3) === q3) {
        j += 3;
        closed = true;
        break;
      }
      if (!tq && ch === qc) {
        j++;
        closed = true;
        break;
      }
      v += ch;
      j++;
    }
    if (!closed) {
      this.anom = true;
      this.ip = n + 1;
      return;
    }
    let interp = false;
    if (this.py && /[fF]/.test(pfx) && index2(v, "{")) interp = true;
    if (this.lang === "perl" && (qc === '"' || qc === "`") && /[$@]/.test(v)) interp = true;
    if (this.lang === "ruby" && (qc === '"' || qc === "`") && index2(v, "#{")) interp = true;
    if (this.lang === "node" && qc === "`" && index2(v, "${")) interp = true;
    const { d } = this;
    if (this.py && d > 0 && /(^|[.])(__import__|import_module)$/.test(this.fname[this.fidAt(d)] ?? "") && PYMODS.test(v)) this.unres();
    if (this.py && (/^(__builtins__|builtins|__self__|__subclasses__|__globals__|__code__|__dict__|__class__|__bases__|__mro__)$/.test(v) || !/[rR]/.test(pfx) && pyesc(v)))
      this.unres();
    if (!this.incontent()) this.print(`Q	${qc}${v.replace(/\n/g, " ")}${qc}`);
    this.tok(interp ? "E" : "L", v);
    if (this.py && d > 0 && !interp) this.acode[this.fidAt(d)] = /[rR]/.test(pfx) ? v : unesc(v);
    this.ip = j;
    this.pc = 0;
    if (qc === "`" && (this.lang === "perl" || this.lang === "ruby")) this.bt(v, interp);
    else if (this.spx && this.role[this.d] === "key") this.skey(v);
    else this.satom(interp ? "I" : "S", v);
  }
  name(rk, rv, pfx) {
    const { s, lang } = this;
    const n = s.length;
    let j = this.ip + 1;
    const st = this.ip;
    while (j <= n) {
      const c = this.at(j);
      if (/[A-Za-z0-9_]/.test(c)) {
        j++;
        continue;
      }
      if (c === "." && /[A-Za-z_$]/.test(this.at(j + 1))) {
        j++;
        continue;
      }
      if (c === ":" && /^:[A-Za-z_]/.test(this.at(j + 1, 2))) {
        j += 2;
        continue;
      }
      break;
    }
    const nm = pfx + this.at(this.ip, j - this.ip);
    this.ip = j;
    this.pc = 0;
    if (this.d > 0 && this.ftype[this.d] === "pseudo" && /^(or|and|xor|if|unless|do|while|until|then)$/.test(nm)) {
      this.endpseudo();
      return;
    }
    let k = this.ip;
    while (/[ \t]/.test(this.at(k))) k++;
    const ch = this.at(k);
    if (this.py && k === this.ip && (ch === Q1 || ch === '"') && /^[rRbBuUfF][rRbBfF]?$/.test(nm)) {
      this.str(ch, nm);
      return;
    }
    if (lang === "perl" && nm === "qx" && ch !== "" && index2(`()[]{}<>/|!~^%+@:-"${Q1}`, ch)) {
      this.qlike(k);
      return;
    }
    const cn = this.py ? this.canon(nm) : nm;
    if ((this.py || lang === "node") && !this.inimport(st) && this.procref(this.canon(nm)) && !(ch === "(" && this.isproc(this.canon(nm)))) this.unres();
    if (this.py) this.pyref(nm, cn, ch, k, st, rk);
    if (this.py && ch === "(" && /^((builtins|__builtins__)[.])?(exec|eval)$/.test(cn) || lang === "node" && (nm === "eval" && ch === "(" || nm === "Function") || lang === "perl" && nm === "eval" && ch !== "{" || lang === "ruby" && nm === "eval")
      this.unres();
    if (this.py && /^os[.]f?chdir$/.test(cn) || lang === "node" && nm === "process.chdir" || lang === "perl" && nm === "chdir" || lang === "ruby" && /^(Dir[.]chdir|FileUtils[.](cd|chdir))$/.test(nm))
      this.print("C");
    if (ch === "(") {
      const rn = this.py ? runner(cn) : "";
      this.opn("call", ")", nm, rk, rv);
      this.frun[this.nf] = rn;
      this.fcn[this.nf] = cn;
      if (this.py) this.fout[this.nf] = /^(cProfile|profile)[.]run$/.test(cn) ? 2 : /^(cProfile|profile)[.]runctx$/.test(cn) ? 4 : 0;
      this.ip = k + 1;
      return;
    }
    if (ch === "=" && this.at(k + 1) !== "=" && this.d > 0 && this.ftype[this.d] === "call" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
      const t = this.fidAt(this.d);
      if ((this.atok[t] ?? 0) === 0 && !this.aoth[t] && (this.akw[t] ?? "") === "") {
        this.akw[t] = nm;
        this.ip = k + 1;
        if (this.spx === this.d) this.setkey(nm);
        return;
      }
    }
    const role = this.role[this.d] ?? "";
    if (ch === ":" && this.at(k + 1) !== ":" && this.spx && role !== "ign" && (lang === "node" && role === "key" || lang === "ruby" && (this.d === this.spx || role === "key"))) {
      this.setkey(nm);
      this.ip = k + 1;
      return;
    }
    if ((lang === "perl" || lang === "ruby") && k > this.ip && (ch === Q1 || ch === "`" || /["$@A-Za-z_]/.test(ch)) && /^(open|unlink|mkdir|rmdir|rename|link|symlink|copy|move|mkpath|make_path|remove_tree|rmtree|system|exec|spawn|(File|IO|FileUtils|Dir)\.[a-z_]+|File::(Copy|Path)::[a-z_]+)$/.test(
      nm
    )) {
      this.opn("pseudo", "", nm, "", "");
      this.ip = k;
      return;
    }
    if (this.spx && role !== "ign") {
      if (role === "key") {
        if (this.keyrole(nm) !== "ign") this.spbad = 1;
      } else if (/^(True|False|None|true|false|nil|null|undefined)$/.test(nm)) this.satom("K", nm);
      else if (!this.exeset && (this.py && nm === "sys.executable" || lang === "node" && nm === "process.execPath"))
        this.satom("X", this.py ? "python3" : "node");
      else if (this.py && /^(os[.](environ|P_[A-Z]+)|subprocess[.](PIPE|STDOUT|DEVNULL))$/.test(cn)) this.satom("K", cn);
      else this.spbad = 1;
    }
    if (this.py && nm === "lambda" && this.d > 0) {
      const t = this.fidAt(this.d);
      if ((this.atok[t] ?? 0) === 0 && !this.aoth[t]) this.alam[t] = 1;
    }
    const lone = this.d > 0 && (this.py || lang === "node") && (this.atok[this.fidAt(this.d)] ?? 0) === 0 && !this.aoth[this.fidAt(this.d)];
    this.tok("E", "");
    if (lone && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) this.anam[this.fidAt(this.d)] = nm;
    const argv = lone && nm === (this.py ? "sys.argv" : "process.argv") ? /^[ \t]*\[[ \t]*([0-9]+)[ \t]*\][ \t]*[,)]/.exec(substr(this.s, this.ip)) : null;
    if (argv) this.aargv[this.fidAt(this.d)] = `${nm}[${Number(argv[1])}]`;
  }
  scan(program) {
    this.s = program;
    const { s, lang } = this;
    const n = s.length;
    this.prescan();
    while (this.ip <= n && !this.anom) {
      const { ip } = this;
      const c = this.at(ip);
      if (c === " " || c === "	" || c === "\r") {
        this.ip++;
        continue;
      }
      if (c === "\n") {
        if (lang === "ruby" && this.d > 0 && this.ftype[this.d] === "pseudo") {
          const t = this.fidAt(this.d);
          if ((this.atok[t] ?? 0) > 0 || this.aoth[t]) this.endpseudo();
        }
        this.ip++;
        continue;
      }
      if (c === "\\") {
        this.ip += 2;
        continue;
      }
      if (c === "#" && (this.py || (lang === "perl" || lang === "ruby") && (ip === 1 || !/[A-Za-z0-9_$@.#/{(]/.test(this.at(ip - 1)))) || lang === "node" && this.at(ip, 2) === "//") {
        const j = index2(substr(s, ip), "\n");
        if (!j) break;
        this.ip += j - 1;
        continue;
      }
      if (lang === "node" && this.at(ip, 2) === "/*") {
        const j = index2(substr(s, ip + 2), "*/");
        if (!j) {
          this.anom = true;
          break;
        }
        this.ip += j + 3;
        continue;
      }
      if (c === Q1 || c === '"' || c === "`" && !this.py) {
        this.str(c, "");
        continue;
      }
      if (lang === "ruby" && c === "%" && this.at(ip + 1) === "x" && /[\][(){}<>/|!~^]/.test(this.at(ip + 2))) {
        this.qlike(ip + 2);
        continue;
      }
      if (lang === "ruby" && c === ":" && /[A-Za-z_]/.test(this.at(ip + 1)) && this.spx && this.role[this.d] !== "ign") {
        let j = ip + 1;
        while (/[A-Za-z0-9_]/.test(this.at(j))) j++;
        let k = j;
        while (/[ \t\n]/.test(this.at(k))) k++;
        if (this.at(k, 2) === "=>" && (this.d === this.spx || this.role[this.d] === "key")) {
          this.setkey(this.at(ip + 1, j - ip - 1));
          this.ip = k + 2;
        } else {
          this.satom("K", this.at(ip, j - ip));
          this.ip = j;
        }
        this.oth();
        this.pc = 0;
        continue;
      }
      if (/[A-Za-z_]/.test(c) || !this.py && /[$@]/.test(c)) {
        this.name("", "", "");
        continue;
      }
      if (c === "." && /[A-Za-z_]/.test(this.at(ip + 1))) {
        const rk = this.pc ? this.lastk : "U";
        const rv = this.pc ? this.lastv : "";
        this.ip++;
        this.name(rk, rv, rk === "P" || rk === "PE" ? "Path()." : rk === "M" ? rv + "." : "?().");
        continue;
      }
      if (/[0-9]/.test(c)) {
        const j = ip;
        while (this.ip <= n && /[0-9A-Za-z_.]/.test(this.at(this.ip))) this.ip++;
        this.satom("N", this.at(j, this.ip - j));
        this.tok("E", "");
        this.pc = 0;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        this.opn("group", c === "(" ? ")" : c === "[" ? "]" : "}", "", "", "");
        this.ip++;
        this.pc = 0;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        while (this.d > 0 && this.ftype[this.d] === "pseudo") this.endone();
        if (this.d === 0 || this.fclose[this.d] !== c) {
          this.anom = true;
          break;
        }
        this.endone();
        this.pc = 1;
        this.ip++;
        continue;
      }
      if (c === ",") {
        if (this.d > 0 && (this.ftype[this.d] === "call" || this.ftype[this.d] === "pseudo")) this.endarg(this.fidAt(this.d));
        else this.oth();
        if (this.spx) {
          if (this.d === this.spx) {
            this.spai++;
            this.slotstart(this.ip + 1);
          } else if (this.isopt[this.d]) {
            this.role[this.d] = "key";
            this.nat[this.d] = 0;
          } else if (this.role[this.d] === "elem") this.nat[this.d] = 0;
        }
        this.ip++;
        this.pc = 0;
        continue;
      }
      if (c === ";" || this.at(ip, 2) === "||" || this.at(ip, 2) === "&&") {
        this.endpseudo();
        this.oth();
        this.ip += c === ";" ? 1 : 2;
        if (this.spx && this.role[this.d] !== "ign") this.spbad = 1;
        continue;
      }
      if (this.spx && this.role[this.d] !== "ign") this.spbad = 1;
      this.oth();
      this.pc = 0;
      this.ip++;
    }
    if (!this.anom) this.endpseudo();
    if (this.anom || this.d > 0) this.print("A");
    return this.out;
  }
};
function sqt(v) {
  return Q1 + v.split(Q1).join(`${Q1}\\${Q1}${Q1}`) + Q1;
}
function unesc(v) {
  let o = "";
  let i2;
  while ((i2 = index2(v, "\\")) > 0) {
    let ch = substr(v, i2 + 1, 1);
    if (ch === "n") ch = "\n";
    else if (ch === "t") ch = "	";
    else if (ch === "\n") ch = "";
    else if (ch !== "\\" && ch !== Q1 && ch !== '"') return "";
    o += substr(v, 1, i2 - 1) + ch;
    v = substr(v, i2 + 2);
  }
  return o + v;
}
function pyesc(v) {
  let i2;
  while ((i2 = index2(v, "\\")) > 0) {
    const ch = substr(v, i2 + 1, 1);
    if (/[xuU0-7]/.test(ch) || ch === "N" && substr(v, i2 + 2, 1) === "{") return true;
    v = substr(v, i2 + 2);
  }
  return false;
}
function runner(cn) {
  if (RUNRE.test(cn)) return /^timeit[.]/.test(cn) ? "t" : "c";
  if (/^((builtins|__builtins__)[.])?compile$/.test(cn)) return "c";
  return "";
}
function wmode(m) {
  const x = m.replace(/[:|].*$/s, "");
  return /^[rwxabtUs+]+$/.test(x) && /[wax+]/.test(x);
}
function wkind(last, pre) {
  if (last === "open" || last === "openSync") return "open";
  if (last === "truncate" && /(^|[.:])(os|fs|fsp|promises|File)$/.test(pre)) return "trunc";
  if (last === "ZipFile" || last === "PyZipFile") return "zip";
  if (/^(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|rmSync|rmdirSync|unlinkSync|truncateSync|makedirs|removedirs|rmtree|mkdtemp|mkdtempSync|mkfifo|mkpath|make_path|remove_tree|mkdir_p|rm_rf|rm_r|rm_f|dump_stats)$/.test(
    last
  ))
    return "p1";
  if ((last === "write" || last === "binwrite") && /(^|[.:])(File|IO)$/.test(pre)) return "fw";
  if (last === "write_text" || last === "write_bytes") return "wt";
  if (/^(mkdir|rmdir|unlink|rm|touch)$/.test(last) || last === "remove" && /(^|\.)os$/.test(pre) || last === "delete" && /(^|[.:])File$/.test(pre))
    return "pn";
  if (/^(copyFileSync|cpSync|copyFile|copyfile|copy2|copytree|symlinkSync|linkSync|symlink|link)$/.test(last) || /^(copy|cp|cp_r)$/.test(last) && (pre === "" || /(^|[.:])(shutil|fs|fsp|promises|\?\(\)|FileUtils|Copy)$/.test(pre)))
    return "dst";
  if (/^(renameSync|rename|renames)$/.test(last) || last === "replace" && /(^|\.)os$/.test(pre) || /^(move|mv)$/.test(last) && (pre === "" || /(^|[.:])(shutil|FileUtils|Copy)$/.test(pre)))
    return "mv";
  return "";
}
function progCalls(lang, program) {
  const bytes = Buffer.from(program, "utf8").toString("latin1");
  const out2 = new Scanner(lang).scan(bytes);
  if (out2.length === 0) return [];
  return Buffer.from(out2.join("\n"), "latin1").toString("utf8").split("\n");
}
function judgedCall(lang, name3) {
  const at = name3.lastIndexOf(".");
  return wkind(name3.slice(at + 1), at < 0 ? "" : name3.slice(0, at)) !== "" || new Scanner(lang).isproc(name3);
}

// src/hooks/cmd-analysis/prove.ts
import { builtinModules } from "node:module";
var PY_SAFE_BUILTINS = /* @__PURE__ */ new Set([
  "print",
  "len",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "sorted",
  "min",
  "max",
  "sum",
  "range",
  "enumerate",
  "zip",
  "map",
  "filter",
  "any",
  "all",
  "repr",
  "isinstance"
]);
var PY_BUILTINS = /* @__PURE__ */ new Set([
  ...PY_SAFE_BUILTINS,
  "abs",
  "aiter",
  "anext",
  "ascii",
  "bin",
  "breakpoint",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "copyright",
  "credits",
  "delattr",
  "dir",
  "divmod",
  "eval",
  "exec",
  "exit",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "help",
  "hex",
  "id",
  "input",
  "issubclass",
  "iter",
  "license",
  "locals",
  "memoryview",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "property",
  "quit",
  "reversed",
  "round",
  "setattr",
  "slice",
  "staticmethod",
  "super",
  "type",
  "vars",
  "__import__",
  "__build_class__"
]);
var PY_READ_MODES = /* @__PURE__ */ new Set(["r", "rb", "rt"]);
var PY_SAFE_CALLS = /* @__PURE__ */ new Set(["json.load", "json.loads", "json.dumps", "os.listdir", "os.getcwd"]);
var PY_SAFE_MODULES = {
  re: {
    names: /* @__PURE__ */ new Set([
      "compile",
      "search",
      "match",
      "fullmatch",
      "split",
      "findall",
      "finditer",
      "sub",
      "subn",
      "escape",
      "purge",
      "error",
      "PatternError",
      "Pattern",
      "Match",
      "RegexFlag",
      "NOFLAG",
      "ASCII",
      "A",
      "IGNORECASE",
      "I",
      "LOCALE",
      "L",
      "MULTILINE",
      "M",
      "DOTALL",
      "S",
      "VERBOSE",
      "X",
      "UNICODE",
      "U",
      "DEBUG"
    ])
  },
  "os.path": {
    names: /* @__PURE__ */ new Set([
      "abspath",
      "basename",
      "commonpath",
      "commonprefix",
      "dirname",
      "exists",
      "lexists",
      "expanduser",
      "expandvars",
      "getatime",
      "getctime",
      "getmtime",
      "getsize",
      "isabs",
      "isdir",
      "isfile",
      "islink",
      "ismount",
      "isjunction",
      "isdevdrive",
      "isreserved",
      "join",
      "normcase",
      "normpath",
      "realpath",
      "relpath",
      "samefile",
      "sameopenfile",
      "samestat",
      "split",
      "splitdrive",
      "splitext",
      "splitroot",
      "curdir",
      "pardir",
      "sep",
      "altsep",
      "extsep",
      "pathsep",
      "defpath",
      "devnull",
      "supports_unicode_filenames"
    ])
  },
  collections: {
    names: /* @__PURE__ */ new Set(["ChainMap", "Counter", "OrderedDict", "UserDict", "UserList", "UserString", "defaultdict", "deque", "namedtuple"]),
    deep: /* @__PURE__ */ new Set(["ChainMap", "Counter", "OrderedDict", "defaultdict", "deque"])
  },
  itertools: {
    names: /* @__PURE__ */ new Set([
      "accumulate",
      "batched",
      "chain",
      "combinations",
      "combinations_with_replacement",
      "compress",
      "count",
      "cycle",
      "dropwhile",
      "filterfalse",
      "groupby",
      "islice",
      "pairwise",
      "permutations",
      "product",
      "repeat",
      "starmap",
      "takewhile",
      "tee",
      "zip_longest"
    ]),
    deep: /* @__PURE__ */ new Set(["chain"])
  },
  math: { names: "*" },
  datetime: {
    names: /* @__PURE__ */ new Set(["date", "datetime", "time", "timedelta", "timezone", "tzinfo", "MINYEAR", "MAXYEAR", "UTC"]),
    deep: /* @__PURE__ */ new Set(["date", "datetime", "time", "timedelta", "timezone"])
  }
};
var PY_JSON_NAMES = /* @__PURE__ */ new Set(["load", "loads", "dump", "dumps", "JSONDecoder", "JSONEncoder", "JSONDecodeError"]);
var PY_SAFE_STREAMS = /* @__PURE__ */ new Set(["sys.argv", "sys.stdin", "sys.stdout", "sys.stderr", "os.environ"]);
var publicName = (p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p);
function safeModuleMember(q) {
  for (const [mod, { names, deep }] of Object.entries(PY_SAFE_MODULES)) {
    if (!q.startsWith(`${mod}.`)) continue;
    const [name3, attr, ...more] = q.slice(mod.length + 1).split(".");
    if (more.length > 0 || !publicName(name3) || names !== "*" && !names.has(name3)) return false;
    return attr === void 0 || deep?.has(name3) === true && publicName(attr);
  }
  return false;
}
function pySafeValue(q) {
  if (Object.hasOwn(PY_SAFE_MODULES, q) || q === "json" || safeModuleMember(q)) return true;
  const parts2 = q.split(".");
  if (parts2[0] === "json") return parts2.length === 2 && PY_JSON_NAMES.has(parts2[1]);
  const stream = parts2.slice(0, 2).join(".");
  return PY_SAFE_STREAMS.has(stream) && parts2.slice(2).every(publicName);
}
var PY_PATH = /* @__PURE__ */ new Set(["pathlib.Path", "pathlib.PurePath"]);
var PY_METHODS = /* @__PURE__ */ new Set([
  "strip",
  "split",
  "rsplit",
  "join",
  "get",
  "items",
  "keys",
  "values",
  "lower",
  "upper",
  "startswith",
  "endswith",
  "read",
  "readlines",
  "format",
  "count",
  "find",
  "append",
  "extend",
  "write",
  "writelines",
  "close",
  "flush"
]);
var PY_DUNDERS = /* @__PURE__ */ new Set(["__name__", "__file__", "__doc__"]);
var PY_UNPROVEN = /* @__PURE__ */ new Set([
  "class_definition",
  "decorated_definition",
  "decorator",
  "exec_statement",
  "print_statement",
  "match_statement",
  "wildcard_import",
  "relative_import",
  "type_alias_statement"
]);
var JSON_HOOKS = ["object_hook", "object_pairs_hook", "parse_float", "parse_int", "parse_constant", "cls", "default"];
var PY_CALLBACKS = {
  map: { pos: [0], kw: [] },
  filter: { pos: [0], kw: [] },
  sorted: { pos: [], kw: ["key"] },
  min: { pos: [], kw: ["key"] },
  max: { pos: [], kw: ["key"] },
  "re.sub": { pos: [1], kw: ["repl"] },
  "re.subn": { pos: [1], kw: ["repl"] },
  "json.load": { pos: [], kw: JSON_HOOKS },
  "json.loads": { pos: [], kw: JSON_HOOKS },
  "json.dumps": { pos: [], kw: JSON_HOOKS },
  "collections.defaultdict": { pos: [0], kw: ["default_factory"] },
  "itertools.accumulate": { pos: [1], kw: ["func"] },
  "itertools.starmap": { pos: [0], kw: [] },
  "itertools.filterfalse": { pos: [0], kw: [] },
  "itertools.takewhile": { pos: [0], kw: [] },
  "itertools.dropwhile": { pos: [0], kw: [] },
  "itertools.groupby": { pos: [1], kw: ["key"] }
};
var JS_SAFE_GLOBAL_CALLS = /* @__PURE__ */ new Set(["parseInt", "parseFloat", "Number", "String"]);
var JS_SAFE_GLOBALS = /* @__PURE__ */ new Set([
  ...JS_SAFE_GLOBAL_CALLS,
  "console",
  "JSON",
  "Math",
  "Object",
  "Array",
  "undefined",
  "NaN",
  "Infinity",
  "Map",
  "Set",
  "Date",
  "RegExp",
  "Error"
]);
var JS_NEW = /* @__PURE__ */ new Set(["Map", "Set", "Array", "Date", "RegExp", "Error"]);
var JS_ROOTS = /* @__PURE__ */ new Set(["console", "JSON", "Math", "Object", "process", "Array", "String", "Number"]);
var JS_SAFE_CALLS = /* @__PURE__ */ new Set([
  "Object.keys",
  "Object.values",
  "Object.entries",
  "fs.readFileSync",
  "fs.existsSync",
  "fs.readdirSync",
  "fs.statSync",
  "process.stdout.write",
  "process.stderr.write"
]);
var JS_SAFE_ROOT_CALL = /^(console|JSON|Math)\./;
var JS_SAFE_VALUE = /^process\.(argv|env|stdout|stderr|version|versions|platform|arch)(\.|$)/;
var JS_METHODS = /* @__PURE__ */ new Set([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "values",
  "toSorted",
  "toReversed",
  "toString",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "endsWith",
  "localeCompare",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "search",
  "split",
  "startsWith",
  "substring",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "write",
  "end",
  "close"
]);
var JS_CALLBACK_METHODS = /* @__PURE__ */ new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "toSorted"
]);
var JS_UNPROVEN = /* @__PURE__ */ new Set(["class_declaration", "class", "import_statement", "export_statement", "with_statement", "import"]);
var JS_HIDDEN = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__"]);
var SCRIPT_WORDS = /* @__PURE__ */ new Set([
  "print",
  "printf",
  "say",
  "puts",
  "p",
  "split",
  "join",
  "chomp",
  "chop",
  "lc",
  "uc",
  "length",
  "substr",
  "sprintf",
  "sort",
  "keys",
  "values",
  "reverse",
  "map",
  "grep",
  "my",
  "our",
  "if",
  "unless",
  "for",
  "foreach",
  "while",
  "ARGV",
  "upcase",
  "downcase",
  "STDIN",
  "STDOUT",
  "STDERR",
  "else",
  "elsif",
  "until",
  "and",
  "or",
  "not",
  "xor",
  "eq",
  "ne",
  "lt",
  "gt",
  "le",
  "ge",
  "cmp",
  "x",
  "last",
  "next",
  "do",
  "end",
  "then",
  "nil",
  "true",
  "false",
  "in",
  "BEGIN",
  "END",
  "write",
  "close",
  "sleep"
]);
var Bindings = class {
  map = /* @__PURE__ */ new Map();
  add(name3, bind) {
    const list = this.map.get(name3);
    if (list) list.push(bind);
    else this.map.set(name3, [bind]);
  }
  resolve(name3) {
    const list = this.map.get(name3);
    if (!list) return void 0;
    if (list.every((b) => b.kind === "import" && b.q === list[0].q)) return list[0];
    if (list.every((b) => b.kind === "def")) return list[0];
    return { kind: "local" };
  }
};
var kids = (node) => node.namedChildren.filter((c) => c !== null);
var field = (node, name3) => node.childForFieldName(name3);
function chain(node, type, object, property) {
  const parts2 = [];
  let at = node;
  while (at.type === type) {
    const prop = field(at, property);
    const obj = field(at, object);
    if (!prop || !obj) break;
    parts2.unshift(prop.text);
    at = obj;
  }
  return { root: at, parts: parts2 };
}
var Proof = class {
  binds = new Bindings();
  ok = true;
  judged = false;
  fail() {
    this.ok = false;
  }
};
function pyLiteral(node) {
  if (!node || node.type !== "string") return void 0;
  if (kids(node).some((c) => c.type === "interpolation")) return void 0;
  const m = /^(['"])([^'"\\]*)\1$/.exec(node.text);
  return m?.[2];
}
var PyProof = class extends Proof {
  bindTargets(node) {
    switch (node.type) {
      case "identifier":
        this.binds.add(node.text, { kind: "local" });
        return;
      case "subscript":
      case "attribute":
        return;
      default:
        for (const c of kids(node)) this.bindTargets(c);
    }
  }
  bindParams(node) {
    for (const p of kids(node)) {
      if (p.type === "identifier") this.binds.add(p.text, { kind: "local" });
      else if (p.type === "default_parameter" || p.type === "typed_default_parameter") {
        const name3 = field(p, "name");
        if (name3) this.bindTargets(name3);
      } else if (p.type === "typed_parameter" || p.type === "list_splat_pattern" || p.type === "dictionary_splat_pattern") {
        for (const c of kids(p)) if (c.type === "identifier") this.binds.add(c.text, { kind: "local" });
      } else this.bindTargets(p);
    }
  }
  collect(node) {
    switch (node.type) {
      case "import_statement":
        for (const name3 of node.childrenForFieldName("name")) {
          if (!name3) continue;
          if (name3.type === "aliased_import") {
            const alias = field(name3, "alias");
            const dotted = field(name3, "name");
            if (alias && dotted) this.binds.add(alias.text, { kind: "import", q: dotted.text.replace(/\s+/g, "") });
          } else {
            const top = name3.text.replace(/\s+/g, "").split(".")[0];
            this.binds.add(top, { kind: "import", q: top });
          }
        }
        return;
      case "import_from_statement": {
        const mod = field(node, "module_name");
        if (!mod || mod.type !== "dotted_name") {
          this.fail();
          return;
        }
        const base = mod.text.replace(/\s+/g, "");
        for (const name3 of node.childrenForFieldName("name")) {
          if (!name3) continue;
          const dotted = name3.type === "aliased_import" ? field(name3, "name") : name3;
          const alias = name3.type === "aliased_import" ? field(name3, "alias") : name3;
          if (dotted && alias) this.binds.add(alias.text, { kind: "import", q: `${base}.${dotted.text.replace(/\s+/g, "")}` });
        }
        return;
      }
      case "function_definition": {
        const name3 = field(node, "name");
        if (name3) this.binds.add(name3.text, { kind: "def" });
        const params = field(node, "parameters");
        if (params) this.bindParams(params);
        break;
      }
      case "lambda": {
        const params = field(node, "parameters");
        if (params) this.bindParams(params);
        break;
      }
      case "assignment": {
        const left = field(node, "left");
        const right = field(node, "right");
        if (left?.type === "identifier" && right?.type === "lambda") this.binds.add(left.text, { kind: "def" });
        else if (left) this.bindTargets(left);
        break;
      }
      case "augmented_assignment":
      case "for_statement":
      case "for_in_clause": {
        const left = field(node, "left");
        if (left) this.bindTargets(left);
        break;
      }
      case "named_expression": {
        const name3 = field(node, "name");
        if (name3) this.bindTargets(name3);
        break;
      }
      case "as_pattern_target":
        this.bindTargets(node);
        return;
      case "delete_statement":
        for (const c of kids(node)) this.bindTargets(c);
        break;
    }
    for (const c of kids(node)) this.collect(c);
  }
  safeValue(q) {
    return pySafeValue(q);
  }
  safeCall(q) {
    if (PY_SAFE_CALLS.has(q) || safeModuleMember(q)) return true;
    const at = q.lastIndexOf(".");
    const last = q.slice(at + 1);
    return at > 0 && last !== "replace" && PY_METHODS.has(last) && this.safeValue(q.slice(0, at)) && q.slice(0, at).includes(".");
  }
  qualified(root, parts2) {
    if (root.type !== "identifier") return void 0;
    const b = this.binds.resolve(root.text);
    return b?.kind === "import" ? [b.q, ...parts2].join(".") : void 0;
  }
  dunder(name3) {
    return /^__.*__$/.test(name3) && !PY_DUNDERS.has(name3);
  }
  name(node) {
    const name3 = node.text;
    if (this.dunder(name3)) return this.fail();
    const b = this.binds.resolve(name3);
    if (b?.kind === "import") {
      if (!this.safeValue(b.q) && !this.safeCall(b.q)) this.fail();
    } else if (!b && PY_BUILTINS.has(name3) && (!PY_SAFE_BUILTINS.has(name3) || name3 === "open")) this.fail();
  }
  attribute(node) {
    const { root, parts: parts2 } = chain(node, "attribute", "object", "attribute");
    if (parts2.some((p) => this.dunder(p))) return this.fail();
    const q = this.qualified(root, parts2);
    if (q !== void 0) {
      if (!this.safeValue(q) && !this.safeCall(q)) this.fail();
      return;
    }
    this.visit(root);
  }
  /** Whether a node in a position the call calls back is a function the proof follows. */
  callback(node) {
    if (node.type === "lambda") return true;
    if (node.type === "identifier") {
      const b = this.binds.resolve(node.text);
      if (b?.kind === "def") return true;
      if (b?.kind === "import") return this.safeCall(b.q);
      if (b) return false;
      return PY_SAFE_BUILTINS.has(node.text) && node.text !== "open" || !PY_BUILTINS.has(node.text) && !this.dunder(node.text);
    }
    if (node.type === "attribute") {
      const { root, parts: parts2 } = chain(node, "attribute", "object", "attribute");
      const q = this.qualified(root, parts2);
      if (q !== void 0) return this.safeCall(q);
      return root.type === "identifier" && !this.binds.resolve(root.text) && PY_SAFE_BUILTINS.has(root.text) && parts2.length === 1 && PY_METHODS.has(parts2[0]);
    }
    return false;
  }
  openMode(args2) {
    const list = args2 ? kids(args2) : [];
    const kw = list.find((a) => a.type === "keyword_argument" && field(a, "name")?.text === "mode");
    const positional = list.filter((a) => a.type !== "keyword_argument");
    if (list.some((a) => a.type === "list_splat" || a.type === "dictionary_splat")) this.judged = true;
    const mode = kw ? field(kw, "value") : positional[1] ?? null;
    if (mode && !PY_READ_MODES.has(pyLiteral(mode) ?? "")) this.judged = true;
  }
  call(node) {
    const fn = field(node, "function");
    const args2 = field(node, "arguments");
    let callee;
    if (!fn) return this.fail();
    if (fn.type === "identifier") {
      const name3 = fn.text;
      const b = this.binds.resolve(name3);
      if (this.dunder(name3)) return this.fail();
      if (b?.kind === "import") {
        callee = b.q;
        if (!this.safeCall(b.q) && !PY_PATH.has(b.q)) {
          if (judgedCall("py", b.q)) this.judged = true;
          else return this.fail();
        }
      } else if (b?.kind === "local") return this.fail();
      else if (!b) {
        if (name3 === "open") this.openMode(args2);
        else if (PY_SAFE_BUILTINS.has(name3)) callee = name3;
        else if (PY_BUILTINS.has(name3)) return this.fail();
      }
    } else if (fn.type === "attribute") {
      const { root, parts: parts2 } = chain(fn, "attribute", "object", "attribute");
      if (parts2.some((p) => this.dunder(p))) return this.fail();
      const q = this.qualified(root, parts2);
      const last = parts2[parts2.length - 1];
      if (q !== void 0) {
        callee = q;
        if (!this.safeCall(q) && !PY_PATH.has(q)) {
          if (judgedCall("py", q)) this.judged = true;
          else return this.fail();
        }
      } else {
        this.visit(root);
        const literal = root.type === "string" && parts2.length === 1;
        const pre = root.type === "identifier" ? [root.text, ...parts2.slice(0, -1)].join(".") : "?";
        if (last === "replace" ? !literal : !PY_METHODS.has(last)) {
          if (judgedCall("py", `${pre}.${last}`)) this.judged = true;
          else return this.fail();
        }
      }
    } else return this.fail();
    if (!args2) return;
    const back = callee !== void 0 ? PY_CALLBACKS[callee] : void 0;
    let pos = 0;
    for (const a of kids(args2)) {
      if (a.type === "keyword_argument") {
        const value = field(a, "value");
        if (back && value && back.kw.includes(field(a, "name")?.text ?? "") && !this.callback(value)) this.fail();
        if (value) this.visit(value);
        continue;
      }
      if (back && (a.type === "list_splat" || a.type === "dictionary_splat")) this.fail();
      if (back?.pos.includes(pos) && !this.callback(a)) this.fail();
      pos++;
      this.visit(a);
    }
  }
  /** An assignment or `del` target: a name binds, a subscript of a local name is checked, anything else is unproven. */
  target(node) {
    switch (node.type) {
      case "identifier":
        return;
      case "subscript": {
        const base = field(node, "value");
        if (base?.type !== "identifier" || this.binds.resolve(base.text)?.kind !== "local") return this.fail();
        for (const s of node.childrenForFieldName("subscript")) if (s) this.visit(s);
        return;
      }
      case "attribute":
        return this.fail();
      default:
        for (const c of kids(node)) this.target(c);
    }
  }
  visit(node) {
    if (!this.ok) return;
    if (node.isError || node.isMissing || PY_UNPROVEN.has(node.type)) return this.fail();
    switch (node.type) {
      case "import_statement":
      case "import_from_statement":
      case "future_import_statement":
      case "global_statement":
      case "nonlocal_statement":
        return;
      case "identifier":
        return this.name(node);
      case "attribute":
        return this.attribute(node);
      case "call":
        return this.call(node);
      case "keyword_argument": {
        const value = field(node, "value");
        if (value) this.visit(value);
        return;
      }
      case "assignment":
      case "augmented_assignment": {
        const left = field(node, "left");
        if (left) this.target(left);
        for (const f of ["type", "right"]) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case "for_statement":
      case "for_in_clause": {
        const left = field(node, "left");
        if (left) this.target(left);
        for (const c of kids(node)) if (c !== left) this.visit(c);
        return;
      }
      case "as_pattern_target":
      case "delete_statement":
        for (const c of kids(node)) this.target(c);
        return;
      case "named_expression": {
        const value = field(node, "value");
        if (value) this.visit(value);
        return;
      }
      case "function_definition": {
        for (const f of ["parameters", "return_type", "body"]) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case "default_parameter":
      case "typed_default_parameter": {
        for (const f of ["type", "value"]) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
    }
    for (const c of kids(node)) this.visit(c);
  }
};
function requiredModule(node) {
  if (node.type !== "call_expression" || field(node, "function")?.text !== "require") return void 0;
  const args2 = field(node, "arguments");
  const list = args2 ? kids(args2) : [];
  if (list.length !== 1 || list[0].type !== "string") return void 0;
  const lit = list[0].text.slice(1, -1);
  if (/[\\'"]/.test(lit)) return void 0;
  const bare = lit.replace(/^node:/, "");
  if (builtinModules.includes(bare)) return bare;
  return /^(\.{0,2}\/).*\.json$/.test(lit) ? lit : void 0;
}
var JsProof = class extends Proof {
  bindPattern(node, kind = { kind: "local" }) {
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        this.binds.add(node.text, kind);
        return;
      case "member_expression":
      case "subscript_expression":
        return;
      case "assignment_pattern": {
        const left = field(node, "left");
        if (left) this.bindPattern(left);
        return;
      }
      case "pair_pattern": {
        const value = field(node, "value");
        if (value) this.bindPattern(value);
        return;
      }
      default:
        for (const c of kids(node)) this.bindPattern(c);
    }
  }
  /** The module path a declaration's value names: `require('<m>')` or a member chain on one. */
  moduleOf(value) {
    if (!value) return void 0;
    const { root, parts: parts2 } = chain(value, "member_expression", "object", "property");
    const mod = requiredModule(root);
    return mod === void 0 ? void 0 : [mod, ...parts2].join(".");
  }
  collect(node) {
    switch (node.type) {
      case "variable_declarator": {
        const name3 = field(node, "name");
        const value = field(node, "value");
        const mod = this.moduleOf(value);
        if (!name3) break;
        if (mod !== void 0 && name3.type === "identifier") this.binds.add(name3.text, { kind: "import", q: mod });
        else if (mod !== void 0 && name3.type === "object_pattern") {
          for (const p of kids(name3)) {
            if (p.type === "shorthand_property_identifier_pattern") this.binds.add(p.text, { kind: "import", q: `${mod}.${p.text}` });
            else if (p.type === "pair_pattern" && field(p, "value")?.type === "identifier" && field(p, "key")?.type === "property_identifier") {
              this.binds.add(field(p, "value").text, { kind: "import", q: `${mod}.${field(p, "key").text}` });
            } else this.bindPattern(p);
          }
        } else if (name3.type === "identifier" && (value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function")) {
          this.binds.add(name3.text, { kind: "def" });
        } else this.bindPattern(name3);
        break;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name3 = field(node, "name");
        if (name3) this.binds.add(name3.text, { kind: "def" });
        break;
      }
      case "formal_parameters":
        for (const c of kids(node)) this.bindPattern(c);
        break;
      case "arrow_function": {
        const param = field(node, "parameter");
        if (param) this.bindPattern(param);
        break;
      }
      case "assignment_expression":
      case "augmented_assignment_expression":
      case "for_in_statement": {
        const left = field(node, "left");
        if (left) this.bindPattern(left);
        break;
      }
      case "update_expression": {
        const arg = field(node, "argument");
        if (arg) this.bindPattern(arg);
        break;
      }
      case "catch_clause": {
        const param = field(node, "parameter");
        if (param) this.bindPattern(param);
        break;
      }
    }
    for (const c of kids(node)) this.collect(c);
  }
  safeCall(q) {
    if (JS_SAFE_CALLS.has(q) || JS_SAFE_ROOT_CALL.test(q)) return true;
    const at = q.lastIndexOf(".");
    return at > 0 && JS_METHODS.has(q.slice(at + 1)) && JS_SAFE_VALUE.test(q.slice(0, at));
  }
  /** The dotted name of a chain rooted at a module alias, a literal require or a known global. */
  qualified(root, parts2) {
    const mod = requiredModule(root);
    if (mod !== void 0) return [mod, ...parts2].join(".");
    if (root.type !== "identifier") return void 0;
    const b = this.binds.resolve(root.text);
    if (b?.kind === "import") return [b.q, ...parts2].join(".");
    if (!b && JS_ROOTS.has(root.text)) return [root.text, ...parts2].join(".");
    return void 0;
  }
  name(node) {
    const b = this.binds.resolve(node.text);
    if (b?.kind === "import") this.fail();
    else if (!b && !JS_SAFE_GLOBALS.has(node.text)) this.fail();
  }
  member(node) {
    const { root, parts: parts2 } = chain(node, "member_expression", "object", "property");
    if (parts2.some((p) => JS_HIDDEN.has(p))) return this.fail();
    const q = this.qualified(root, parts2);
    if (q !== void 0) {
      if (root.type === "call_expression") this.visit(root);
      if (!JS_SAFE_VALUE.test(q) && !this.safeCall(q) && !/^(console|JSON|Math|Object|Array|String|Number)\./.test(q) && !/\.json(\.|$)/.test(q)) this.fail();
      return;
    }
    this.visit(root);
  }
  callback(node) {
    if (node.type === "arrow_function" || node.type === "function_expression" || node.type === "function") return true;
    if (node.type === "identifier") {
      const b = this.binds.resolve(node.text);
      if (b?.kind === "def") return true;
      return !b && JS_SAFE_GLOBAL_CALLS.has(node.text);
    }
    if (node.type === "member_expression") {
      const { root, parts: parts2 } = chain(node, "member_expression", "object", "property");
      const q = this.qualified(root, parts2);
      return q !== void 0 && this.safeCall(q);
    }
    return false;
  }
  /** A member assignment, update or delete target: only a property of a local name. */
  target(node) {
    if (node.type !== "member_expression" && node.type !== "subscript_expression") return this.visit(node);
    let root = node;
    while (root.type === "member_expression" || root.type === "subscript_expression") root = field(root, "object") ?? root;
    if (root.type !== "identifier" || this.binds.resolve(root.text)?.kind !== "local") return this.fail();
    for (const c of kids(node)) this.visit(c);
  }
  call(node) {
    const fn = field(node, "function");
    const args2 = field(node, "arguments");
    if (!fn) return this.fail();
    let callee;
    let method = "";
    if (fn.type === "identifier") {
      const name3 = fn.text;
      const b = this.binds.resolve(name3);
      if (name3 === "require" && !b) {
        if (requiredModule(node) === void 0) this.fail();
        return;
      }
      if (b?.kind === "import") {
        callee = b.q;
        if (!this.safeCall(b.q)) {
          if (judgedCall("node", b.q)) this.judged = true;
          else return this.fail();
        }
      } else if (b?.kind === "local") return this.fail();
      else if (!b) {
        if (JS_SAFE_GLOBAL_CALLS.has(name3)) callee = name3;
        else if (judgedCall("node", name3)) this.judged = true;
        else return this.fail();
      }
    } else if (fn.type === "member_expression") {
      const { root, parts: parts2 } = chain(fn, "member_expression", "object", "property");
      if (parts2.some((p) => JS_HIDDEN.has(p))) return this.fail();
      const q = this.qualified(root, parts2);
      method = parts2[parts2.length - 1];
      if (q !== void 0) {
        if (root.type === "call_expression") this.visit(root);
        callee = q;
        if (!this.safeCall(q)) {
          if (judgedCall("node", q)) this.judged = true;
          else return this.fail();
        }
      } else {
        this.visit(root);
        const pre = root.type === "identifier" ? [root.text, ...parts2.slice(0, -1)].join(".") : "?()";
        if (!JS_METHODS.has(method)) {
          if (judgedCall("node", `${pre}.${method}`)) this.judged = true;
          else return this.fail();
        }
      }
    } else return this.fail();
    if (!args2) return;
    const list = args2.type === "template_string" ? [args2] : kids(args2);
    const at = callee === "JSON.parse" || callee === "JSON.stringify" || method === "replace" || method === "replaceAll" ? 1 : JS_CALLBACK_METHODS.has(method) ? 0 : -1;
    if (at >= 0 && list.some((a) => a.type === "spread_element")) this.fail();
    list.forEach((a, i2) => {
      if (i2 === at && !this.callback(a) && !(method.startsWith("replace") && a.type !== "arrow_function" && a.type !== "identifier" && a.type !== "member_expression" && a.type !== "function_expression" && a.type !== "call_expression" && a.type !== "subscript_expression")) this.fail();
      this.visit(a);
    });
  }
  visit(node) {
    if (!this.ok) return;
    if (node.isError || node.isMissing || JS_UNPROVEN.has(node.type)) return this.fail();
    switch (node.type) {
      case "identifier":
        return this.name(node);
      case "shorthand_property_identifier":
        return this.name(node);
      case "property_identifier":
      case "shorthand_property_identifier_pattern":
      case "statement_identifier":
        return;
      case "member_expression":
        return this.member(node);
      case "call_expression":
        return this.call(node);
      case "new_expression": {
        const ctor = field(node, "constructor");
        if (ctor?.type !== "identifier" || this.binds.resolve(ctor.text) || !JS_NEW.has(ctor.text)) return this.fail();
        const args2 = field(node, "arguments");
        if (args2) this.visit(args2);
        return;
      }
      case "variable_declarator": {
        const value = field(node, "value");
        if (value) this.visit(value);
        const name3 = field(node, "name");
        if (name3 && name3.type !== "identifier") this.pattern(name3);
        return;
      }
      case "assignment_expression":
      case "augmented_assignment_expression": {
        const left = field(node, "left");
        if (left?.type === "object_pattern" || left?.type === "array_pattern") this.pattern(left);
        else if (left && left.type !== "identifier") this.target(left);
        const right = field(node, "right");
        if (right) this.visit(right);
        return;
      }
      case "update_expression": {
        const arg = field(node, "argument");
        if (arg && arg.type !== "identifier") this.target(arg);
        return;
      }
      case "unary_expression": {
        const arg = field(node, "argument");
        if (node.child(0)?.type === "delete" && arg) return this.target(arg);
        break;
      }
      case "for_in_statement": {
        const left = field(node, "left");
        if (left && (left.type === "member_expression" || left.type === "subscript_expression")) this.target(left);
        for (const c of kids(node)) if (c !== left) this.visit(c);
        return;
      }
      case "pair": {
        const key2 = field(node, "key");
        if (key2?.type === "computed_property_name") this.visit(key2);
        const value = field(node, "value");
        if (value) this.visit(value);
        return;
      }
      case "formal_parameters":
        return this.pattern(node);
      case "function_declaration":
      case "generator_function_declaration":
      case "function_expression":
      case "function":
      case "arrow_function": {
        for (const f of ["parameters", "body"]) {
          const c = field(node, f);
          if (c) this.visit(c);
        }
        return;
      }
      case "catch_clause": {
        const body2 = field(node, "body");
        if (body2) this.visit(body2);
        return;
      }
    }
    for (const c of kids(node)) this.visit(c);
  }
  /** A binding pattern: only its default values and computed keys are evaluated. */
  pattern(node) {
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        return;
      case "assignment_pattern": {
        const left = field(node, "left");
        const right = field(node, "right");
        if (left) this.pattern(left);
        if (right) this.visit(right);
        return;
      }
      case "pair_pattern": {
        const key2 = field(node, "key");
        if (key2?.type === "computed_property_name") this.visit(key2);
        const value = field(node, "value");
        if (value) this.pattern(value);
        return;
      }
      case "member_expression":
      case "subscript_expression":
        return this.target(node);
      default:
        for (const c of kids(node)) this.pattern(c);
    }
  }
};
var QUOTE_LIKE = /^(q|qq|qw|qr|m|s|tr|y)$/;
var CLOSER = { "(": ")", "[": "]", "{": "}", "<": ">" };
function delimited(src, i2, open) {
  const close = CLOSER[open] ?? open;
  let depth = 1;
  for (let k = i2; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === close && --depth === 0) return k;
    else if (c === open && close !== open) depth++;
  }
  return -1;
}
function runsCode(perl, body2) {
  return perl ? /[@$]\{|\(\?\??\{/.test(body2) : /#\{|\(\?\??\{/.test(body2);
}
function lexScript(perl, src) {
  const out2 = [];
  const termPos = () => {
    const prev = out2[out2.length - 1];
    if (!prev) return true;
    if (prev.t === "w") return true;
    if (prev.t === "p") return !/^[)\]}]$/.test(prev.text);
    return false;
  };
  let i2 = 0;
  while (i2 < src.length) {
    const c = src[i2];
    const rest = src.slice(i2);
    if (/\s/.test(c)) {
      i2++;
      continue;
    }
    if (c === "#") {
      const e = src.indexOf("\n", i2);
      i2 = e < 0 ? src.length : e;
      continue;
    }
    if (c === "`") return void 0;
    if (c === "'" || c === '"') {
      const e = delimited(src, i2 + 1, c);
      if (e < 0) return void 0;
      if (c === '"' && runsCode(perl, src.slice(i2 + 1, e))) return void 0;
      out2.push({ t: "lit", text: src.slice(i2, e + 1) });
      i2 = e + 1;
      continue;
    }
    if (perl && (c === "$" || c === "@" || c === "%")) {
      const m = /^[$@%]#?(\$*)([A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*|\^[A-Z]|[0-9]+|[^\sA-Za-z0-9_{])/.exec(rest);
      if (m && (c !== "%" || termPos())) {
        out2.push({ t: "v", text: m[0] });
        i2 += m[0].length;
        continue;
      }
    }
    if (!perl && (c === "$" || c === "@")) {
      const m = /^(@@?|\$)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\sA-Za-z0-9_{])/.exec(rest);
      if (m) {
        out2.push({ t: "v", text: m[0] });
        i2 += m[0].length;
        continue;
      }
    }
    if (!perl && c === "%" && termPos()) {
      const m = /^%([qQwWiIrsx]?)([^\sA-Za-z0-9_])/.exec(rest);
      if (m) {
        if (m[1] === "x") return void 0;
        const e = delimited(src, i2 + m[0].length, m[2]);
        if (e < 0) return void 0;
        if (/^[QWIr]?$/.test(m[1]) && runsCode(false, src.slice(i2 + m[0].length, e))) return void 0;
        out2.push({ t: "lit", text: src.slice(i2, e + 1) });
        i2 = e + 1;
        continue;
      }
    }
    if (!perl && c === ":" && src[i2 + 1] !== ":" && src[i2 - 1] !== ":") {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*[?!=]?)/.exec(rest);
      if (m) {
        out2.push({ t: "sym", text: m[1] });
        i2 += m[0].length;
        continue;
      }
      if (src[i2 + 1] === '"' || src[i2 + 1] === "'") {
        i2++;
        continue;
      }
    }
    if (/[0-9]/.test(c)) {
      i2 += /^[0-9][A-Za-z0-9_]*(\.[0-9][A-Za-z0-9_]*)*/.exec(rest)[0].length;
      out2.push({ t: "lit", text: "0" });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*[?!]?/.exec(rest)[0];
      const after2 = src.slice(i2 + word.length);
      if (perl && QUOTE_LIKE.test(word) && /^\s*[^\sA-Za-z0-9_,;)=]/.test(after2) && !/^\s*=>/.test(after2)) {
        if (word === "qx") return void 0;
        let k = i2 + word.length;
        while (/\s/.test(src[k] ?? "")) k++;
        const open = src[k];
        let e = delimited(src, k + 1, open);
        if (e < 0) return void 0;
        let body2 = src.slice(k + 1, e);
        if (word === "s" || word === "tr" || word === "y") {
          if (CLOSER[open]) {
            k = e + 1;
            while (/\s/.test(src[k] ?? "")) k++;
            const second = src[k];
            const e2 = delimited(src, k + 1, second);
            if (e2 < 0) return void 0;
            body2 += src.slice(k + 1, e2);
            e = e2;
          } else {
            const e2 = delimited(src, e + 1, open);
            if (e2 < 0) return void 0;
            body2 += src.slice(e + 1, e2);
            e = e2;
          }
        }
        const flags2 = /^[A-Za-z]*/.exec(src.slice(e + 1))[0];
        if (word === "s" && flags2.includes("e")) return void 0;
        if (word !== "q" && word !== "qw" && word !== "tr" && word !== "y" && runsCode(true, body2)) return void 0;
        out2.push({ t: "lit", text: src.slice(i2, e + 1 + flags2.length) });
        i2 = e + 1 + flags2.length;
        continue;
      }
      if (perl && (word === "__END__" || word === "__DATA__")) break;
      out2.push({ t: "w", text: word });
      i2 += word.length;
      continue;
    }
    if (c === "/" && termPos()) {
      const e = delimited(src, i2 + 1, "/");
      if (e < 0) return void 0;
      if (runsCode(perl, src.slice(i2 + 1, e))) return void 0;
      const flags2 = /^[A-Za-z]*/.exec(src.slice(e + 1))[0];
      out2.push({ t: "lit", text: src.slice(i2, e + 1 + flags2.length) });
      i2 = e + 1 + flags2.length;
      continue;
    }
    if (perl && c === "<" && termPos()) {
      const m = /^<(\$?[A-Za-z_][A-Za-z0-9_]*)?>/.exec(rest);
      if (m) {
        out2.push({ t: "lit", text: m[0] });
        i2 += m[0].length;
        continue;
      }
    }
    const op = /^(&&|&\.|->|=>|::|\|\||==|=~|!~|\.\(|.)/s.exec(rest)[0];
    out2.push({ t: "p", text: op });
    i2 += op.length;
  }
  return out2;
}
var member = (t) => t?.t === "p" && (t.text === "." || t.text === "::");
var SLEEP_SELECT = [
  { t: "w", text: "select" },
  { t: "p", text: "(" },
  { t: "w", text: "undef" },
  { t: "p", text: "," },
  { t: "w", text: "undef" },
  { t: "p", text: "," },
  { t: "w", text: "undef" },
  { t: "p", text: "," }
];
function perlSleepSelect(toks, k) {
  if (toks[k - 1]?.text === "->") return 0;
  if (!SLEEP_SELECT.every((s, j) => toks[k + j]?.t === s.t && toks[k + j].text === s.text)) return 0;
  const wait = toks[k + SLEEP_SELECT.length];
  const numeric = wait?.t === "lit" && wait.text === "0";
  const scalar = wait?.t === "v" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(wait.text);
  if (!(numeric || scalar) || toks[k + SLEEP_SELECT.length + 1]?.text !== ")") return 0;
  return SLEEP_SELECT.length + 2;
}
function proveScript(lang, src) {
  const perl = lang === "perl";
  const fail = { ok: false, judged: false };
  const toks = lexScript(perl, src);
  if (!toks) return fail;
  let judged = false;
  const locals = /* @__PURE__ */ new Set();
  if (!perl) {
    toks.forEach((tk, k) => {
      const next = toks[k + 1];
      if (tk.t === "w" && next?.t === "p" && next.text === "=" && toks[k - 1]?.text !== ".") locals.add(tk.text);
    });
    let inPipes = false;
    toks.forEach((tk, k) => {
      if (tk.t === "p" && tk.text === "|" && (inPipes || toks[k - 1]?.text === "{" || toks[k - 1]?.text === "do")) inPipes = !inPipes;
      else if (inPipes && tk.t === "w") locals.add(tk.text);
    });
  }
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (tk.t === "p") {
      if (tk.text === "&" && !(!perl && next?.t === "sym")) return fail;
      if (tk.text === ".(" || tk.text === "&." || tk.text === "->" && (!perl || next?.text === "(" || next?.t === "v")) return fail;
      continue;
    }
    if (tk.t === "v") {
      if (/^[$@]ARGV$/.test(tk.text)) {
        let j = k + 1;
        if (toks[j]?.text === "[" || toks[j]?.text === "{") {
          let depth = 0;
          for (; j < toks.length; j++) {
            if (toks[j].text === "[" || toks[j].text === "{") depth++;
            else if ((toks[j].text === "]" || toks[j].text === "}") && --depth === 0) break;
          }
          j++;
        }
        if (toks[j]?.text === "=" || toks[j]?.t === "p" && /^[.+\-*/x|&^]$/.test(toks[j].text) && toks[j + 1]?.text === "=") return fail;
      }
      continue;
    }
    if (tk.t === "lit" || tk.t === "sym" && prev?.text !== "&") continue;
    const name3 = tk.text;
    if (tk.t === "w" && next?.text === "=>") continue;
    if (tk.t === "w" && prev?.text === "{" && next?.text === "}") continue;
    if (!perl && tk.t === "w" && next?.text === ":") continue;
    if (!perl && tk.t === "w" && locals.has(name3) && !member(prev)) continue;
    if (!perl && tk.t === "w" && /^[A-Z]/.test(name3) && member(next) && toks[k + 2]?.t === "w") continue;
    if (!perl && name3 === "ARGV" && next?.text === "[") {
      let j = k + 1;
      let depth = 0;
      for (; j < toks.length; j++) {
        if (toks[j].text === "[") depth++;
        else if (toks[j].text === "]" && --depth === 0) break;
      }
      if (toks[j + 1]?.text === "=") return fail;
    }
    if (SCRIPT_WORDS.has(name3)) continue;
    const sleep = perl ? perlSleepSelect(toks, k) : 0;
    if (sleep) {
      k += sleep - 1;
      continue;
    }
    let dotted = name3;
    for (let j = k; !perl && member(toks[j - 1]) && toks[j - 2]?.t === "w"; j -= 2) dotted = `${toks[j - 2].text}.${dotted}`;
    if (!judgedCall(lang, dotted.replace(/::/g, "."))) return fail;
    judged = true;
  }
  return { ok: true, judged };
}
function proveProgram(lang, program, scanned) {
  if (lang === "perl" || lang === "ruby") {
    const proof = proveScript(lang, program);
    return proof.ok && (!proof.judged || scanned.includes("W"));
  }
  const parser2 = programParser(lang === "py" ? "python" : "javascript");
  if (!parser2) return false;
  const tree = parser2.parse(program);
  if (!tree) return false;
  try {
    const root = tree.rootNode;
    if (root.hasError) return false;
    const proof = lang === "py" ? new PyProof() : new JsProof();
    proof.collect(root);
    if (proof.ok) proof.visit(root);
    if (proof.judged && !scanned.includes("W")) return false;
    return proof.ok;
  } finally {
    tree.delete();
  }
}

// src/hooks/cmd-analysis/programs.ts
var COMPUTED = "$(computed):";
var PARSE = "$(parse):";
var UNPROVEN = "$(unproven):";
function dquoteEnd(s, from) {
  for (let k = from; k < s.length; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === '"') return k + 1;
    else if (s.startsWith("$(", k)) {
      const e = closeAt(s, k + 2, true, "(", ")");
      if (e < 0) return -1;
      k = e - 1;
    } else if (s[k] === "`") {
      const e = s.indexOf("`", k + 1);
      if (e < 0) return -1;
      k = e;
    }
  }
  return -1;
}
function closeAt(s, from, quotes, open, shut) {
  let depth = 1;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (quotes && c === "\\") k++;
    else if (quotes && c === "'") {
      k = s.indexOf("'", k + 1);
      if (k < 0) return -1;
    } else if (quotes && c === '"') {
      k = dquoteEnd(s, k + 1) - 1;
      if (k < 0) return -1;
    } else if (c === open) depth++;
    else if (c === shut && --depth === 0) return k + 1;
  }
  return -1;
}
function expansionEnd(s, i2, quotes) {
  const c = s[i2];
  const n = s[i2 + 1] ?? "";
  if (c === "`") {
    const e = s.indexOf("`", i2 + 1);
    return e < 0 ? -1 : e + 1;
  }
  if (c === "\x07") return closeAt(s, i2 + 1, quotes, "\x07", "\b");
  if (c !== "$") return -1;
  if (n === "(") return closeAt(s, i2 + 2, quotes, "(", ")");
  if (n === "{") return closeAt(s, i2 + 2, quotes, "{", "}");
  if (/[A-Za-z_]/.test(n)) return i2 + 1 + /^[A-Za-z0-9_]*/.exec(s.slice(i2 + 1))[0].length;
  return /[0-9@*#?$!-]/.test(n) ? i2 + 2 : -1;
}
function onlyExpansions(s, quotes) {
  let i2 = 0;
  let any = false;
  for (; ; ) {
    while (i2 < s.length && /[ \t\n;]/.test(s[i2])) i2++;
    if (i2 >= s.length) return any;
    i2 = expansionEnd(s, i2, quotes);
    if (i2 < 0) return false;
    any = true;
  }
}
function heldProgram(program) {
  const text = decode(program.split(SUB_PO).join("_").split(SUB_PC).join("_"));
  if (!/[$`\x07]/.test(text)) return false;
  return onlyExpansions(text, true) || onlyExpansions(text, false);
}
function shown(text) {
  const flat = decode(text).replace(/\x07/g, "$(").replace(/\x08/g, ")").replace(/[\r\n]/g, " ");
  return [...flat].slice(0, 80).join("");
}
var PY_RUNNERS = /^(timeit|cProfile|profile|trace|pdb|runpy|code|doctest|pydoc|pickle|py_compile|compileall)$/;
var SP = "[ \\t\\n\\v\\f\\r]*";
var Q = `['"]`;
var LIT = `${Q}[^'"]+${Q}`;
var FN = "writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|renameSync|rmSync|rmdirSync|unlinkSync|copyFileSync|cpSync|fs\\.(mkdir|rename|rm|rmdir|unlink|copyFile|cp)|makedirs|rmtree|dump_stats|(File|IO)\\.(bin)?write|os\\.(remove|unlink|mkdir|rename|replace|rmdir)|shutil\\.(copy|copyfile|copy2|copytree|move)";
var SHAPE = new RegExp(
  `open${SP}\\([^)]*,${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|open${SP}\\(?[^,;()]*,${SP}${Q}[+]?>|write_text|write_bytes|createWriteStream|(${FN})${SP}\\(`
);
var WRITES = new RegExp(
  `open${SP}\\(${SP}${LIT}${SP},${SP}(mode${SP}=${SP})?${Q}[rbt]*[wax+]|(${FN})${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(write_text|write_bytes|mkdir|touch|unlink|rmdir|rename)`,
  "g"
);
var READS = new RegExp(
  `open${SP}\\(${SP}${LIT}${SP}(,${SP}${Q}r[bt]?${Q}${SP})?\\)|(readFileSync|readFile|createReadStream|existsSync|statSync)${SP}\\(${SP}${LIT}|Path${SP}\\(${SP}${LIT}${SP}\\)${SP}\\.${SP}(read_text|read_bytes|exists)`,
  "g"
);
var QUOTED = new RegExp(LIT, "g");
var RAW_TOKEN = /['"][^'"\t\n\v\f\r ]+['"]/g;
var chomp = (s) => s.replace(/\n+$/, "");
var basename3 = (w) => w.replace(/.*\//, "");
var blank = (line) => !/[^ \t\n]/.test(line);
function grepO(text, re) {
  const out2 = [];
  for (const line of text.split("\n")) for (const m of line.matchAll(re)) if (m[0] !== "") out2.push(m[0]);
  return out2;
}
function progScan(lang, program, depth = 0) {
  if (depth > 3) return ["W", "U"];
  const out2 = [];
  for (const line of progCalls(lang, program)) {
    if (line.startsWith("R	")) out2.push("R", ...progScan(lang, chomp(line.slice(2).replace(/\x1f/g, "\n")), depth + 1));
    else out2.push(line);
  }
  return out2;
}
function progLiterals(src, reads, writes, raw) {
  const lits = raw ? grepO(src, RAW_TOKEN) : src.split("\n");
  const out2 = [];
  for (let lit of lits) {
    if (lit.length < 2) continue;
    if (reads.includes(lit) && !writes.includes(lit)) continue;
    lit = lit.slice(1, -1).replace(/^\+/, "").replace(/^>/, "").replace(/^>/, "");
    if (lit === "" || lit === "." || lit === ".." || /[^A-Za-z0-9_./~-]/.test(lit)) continue;
    if (lit.includes("/") || /\.[A-Za-z0-9]/.test(lit)) out2.push(lit);
  }
  return out2;
}
var PY_DYNAMIC = /^(globals|locals|vars|exec|eval|compile|getattr|setattr|delattr|builtins|modules|_getframe|f_globals|f_locals|f_back|tb_frame|gi_frame|cr_frame|settrace|setprofile|inspect|gc|ctypes|importlib|pickle|marshal|shelve|yaml|dill|cloudpickle|jsonpickle|runpy|breakpoint|pdb|interact|operator|attrgetter|__[A-Za-z0-9_]*__)$/;
var NODE_DYNAMIC = /^(eval|Function|globalThis|global|window|self|with|vm|Reflect|defineProperty|arguments|this|constructor|prototype|__proto__|import|module|mainModule|binding|contextify|repl|inspector|dlopen|runInThisContext|runInContext|runInNewContext|Script|compileFunction)$/;
var PY_KEYWORDS = /^(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case)$/;
var NODE_KEYWORDS = /^(if|while|for|switch|catch|with|return|function|typeof|void|delete|new|in|of|instanceof|await|yield|case|throw|else|do|let|const|var|class|extends|super|import|export|async|get|set|static)$/;
var PY_COMPOUND = /^(if|elif|else|for|while|with|try|except|finally|def|class|async|match|case|lambda)$/;
var DEFINER = /^(function|def|class|async|get|set|static)$/;
var UNBINDABLE = /^(True|False|None|__debug__|undefined|NaN|Infinity|null|true|false)$/;
var PLAIN = /^[^\\$@#{}%`'"\x00-\x1f]+$/;
var GAP = "(?:\\s|\\\\\\r?\\n)*";
var VOIDERS = new RegExp(
  `\\bimport${GAP}\\*|\\b(?:exec|eval|compile|globals|locals|vars|setattr|delattr)${GAP}\\(|__dict__|__builtins__|__import__|importlib`
);
var STR = "";
var OPENER = { ")": "(", "]": "[", "}": "{" };
var space = (c) => c !== void 0 && /\s/.test(c);
function lex(py, src) {
  if (/[\x00-\x08\x0e-\x1f]/.test(src) || VOIDERS.test(src)) return void 0;
  let code = "";
  const strs = [];
  const strAt = /* @__PURE__ */ new Map();
  for (let i2 = 0; i2 < src.length; ) {
    const c = src[i2];
    if (py && c === "#" || !py && src.startsWith("//", i2)) {
      const e = src.indexOf("\n", i2);
      i2 = e < 0 ? src.length : e;
      code += " ";
      continue;
    }
    if (!py && src.startsWith("/*", i2)) {
      const e = src.indexOf("*/", i2 + 2);
      if (e < 0) return void 0;
      i2 = e + 2;
      code += " ";
      continue;
    }
    if (c === "'" || c === '"' || !py && c === "`") {
      let pfx = "";
      const m = py ? /(?:^|[^A-Za-z0-9_])([A-Za-z]{1,2})$/.exec(code) : null;
      if (m && /^[rRbBuUfF]{1,2}$/.test(m[1])) {
        pfx = m[1];
        code = code.slice(0, -pfx.length);
      }
      const q = py && src.startsWith(c.repeat(3), i2) ? c.repeat(3) : c;
      let j = i2 + q.length;
      let body2 = "";
      while (!src.startsWith(q, j)) {
        if (j >= src.length || q.length === 1 && c !== "`" && src[j] === "\n") return void 0;
        if (c === "`" && src.startsWith("${", j)) return void 0;
        const n = src[j] === "\\" ? 2 : 1;
        body2 += src.slice(j, j + n);
        j += n;
      }
      strAt.set(code.length, strs.length);
      strs.push({ pfx, q, body: body2 });
      code += STR;
      i2 = j + q.length;
      continue;
    }
    code += c;
    i2++;
  }
  if (/[^\x00-\x7f]/.test(code) || (py ? /\\(?!\n)/.test(code) : /[\\/]/.test(code))) return void 0;
  if (py && /(^|\n)[ \t]*case\b/.test(code)) return void 0;
  if (!py && /\brequire\b(?!\s*\(\s*\x01\s*\))/.test(code)) return void 0;
  const word = py ? /[A-Za-z0-9_]+/g : /[A-Za-z0-9_$]+/g;
  const dynamic = py ? PY_DYNAMIC : NODE_DYNAMIC;
  for (const text of [code, ...strs.map((s) => s.body)]) for (const w of text.match(word) ?? []) if (dynamic.test(w)) return void 0;
  const encl = [];
  const match2 = /* @__PURE__ */ new Map();
  const stack = [];
  for (let k = 0; k < code.length; k++) {
    const ch = code[k];
    if (OPENER[ch]) {
      const o = stack.pop();
      if (o === void 0 || code[o] !== OPENER[ch]) return void 0;
      match2.set(o, k);
    }
    encl[k] = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (ch === "(" || ch === "[" || ch === "{") stack.push(k);
  }
  if (stack.length > 0) return void 0;
  return { py, code, strs, strAt, encl, match: match2 };
}
function lineStart(lx, i2) {
  const { code, encl } = lx;
  let ls = code.lastIndexOf("\n", i2 - 1) + 1;
  while (ls > 0 && (encl[ls - 1] !== -1 || code[ls - 2] === "\\")) ls = code.lastIndexOf("\n", ls - 2) + 1;
  return ls;
}
function statementAt(lx, i2) {
  const { code, encl } = lx;
  const from = Math.max(lineStart(lx, i2), code.lastIndexOf(";", i2 - 1) + 1);
  let to = i2;
  while (to < code.length && code[to] !== ";" && !(code[to] === "\n" && encl[to] === -1 && code[to - 1] !== "\\")) to++;
  return code.slice(from, to);
}
var PATH_CALLEE = /^(pathlib\s*\.\s*Path|Path|PurePath)\s*\(\s*/;
function pathlibCalls(lx) {
  const { code } = lx;
  for (const m of code.matchAll(/\b(Path|PurePath|pathlib)\b/g)) {
    const st = statementAt(lx, m.index);
    if (/^\s*(from|import)\b/.test(st)) {
      if (/^\s*from\s+pathlib\s+import\b/.test(st) || /^\s*import\s+[A-Za-z0-9_.,\s]*$/.test(st) && !/\bas\b/.test(st)) continue;
      return false;
    }
    const rest = code.slice(m.index + m[0].length);
    if (m[0] === "pathlib" ? !/^\s*\.\s*(Path|PurePath)\s*\(/.test(rest) : !/^\s*\(/.test(rest)) return false;
    if (DEFINER.test(/([A-Za-z0-9_]+)\s*$/.exec(code.slice(0, m.index))?.[1] ?? "")) return false;
  }
  return true;
}
function bindingAt(lx, name3, i2) {
  const { py, code } = lx;
  if (lx.encl[i2] !== -1) return void 0;
  if (py) {
    const ls = lineStart(lx, i2);
    const before2 = code.slice(ls, i2);
    const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(before2)?.[0] ?? "";
    if (before2 !== "" && (space(before2[0]) || !/;[ \t]*$/.test(before2) || PY_COMPOUND.test(first))) return void 0;
  } else {
    let b = code.slice(0, i2).replace(/\s+$/, "");
    const decl = /(?:^|[^A-Za-z0-9_$])(const|let|var)$/.exec(b);
    if (decl) b = b.slice(0, -decl[1].length).replace(/\s+$/, "");
    if (b !== "" && !b.endsWith(";")) return void 0;
  }
  let j = i2 + name3.length;
  while (code[j] === " " || code[j] === "	") j++;
  if (code[j] !== "=" || code[j + 1] === "=" || code[j + 1] === ">") return void 0;
  j++;
  while (code[j] === " " || code[j] === "	") j++;
  const callee = py ? PATH_CALLEE.exec(code.slice(j)) : null;
  if (callee) {
    if (!pathlibCalls(lx)) return void 0;
    j += callee[0].length;
  }
  const s = lx.strs[lx.strAt.get(j) ?? -1];
  if (!s || s.pfx !== "" || s.q !== "'" && s.q !== '"' || !PLAIN.test(s.body)) return void 0;
  j++;
  if (callee) {
    while (space(code[j])) j++;
    if (code[j] !== ")") return void 0;
    j++;
  }
  while (code[j] === " " || code[j] === "	" || code[j] === "\r") j++;
  return code[j] === void 0 || code[j] === ";" || py && code[j] === "\n" ? s.body : void 0;
}
function lambdaLine(lx, u, from) {
  const end = lx.code.indexOf("\n", from);
  return /\blambda\b/.test(lx.code.slice(lineStart(lx, u), end < 0 ? lx.code.length : end));
}
function useAt(lx, name3, u) {
  const { py, code } = lx;
  let a = u - 1;
  while (space(code[a])) a--;
  let b = u + name3.length;
  while (space(code[b])) b++;
  if (code[a] === ".") return false;
  if (py && code[b] === ".") {
    if (!/^\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(code.slice(b))) return false;
    return !/^\s*(from|import)\b/.test(statementAt(lx, u)) && !lambdaLine(lx, u, u);
  }
  if (code[a] !== "(" && code[a] !== "," || code[b] !== ")" && code[b] !== ",") return false;
  const o = lx.encl[u];
  const c = lx.match.get(o);
  if (o < 0 || code[o] !== "(" || c === void 0) return false;
  let k = o - 1;
  while (space(code[k])) k--;
  if (code[k] !== ")" && code[k] !== "]") {
    const callee = /[A-Za-z0-9_$.]+$/.exec(code.slice(0, k + 1))?.[0] ?? "";
    const head = callee.replace(/^\.+/, "");
    if (head === "" || /^[0-9]/.test(head) || (py ? PY_KEYWORDS : NODE_KEYWORDS).test(head)) return false;
    let w = k - callee.length;
    while (space(code[w])) w--;
    if (DEFINER.test(/[A-Za-z0-9_$]+$/.exec(code.slice(0, w + 1))?.[0] ?? "")) return false;
  }
  let e = c + 1;
  while (space(code[e])) e++;
  if (code[e] === "{" || code[e] === ":" || code.startsWith("=>", e) || code.startsWith("->", e) || code[e] === "=" && code[e + 1] !== "=") return false;
  return !(py && lambdaLine(lx, u, c));
}
function heldLiterals(lx, name3) {
  if (UNBINDABLE.test(name3)) return void 0;
  const word = lx.py ? /[A-Za-z0-9_]+/g : /[A-Za-z0-9_$]+/g;
  for (const s of lx.strs) if (s.body.match(word)?.includes(name3)) return void 0;
  const occ = [...lx.code.matchAll(word)].filter((m) => m[0] === name3).map((m) => m.index);
  if (occ.length < 2) return void 0;
  const first = bindingAt(lx, name3, occ[0]);
  if (first === void 0) return void 0;
  const lits = [first];
  for (const u of occ.slice(1)) {
    const lit = lx.py ? bindingAt(lx, name3, u) : void 0;
    if (lit !== void 0) lits.push(lit);
    else if (!useAt(lx, name3, u)) return void 0;
  }
  return lits;
}
function progWrites(lang, program, operands, procWrites) {
  const scanned = progScan(lang, program);
  const unproven = !proveProgram(lang, program, scanned);
  const found = progFound(lang, program, scanned, operands, procWrites);
  return { ...found, unproven };
}
function progFound(lang, program, scanned, operands, procWrites) {
  const scan = chomp(scanned.join("\n"));
  const has = (line) => `
${scan}
`.includes(`
${line}
`);
  const cd = has("C");
  const run2 = has("R");
  const names = scan.split("\n").flatMap((line) => line.startsWith("F	") ? [line.slice(2)] : []);
  const lexed = names.length > 0 && (lang === "py" || lang === "node") && !has("A") && !run2 ? lex(lang === "py", program) : void 0;
  const held = new Map(names.map((name3) => [name3, lexed && heldLiterals(lexed, name3)]));
  const unread = has("A") || has("F") || [...held.values()].includes(void 0);
  let fail = unread || held.size > 0;
  if (!has("W")) {
    if (!program.split("\n").some((line) => SHAPE.test(line))) return { lines: [], computed: false };
    fail = true;
  }
  let out2 = "";
  let src = "";
  for (const line of scan.split("\n")) {
    const rest = line.slice(2);
    if (line === "U") out2 += "$(proc)\n";
    else if (line === "H") out2 += "$(alias-write)\n";
    else if (rest === "" || line[1] !== "	") continue;
    else if (line[0] === "T") out2 += rest + "\n";
    else if (line[0] === "S") out2 += (cd ? "$(proc)" : chomp(procWrites(chomp(rest.replace(/\x1f/g, "\n"))))) + "\n";
    else if (line[0] === "Q") src += rest + "\n";
  }
  let raw = false;
  if (has("A")) {
    src = program;
    raw = true;
  }
  if (fail) {
    const writes = grepO(program, WRITES).map((m) => /^[^'"]*['"][^'"]+['"]/.exec(m)?.[0]).filter((m) => m !== void 0).map((m) => /['"][^'"]+['"]$/.exec(m)?.[0]).filter((m) => m !== void 0);
    const reads = grepO(grepO(program, READS).join("\n"), QUOTED);
    out2 += progLiterals(src, reads, writes, raw).join("\n");
    if (run2) out2 += "\n$(proc)";
    for (const lits of held.values()) for (const lit of lits ?? []) out2 += `
${lit}`;
  }
  let lines2 = out2.split("\n");
  if (cd) lines2 = lines2.filter((l) => !blank(l)).map((l) => (/^[/~$]/.test(l) ? "" : "$(proc)/") + l);
  const seen = /* @__PURE__ */ new Set();
  lines2 = lines2.filter((l) => !blank(l) && !seen.has(l) && seen.add(l) !== void 0);
  if (lines2.length > 0) return { lines: lines2, computed: unread };
  return { lines: operands ? ["-"] : [], computed: fail };
}
var PROGRAM_FLAG = {
  py: /^-[bBdEhiIOPqRsSuvx]*c(.*)$/s,
  node: /^(?:-e|-p|-pe|--eval|--print)(?:=(.*))?$/s,
  perl: /^-[nlpaswWtTUcX]*[eE](.*)$/s,
  ruby: /^-[nlpaswWdv]*e(.*)$/s
};
function interpWrites(words, procWrites, held = () => false) {
  const argv0 = basename3(words[0] ?? "");
  let lang;
  let pyopt = false;
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) {
    lang = "py";
    pyopt = true;
  } else if (argv0 === "node" || argv0 === "nodejs") lang = "node";
  else if (argv0 === "perl") lang = "perl";
  else if (argv0 === "ruby") lang = "ruby";
  else return [];
  const n = words.length;
  let k = 1;
  let optarg = false;
  const encoded = [];
  const carriers = [];
  const take = (flagWord, attached, next) => {
    encoded.push(attached ? attached : next ?? "");
    carriers.push(attached ? flagWord : next ?? "");
  };
  while (k < n) {
    const w = words[k++];
    if (pyopt) {
      const m2 = /^-[bBdEhiIOPqRsSuvx]*m(.*)$/s.exec(w);
      if (m2) {
        pyopt = false;
        if (PY_RUNNERS.test(chomp(decode(m2[1] || (words[k] ?? ""))))) return ["$(proc)"];
      } else if (optarg) optarg = false;
      else if (w === "-W" || w === "-X") optarg = true;
      else if (!w.startsWith("-")) pyopt = false;
    }
    const m = PROGRAM_FLAG[lang].exec(w);
    if (m) {
      take(w, m[1], m[1] ? void 0 : words[k++]);
      break;
    }
  }
  if (lang === "perl" || lang === "ruby") {
    for (let j = k; j < n; j++) {
      const m = PROGRAM_FLAG[lang].exec(words[j]);
      if (m) take(words[j], m[1], m[1] ? void 0 : words[++j]);
    }
  }
  const program = encoded.map((e) => chomp(decode(e))).join("\n");
  if (program === "") return [];
  if (heldProgram(encoded[0])) return [COMPUTED + shown(`${argv0} ${program}`)];
  const found = progWrites(lang, program, true, procWrites);
  const unproven = found.unproven || carriers.some(held) ? [UNPROVEN + shown(program)] : [];
  if (found.lines.length === 0) return unproven;
  const literal = !(found.lines[0] === "-" && found.lines.length === 1);
  const out2 = literal ? [...found.lines] : [];
  for (; k < n; k++) if (!words[k].startsWith("-")) out2.push(...decode(words[k]).split("\n"));
  if (found.computed) out2.push(COMPUTED + argv0);
  return [...out2, ...unproven];
}

// src/hooks/cmd-analysis/unwrap.ts
var NO_SPEC = { short: "", dirShort: "", long: " ", dirLong: " " };
var SPECS = {
  sudo: {
    short: "CDRTUcghprtu",
    dirShort: "D",
    long: " chdir chroot close-from command-timeout group host login-class other-user prompt role type user ",
    dirLong: " chdir "
  },
  env: { short: "CPSu", dirShort: "C", long: " chdir split-string unset ", dirLong: " chdir " },
  time: { short: "fo", dirShort: "", long: " format output ", dirLong: " " },
  exec: { short: "a", dirShort: "", long: " ", dirLong: " " },
  timeout: { short: "ks", dirShort: "", long: " kill-after signal ", dirLong: " " },
  stdbuf: { short: "eio", dirShort: "", long: " error input output ", dirLong: " " },
  nice: { short: "n", dirShort: "", long: " adjustment ", dirLong: " " }
};
SPECS.gtimeout = SPECS.timeout;
SPECS.gstdbuf = SPECS.stdbuf;
SPECS.gnice = SPECS.nice;
var WRAPPER = /^(sudo|env|command|nohup|time|exec|g?timeout|g?stdbuf|g?nice)$/;
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
function under(a, b) {
  if (a === "" || /^[/~$]/.test(b)) return b;
  if (b === ".") return a;
  return `${a}/${b}`;
}
function splitWords(s) {
  return s === "" ? [] : s.split(/[ \t]+/);
}
function lookup(w, k) {
  for (let j = k + 1; j < w.length && w[j].startsWith("-") && w[j] !== "--" && w[j] !== "-"; j++) {
    if (/^-[^-]*[vV]/.test(w[j])) return true;
  }
  return false;
}
function unwrap(w, k) {
  const dirs = [];
  const n = w.length;
  while (k < n) {
    const a = w[k];
    if (a === "" || ASSIGNMENT.test(a)) {
      k++;
      continue;
    }
    if (/^--chdir=./.test(a)) {
      dirs.push(a.slice(8));
      k++;
      continue;
    }
    if (!WRAPPER.test(a)) break;
    if (a === "command" && lookup(w, k)) return { k: k + 1, dirs };
    const spec = SPECS[a] ?? NO_SPEC;
    k++;
    while (k < n && w[k].startsWith("-")) {
      const opt = w[k];
      k++;
      if (opt === "--") break;
      if (opt === "-") continue;
      if (opt.startsWith("--")) {
        let name3 = opt.slice(2);
        let value = "";
        const eq = name3.indexOf("=");
        if (eq >= 0) {
          value = name3.slice(eq + 1);
          name3 = name3.slice(0, eq);
        }
        if (!spec.long.includes(` ${name3} `)) continue;
        if (eq < 0) {
          value = w[k] ?? "";
          k++;
        }
        if (spec.dirLong.includes(` ${name3} `) && value !== "") dirs.push(value);
        continue;
      }
      for (let j = 1; j < opt.length; j++) {
        const ch = opt[j];
        if (!spec.short.includes(ch)) continue;
        let value = opt.slice(j + 1);
        if (value === "") {
          value = w[k] ?? "";
          k++;
        }
        if (spec.dirShort.includes(ch) && value !== "") dirs.push(value);
        break;
      }
    }
    if ((a === "timeout" || a === "gtimeout") && k < n) k++;
  }
  return { k, dirs };
}

// src/hooks/cmd-analysis/statements.ts
var SEP = "";
var WSEP = "";
var VSEP = "";
var VEQ = "";
var BAD = "";
var VPLAIN = /^(cd|git|echo|true|false|ls|cat|pwd|mkdir|touch)$/;
var VBAD = "*?[](){<>`";
var HD_MARK = /<<[\x1a\x1e]/g;
var VSPECIAL = /^(IFS|PWD|OLDPWD|RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|BASHPID|PPID|UID|EUID|GROUPS|HISTCMD|PIPESTATUS|FUNCNAME|BASH_[A-Z_]*)$/;
var KEYWORD = /^(\{|\}|!|if|then|else|elif|do|while|until|fi|done|esac)$/;
var NAME2 = /^[A-Za-z_][A-Za-z0-9_]*/;
var BRACED = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
var FOR_HEAD = /^[ \t]*(((do|then|else|elif|\{|!)[ \t]+)*)for[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+in[ \t]+\$$/;
function norm(p) {
  let lead = "";
  if (p.startsWith("@")) {
    lead = "@";
    p = p.slice(1);
  }
  const out2 = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out2.length > 0 && out2[out2.length - 1] !== "..") {
      out2.pop();
      continue;
    }
    out2.push(part);
  }
  const joined = out2.map((x) => "/" + x).join("");
  if (lead === "@") return "@" + joined;
  return joined === "" ? "/" : joined;
}
function rawword(t) {
  t = unmark(t);
  let out2 = "";
  for (const ch of t) {
    if (ch === QO) out2 += "$" + ENC[8];
    else if (ch === QC) out2 += ENC[9];
    else if (ch === ENC[8]) out2 += SUB_PO;
    else if (ch === ENC[9]) out2 += SUB_PC;
    else if (ch === "\n") out2 += ENC[12];
    else {
      const x = " 	<>|;&()`".indexOf(ch);
      out2 += x >= 0 ? ENC[x + 1] : ch;
    }
  }
  return out2;
}
function unmark(t) {
  return t.replace(HD_MARK, "<<");
}
function srcmark(body2, dir) {
  body2 = unmark(body2);
  if (/[;&|()`\n]/.test(body2) || body2.includes(QO) || body2.includes(QC)) return "";
  body2 = body2.replace(/[ \t]+/g, SEP);
  if (body2.startsWith(SEP)) body2 = body2.slice(1);
  if (body2.endsWith(SEP)) body2 = body2.slice(0, -1);
  if (body2 === "") return "";
  return SEP + dir + SEP + body2;
}
function statementsEnc(buf, base, home, assign) {
  const records = [];
  let old = "-";
  let cwhy = "";
  let owhy = "";
  let cond = false;
  let vok = true;
  let vkill = false;
  let vtop = true;
  let vs = "";
  let fsep = "";
  let asg = "";
  let lastout = "";
  let lastdir = "";
  let piped = false;
  let pipesrc = "";
  let i2 = 0;
  let s = base.indexOf(SEP);
  if (s >= 0) {
    old = base.slice(s + 1);
    base = base.slice(0, s);
  }
  s = old.indexOf(SEP);
  if (s >= 0) {
    cwhy = old.slice(s + 1);
    old = old.slice(0, s);
  }
  let cur = base;
  let sp = 0;
  let bt = false;
  let stmt = "";
  let qsp = 0;
  const stack = [];
  const ostack = [];
  const wstack = [];
  const owstack = [];
  const q = [];
  const emit = (dir, text) => records.push({ dir, stmt: text });
  function closepar(pos) {
    let d = 0;
    for (let k = pos; k < buf.length; k++) {
      const ch = buf[k];
      if (ch === "(") d++;
      else if (ch === ")") {
        d--;
        if (d === 0) return k;
      }
    }
    return -1;
  }
  function forsrc(pos) {
    if (!FOR_HEAD.test(stmt)) return "";
    const j = closepar(pos);
    if (j < 0) return "";
    let k = j + 1;
    while (k < buf.length && /[ \t]/.test(buf[k])) k++;
    if (k < buf.length && !/[;\n]/.test(buf[k])) return "";
    return srcmark(buf.slice(pos + 1, j), cur);
  }
  function donesrc(pos) {
    let depth = 0;
    let atcmd = true;
    let pd = 0;
    let k = pos;
    const m = buf.length;
    while (k < m) {
      let ch = buf[k];
      if (/[ \t]/.test(ch)) {
        k++;
        continue;
      }
      if (/[;\n&|`]/.test(ch) || ch === QO || ch === QC) {
        atcmd = true;
        k++;
        continue;
      }
      if (ch === "(") {
        pd++;
        atcmd = true;
        k++;
        continue;
      }
      if (ch === ")") {
        if (--pd < 0) return "";
        atcmd = false;
        k++;
        continue;
      }
      if (ch === "<" || ch === ">") {
        atcmd = false;
        k++;
        continue;
      }
      let w = "";
      while (k < m) {
        ch = buf[k];
        if (/[ \t;\n&|()<>`]/.test(ch) || ch === QO || ch === QC) break;
        w += ch;
        k++;
      }
      if (atcmd && w === "do") {
        depth++;
        continue;
      }
      if (atcmd && w === "done") {
        if (--depth < 0) return "";
        if (depth > 0) {
          atcmd = false;
          continue;
        }
        while (k < m && /[ \t]/.test(buf[k])) k++;
        if (buf[k] !== "<") return "";
        k++;
        while (k < m && /[ \t]/.test(buf[k])) k++;
        if (buf.slice(k, k + 2) !== "<(") return "!";
        const j = closepar(k + 1);
        if (j < 0) return "!";
        const mark = srcmark(buf.slice(k + 2, j), cur);
        return mark === "" ? "!" : mark;
      }
      atcmd = atcmd && /^(then|else|elif|if|while|until|!|\{|\}|time)$/.test(w);
    }
    return "";
  }
  function getvar(name3) {
    if (!vok || !vtop) return BAD;
    let v = BAD;
    const entries = vs.split(VSEP);
    for (let k = 1; k < entries.length; k++) {
      const j = entries[k].indexOf(VEQ);
      if ((j < 0 ? "" : entries[k].slice(0, j)) === name3) v = entries[k].slice(j + 1);
    }
    return v;
  }
  function subst(p) {
    let out2 = "";
    let m;
    while ((m = p.indexOf("$")) >= 0) {
      out2 += p.slice(0, m);
      const rest = p.slice(m + 1);
      let name3;
      let len;
      let hit = BRACED.exec(rest);
      if (hit) {
        name3 = hit[0].slice(1, -1);
        len = hit[0].length;
      } else if (hit = NAME2.exec(rest)) {
        name3 = hit[0];
        len = hit[0].length;
      } else return BAD;
      const v = getvar(name3);
      if (v === BAD) return BAD;
      out2 += v;
      p = rest.slice(len);
    }
    return out2 + p;
  }
  function assignword(a, uncertain) {
    const j = a.indexOf("=");
    const nm = a.slice(0, j);
    let v = a.slice(j + 1);
    if (VSPECIAL.test(nm)) return false;
    if (uncertain || /[$`*?[~\\\x01-\x13]/.test(v)) v = BAD;
    vs += VSEP + nm + VEQ + v;
    return true;
  }
  function whyof(d, dw, p) {
    if (/^[$`/~]/.test(p) || d !== "-") return d + WSEP + p;
    if (dw === "") return "";
    return dw + "/" + p;
  }
  function resolve3(d, p) {
    if (p.includes("$") && !/[`\x01-\x06\x0e-\x13]/.test(p)) {
      p = subst(p);
      if (p === BAD) return "-";
    }
    if (p === "" || /[$`\x01-\x06\x0e-\x13]/.test(p)) return "-";
    if (p === "~") p = home;
    else if (p.startsWith("~/")) p = home + p.slice(1);
    if (p.startsWith("/")) return norm(p);
    if (d === "-") return "-";
    return norm(d + "/" + p);
  }
  function vend(ok) {
    if (vtop) {
      if (!ok || vkill) vok = false;
      vkill = false;
    }
  }
  function vplainexp(text) {
    const parts2 = text.split("<<");
    for (let k = 1; k < parts2.length; k++) {
      if (!parts2[k].startsWith(HD_DATA)) return false;
      parts2[k] = parts2[k].slice(1);
    }
    text = parts2.join("");
    const t = text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
    for (const ch of VBAD) if (t.includes(ch)) return false;
    return plainDollars(text);
  }
  function flush() {
    const chained = fsep === "&&";
    fsep = "";
    vtop = sp === 0 && qsp === 0 && !bt;
    if (!vplainexp(stmt)) vok = false;
    stmt = unmark(stmt);
    const csure = !cond;
    cond = false;
    const w = splitWords(stmt);
    const n = w.length;
    stmt = "";
    let first = 0;
    asg = "";
    let cdw = "";
    const aw = [];
    let plain = true;
    const waspiped = piped;
    piped = false;
    lastout = "";
    lastdir = cur;
    let sawwhile = false;
    while (first < n) {
      if (w[first] === "") {
        first++;
        continue;
      }
      if (w[first] === "while") sawwhile = true;
      if (KEYWORD.test(w[first])) {
        plain = false;
        first++;
        continue;
      }
      if (ASSIGNMENT.test(w[first])) {
        asg += (asg === "" ? "" : " ") + w[first];
        aw.push(w[first]);
        first++;
        continue;
      }
      if (w[first] === "time") {
        let k = first + 1;
        while (k < n && w[k].startsWith("-")) k++;
        if (k < n && ASSIGNMENT.test(w[k])) {
          first = k;
          plain = false;
          continue;
        }
      }
      if (WRAPPER.test(w[first])) {
        const u = unwrap(w, first);
        first = u.k;
        plain = false;
        for (const dir of u.dirs) cdw += (cdw === "" ? "" : " ") + "--chdir=" + dir;
        continue;
      }
      break;
    }
    if (first >= n) {
      let ok2 = plain;
      if (vtop && plain) {
        for (const a of aw) if (!assignword(a, !csure)) ok2 = false;
      }
      if (assign && asg !== "") {
        emit("=" + cur + SEP + old, asg);
        if (!chained) {
          old = "-";
          owhy = "";
        }
      }
      vend(ok2);
      return;
    }
    let a0 = w[first];
    let ok = plain && aw.length === 0;
    if (ok && a0 === "export") {
      for (let k = first + 1; k < n; k++) {
        if (w[k] === "") continue;
        if (!ASSIGNMENT.test(w[k])) ok = false;
        else if (vtop && !assignword(w[k], !csure)) ok = false;
      }
    } else if (ok) {
      ok = VPLAIN.test(a0);
    }
    let out2 = a0;
    for (let k = first + 1; k < n; k++) if (w[k] !== "") out2 += " " + w[k];
    if (cdw !== "") {
      out2 = cdw + " " + out2;
      a0 = "";
    }
    lastout = out2;
    let d = cur;
    const o = old;
    let dw = cwhy;
    if (a0 === "cd" || a0 === "pushd") {
      let p = "";
      for (let k = first + 1; k < n; k++) {
        if (w[k] === "") continue;
        if (/^-[LPe@]+$/.test(w[k])) continue;
        p = w[k];
        break;
      }
      if (p === "-" && a0 === "cd") {
        [cur, old] = [old, cur];
        [cwhy, owhy] = [owhy, cwhy];
      } else if (p === "" || p === "-") {
        old = cur;
        owhy = cwhy;
        cur = "-";
        cwhy = p === "" && a0 === "cd" ? "-" + WSEP + "$HOME" : "";
      } else {
        old = cur;
        owhy = cwhy;
        const t = resolve3(cur, p);
        cwhy = t === "-" ? whyof(cur, cwhy, p) : "";
        cur = t;
      }
    } else if (a0 === "popd") {
      old = cur;
      owhy = cwhy;
      cur = "-";
      cwhy = "";
    } else if (assign && a0 === "read") {
      let mk = sawwhile ? donesrc(i2) : "";
      if (mk === "" && waspiped) mk = pipesrc;
      if (mk !== "" && mk !== "!") out2 += " " + mk;
    } else if (assign && a0 === "xargs") {
      if (waspiped && pipesrc !== "") out2 += " " + pipesrc;
    } else if (a0 === "git") {
      for (let k = first + 1; k < n; k++) {
        if (w[k] === "") continue;
        if (w[k] === "-C") {
          const t = resolve3(d, w[k + 1] ?? "");
          dw = t === "-" ? whyof(d, dw, w[k + 1] ?? "") : "";
          d = t;
          k++;
          continue;
        }
        if (w[k] === "-c") {
          k++;
          continue;
        }
        if (w[k].startsWith("-")) continue;
        break;
      }
    }
    emit(d + (assign ? SEP + o + (d === "-" && dw !== "" ? SEP + dw : "") : ""), out2);
    if (!chained) {
      old = "-";
      owhy = "";
    }
    vend(ok);
  }
  function push() {
    ostack[sp + 1] = old;
    wstack[sp + 1] = cwhy;
    owstack[sp + 1] = owhy;
    stack[++sp] = cur;
  }
  function pop() {
    if (sp > 0) {
      old = ostack[sp];
      cwhy = wstack[sp];
      owhy = owstack[sp];
      cur = stack[sp--];
    }
  }
  for (i2 = 0; i2 < buf.length; i2++) {
    const c = buf[i2];
    const nx = buf[i2 + 1] ?? "";
    const prev = i2 > 0 ? buf[i2 - 1] : "";
    if (c === QO) {
      qsp++;
      q[qsp] = { stmt, cur, old, start: i2 + 1, sp, why: cwhy, owhy };
      vkill = true;
      stmt = "";
      continue;
    }
    if (c === QC) {
      if (qsp === 0) continue;
      flush();
      const f = q[qsp];
      stmt = f.stmt + "$" + ENC[8] + rawword(buf.slice(f.start, i2)) + ENC[9];
      cur = f.cur;
      old = f.old;
      sp = f.sp;
      cwhy = f.why;
      owhy = f.owhy;
      qsp--;
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      continue;
    }
    if (c === "&") {
      if (nx === ">" || prev === ">") {
        stmt += c;
        continue;
      }
      if (nx === "&") {
        i2++;
        fsep = "&&";
        flush();
        cond = true;
      } else {
        vkill = true;
        flush();
      }
      continue;
    }
    if (c === "|") {
      if (prev === ">") {
        stmt += c;
        continue;
      }
      const p1 = nx !== "|" && nx !== "&";
      if (!p1) i2++;
      vkill = true;
      flush();
      if (assign && p1) {
        piped = true;
        pipesrc = lastout !== "" ? srcmark(lastout, lastdir) : "";
      }
      continue;
    }
    if (c === "(") {
      vkill = true;
      const last = stmt.slice(-1);
      if (last === "$" || last === "<" || last === ">") {
        if (assign && last === "$") stmt = stmt + ENC[8] + ENC[9] + forsrc(i2);
        else stmt = stmt.slice(0, -1);
      }
      flush();
      push();
      continue;
    }
    if (c === ")") {
      flush();
      if (sp === 0) vok = false;
      pop();
      continue;
    }
    if (c === "`") {
      vkill = true;
      if (assign && !bt) stmt += "$" + ENC[8] + ENC[9];
      flush();
      if (bt) {
        bt = false;
        pop();
      } else {
        bt = true;
        push();
      }
      continue;
    }
    stmt += c;
  }
  flush();
  return records.filter((r) => r.stmt !== "");
}

// src/hooks/cmd-analysis/targets.ts
var basename4 = (w) => w.replace(/.*\//, "");
function writeTargetWords(w, out2) {
  let pre = "";
  const u = unwrap(w, 0);
  for (const dir of u.dirs) {
    pre = under(pre, dir);
    out2.push(pre);
  }
  const first = u.k;
  const nw = w.length;
  if (first >= nw) return;
  const put = (p) => out2.push(under(pre, p));
  const cmd = basename4(w[first]);
  const nonopt = [];
  const diropts = (short, long, compose) => {
    let cur = "";
    for (let k = first + 1; k < nw; k++) {
      const a = w[k];
      let d = "";
      if (a === "--") break;
      if (a === short || a === long) {
        if (k < nw - 1) d = w[k + 1];
        k++;
      } else if (a.startsWith(long + "=")) d = a.slice(long.length + 1);
      else if (a.startsWith(short) && a.length > 2) d = a.slice(2);
      if (d === "") continue;
      cur = compose ? under(cur, d) : d;
      put(cur);
    }
  };
  if (/^(tee|mkdir|rm|touch|rmdir)$/.test(cmd)) {
    for (let k = first + 1; k < nw; k++) if (!w[k].startsWith("-")) put(w[k]);
  } else if (/^(tar|gtar|bsdtar|make|gmake)$/.test(cmd)) {
    diropts("-C", "--directory", true);
  } else if (cmd === "npm") {
    diropts("-C", "--prefix", false);
  } else if (cmd === "ln" || cmd === "link") {
    let sym = false;
    let tdir = "";
    for (let k = first + 1; k < nw; k++) {
      const a = w[k];
      if (a === "-t" || a === "--target-directory") {
        if (k < nw - 1) tdir = w[k + 1];
        k++;
        continue;
      }
      if (a.startsWith("--target-directory=")) {
        tdir = a.slice("--target-directory=".length);
        continue;
      }
      if (a === "--symbolic") {
        sym = true;
        continue;
      }
      if (a.startsWith("--")) continue;
      if (a.startsWith("-")) {
        if (a.includes("s")) sym = true;
        continue;
      }
      nonopt.push(a);
    }
    const nn = nonopt.length;
    let last = nn;
    if (tdir !== "") put(tdir);
    else if (nn >= 2) {
      put(nonopt[nn - 1]);
      last = nn - 1;
    }
    for (let k = 0; k < last; k++) {
      const a = nonopt[k];
      if (!sym || a.startsWith("/")) {
        put(a);
        continue;
      }
      if (tdir !== "") {
        put(tdir + "/" + a);
        continue;
      }
      if (nn < 2) {
        put(a);
        continue;
      }
      let val = nonopt[nn - 1];
      if (val.includes("/")) {
        val = val.replace(/\/[^/]*\/?$/, "");
        if (val === "") val = "/";
      } else val = ".";
      put(val + "/" + a);
      put(nonopt[nn - 1] + "/" + a);
    }
  } else if (/^(cp|mv|install|rsync)$/.test(cmd)) {
    let installdir = false;
    let linkcopy = false;
    for (let k = first + 1; k < nw; k++) {
      const a = w[k];
      if (a === "-t" || a === "--target-directory") {
        if (k < nw - 1) put(w[k + 1]);
        k++;
        continue;
      }
      if (a.startsWith("--target-directory=")) {
        put(a.slice("--target-directory=".length));
        continue;
      }
      if (cmd === "install" && a === "-d") {
        installdir = true;
        continue;
      }
      if (cmd === "cp" && (a === "--symbolic-link" || a === "--link" || /^-[A-Za-z]*[sl]/.test(a))) {
        linkcopy = true;
        continue;
      }
      if (a.startsWith("-")) continue;
      nonopt.push(a);
    }
    const nn = nonopt.length;
    if (installdir || linkcopy) for (const a of nonopt) put(a);
    else if (nn >= 2 && !/^[^/]*:/.test(nonopt[nn - 1])) put(nonopt[nn - 1]);
  } else if (cmd === "dd") {
    for (let k = first + 1; k < nw; k++) if (/^of=./.test(w[k])) put(w[k].slice(3));
  } else if (cmd === "truncate") {
    for (let k = first + 1; k < nw; k++) {
      if (/^(-s|-r|--size|--reference)$/.test(w[k])) {
        k++;
        continue;
      }
      if (!w[k].startsWith("-")) put(w[k]);
    }
  } else if (cmd === "git") {
    let k = first + 1;
    while (k < nw && w[k].startsWith("-")) {
      if (w[k] === "-C" || w[k] === "-c") k++;
      k++;
    }
    const at = (j) => j < nw ? w[j] : void 0;
    if (at(k) === "mv") {
      for (let j = k + 1; j < nw; j++) if (!w[j].startsWith("-")) nonopt.push(w[j]);
      if (nonopt.length >= 2) put(nonopt[nonopt.length - 1]);
    } else if (at(k) === "worktree" && at(k + 1) === "add") {
      for (let j = k + 2; j < nw; j++) {
        if (/^(-b|-B|--reason)$/.test(w[j])) {
          j++;
          continue;
        }
        if (w[j].startsWith("-")) continue;
        put(w[j]);
        break;
      }
    } else if (at(k) === "worktree" && (at(k + 1) === "remove" || at(k + 1) === "move")) {
      for (let j = k + 2; j < nw; j++) {
        if (w[j] === "--reason") {
          j++;
          continue;
        }
        if (!w[j].startsWith("-")) put(w[j]);
      }
    } else if (at(k) === "clone") {
      let pos = 0;
      for (let j = k + 1; j < nw; j++) {
        if (/^(-b|-o|-c|-u|-j|--depth|--branch|--origin|--config|--reference|--jobs|--upload-pack|--template|--separate-git-dir)$/.test(w[j])) {
          j++;
          continue;
        }
        if (w[j].startsWith("-")) continue;
        pos++;
        if (pos === 2) {
          put(w[j]);
          break;
        }
      }
    }
  }
}
function writeTargets(line) {
  const out2 = [];
  let w = [];
  let want = 0;
  const flush = () => {
    writeTargetWords(w, out2);
    w = [];
  };
  const n = line.length;
  let i2 = 0;
  while (i2 < n) {
    let c = line[i2];
    if (c === " " || c === "	") {
      i2++;
      continue;
    }
    if (c === ";" || c === "|" || c === "(" || c === ")") {
      flush();
      want = 0;
      i2++;
      continue;
    }
    if (c === "&" && line[i2 + 1] === ">") {
      i2 += 2;
      if (line[i2] === ">") i2++;
      want = 1;
      continue;
    }
    if (c === "&") {
      flush();
      want = 0;
      i2++;
      continue;
    }
    if (c === "<") {
      i2++;
      while (line[i2] === "<") i2++;
      want = 2;
      continue;
    }
    if (c === ">") {
      i2++;
      if (line[i2] === ">" || line[i2] === "|") i2++;
      if (line[i2] === "&") {
        i2++;
        while (i2 < n && /[0-9-]/.test(line[i2])) i2++;
        continue;
      }
      want = 1;
      continue;
    }
    let word = "";
    while (i2 < n) {
      c = line[i2];
      if (/[ \t;|&()<]/.test(c)) break;
      if (c === ">") {
        if (/^[0-9]+$/.test(word)) word = "";
        break;
      }
      word += c;
      i2++;
    }
    if (word === "") continue;
    if (want === 1) {
      out2.push(word);
      want = 0;
      continue;
    }
    if (want === 2) {
      want = 0;
      continue;
    }
    w.push(word);
  }
  flush();
  return out2;
}
function unwrapStatement(stmt) {
  const w = splitWords(stmt);
  const u = unwrap(w, 0);
  let pre = "";
  for (const dir of u.dirs) pre = under(pre, dir);
  return { pre, words: w.slice(u.k).filter((x) => x !== "") };
}
function inplaceFiles(tool, args2) {
  let inplace = false;
  let hasprog = false;
  let skip = false;
  let ops = [];
  for (const w of args2) {
    if (skip) {
      skip = false;
      continue;
    }
    if (w === "--") continue;
    if (tool === "sed") {
      if (w.startsWith("--in-place") || w.startsWith("-i") || /^-[a-zA-Z].*i$/s.test(w)) inplace = true;
      else if (/^(-e|-f|--expression|--file|-l)$/.test(w)) {
        hasprog = true;
        skip = true;
      } else if (w.startsWith("--expression=") || w.startsWith("--file=")) hasprog = true;
      else if (/^-[a-zA-Z].*[ef]$/s.test(w)) {
        hasprog = true;
        skip = true;
      } else if (!w.startsWith("-")) ops.push(w);
    } else {
      if (w.startsWith("--")) continue;
      if (/^-.*[eE]$/s.test(w)) {
        if (w.includes("i")) inplace = true;
        hasprog = true;
        skip = true;
      } else if (/^-.*i/s.test(w)) inplace = true;
      else if (!w.startsWith("-")) ops.push(w);
    }
  }
  if (!inplace || ops.length === 0) return [];
  if (!hasprog) ops = ops.slice(1);
  return ops;
}
function gitTree(chain2, words) {
  const n = words.length;
  let cdir = "";
  let tree = "";
  let k = 1;
  let usetree = true;
  let dir = "";
  let outs = [];
  const at = (j) => words[j] ?? "";
  while (k < n) {
    const w = words[k];
    if (w === "-C") {
      cdir = under(cdir, at(k + 1));
      k += 2;
    } else if (w === "--work-tree") {
      tree = at(k + 1);
      k += 2;
    } else if (w.startsWith("--work-tree=")) {
      tree = w.slice("--work-tree=".length);
      k++;
    } else if (/^(-c|--git-dir|--namespace|--config-env)$/.test(w)) k += 2;
    else if (w.startsWith("-")) k++;
    else break;
  }
  const sub = at(k);
  const next = at(k + 1);
  if (/^(add|am|checkout|cherry-pick|clean|commit|merge|mergetool|pull|rebase|reset|restore|revert|rm|switch)$/.test(sub)) {
  } else if (sub === "stash") {
    if (next === "list" || next === "show") return [];
  } else if (sub === "apply") {
    const all = ` ${words.slice(k).join(" ")} `;
    if (!all.includes(" --apply ") && /( --check | --stat | --numstat | --summary )/.test(all)) return [];
  } else if (sub === "bisect") {
    if (/^(|log|view|visualize|terms|help)$/.test(next)) return [];
  } else if (sub === "sparse-checkout") {
    if (/^(|list|check-rules)$/.test(next)) return [];
  } else if (sub === "submodule") {
    let j = k + 1;
    while (j < n && words[j].startsWith("-")) j++;
    if (!/^(update|add|deinit|absorbgitdirs)$/.test(at(j))) return [];
  } else if (sub === "read-tree") {
    let j = k + 1;
    for (; j < n; j++) {
      const w = words[j];
      if (w === "--") break;
      if (w.startsWith("--")) continue;
      if (/^-.*u/s.test(w)) break;
    }
    if (!(j < n && words[j] !== "--")) return [];
  } else if (sub === "checkout-index") {
    for (let j = k + 1; j < n; j++) {
      if (/^--prefix=./s.test(words[j])) {
        outs.push(words[j].slice("--prefix=".length));
        usetree = false;
      }
    }
  } else if (sub === "init") {
    usetree = false;
    for (let j = k + 1; j < n; j++) {
      const w = words[j];
      if (w === "--separate-git-dir") {
        outs.push(at(j + 1));
        j++;
      } else if (w.startsWith("--separate-git-dir=")) outs.push(w.slice(w.indexOf("=") + 1));
      else if (/^(--template|-b|--initial-branch|--object-format|--ref-format)$/.test(w)) j++;
      else if (w.startsWith("-")) continue;
      else if (dir === "") dir = w;
    }
    outs.push(dir || ".");
  } else if (sub === "format-patch" || sub === "archive") {
    usetree = false;
    const fp = sub === "format-patch";
    for (let j = k + 1; j < n; j++) {
      const w = words[j];
      if (fp && w === "--stdout") return [];
      if (w === "-o" || w === "--output" || fp && w === "--output-directory") {
        outs.push(at(j + 1));
        j++;
      } else if (w.startsWith("--output=") || fp && w.startsWith("--output-directory=")) outs.push(w.slice(w.indexOf("=") + 1));
      else if (/^-o./s.test(w)) outs.push(w.slice(2));
      else if (w === "--") break;
    }
    if (outs.length === 0 && sub !== "archive") outs.push(".");
  } else return [];
  if (usetree) outs = [tree || ".", ...outs];
  return outs.filter((w) => w !== "").map((w) => chain2 ? under(cdir, w) : w);
}
function extraWrites(chain2, words, interp) {
  const out2 = [];
  let ops = [];
  const tool = basename4(words[0]);
  if (tool === "sed" || tool === "perl") out2.push(...inplaceFiles(tool, words.slice(1)));
  else if (tool === "mv") ops = words.slice(1);
  else if (tool === "git") {
    let k = 1;
    while (k < words.length) {
      if (words[k] === "-C" || words[k] === "-c") k += 2;
      else if (words[k].startsWith("-")) k++;
      else break;
    }
    if (words[k] === "mv") ops = words.slice(k + 1);
    out2.push(...gitTree(chain2, words));
  }
  const srcs = ops.filter((w) => !w.startsWith("-"));
  if (srcs.length >= 2) out2.push(...srcs.slice(0, -1));
  out2.push(...interp(words));
  return out2;
}
function stmtWritePaths(stmt, chain2, interp) {
  const paths = writeTargets(stmt);
  const { pre, words } = unwrapStatement(stmt);
  if (words.length <= 1) return { paths, words };
  if (pre === "") paths.push(...extraWrites(chain2, words, interp));
  else for (const p of extraWrites(true, words, interp)) if (p !== "") paths.push(under(pre, p));
  return { paths, words };
}

// src/hooks/cmd-analysis/write-paths.ts
var BAD2 = "";
var MAX_DEPTH = 3;
var VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var PROG_DIR = "/.tmb-prog-dir";
var XARGS_VALUE = /^(-d|-E|-L|-n|-P|-s|-R|-S|--delimiter|--max-lines|--max-args|--max-procs|--max-chars)$/;
var WATCH_VALUE = /^(-[A-Za-z]*[nq]|--interval|--equexit)$/;
var BODY_UNRESOLVED = /^UNRESOLVED:(?!\$\(|PWD:)/;
var INFO = {
  py: /^(-V|-VV|--version|-h|--help|-\?)$/,
  node: /^(-v|--version|-h|--help|--v8-options|-c|--check)$/,
  perl: /^(-v|-V|-h)$/,
  ruby: /^(-v|--version|-h|--help|-c|-y)$/,
  sh: /^(--version|--help|-n)$/
};
var basename5 = (w) => w.replace(/.*\//, "");
var chomp2 = (s) => s.replace(/\n+$/, "");
var dec = (s) => chomp2(decode(s));
var before = (s, sep2) => {
  const k = s.indexOf(sep2);
  return k < 0 ? s : s.slice(0, k);
};
var after = (s, sep2) => {
  const k = s.indexOf(sep2);
  return k < 0 ? s : s.slice(k + sep2.length);
};
var shellWords = (s) => s.split(/[ \t\n]+/).filter((w) => w !== "");
function dirPath(tok, cwd) {
  if (tok.startsWith("/")) return tok;
  if (tok === "@") return cwd;
  if (tok.startsWith("@/")) return cwd === "" ? "" : `${cwd.replace(/\/$/, "")}/${tok.slice(2)}`;
  return "";
}
function normalize(p) {
  const lead = p.startsWith("/") ? "/" : "";
  const out2 = [];
  for (const part of p === "" ? [] : p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out2.length > 0 && out2[out2.length - 1] !== "..") {
      out2.pop();
      continue;
    }
    if (part === ".." && lead === "/") continue;
    out2.push(part);
  }
  const joined = out2.join("/");
  return lead + (joined === "" && lead === "" ? "." : joined);
}
function computedLine(text) {
  return `UNRESOLVED:${COMPUTED}${shown(text)}
`;
}
function unprovenLine(text) {
  return `UNRESOLVED:${UNPROVEN}${shown(text)}
`;
}
function parseLine(cmd) {
  return `UNRESOLVED:${PARSE}${[...cmd].slice(0, 80).join("").replace(/[\r\n]/g, " ")}
`;
}
function inner(stmt) {
  const words = shellWords(stmt);
  const argv0 = words[0] ?? "";
  if (basename5(argv0) === "watch") {
    let i2 = 1;
    while (i2 < words.length && words[i2].startsWith("-")) {
      const w = words[i2++];
      if (w === "--") break;
      if (WATCH_VALUE.test(w)) i2++;
    }
    return words.slice(i2).join(" ");
  }
  if (/^(.*\/)?(bash|sh|zsh|dash|ksh)$/.test(argv0)) {
    for (let i2 = 1; i2 < words.length; i2++) {
      const w = words[i2];
      if (w === "-c" || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i2 + 1] ?? "";
      if (!w.startsWith("-")) return "";
    }
    return "";
  }
  if (argv0 === "eval") return stmt.slice(4).replace(/^ /, "");
  const builtin = /^(builtin|command)[ \t]+eval(?:[ \t]+|$)/.exec(stmt);
  return builtin ? stmt.slice(builtin[0].length) : "";
}
function evalArgs(words) {
  if (words[0] === "eval") return words.slice(1);
  if ((words[0] === "builtin" || words[0] === "command") && words[1] === "eval") return words.slice(2);
  return void 0;
}
var SET_IN_TEXT = /(?<![A-Za-z0-9_$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?[ \t]*(?:[-+*/%&^|]|<<|>>)?=(?!=)/g;
var STEPPED = /(?:\+\+|--)[ \t]*([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:\+\+|--)/g;
function setInText(text) {
  const names = [...text.matchAll(SET_IN_TEXT)].map((m) => m[1]);
  if (/\(\(|\$\[|\[|^let\b/.test(text)) for (const m of text.matchAll(STEPPED)) names.push(m[1] ?? m[2]);
  return names;
}
function stdinProgram(words) {
  const argv0 = basename5(words[0]);
  let kind;
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) kind = "py";
  else if (argv0 === "node" || argv0 === "nodejs") kind = "node";
  else if (argv0 === "perl") kind = "perl";
  else if (argv0 === "ruby") kind = "ruby";
  else if (/^(sh|bash|zsh|dash|ksh)$/.test(argv0)) kind = "sh";
  else return { kind: "", info: false };
  const none = { kind: "", info: false };
  let info2 = false;
  let skip = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (skip) {
      skip = false;
      continue;
    }
    if (w === "<<<") {
      skip = true;
      continue;
    }
    if (w.startsWith("<<")) continue;
    if (/^(<|>|>>|>\||&>|&>>|[0-9]<|[0-9]>|[0-9]>>)$/.test(w)) {
      skip = true;
      continue;
    }
    if (/^(<|>|&>|[0-9]<|[0-9]>)/.test(w)) continue;
    if (w === "-" || w === "--") return { kind, info: info2 };
    if (INFO[kind].test(w)) info2 = true;
    const kw = `${kind}:${w}`;
    if (w.startsWith("--")) {
      if (/^node:--(eval|print)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(test|run|watch|watch-path)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(require|import|loader|input-type)$/.test(kw)) skip = true;
      continue;
    }
    if (w.startsWith("-")) {
      if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw)) return none;
      if (/^py:-[bBdEhiIOPqRsSuvVx]*m/.test(kw)) return none;
      if (/^sh:-.*s/s.test(kw)) return { kind, info: info2 };
      if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw)) skip = true;
      continue;
    }
    return none;
  }
  return { kind, info: info2 };
}
var stdinInterp = (words) => stdinProgram(words).kind;
var WritePaths = class _WritePaths {
  constructor(parser2, opts) {
    this.parser = parser2;
    this.opts = opts;
  }
  parser;
  opts;
  out = "";
  pwd = "";
  rootc;
  envVar(name3, level) {
    const { env } = this.opts;
    let v = "";
    switch (name3) {
      case "PWD":
        v = this.pwd;
        break;
      case "OLDPWD":
        v = dirPath(level.oldtok || "-", this.opts.cwd);
        break;
      case "HOME":
        v = env.HOME ?? "";
        break;
      case "TMPDIR":
        v = env.TMPDIR ?? "";
        break;
      case "CLAUDE_PROJECT_DIR":
        v = env.CLAUDE_PROJECT_DIR ?? "";
        break;
      case "TMB_MODEL_CACHE_DIR":
        v = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || "";
        if (v === "" && env.HOME) v = `${env.HOME}/.cache/huggingface`;
        break;
    }
    return v === "" ? null : chomp2(v);
  }
  varGet(vars, name3) {
    let found = false;
    let out2 = "";
    for (const line of vars.split("\n")) {
      if (!line.startsWith(name3 + "	")) continue;
      out2 += after(line, "	") + "\n";
      found = true;
    }
    return found ? chomp2(out2) : null;
  }
  /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it. */
  expand(word, level) {
    let rest = word;
    let acc = [""];
    const fail = (unres) => ({ ok: false, unres });
    for (; ; ) {
      const at = rest.search(/[$`]/);
      if (at < 0) {
        acc = acc.map((a) => a + rest);
        break;
      }
      const lit = rest.slice(0, at);
      rest = rest.slice(at);
      acc = acc.map((a) => a + lit);
      let name3;
      let def = null;
      let cut = "";
      if (rest.startsWith("$(proc)")) return fail("$(proc)");
      if (rest.startsWith("$(alias-write)")) return fail("$(alias-write)");
      if (rest.startsWith("`") || rest.startsWith("$(")) return fail("$()");
      if (rest.startsWith("${")) {
        let a = rest.slice(2);
        if (!a.includes("}")) return fail(rest);
        rest = after(a, "}");
        a = before(a, "}");
        name3 = /^[A-Za-z0-9_]*/.exec(a)[0];
        const op = a.slice(name3.length);
        if (name3 === "" || /^[0-9]/.test(name3)) return fail("${" + a + "}");
        if (op === "") {
        } else if (op.startsWith(":-") || op.startsWith(":=")) def = op.slice(2);
        else if (op.startsWith("-") || op.startsWith("=")) def = op.slice(1);
        else if (op.startsWith("%")) {
          cut = op.slice(1).replace(/^%/, "");
          if (cut === "" || /[^A-Za-z0-9._-]/.test(cut)) return fail(name3);
        } else return fail(name3);
      } else if (/^\$[A-Za-z_]/.test(rest)) {
        const a = rest.slice(1);
        name3 = /^[A-Za-z0-9_]*/.exec(a)[0];
        rest = a.slice(name3.length);
      } else if (/^\$[0-9@*#?$!-]/.test(rest)) return fail(rest.slice(0, 2));
      else {
        acc = acc.map((a) => a + "$");
        rest = rest.slice(1);
        continue;
      }
      let vals = this.varGet(level.vars, name3);
      if (vals !== null) {
        if (vals.includes(BAD2)) return fail(name3);
      } else if (def !== null) {
        if (/[$`]/.test(def)) return fail(name3);
        vals = def;
      } else {
        vals = this.envVar(name3, level);
        if (vals === null) return fail(name3);
      }
      const next = [];
      for (const a of acc) {
        for (const v of vals.split("\n")) next.push(a + (cut !== "" && v.endsWith(cut) ? v.slice(0, -cut.length) : v));
      }
      if (next.length > 16) return fail(name3);
      acc = next;
    }
    return { ok: true, values: acc };
  }
  poison(level, name3) {
    if (VAR_NAME.test(name3)) level.vars += `${name3}	${BAD2}
`;
  }
  varSet(level, name3, value) {
    for (const set of setInText(value)) this.poison(level, set);
    if (!VAR_NAME.test(name3)) {
      this.poison(level, /^[A-Za-z_][A-Za-z0-9_]*/.exec(name3)?.[0] ?? "");
      return;
    }
    const e = this.expand(value, level);
    if (e.ok) for (const v of e.values) level.vars += `${name3}	${v}
`;
    else level.vars += `${name3}	${BAD2}
`;
  }
  /** _tmb_cmd_join: <p> joined to its statement's dir and normalized, newline-terminated. */
  join(dir, p) {
    const { cwd, raw, env } = this.opts;
    if (/[$`]/.test(p)) return p + "\n";
    if (p === "~" || p.startsWith("~/")) {
      if (!env.HOME) return p + "\n";
      p = env.HOME + p.slice(1);
    }
    let base = "";
    if (!p.startsWith("/")) {
      if (dir === "-") return p === "." ? "UNRESOLVED:PWD:$PWD\n" : `UNRESOLVED:PWD:$PWD/${p}
`;
      if (dir === "@") base = cwd;
      else if (dir.startsWith("@/")) base = (cwd === "" ? "" : `${cwd.replace(/\/$/, "")}/`) + dir.slice(2);
      else base = dir;
    }
    if (raw) {
      if (p === "." && base !== "") return base + "\n";
      return (base === "" ? "" : `${base.replace(/\/$/, "")}/`) + p + "\n";
    }
    return ((base === "" ? "" : base + "/") + p).split("\n").map(normalize).join("\n") + "\n";
  }
  /** _tmb_cmd_emit */
  emit(level, dir, p, why = level.why) {
    if (p.startsWith(COMPUTED)) {
      this.out += computedLine(p.slice(COMPUTED.length));
      return;
    }
    if (p.startsWith(PARSE)) {
      this.out += parseLine(p.slice(PARSE.length));
      return;
    }
    if (p.startsWith(UNPROVEN)) {
      this.out += unprovenLine(p.slice(UNPROVEN.length));
      return;
    }
    if (dir === "-" && why !== "" && !/^[/~$`]/.test(p)) {
      let v = dec(after(why, WSEP));
      if (p !== ".") v = `${v.replace(/\/$/, "")}/${p}`;
      this.emit(level, before(why, WSEP), v, "");
      return;
    }
    if (!/[$`]/.test(p)) {
      this.out += this.join(dir, p);
      return;
    }
    this.pwd = dirPath(dir, this.opts.cwd);
    const e = this.expand(p, level);
    if (e.ok) {
      for (const v of e.values) this.out += this.join(dir, v);
      return;
    }
    if (!/^[/~$`]/.test(p)) {
      if (dir === "-") p = "$PWD/" + p;
      else {
        const base = chomp2(this.join(dir, "."));
        if (base !== ".") p = `${base.replace(/\/$/, "")}/${p}`;
      }
    }
    this.out += `UNRESOLVED:${e.unres}:${p}
`;
  }
  listerHost(level) {
    const { cwd, root, env } = this.opts;
    return {
      cwd,
      root,
      home: env.HOME ?? "",
      rootc: () => this.rootc ??= pathCanonical2(root),
      expand: (word) => {
        const e = this.expand(word, level);
        return e.ok ? e.values : null;
      }
    };
  }
  bind(level, name3, values) {
    if (values === null) return false;
    for (const v of values) level.vars += `${name3}	${v}
`;
    return true;
  }
  /** _tmb_cmd_loop_source: the variable bound from the lister of a source mark (\022<dir>\022<word>…). */
  loopSource(level, name3, mark) {
    let m = mark.replace(/^\x12/, "");
    const dirtok = before(m, SEP);
    m = dec(m.slice(dirtok.length).replace(/^\x12/, ""));
    const fields = before(m, "\n").split(SEP);
    if (fields[fields.length - 1] === "") fields.pop();
    if (fields.length === 0) return false;
    return this.bind(level, name3, listerBind(this.listerHost(level), name3, dirtok, "loop", fields, []));
  }
  /** _tmb_cmd_exec_writes: what a find / fd / xargs statement writes through the command it runs. */
  execWrites(outer, dir, mark, words, tok, depth) {
    const level = { ...outer };
    const tool = basename5(words[0]);
    const acts = [];
    let name3;
    if (tool === "find") name3 = "find_path";
    else if (tool === "fd" || tool === "fdfind") name3 = "fd_path";
    else if (tool === "xargs") {
      name3 = "xargs_arg";
      const n = words.length;
      let k = 1;
      let rep = "";
      let noin = false;
      while (k < n) {
        const p = words[k];
        if (p === "--") {
          k++;
          break;
        }
        if (p === "-I" || p === "-J") {
          rep = words[k + 1] ?? "";
          k += 2;
          continue;
        }
        k++;
        if (p.startsWith("-I") || p.startsWith("-J")) rep = p.slice(2);
        else if (p === "-i" || p === "--replace") rep = "{}";
        else if (p.startsWith("-i")) rep = p.slice(2);
        else if (p.startsWith("--replace=")) rep = p.slice(10);
        else if (p === "-a" || p === "--arg-file") {
          noin = true;
          k++;
        } else if (p.startsWith("-a") || p.startsWith("--arg-file=")) noin = true;
        else if (XARGS_VALUE.test(p)) k++;
        else if (!p.startsWith("-")) {
          k--;
          break;
        }
      }
      if (k >= n) return;
      const rv2 = "${" + name3 + "}";
      let cmd = words.slice(k).join(" ");
      cmd = rep !== "" ? cmd.split(rep).join(rv2) : `${cmd} ${rv2}`;
      acts.push("x" + cmd);
      if (noin || mark === "" || !this.loopSource(level, name3, mark)) level.vars += `${name3}	${BAD2}
`;
    } else return;
    if (tool !== "xargs" && !this.bind(level, name3, listerBind(this.listerHost(level), name3, dir, "exec", words, acts))) {
      level.vars += `${name3}	${BAD2}
`;
    }
    const rv = "${" + name3 + "}";
    for (const act of acts) {
      if (act === "d") this.emit(level, dir, rv);
      else if (act.startsWith("f")) this.emit(level, dir, dec(act.slice(1)));
      else if (act.startsWith("x")) {
        let cmd = act.slice(1);
        if (tool === "find") cmd = cmd.split("{}").join(rv);
        else if (tool !== "xargs") {
          for (const ph of ["{//}", "{.}", "{}"]) cmd = cmd.split(ph).join(rv);
          for (const ph of ["{/.}", "{/}"]) cmd = cmd.split(ph).join("*");
        }
        for (const p of stmtWritePaths(cmd, true, this.interp).paths) if (p !== "") this.emit(level, dir, dec(p));
        this.execShell(level, cmd, tok, depth);
      }
    }
  }
  /**
   * TS only: the body of a shell that find / fd / xargs run (`-exec sh -c
   * '…"$0"…' {} \;`, `xargs -I % sh -c 'echo > %'`), judged as a command with
   * the placeholder bound. A target left on a variable (a positional
   * parameter, `for f;`, the unbound placeholder) fails closed as $(computed).
   */
  execShell(level, cmd, tok, depth) {
    const body2 = inner(unwrapStatement(cmd).words.join(" "));
    if (body2 === "") return;
    const text = dec(body2);
    if (depth >= MAX_DEPTH) {
      this.out += computedLine(text);
      return;
    }
    const outer = this.out;
    this.out = "";
    this.run(text, tok, depth + 1, level.vars);
    const lines2 = this.out.split("\n");
    lines2.pop();
    this.out = outer;
    let failed = false;
    for (const line of lines2) {
      if (BODY_UNRESOLVED.test(line)) failed = true;
      else this.out += line + "\n";
    }
    if (failed) this.out += computedLine(text);
  }
  /**
   * _tmb_cmd_proc_writes: what a program's process call writes, relative paths
   * under `$(proc)/`. A nested `$(parse)` or `$(computed)` line keeps its
   * reason (TS-only): the .sh strips it to its text, which is then judged as a path.
   */
  procWrites(cmd) {
    const out2 = [];
    for (const record of this.listing(cmd, "@", 0)) {
      if (record.dir.startsWith("=")) continue;
      const { words } = unwrapStatement(record.stmt);
      if (words.length === 0) continue;
      if (/[$`]/.test(dec(words[0]))) {
        out2.push("$(proc)");
        continue;
      }
      if (!cmd.includes("<<") && stdinInterp(words) !== "") out2.push("$(proc)");
    }
    const nested = new _WritePaths(this.parser, { cwd: PROG_DIR, raw: true, root: "", env: this.opts.env });
    nested.run(cmd, "@", 0, "");
    const lines2 = nested.out.split("\n");
    lines2.pop();
    for (let p of lines2) {
      if (p.startsWith(`UNRESOLVED:${COMPUTED}`) || p.startsWith(`UNRESOLVED:${PARSE}`) || p.startsWith(`UNRESOLVED:${UNPROVEN}`)) {
        out2.push(p.slice("UNRESOLVED:".length));
        continue;
      }
      if (p.startsWith("UNRESOLVED:PWD:")) p = "$(proc)";
      else if (p.startsWith("UNRESOLVED:") && p.indexOf(":", 11) >= 0) p = p.slice(p.indexOf(":", 11) + 1);
      if (p === "") continue;
      if (p === PROG_DIR) p = ".";
      else if (p.startsWith(PROG_DIR + "/")) p = p.slice(PROG_DIR.length + 1);
      else if (!/^[/~$]/.test(p)) p = "$(proc)/" + p;
      out2.push(p);
    }
    return out2.join("\n");
  }
  /** _tmb_cmd_statements_enc to depth 3: bash -c / eval bodies listed as their own statements. */
  listing(cmd, base, depth) {
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) return [];
    const out2 = [];
    for (const record of statementsEnc(encoded.text, base, this.opts.env.HOME ?? "", true)) {
      if (/^\t*$/.test(record.stmt)) continue;
      const body2 = depth < MAX_DEPTH && !record.dir.startsWith("=") ? inner(record.stmt) : "";
      if (body2 !== "") out2.push(...this.listing(dec(body2), record.dir, depth + 1));
      else out2.push(record);
    }
    return out2;
  }
  /** The `heldKey` of every word of the command `run` is in whose text the shell fills in part of. */
  held = /* @__PURE__ */ new Set();
  isHeld(word) {
    return this.held.has(heldKey(word));
  }
  interp = (words) => interpWrites(
    words,
    (cmd) => this.procWrites(cmd),
    (w) => this.isHeld(w)
  );
  /**
   * _tmb_cmd_track_vars. The TS poisons the names a declare-like builtin sets
   * with an option other than -x / -r / -g / -t (`declare -n`, `-a`, `-i`,
   * ...), and those mapfile / readarray, getopts and unset set (GH 1739).
   */
  trackVars(level, words) {
    switch (basename5(words[0])) {
      case "export":
      case "declare":
      case "typeset":
      case "local":
      case "readonly": {
        const plain = words.slice(1).every((w) => !/^[-+]/.test(w) || /^[-+][xrgt]+$/.test(w));
        for (const w of words.slice(1)) {
          if (!/^[A-Za-z_].*=/s.test(w)) continue;
          if (plain) this.varSet(level, before(w, "="), dec(after(w, "=")));
          else this.poison(level, before(w, "="));
        }
        if (!plain) for (const w of words.slice(1)) this.poison(level, w);
        return;
      }
      case "mapfile":
      case "readarray":
        for (const w of [...words.slice(1), "MAPFILE"]) this.poison(level, w);
        return;
      case "unset":
        for (const w of words.slice(1)) this.poison(level, w);
        return;
      case "getopts":
        this.poison(level, words[2] ?? "");
        return;
      case "for": {
        if (words[2] !== "in") {
          level.vars += `${words[1] ?? ""}	${BAD2}
`;
          return;
        }
        const name3 = words[1] ?? "";
        const rest = words.slice(3);
        if (rest.length === 1 && rest[0].startsWith("$")) {
          if (!this.loopSource(level, name3, rest[0].slice(3))) level.vars += `${name3}	${BAD2}
`;
          return;
        }
        for (const w of rest) this.varSet(level, name3, dec(w));
        return;
      }
      case "read": {
        let mk = "";
        let skip = false;
        const names = [];
        for (const w of words.slice(1)) {
          if (skip) {
            skip = false;
            continue;
          }
          if (w.startsWith(SEP)) mk = w;
          else if (w === "-d") skip = true;
          else if (w === "-r" || w === "-e") continue;
          else if (w.startsWith("-")) mk = "!";
          else if (/^[A-Za-z_]/.test(w)) names.push(w);
        }
        if (names.length === 1 && mk !== "" && mk !== "!" && this.loopSource(level, names[0], mk)) return;
        for (const w of names) level.vars += `${w}	${BAD2}
`;
        return;
      }
      case "printf":
        if (words[1] === "-v") level.vars += `${words[2] ?? ""}	${BAD2}
`;
        return;
    }
  }
  /** _tmb_cmd_write_paths_in */
  run(cmd, base, depth, vars) {
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) {
      this.out += parseLine(cmd);
      return;
    }
    const outer = this.held;
    this.held = encoded.held;
    try {
      this.runEncoded(encoded.text, encoded.heredocs, base, depth, vars);
    } finally {
      this.held = outer;
    }
  }
  /** The names a statement's words may set beyond what `trackVars` follows; a declare-like builtin's own `name=` words are its to judge. */
  poisonSet(level, words) {
    const declares = /^(export|declare|typeset|local|readonly)$/.test(basename5(words[0]));
    for (const w of words) {
      if (declares && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
      for (const name3 of setInText(dec(w))) this.poison(level, name3);
    }
  }
  runEncoded(text, heredocs2, base, depth, vars) {
    const level = { vars, oldtok: "-", why: "" };
    const { cwd } = this.opts;
    const records = statementsEnc(text, base, this.opts.env.HOME ?? "", true).filter((r) => !/^\t*$/.test(r.stmt));
    const bodies = heredocAlign(heredocs2, records);
    let idx = 0;
    for (const record of records) {
      idx++;
      let dir = record.dir;
      let old = dir.includes(SEP) ? after(dir, SEP) : "-";
      dir = before(dir, SEP);
      let why = "";
      if (old.includes(SEP)) {
        why = after(old, SEP);
        old = before(old, SEP);
      }
      level.oldtok = old;
      level.why = why;
      let words = shellWords(record.stmt);
      if (words.length === 0) continue;
      if (dir.startsWith("=")) {
        this.pwd = dirPath(dir.slice(1), cwd);
        for (const w of words) this.varSet(level, before(w, "="), dec(after(w, "=")));
        continue;
      }
      const tok = dir + SEP + old + (why === "" ? "" : SEP + why);
      const chain2 = dir === "-" && why === "";
      const body2 = inner(record.stmt);
      const evaluated = evalArgs(words);
      this.poisonSet(level, words);
      for (const h of bodies.get(idx) ?? []) if (h.expands) for (const name3 of setInText(h.body)) this.poison(level, name3);
      const argv0 = unwrapStatement(record.stmt).words[0] ?? "";
      if (/[$`\x07]/.test(decode(argv0))) this.out += unprovenLine(dec(record.stmt));
      if (evaluated?.some((w) => this.isHeld(w))) this.out += unprovenLine(dec(record.stmt));
      else if (body2 !== "" && !evaluated && this.isHeld(body2)) this.out += unprovenLine(`${basename5(dec(words[0]))} ${dec(body2)}`);
      const ownWords = body2 !== "" && !evaluated && basename5(words[0]) !== "watch";
      if (ownWords) {
        for (const p of stmtWritePaths(record.stmt, chain2, this.interp).paths) if (p !== "") this.emit(level, dir, dec(p));
      }
      if (body2 !== "" && !evaluated && heldProgram(body2)) {
        this.out += computedLine(`${basename5(dec(words[0]))} ${dec(body2)}`);
        continue;
      }
      if (body2 !== "" && depth < MAX_DEPTH) {
        this.run(dec(body2), tok, depth + 1, level.vars);
        continue;
      }
      if (body2 !== "") this.out += computedLine(dec(body2));
      let stmt = record.stmt;
      let mark = "";
      if (basename5(words[0]) === "xargs" && words[words.length - 1].startsWith(SEP)) {
        mark = words[words.length - 1];
        words = words.slice(0, -1);
        stmt = words.join(" ");
      }
      if (!ownWords) {
        for (const p of stmtWritePaths(stmt, chain2, this.interp).paths) if (p !== "") this.emit(level, dir, dec(p));
      }
      if (/^(find|fd|fdfind|xargs)$/.test(basename5(words[0]))) this.execWrites(level, dir, mark, words, tok, depth);
      const { kind, info: info2 } = stdinProgram(words);
      if (kind !== "") {
        const progs = [];
        const herestring = (w) => {
          progs.push({ prog: dec(w), held: heldProgram(w), partly: this.isHeld(w) });
        };
        for (let w = 0; w < words.length; w++) {
          if (words[w] === "<<<") herestring(words[w + 1] ?? "");
          else if (words[w].startsWith("<<<")) herestring(words[w].slice(3));
        }
        for (const h of bodies.get(idx) ?? []) progs.push({ prog: h.body, held: heldProgram(h.body), partly: h.expands });
        if (progs.length === 0 && !info2) this.out += computedLine(basename5(dec(words[0])));
        const shownArgv0 = basename5(dec(words[0]));
        for (const { prog, held, partly } of progs) {
          if (held) this.out += computedLine(`${shownArgv0} ${prog}`);
          else if (kind === "sh") {
            if (partly) this.out += unprovenLine(`${shownArgv0} ${prog}`);
            if (depth < MAX_DEPTH) this.run(prog, tok, depth + 1, level.vars);
            else this.out += computedLine(prog);
          } else {
            const found = progWrites(kind, prog, false, (c) => this.procWrites(c));
            for (const p of found.lines) if (p !== "") this.emit(level, dir, p);
            if (found.computed) this.out += computedLine(shownArgv0);
            if (partly || found.unproven) this.out += unprovenLine(`${shownArgv0} ${prog}`);
          }
        }
      }
      this.pwd = dirPath(dir, cwd);
      this.trackVars(level, words);
    }
  }
};
function heredocAlign(heredocs2, records) {
  const out2 = /* @__PURE__ */ new Map();
  if (heredocs2.length === 0) return out2;
  const used = /* @__PURE__ */ new Set();
  let p = -1;
  records.forEach((record, i2) => {
    for (const m of record.stmt.matchAll(/<<+([^ \t;&|<>()]*)/g)) {
      if (m[0].length - m[1].length !== 2 || m[1] === "") continue;
      let j = p + 1;
      while (j < heredocs2.length && (used.has(j) || heredocs2[j].delim !== m[1])) j++;
      if (j >= heredocs2.length) continue;
      used.add(j);
      p = j;
      out2.set(i2 + 1, [...out2.get(i2 + 1) ?? [], heredocs2[j]]);
    }
  });
  return out2;
}
function writePathsWith(parser2, command, opts) {
  const w = new WritePaths(parser2, opts);
  w.run(command, "@", 0, "");
  const lines2 = w.out.split("\n");
  if (lines2[lines2.length - 1] === "") lines2.pop();
  return lines2;
}

// src/hooks/lib/git.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { statSync as statSync7 } from "node:fs";
var GIT_MAX_BUFFER = 256 * 1024 * 1024;
function gitRun(dir, args2, env = process.env, input = "") {
  const r = spawnSync3("git", ["-C", dir, ...args2], {
    encoding: "utf8",
    env,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["pipe", "pipe", "ignore"]
  });
  return { code: r.error ? -1 : r.status ?? -1, stdout: r.stdout ?? "" };
}
function gitOut(dir, args2, env = process.env, input = "") {
  return gitRun(dir, args2, env, input).stdout.replace(/\n+$/, "");
}
function gitOk(dir, args2, env = process.env) {
  return gitRun(dir, args2, env).code === 0;
}
function isDir2(path) {
  if (path === "") return false;
  try {
    return statSync7(path).isDirectory();
  } catch {
    return false;
  }
}
function cdPwd(path, pwd) {
  if (!isDir2(path === "" ? "." : path)) return "";
  const abs = path.startsWith("/") ? path : `${pwd.replace(/\/$/, "")}/${path}`;
  const out2 = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out2.pop();
    else out2.push(part);
  }
  return `/${out2.join("/")}`;
}

// src/hooks/cmd-analysis/git.ts
var MAX_DEPTH2 = 3;
var SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;
var ENCODED = /[\x01-\x06\x0e-\x11\x13\x15\x16]/g;
var HD_MARK2 = /<<[\x1a\x1e]/g;
function readWords(s) {
  return (s.split("\n")[0] ?? "").split(/[ \t]+/).filter((w) => w !== "");
}
function readStmt(stmt) {
  return stmt.replace(/^\t+|\t+$/g, "");
}
function inner2(stmt) {
  const words = readWords(stmt);
  const argv0 = words[0] ?? "";
  if (SHELL.test(argv0)) {
    for (let i2 = 1; i2 < words.length; i2++) {
      const w = words[i2];
      if (w === "-c" || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i2 + 1] ?? "";
      if (!w.startsWith("-")) return "";
    }
    return "";
  }
  if (argv0 === "eval") return (stmt.startsWith("eval") ? stmt.slice(4) : stmt).replace(/^ /, "");
  return "";
}
function listing(parser2, cmd, base, depth, home) {
  if (cmd.trim() === "") return [];
  const encoded = encode(parser2, cmd);
  if (!encoded.ok) return null;
  const out2 = [];
  for (const record of statementsEnc(encoded.text, base, home, false)) {
    const stmt = readStmt(record.stmt);
    if (stmt === "") continue;
    const body2 = depth < MAX_DEPTH2 && !record.dir.startsWith("=") ? inner2(stmt) : "";
    if (body2 === "") {
      out2.push({ dir: record.dir, stmt });
      continue;
    }
    const nested = listing(parser2, decode(body2).replace(/\n+$/, ""), record.dir, depth + 1, home);
    if (nested === null) return null;
    out2.push(...nested);
  }
  return out2;
}
function cwdState(cwd, env = process.env) {
  if (!isDir2(cwd)) return "-";
  if (gitOk(cwd, ["rev-parse", "--git-dir"], env)) {
    const n = gitOut(cwd, ["worktree", "list", "--porcelain"], env).split("\n").filter((l) => l.startsWith("worktree ")).length;
    if (n > 1) return "?";
  }
  return cwd;
}
async function cmdStatements(command, cwd, env = process.env) {
  const parser2 = await bashParser();
  const listed2 = listing(parser2, command, "@", 0, env.HOME ?? "");
  if (listed2 === null) return { ok: false };
  let state;
  const statements = listed2.map(({ dir, stmt }) => {
    if (dir.startsWith("@/")) dir = isDir2(cwd) ? `${cwd.replace(/\/$/, "")}${dir.slice(1)}` : "-";
    else if (dir === "@") dir = state ??= cwdState(cwd, env);
    return { dir, stmt: stmt.replace(HD_MARK2, "<<").replace(ENCODED, "_") };
  });
  return { ok: true, statements };
}
function gitSubcommand(stmt) {
  const w = readWords(stmt);
  if (w[0] !== "git") return "";
  let k = 1;
  while (k < w.length) {
    const word = w[k];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(word)) k += 2;
    else if (word.startsWith("-")) k += 1;
    else break;
  }
  return k < w.length ? w.slice(k).join(" ") : "";
}
function stmtRepoRoot(dir, cwd, env = process.env) {
  if (dir === "?") dir = cwd || shellPwd(env);
  else if (dir === "-" || dir === "") return "";
  while (!isDir2(dir)) {
    const slash = dir.lastIndexOf("/");
    if (slash < 0) return "";
    dir = dir.slice(0, slash) || "/";
  }
  const common = gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  if (common === "") return "";
  if (common.endsWith("/.git")) return cdPwd(common.slice(0, -5), shellPwd(env));
  return gitOut(dir, ["rev-parse", "--show-toplevel"], env);
}
function denyAmbiguousGitTarget(stmt, unresolved = false) {
  const what = stmt || "git";
  const reason = unresolved ? `BLOCKED: ambiguous_git_target: \`${what}\` runs in a directory that comes through a variable, \`cd -\` or popd the guard cannot resolve, and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Pass the literal path: git -C <path> or cd <path> && \u2026` : `BLOCKED: ambiguous_git_target: \`${what}\` names no directory and this repo has linked worktrees, so the guard cannot tell which checkout (and branch) it runs in. Run with git -C <path> or cd <path> && \u2026`;
  return `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}
`;
}

// src/hooks/cmd-analysis/index.ts
async function writePaths(command, options = {}) {
  if (command.trim() === "") return [];
  const parser2 = await bashParser();
  const opts = {
    cwd: options.cwd ?? "",
    raw: options.raw ?? false,
    root: options.root ?? "",
    env: options.env ?? process.env
  };
  let lines2 = writePathsWith(parser2, command, opts);
  while (await loadWanted()) lines2 = writePathsWith(parser2, command, opts);
  return lines2;
}

// src/hooks/containment-guard.ts
var HOOK = "containment-guard";
var RUN_BUDGET_MS = "2500";
var JUDGED_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
var DEVICE = /^\/dev\/(null|stdout|stderr|tty)$|^\/dev\/fd\//;
var GLOB_CHAR = /[*?[]/;
var UNJUDGED_PHRASE = "cannot be judged:";
var NEVER_JUDGED = {
  "$(parse)": "the command could not be parsed, so its write targets are unknown; split it or fix its quoting.",
  "$(computed)": "the program builds the path at run time (a computed or argv path, a program held in a variable, a substitution or stdin, or an exec placeholder under `sh -c`), so the guard cannot tell where it writes; use Edit or Write on the literal path, or a Bash command whose write target is a literal path.",
  "$(unproven)": "the inline program is unproven: it calls something the guard can neither prove read-only nor judge as a write (an unlisted call, a callable held in a name, dynamic attribute access), or the shell fills in part of its text or command word, so the guard cannot tell what it writes; use Edit or Write, a plain read-only one-liner, or a script file."
};
function capture(text) {
  return stripTrailingNewlines(text.replace(/\0/g, ""));
}
function jqField2(input, ...paths) {
  return capture(jqAlternatives(input, paths));
}
function canonical(path) {
  return capture(pathCanonical(path));
}
function stripSlash(dir) {
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}
function under2(path, dir) {
  return path === dir || path.startsWith(`${stripSlash(dir)}/`);
}
function harnessTmp(uid) {
  const dir = `/tmp/claude-${uid}`;
  let link;
  try {
    link = lstatSync4(dir);
  } catch {
    link = void 0;
  }
  let target;
  try {
    target = statSync8(dir);
  } catch {
    target = void 0;
  }
  const isLink2 = link?.isSymbolicLink() ?? false;
  if (!target && !isLink2) return canonical(dir);
  if (target?.isDirectory() && !isLink2 && target.uid === (process.geteuid?.() ?? uid)) return canonical(dir);
  return "";
}
function ccSlug(dir, env) {
  const units = ctypeUtf8(env) ? [...dir] : [...Buffer.from(dir, "utf8")].map((b) => String.fromCharCode(b));
  return capture(units.map((u) => u === "\n" || /^[A-Za-z0-9]$/.test(u) ? u : "-").join(""));
}
function ccProjectDir(ccHome, dir, env) {
  const slug = ccSlug(dir, env);
  return /[A-Za-z0-9]/.test(slug) ? canonical(`${ccHome}/projects/${slug}`) : "";
}
var Denied = class {
  constructor(result) {
    this.result = result;
  }
  result;
};
var Guard = class {
  env;
  uid = process.getuid?.() ?? 0;
  db = "";
  cwd = "";
  toolName = "";
  agentId = "";
  taskId = "";
  root = "";
  rootC = "";
  unbound = false;
  bound = false;
  missing = "";
  cacheDir = "";
  cacheC = "";
  hostTmpC = "";
  harnessTmpC = "";
  ccProjectC = "";
  ccSessionC = "";
  ccPlansC = "";
  runEnv;
  constructor(env) {
    this.env = env;
    this.runEnv = env;
  }
  home() {
    return this.env.HOME ?? "";
  }
  allowed(path) {
    if (DEVICE.test(path)) return true;
    if (this.unbound) return false;
    const c = canonical(path);
    return under2(c, this.rootC) || under2(c, this.cacheC) || this.hostTmpC !== "" && this.hostTmpC !== "/" && under2(c, this.hostTmpC) || this.harnessTmpC !== "" && under2(c, this.harnessTmpC) || this.ccProjectC !== "" && under2(c, this.ccProjectC) || this.ccSessionC !== "" && under2(c, this.ccSessionC) || this.ccPlansC !== "" && under2(c, this.ccPlansC);
  }
  deny(path, given = "") {
    let reason = given;
    let why = "";
    if (this.unbound) {
      why = `unbound_caller: ${this.agentId ? `swe agent_id ${this.agentId}: ` : ""}${this.missing}`;
      reason = `BLOCKED: containment \u2014 this swe${this.agentId ? ` (agent_id ${this.agentId})` : ""} has no root to write under: ${this.missing}. An swe writes under <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt. Target: ${path}. Report this to bro.`;
    }
    const content = jqCompact({
      tool: this.toolName,
      path,
      root: this.root === "" ? null : this.root,
      task_id: this.taskId === "" ? null : Number(this.taskId),
      ...why === "" ? {} : { reason: why }
    });
    const taskId = sqlInt(this.taskId);
    let issue = "-1";
    if (taskId !== "") issue = sqlInt(sqliteRo(this.db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, this.env)) || "-1";
    const written = auditAppend(
      this.db,
      {
        issueId: issue,
        branchId: "",
        fromNode: `hook:${HOOK}`,
        eventType: "containment_denied",
        summary: `${this.toolName} denied: ${path} is outside ${this.root || `any root (unbound swe ${this.agentId})`}`,
        contentJson: content
      },
      { caller: HOOK, env: this.env }
    );
    if (written.error !== "") process.stderr.write(`${written.error}
`);
    if (reason === "") {
      reason = `BLOCKED: containment \u2014 ${path} is outside this run's root ${this.root}. TMB agents write only under their root (the task worktree for swe, the project for bro); put scratch files in ${stripSlash(this.root)}/.claude/tmb/scratch/ (or /tmp/claude-${this.uid}).`;
    }
    const decision = jqCompact({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    });
    throw new Denied({ stdout: `${written.stdout}${decision}
`, code: 0 });
  }
  /** The absolute path a write-position word names; null behind an unresolvable variable or command. */
  expand(word) {
    const home = this.home();
    let p = word;
    if (p === "~") p = home;
    else if (p.startsWith("~/")) p = `${home}/${p.slice(2)}`;
    p = p.split("${HOME}").join(home).split("$HOME").join(home);
    p = p.split("${TMB_MODEL_CACHE_DIR}").join(this.cacheDir).split("$TMB_MODEL_CACHE_DIR").join(this.cacheDir);
    if (/[$`]/.test(p) || p.startsWith("~")) return null;
    const glob = p.search(GLOB_CHAR);
    if (glob >= 0) {
      p = p.slice(0, glob);
      if (!p.endsWith("/")) p = capture(posixDirname(p));
    }
    if (!p.startsWith("/")) p = `${this.cwd}/${p}`;
    return stripTrailingNewlines(p);
  }
  unresolved(raw, variable) {
    const cut = raw.search(/[$`]/);
    const lit = cut < 0 ? raw : raw.slice(0, cut);
    const slash = lit.lastIndexOf("/");
    const dir = slash < 0 ? "" : lit.slice(0, slash) || "/";
    if (dir !== "") {
      const expanded = this.expand(dir);
      if (expanded !== null && this.allowed(expanded)) return;
    }
    this.deny(raw, `BLOCKED: write target "${raw}" ${UNJUDGED_PHRASE} ${unresolvedWhy(variable)}.`);
  }
  /** A .. leaves the root and a later name enters it again: the write lands on the root from outside. */
  climbsBack(path) {
    if (!`/${path}/`.includes("/../")) return false;
    if (this.root === "") return false;
    const line = (path.startsWith("/") ? path.slice(1) : path).split("\n")[0];
    let acc = "";
    let left = false;
    let inside = false;
    for (const part of line.split("/")) {
      if (part === "" || part === ".") continue;
      acc = part === ".." ? acc.slice(0, Math.max(0, acc.lastIndexOf("/"))) : `${acc}/${part}`;
      const at = acc || "/";
      if (under2(at, stripSlash(this.root)) || under2(at, stripSlash(this.rootC))) {
        inside = true;
      } else {
        if (inside) left = true;
        inside = false;
      }
    }
    return left && inside;
  }
  judge(path) {
    if (this.climbsBack(path)) {
      this.deny(
        path,
        `BLOCKED: containment \u2014 write target "${path}" leaves this run's root ${this.root} with .. and comes back into it, so it lands on the root from outside. Name the path from inside the root.`
      );
    }
    if (!this.allowed(path)) this.deny(path);
  }
};
function unresolvedWhy(variable) {
  switch (variable) {
    case "$(proc)":
      return "comes from a process call in an inline program (subprocess, os.system, exec, spawn, \u2026) whose command, arguments or cwd are not all plain literals, so the guard cannot tell what it writes; pass literal arguments, or run the command from the shell";
    case "$(alias-write)":
      return "is written through an aliased or stored write builtin the guard can't resolve; call open() (or the write method) directly with a literal path";
    case "$()":
      return "is built by a command substitution or backticks the guard cannot evaluate; inline the path";
    case "PWD":
      return "is relative to a directory from a cd, pushd or popd the guard cannot resolve (cd -, popd, or a cd through a variable); cd to a literal path";
    case "":
      return "depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command";
    default:
      return `depends on a variable the guard cannot resolve in this command: $${variable} is not set to a literal earlier in it; inline the path or set ${variable}=<path> in the same command`;
  }
}
function globClimbs(word) {
  const glob = word.search(GLOB_CHAR);
  return glob >= 0 && `/${word.slice(glob + 1)}/`.includes("/../");
}
function splitUnresolved(word) {
  if (!word.startsWith("UNRESOLVED:")) return { variable: null, target: word };
  const rest = word.slice("UNRESOLVED:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return { variable: rest, target: word };
  return { variable: rest.slice(0, colon), target: rest.slice(colon + 1) };
}
async function judgeBash(g, input, analyze) {
  const command = jqField2(input, ["tool_input", "command"]);
  const writes = command === "" ? [] : await analyze(command, { cwd: g.cwd, raw: true, root: g.root, env: g.runEnv });
  const lines2 = capture(writes.join("\n")).split("\n").filter((w) => w !== "");
  if (lines2.length === 0) return;
  if (!g.unbound && !g.bound && !g.allowed(g.cwd)) g.deny(g.cwd);
  const seen = /* @__PURE__ */ new Set();
  for (const word of lines2) {
    if (seen.has(word)) continue;
    seen.add(word);
    const { variable, target } = splitUnresolved(word);
    if (variable !== null && Object.hasOwn(NEVER_JUDGED, variable)) {
      g.deny(target, `BLOCKED: write target "${target}" ${UNJUDGED_PHRASE} ${NEVER_JUDGED[variable]}`);
    }
    if (globClimbs(target)) {
      g.deny(
        target,
        `BLOCKED: containment \u2014 write target "${target}" climbs with .. after a glob; the guard cannot tell where that lands. Name the directory without .. after a glob.`
      );
    }
    const path = g.expand(target);
    if (variable !== null) {
      if (path !== null) g.judge(path);
      else g.unresolved(target, variable);
      continue;
    }
    if (path !== null) g.judge(path);
  }
}
function runTmpdir(input, g) {
  const hookTmp = g.env.TMPDIR ?? "";
  if (/^\/./s.test(hookTmp)) return hookTmp;
  if (g.toolName !== "Bash" || g.harnessTmpC === "") return hookTmp;
  if (jqField2(input, ["tool_input", "dangerouslyDisableSandbox"]) === "true") return hookTmp;
  return `/tmp/claude-${g.uid}`;
}
async function guard(input, env, analyze) {
  const g = new Guard(env);
  g.toolName = jqField2(input, ["tool_name"]);
  if (!JUDGED_TOOLS.has(g.toolName)) return;
  const state = dbState(env);
  if (state === "unresolved") return;
  if (state === "error") throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}
`, code: 0 });
  g.db = dbPath(env) ?? "";
  g.cwd = capture(jqField2(input, ["cwd"]) || shellPwd(env));
  const agentType = normalizeRole(jqField2(input, ["agent_type"]));
  g.agentId = jqField2(input, ["agent_id"]);
  const project = projectRoot(env);
  if (sweContext(agentType) === "yes") {
    const ctx = agentContext(input, g.db, env);
    g.taskId = ctx.taskId;
    if (ctx.code === 0) {
      g.root = ctx.worktree;
      g.bound = true;
    } else if (ctx.code === 2) {
      throw new Denied({ stdout: `${denyDbUnavailable(HOOK, env)}
`, code: 0 });
    } else {
      g.unbound = true;
      g.missing = ctx.missing;
    }
  }
  if (g.root === "" && !g.unbound) g.root = project;
  g.rootC = g.root === "" ? "" : canonical(g.root);
  g.cacheDir = env.TMB_MODEL_CACHE_DIR || env.HF_HOME || `${g.home()}/.cache/huggingface`;
  g.cacheC = canonical(g.cacheDir);
  g.harnessTmpC = harnessTmp(g.uid);
  const tmpdir = runTmpdir(input, g);
  if (tmpdir !== (env.TMPDIR ?? "")) g.runEnv = { ...env, TMPDIR: tmpdir };
  if (/^\/./s.test(tmpdir)) g.hostTmpC = canonical(tmpdir);
  if (agentType === "" || agentType === "bro") {
    const ccHome = env.CLAUDE_CONFIG_DIR || `${g.home()}/.claude`;
    g.ccProjectC = ccProjectDir(ccHome, g.root, env);
    if (env.CLAUDE_PROJECT_DIR) g.ccSessionC = ccProjectDir(ccHome, env.CLAUDE_PROJECT_DIR, env);
    g.ccPlansC = canonical(`${ccHome}/plans`);
  }
  if (g.toolName !== "Bash") {
    let target = jqField2(input, ["tool_input", "file_path"], ["tool_input", "notebook_path"]);
    if (target === "") return;
    if (!target.startsWith("/")) target = `${g.cwd}/${target}`;
    if (!g.allowed(target)) g.deny(target);
    return;
  }
  await judgeBash(g, input, analyze);
}
function containmentGuardWith(analyze) {
  return async (payload, env) => {
    try {
      await guard(payload, { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: RUN_BUDGET_MS }, analyze);
      return ALLOW;
    } catch (e) {
      if (e instanceof Denied) return e.result;
      throw e;
    }
  };
}
var containmentGuard = containmentGuardWith(writePaths);

// src/hooks/lib/repo.ts
import { statSync as statSync9 } from "node:fs";
function isFile6(path) {
  if (path === "") return false;
  try {
    return statSync9(path).isFile();
  } catch {
    return false;
  }
}
function firstLine(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}
function readable2(db, env) {
  return isFile6(db) && haveSqlite(env);
}
function repoGitRoot(target, env = process.env) {
  if (target === "") return "";
  while (!isDir2(target) && target !== "/" && target !== ".") target = posixDirname(target);
  if (!isDir2(target)) return "";
  const common = gitOut(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  if (common !== "") return cdPwd(posixDirname(common), shellPwd(env));
  return gitOut(target, ["rev-parse", "--show-toplevel"], env);
}
function repoNameForRoot(db, root, env = process.env) {
  if (!readable2(db, env) || root === "") return "";
  const name3 = firstLine(sqliteRo(db, `SELECT name FROM repos WHERE path = '${sqlQuote(root)}' LIMIT 1;`, env));
  if (name3 !== "") return name3;
  const want = realdir(root);
  for (const row of sqliteRo(db, "SELECT name || '|' || path FROM repos ORDER BY name;", env).split("\n")) {
    if (row === "") continue;
    const bar = row.indexOf("|");
    const rname = bar < 0 ? row : row.slice(0, bar);
    const rpath = bar < 0 ? row : row.slice(bar + 1);
    if (rpath === "") continue;
    if (realdir(repoPathAbs(db, rpath)) === want) return rname;
  }
  return "";
}
function repoResolve(db, root, env = process.env) {
  if (!readable2(db, env) || root === "") return "";
  const name3 = repoNameForRoot(db, root, env);
  if (name3 === "") return "";
  return firstLine(
    sqliteRo(
      db,
      `SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'') FROM repos WHERE name = '${sqlQuote(name3)}' LIMIT 1;`,
      env
    )
  );
}
function repoSinglePath(db, env = process.env) {
  if (!readable2(db, env)) return "";
  if (sqliteRo(db, "SELECT COUNT(*) FROM repos;", env) !== "1") return "";
  return firstLine(sqliteRo(db, "SELECT path FROM repos LIMIT 1;", env));
}

// src/hooks/git-push-guard.ts
var GATE_NAME2 = "git-push-guard";
var SOURCE_PATHS = [":(top)", ":(top,exclude,glob)mcp/*/dist/**", ":(top,exclude)dashboard/dist"];
var FORCE = / --force | -f | --force-with-lease | --force-with-lease=/;
var HEX = /^[0-9a-f]+$/;
var SWE_REASON = "BLOCKED: SWE must never push. Bro handles the push gate after code-reviewer passes. Commit in your worktree and call task_update_status(completed).";
var CODE_REVIEWER_REASON = `BLOCKED: ${CODE_REVIEWER_ROLE} must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed.`;
var WORKTREE_REASON = "BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`.";
var DB_REASON = "BLOCKED: trajectory DB unavailable \u2014 the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB and retry the push.";
var PARSE_REASON = "BLOCKED: the push gate could not parse this command, so it cannot tell which statements push or from which checkout. Split it into simpler commands or fix its quoting, then retry the push.";
function deny(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}
function lines(text) {
  return text.split("\n");
}
function field2(line, n) {
  return line.split("|")[n - 1] ?? "";
}
function hexLines(text) {
  return lines(text).filter((l) => HEX.test(l));
}
function without(text, drop) {
  const gone = new Set(lines(drop));
  return lines(text).filter((l) => !gone.has(l)).join("\n");
}
var Guard2 = class {
  constructor(db, cwd, env) {
    this.db = db;
    this.cwd = cwd;
    this.env = env;
  }
  db;
  cwd;
  env;
  read(sql) {
    return gateRead(this.db, sql, this.env);
  }
  /** paths_sig: `<\037-joined changed paths>\t<sha>` per commit of <input> that changes something within the pathspec. */
  pathsSig(dir, input, spec) {
    const out2 = gitRun(dir, ["diff-tree", "--stdin", "-r", "--root", "--name-only", "--format=commit %H", ...spec], this.env, input).stdout;
    const sigs = [];
    let sha = "";
    let files = "";
    const flush = () => {
      if (sha !== "" && files !== "") sigs.push(`${files}	${sha}`);
      sha = "";
      files = "";
    };
    const rows = out2.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    for (const row of rows) {
      const m = /^commit ([0-9a-f]+)$/.exec(row);
      if (m) {
        flush();
        sha = m[1];
      } else if (/\S/.test(row)) {
        files += `${row}`;
      }
    }
    flush();
    return sigs;
  }
  /** pair_by_paths: `<sha> <task sha>...` per commit of <shas> sharing its changed-path set with task commits. */
  pairByPaths(dir, taskRows, shas, spec) {
    const bySet = /* @__PURE__ */ new Map();
    const taskInput = `${lines(taskRows).map((r) => field2(r, 1)).join("\n")}
`;
    for (const sig of this.pathsSig(dir, taskInput, spec)) {
      const [files, sha = ""] = sig.split("	");
      bySet.set(files, `${bySet.get(files) ?? ""} ${sha}`);
    }
    const out2 = [];
    for (const sig of this.pathsSig(dir, `${shas}
`, spec)) {
      const [files, sha = ""] = sig.split("	");
      const tasks = bySet.get(files);
      if (tasks !== void 0) out2.push(sha + tasks);
    }
    return out2.join("\n");
  }
  /** task_matches: `<sha>|<task_id>|<branch_id>|<reviewed>` per paired commit whose patch-id equals a task commit's, a reviewed task preferred. */
  taskMatches(dir, taskRows, pairs, spec) {
    const shas = [...new Set(pairs.split(/[ \n]/))].sort();
    const patch = gitRun(dir, ["diff-tree", "--stdin", "-p", "-r", "--root", ...spec], this.env, `${shas.join("\n")}
`).stdout;
    const ids = stripTrailingNewlines(gitRun(dir, ["patch-id", "--stable"], this.env, patch).stdout);
    if (ids === "") return [];
    const pid = /* @__PURE__ */ new Map();
    for (const row of lines(ids)) {
      const [id = "", sha = ""] = row.trim().split(/\s+/);
      pid.set(sha, id);
    }
    const task = /* @__PURE__ */ new Map();
    for (const row of lines(taskRows)) {
      const bar = row.indexOf("|");
      task.set(bar < 0 ? "" : row.slice(0, bar), bar < 0 ? row : row.slice(bar));
    }
    const seen = /* @__PURE__ */ new Set();
    const out2 = [];
    for (const row of lines(pairs)) {
      const words = row.trim().split(/\s+/).filter((w) => w !== "");
      const sha = words[0] ?? "";
      if (!pid.has(sha) || seen.has(sha)) continue;
      seen.add(sha);
      let m = "";
      for (const cand of words.slice(1)) {
        if (pid.has(cand) && pid.get(cand) === pid.get(sha) && task.has(cand)) {
          const t = task.get(cand) ?? "";
          if (m === "" || /\|1$/.test(t)) m = t;
          if (/\|1$/.test(m)) break;
        }
      }
      if (m !== "") out2.push(sha + m);
    }
    return out2;
  }
  /**
   * unchecked_rebases: `<sha>|<task_id>|<branch_id>|<reviewed>|<full|src>`
   * per pushed rebase of a task commit that is not reviewed or has no passing
   * verification run of its own; __ERR__ when a DB read fails.
   */
  uncheckedRebases(dir, pushed) {
    const values = hexLines(pushed).map((sha) => `('${sha}')`);
    if (values.length === 0) return "";
    const taskCommits = this.read(
      `WITH p(sha) AS (VALUES ${values.join(",")}) SELECT p.sha FROM p WHERE EXISTS (SELECT 1 FROM tasks t WHERE length(t.commit_sha) >= 7 AND substr(p.sha, 1, length(t.commit_sha)) = t.commit_sha);`
    );
    if (taskCommits === GATE_READ_ERROR) return GATE_READ_ERROR;
    const fresh = without(pushed, taskCommits);
    if (fresh === "") return "";
    const name3 = repoNameForRoot(this.db, repoGitRoot(dir, this.env), this.env);
    const repoFilter = name3 === "" ? "" : `AND (t.repo IS NULL OR t.repo = '${sqlQuote(name3)}')`;
    const tasks = this.read(
      `SELECT t.commit_sha || '|' || t.id || '|' || COALESCE(t.branch_id, '') || '|' || EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'pass') FROM tasks t WHERE length(t.commit_sha) >= 7 AND t.commit_sha NOT GLOB '*[^0-9a-f]*' ${repoFilter} ORDER BY t.id;`
    );
    if (tasks === GATE_READ_ERROR) return GATE_READ_ERROR;
    if (tasks === "") return "";
    const taskLines = lines(tasks);
    const checked = lines(
      gitRun(
        dir,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        this.env,
        `${taskLines.map((r) => field2(r, 1)).join("\n")}
`
      ).stdout.replace(/\n$/, "")
    );
    const fullRows = [];
    const n = Math.max(checked.length, taskLines.length);
    for (let i2 = 0; i2 < n; i2++) {
      const rest2 = taskLines[i2] === void 0 ? "" : taskLines[i2].slice(taskLines[i2].indexOf("|") + 1);
      const row = `${checked[i2] ?? ""}|${rest2}`;
      const o = row.split(/[ |]/);
      if (o[1] === "commit") fullRows.push(o[0] + row.slice(row.indexOf("|")));
    }
    const full = fullRows.join("\n");
    if (full === "") return "";
    let matches = [];
    let pairs = this.pairByPaths(dir, full, fresh, []);
    if (pairs !== "") matches = this.taskMatches(dir, full, pairs, []).map((m) => `${m}|full`);
    let srcMatches = [];
    const rest = without(fresh, matches.map((m) => field2(m, 1)).join("\n"));
    if (rest !== "") {
      const spec = ["--", ...SOURCE_PATHS];
      pairs = this.pairByPaths(dir, full, rest, spec);
      if (pairs !== "") srcMatches = this.taskMatches(dir, full, pairs, spec).map((m) => `${m}|src`);
    }
    const all = [...matches, ...srcMatches].filter((m) => m !== "");
    if (all.length === 0) return "";
    const inList = all.filter((m) => field2(m, 4) === "1" && HEX.test(field2(m, 1))).map((m) => `'${field2(m, 1)}'`);
    let ok = "";
    if (inList.length > 0) {
      ok = this.read(
        `SELECT DISTINCT commit_sha FROM verification_runs WHERE commit_sha IN (${inList.join(",")}) AND exit_code = 0 AND timed_out = 0;`
      );
      if (ok === GATE_READ_ERROR) return GATE_READ_ERROR;
    }
    const passed = new Set(lines(ok).map((l) => field2(l, 1)));
    return all.filter((m) => field2(m, 4) !== "1" || !passed.has(field2(m, 1))).join("\n");
  }
  /** The base the commits of a branch with no upstream are counted from: the target branch's ref, else the remote default's, else "". */
  baseRef(dir) {
    let target = field2(repoResolve(this.db, stmtRepoRoot(dir, this.cwd, this.env), this.env), 1);
    if (target === "") {
      const sole = repoSinglePath(this.db, this.env);
      if (sole !== "") target = field2(repoResolve(this.db, sole, this.env), 1);
    }
    const remoteDefault = () => gitOut(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], this.env).replace(/^origin\//gm, "");
    if (target === "") target = remoteDefault();
    target ||= "main";
    const existing = (branch) => [`origin/${branch}`, branch].find((cand) => gitOk(dir, ["rev-parse", "--verify", "--quiet", cand], this.env)) ?? "";
    let base = existing(target);
    if (base === "") {
      const fallback = remoteDefault();
      if (fallback !== "") base = existing(fallback);
    }
    return base;
  }
  pushedShas(dir) {
    const upstream = gitOut(dir, ["log", "@{u}..HEAD", "--pretty=%H"], this.env);
    if (upstream !== "") return upstream;
    const base = this.baseRef(dir);
    return gitOut(dir, ["log", base === "" ? "HEAD" : `${base}..HEAD`, "--pretty=%H"], this.env);
  }
  /** The deny for one push, or null when it may go. */
  judge(dir) {
    const pushed = this.pushedShas(dir);
    if (pushed === "") return null;
    const shaList = hexLines(pushed).map((sha) => `'${sha}'`);
    if (shaList.length === 0) return null;
    const unsigned = this.read(
      `SELECT t.id || '|' || t.branch_id || '|' || substr(t.title, 1, 60) FROM tasks t WHERE t.commit_sha IN (${shaList.join(",")}) AND NOT EXISTS (SELECT 1 FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'pass');`
    );
    if (unsigned === GATE_READ_ERROR) return deny(DB_REASON);
    if (unsigned !== "") {
      const rows2 = lines(unsigned);
      const list2 = rows2.map((r) => `  - task_id=${field2(r, 1)}  ${field2(r, 2)}  (${field2(r, 3)})`).join("\n");
      return deny(
        `BLOCKED: pushing ${rows2.length} unsigned commit(s). The following tasks lack a code-reviewer pass verdict:

${list2}
Run: @bro review before push

bro will spawn code-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing.`
      );
    }
    const unchecked = this.uncheckedRebases(dir, pushed);
    if (unchecked === GATE_READ_ERROR) return deny(DB_REASON);
    if (unchecked === "") return null;
    const rows = lines(unchecked);
    const list = rows.map((r) => {
      const why = field2(r, 4) === "1" ? "no passing verification run for this commit" : "the task has no passing review";
      const kind = field2(r, 5) === "src" ? "rebase with regenerated dist" : "rebase";
      return `  - ${field2(r, 1)}  ${kind} of task_id=${field2(r, 2)}  ${field2(r, 3)}  (${why})`;
    }).join("\n");
    return deny(
      `BLOCKED: pushing ${rows.length} rebased task commit(s) not covered by a review and a verification run. Each has the patch-id of a task commit (a rebase with regenerated dist: the patch-id outside mcp/*/dist and dashboard/dist) but is not that commit:

${list}
A task with no passing review needs @bro review before push first. Then rebase it with integrate.sh, which re-runs verification[] on the rebased commit, records the run and only then moves the branch:
  bash "\${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/integrate.sh" <task_id> <base>`
    );
  }
};
var gitPushGuard = async (payload, env) => {
  const command = stripTrailingNewlines(jqAlternatives(payload, [["tool_input", "command"]]).replace(/\0/g, ""));
  if (!command.includes("push")) return ALLOW;
  const cwd = payloadCwd(payload, env);
  const listed2 = await cmdStatements(command, cwd, env);
  if (!listed2.ok) return deny(PARSE_REASON);
  const pushes = listed2.statements.filter(({ stmt }) => {
    const sub = gitSubcommand(stmt);
    return (sub === "push" || sub.startsWith("push ")) && !FORCE.test(` ${sub} `);
  });
  if (pushes.length === 0) return ALLOW;
  const role = agentRole(payload);
  if (role === "swe") return deny(SWE_REASON);
  if (role === CODE_REVIEWER_ROLE) return deny(CODE_REVIEWER_REASON);
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`)) ?? "";
  const guard2 = new Guard2(db, cwd, env);
  for (const { dir, stmt } of pushes) {
    if (dir === "?") return { stdout: denyAmbiguousGitTarget(stmt), code: 0 };
    if (dir === "-") return { stdout: denyAmbiguousGitTarget(stmt, true), code: 0 };
    if (dir.includes("/.claude/worktrees/")) return deny(WORKTREE_REASON);
    if (db === "" || !haveSqlite(env)) continue;
    const verdict = guard2.judge(dir);
    if (verdict) return verdict;
  }
  return ALLOW;
};

// src/hooks/code-reviewer-preflight.ts
import { spawnSync as spawnSync5 } from "node:child_process";

// src/utils/git-refs.ts
import { execFileSync, spawnSync as spawnSync4 } from "node:child_process";

// src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS = 5e3;

// src/utils/git-refs.ts
function refResolves(repoPath, ref) {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", ref], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT_MS
    });
    return true;
  } catch {
    return false;
  }
}
function normalizeBase(repoPath, base) {
  if (!base.startsWith("origin/") || refResolves(repoPath, `refs/heads/${base}`)) return base;
  return base.slice("origin/".length);
}
function resolveBaseRef(repoPath, rawBase) {
  const base = normalizeBase(repoPath, rawBase);
  if (refResolves(repoPath, `origin/${base}`)) return `origin/${base}`;
  if (refResolves(repoPath, `refs/heads/${base}`)) return base;
  return null;
}
function gitOut2(repoPath, args2) {
  const res = spawnSync4("git", ["-C", repoPath, ...args2], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS
  });
  if (res.error || res.status !== 0) return null;
  const out2 = res.stdout.trim();
  return out2.length > 0 ? out2 : null;
}
function resolveRepoDefaultBranch(repoPath) {
  const originHead = gitOut2(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "dev"]) {
    if (refResolves(repoPath, `refs/heads/${candidate}`)) return candidate;
  }
  return gitOut2(repoPath, ["symbolic-ref", "--short", "HEAD"]) ?? "main";
}

// src/hooks/code-reviewer-preflight.ts
var GATE_NAME3 = "code-reviewer-preflight";
var BYPASS_ENV = "TMB_SKIP_CODE_REVIEWER_PREFLIGHT";
var GIT_TIMEOUT_MS = 1e4;
var GIT_MAX_BUFFER2 = 256 * 1024 * 1024;
var MAX_LISTED = 10;
var DOC_PATH = /^(?:(?:agents|skills|docs)\/.*\.md|CLAUDE\.md|README\.md)$/;
var TOOL_SOURCE = /^mcp\/[^/]+\/src\/tools\/(?:[^/]+\/)*[^/]+\.ts$/;
var TOOL_NAME = /^\s*name:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]\s*,?\s*$/gm;
var CHANGELOG_DIR = "changelog.d";
function git(repo, args2, env) {
  const r = spawnSync5("git", ["-C", repo, ...args2], {
    encoding: "utf8",
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER2
  });
  return { code: r.error ? -1 : r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error?.message ?? "") };
}
function revParse(repo, rev, env) {
  const r = git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], env);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : null;
}
function nulFields(text) {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}
function listed(items) {
  const shown2 = items.slice(0, MAX_LISTED).join("; ");
  return items.length > MAX_LISTED ? `${shown2}; (+${items.length - MAX_LISTED} more)` : shown2;
}
function deny2(failure2) {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: JSON.stringify(failure2)
      }
    })}
`,
    code: 0
  };
}
function dbUnavailable(env) {
  return { stdout: `${denyDbUnavailable(GATE_NAME3, env)}
`, code: 0 };
}
function treeBlobs(repo, rev, env) {
  const r = git(repo, ["ls-tree", "-r", "-z", "--full-tree", rev], env);
  if (r.code !== 0) return null;
  const blobs = /* @__PURE__ */ new Map();
  for (const entry of nulFields(r.stdout)) {
    const tab = entry.indexOf("	");
    const [, type, oid] = entry.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}
function readBlobs(repo, oids, env) {
  const contents = /* @__PURE__ */ new Map();
  if (oids.length === 0) return contents;
  const r = spawnSync5("git", ["-C", repo, "cat-file", "--batch"], {
    input: `${oids.join("\n")}
`,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER2
  });
  if (r.error || r.status !== 0) return null;
  const out2 = r.stdout;
  let at = 0;
  while (at < out2.length) {
    const eol = out2.indexOf(10, at);
    if (eol < 0) return null;
    const [oid, type, size] = out2.subarray(at, eol).toString("utf8").split(" ");
    if (type === void 0 || size === void 0) return null;
    const start2 = eol + 1;
    const end = start2 + Number(size);
    contents.set(oid, out2.subarray(start2, end).toString("utf8"));
    at = end + 1;
  }
  return contents;
}
function toolNames(blobs, contents) {
  const names = /* @__PURE__ */ new Set();
  for (const [path, oid] of blobs) {
    if (!TOOL_SOURCE.test(path) || path.includes("/test/")) continue;
    for (const m of (contents.get(oid) ?? "").matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return names;
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function pathPattern(path) {
  return new RegExp(`(?:^|(?<=\\./)|(?<![A-Za-z0-9_./-]))${escapeRegExp(path)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "m");
}
function toolPattern(name3) {
  return new RegExp(`(?:(?<=__)|(?<![A-Za-z0-9_]))${escapeRegExp(name3)}(?![A-Za-z0-9_])`, "m");
}
function dirOf(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
function removedInDiff(repo, base, commit, env) {
  const diff = git(repo, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", base, commit], env);
  if (diff.code !== 0) return `git diff ${base}..${commit} failed: ${diff.stderr.trim()}`;
  const fields = nulFields(diff.stdout);
  const paths = [];
  let touchesTools = false;
  for (let i2 = 0; i2 < fields.length; ) {
    const status = fields[i2];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const from = fields[i2 + 1];
    const to = renamed ? fields[i2 + 2] : from;
    i2 += renamed ? 3 : 2;
    if (TOOL_SOURCE.test(from) || TOOL_SOURCE.test(to)) touchesTools = true;
    if (status === "D" || status.startsWith("R")) paths.push(from);
  }
  if (!touchesTools) return { paths, tools: [] };
  const before2 = treeBlobs(repo, base, env);
  const after2 = treeBlobs(repo, commit, env);
  if (!before2 || !after2) return `git ls-tree of ${base} or ${commit} failed`;
  const sources = (blobs) => [...blobs].filter(([p]) => TOOL_SOURCE.test(p) && !p.includes("/test/")).map(([, oid]) => oid);
  const contents = readBlobs(repo, [.../* @__PURE__ */ new Set([...sources(before2), ...sources(after2)])], env);
  if (!contents) return "git cat-file of the tool sources failed";
  const kept = toolNames(after2, contents);
  return { paths, tools: [...toolNames(before2, contents)].filter((t) => !kept.has(t)).sort() };
}
function staleDocRefs(repo, base, commit, env) {
  const removed = removedInDiff(repo, base, commit, env);
  if (typeof removed === "string") return removed;
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const blobs = treeBlobs(repo, commit, env);
  if (!blobs) return `git ls-tree of ${commit} failed`;
  const docs = [...blobs].filter(([p]) => DOC_PATH.test(p)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const contents = readBlobs(repo, docs.map(([, oid]) => oid), env);
  if (!contents) return "git cat-file of the docs failed";
  const tools = removed.tools.map((t) => ({ t, re: toolPattern(t) }));
  const paths = removed.paths.map((p) => ({ p, re: pathPattern(p) }));
  const hits = [];
  for (const [doc, oid] of docs) {
    const text = contents.get(oid) ?? "";
    const dir = dirOf(doc);
    for (const { p, re } of paths) {
      const local = dir !== "" && p.startsWith(`${dir}/`) ? pathPattern(p.slice(dir.length + 1)) : null;
      if (re.test(text) || local?.test(text)) hits.push(`${doc} mentions removed path '${p}'`);
    }
    for (const { t, re } of tools) {
      if (re.test(text)) hits.push(`${doc} mentions removed MCP tool '${t}'`);
    }
  }
  return hits;
}
function hasChangelogDir(repo, rev, env) {
  const r = git(repo, ["ls-tree", "-d", "--name-only", rev, "--", CHANGELOG_DIR], env);
  return r.code === 0 && r.stdout.trim() !== "";
}
function readTask(db, taskId, env) {
  const row = gateRead(
    db,
    `SELECT 'row|' || COALESCE(commit_sha, '') || '|' || COALESCE(parent_branch_id, '') || '|' || branch_id FROM tasks WHERE id = ${taskId};`,
    env
  );
  if (row === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (row === "") return null;
  const [, commitSha = "", parentBranch = "", ...branch] = row.split("\n")[0].split("|");
  return { commitSha, parentBranch, branch: branch.join("|") };
}
function prTargetRef(repo, targetBranch, parentBranch) {
  for (const candidate of [targetBranch, parentBranch, resolveRepoDefaultBranch(repo)]) {
    if (candidate === "") continue;
    const ref = resolveBaseRef(repo, candidate);
    if (ref) return ref;
  }
  return null;
}
function preflight(db, taskId, env) {
  const task = readTask(db, taskId, env);
  if (task === GATE_READ_ERROR) return dbUnavailable(env);
  if (task === null) return ALLOW;
  const location = taskLocation(db, taskId, env);
  if (location.code === 2) return dbUnavailable(env);
  const recorded = task.commitSha;
  if (location.code !== 0) {
    return deny2({ check: "sha_mismatch", expected: recorded || null, actual: `branch tip unresolvable: ${location.missing}` });
  }
  const repo = location.repoRoot;
  const branch = task.branch;
  const tip = revParse(repo, `refs/heads/${branch}`, env);
  const commit = recorded === "" ? null : revParse(repo, recorded, env);
  if (commit === null || tip !== commit) {
    return deny2({
      check: "sha_mismatch",
      expected: recorded === "" ? null : commit ?? recorded,
      actual: tip ?? `refs/heads/${branch} does not resolve in ${repo}`
    });
  }
  const shaIn = `commit_sha IN ('${sqlQuote(recorded)}', '${sqlQuote(commit)}')`;
  const runs = gateRead(
    db,
    `SELECT COUNT(*) FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} AND exit_code = 0 AND timed_out = 0;`,
    env
  );
  if (runs === GATE_READ_ERROR) return dbUnavailable(env);
  if (Number(runs) === 0) {
    const latest = gateRead(
      db,
      `SELECT 'run ' || id || ': exit_code=' || COALESCE(exit_code, 'null') || ', timed_out=' || timed_out
         FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} ORDER BY id DESC LIMIT 1;`,
      env
    );
    return deny2({
      check: "no_passing_run",
      expected: `a verification_runs row for task ${taskId} at ${commit} with exit_code=0 and timed_out=0`,
      actual: latest === GATE_READ_ERROR || latest === "" ? `no verification_runs row for task ${taskId} at ${commit}` : latest
    });
  }
  const targetRow = gateRead(
    db,
    `SELECT COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(location.repo)}';`,
    env
  );
  if (targetRow === GATE_READ_ERROR) return dbUnavailable(env);
  const targetRef = prTargetRef(repo, targetRow.split("\n")[0], task.parentBranch);
  const targetTip = targetRef === null ? null : revParse(repo, targetRef, env);
  if (targetRef === null || targetTip === null) {
    return deny2({
      check: "base_conflict",
      expected: `${commit} merges cleanly into the PR target`,
      actual: `no PR target ref resolves in ${repo}`
    });
  }
  const merge = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetTip, commit], env);
  if (merge.code !== 0) {
    const conflicted = merge.stdout.split("\n").slice(1).filter((l) => l !== "");
    return deny2({
      check: "base_conflict",
      expected: `${commit} merges cleanly into ${targetRef} (${targetTip})`,
      actual: merge.code === 1 && conflicted.length > 0 ? `conflicts in ${listed(conflicted)}` : `git merge-tree exited ${merge.code}: ${merge.stderr.trim()}`
    });
  }
  const mergeBase = git(repo, ["merge-base", targetTip, commit], env).stdout.trim();
  if (mergeBase === "") {
    return deny2({
      check: "base_conflict",
      expected: `${commit} shares history with ${targetRef} (${targetTip})`,
      actual: "no merge-base"
    });
  }
  const stale = staleDocRefs(repo, mergeBase, commit, env);
  if (typeof stale === "string" || stale.length > 0) {
    return deny2({
      check: "stale_doc_ref",
      expected: `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${commit} mentions a path or MCP tool that ${mergeBase}..${commit} removes`,
      actual: typeof stale === "string" ? stale : listed(stale)
    });
  }
  if (hasChangelogDir(repo, commit, env) || hasChangelogDir(repo, mergeBase, env)) {
    const added = git(repo, ["diff", "--no-ext-diff", "--name-only", "--no-renames", "--diff-filter=A", mergeBase, commit, "--", `${CHANGELOG_DIR}/`], env);
    if (added.code !== 0 || added.stdout.trim() === "") {
      return deny2({
        check: "missing_changelog",
        expected: `${mergeBase}..${commit} adds a file under ${CHANGELOG_DIR}/`,
        actual: added.code !== 0 ? `git diff failed: ${added.stderr.trim()}` : `no file added under ${CHANGELOG_DIR}/`
      });
    }
  }
  return ALLOW;
}
var codeReviewerPreflight = (payload, env) => {
  if (env[BYPASS_ENV] === "1") return ALLOW;
  if (jqAlternatives(payload, [["tool_name"]]) !== "Agent") return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "code-reviewer") return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [["tool_input", "prompt"]]));
  const taskId = sqlInt(m?.[1] ?? "");
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return dbUnavailable(env);
  return preflight(db, taskId, env);
};

// src/success-criteria.ts
var SPAWN_NOTE_MAX_CHARS = 300;

// src/hooks/code-reviewer-spawn-note.ts
var GATE_NAME4 = "code-reviewer-spawn-note";
var BYPASS_ENV2 = "TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE";
var ANCHORS = ["task_id", "commit_sha", "branch_id", "repo", "repo_path", "attempt_n", "subagent_session_id"];
var ANCHOR_RE = new RegExp(`\\b(?:${ANCHORS.join("|")})\\s*=\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\S+)`, "g");
function spawnProse(prompt) {
  return prompt.replace(ANCHOR_RE, " ").replace(/\s+/g, " ").trim();
}
function denyReason(proseChars) {
  return `BLOCKED: the code-reviewer spawn prompt carries ${proseChars} characters of prose beyond its anchors (${ANCHORS.map((a) => `${a}=`).join(", ")}); the cap is ${SPAWN_NOTE_MAX_CHARS}. The reviewer reads the spec, discussions and swe's completion report from task_brief. Store the remaining context as spawn_note (at most ${SPAWN_NOTE_MAX_CHARS} chars) with bro_atomic_close, where task_brief returns it, and respawn with the anchors and at most ${SPAWN_NOTE_MAX_CHARS} chars of prose.`;
}
function deny3(reason) {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    })}
`,
    code: 0
  };
}
var codeReviewerSpawnNote = (payload, env) => {
  if (env[BYPASS_ENV2] === "1") return ALLOW;
  if (jqAlternatives(payload, [["tool_name"]]) !== "Agent") return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "code-reviewer") return ALLOW;
  const prose = spawnProse(jqAlternatives(payload, [["tool_input", "prompt"]]));
  return prose.length > SPAWN_NOTE_MAX_CHARS ? deny3(denyReason(prose.length)) : ALLOW;
};

// src/task-rework.ts
var SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";
var REWORK_FAIL_LIMIT = 2;
function elapsedMs(createdAt, endedAt) {
  const start2 = Date.parse(createdAt);
  const end = endedAt.getTime();
  if (Number.isNaN(start2) || Number.isNaN(end)) return null;
  return Math.max(0, end - start2);
}

// src/hooks/rework-limit.ts
var GATE_NAME5 = "rework-limit";
function readState(db, taskId, env) {
  const out2 = gateRead(
    db,
    `WITH t AS (SELECT id, issue_id FROM tasks WHERE id = ${taskId}),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass'),
          fails AS (SELECT v.id, v.created_at FROM validation_attempts v, t, since
                     WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id),
          latest AS (SELECT created_at FROM fails ORDER BY id DESC LIMIT 1)
     SELECT json_object(
       'fails', (SELECT COUNT(*) FROM fails),
       'last_fail_at', (SELECT created_at FROM latest),
       'waived', EXISTS (SELECT 1 FROM discussions d, t, latest
                          WHERE d.issue_id = t.issue_id AND d.created_at > latest.created_at
                            AND ((d.kind = 'decision' AND (d.task_id = t.id OR d.task_id IS NULL)) OR d.author = 'human')))
     FROM t;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (out2 === "") return null;
  const row = JSON.parse(out2.split("\n")[0]);
  return { fails: row.fails, lastFailAt: row.last_fail_at, waived: row.waived === 1 };
}
function denyReason2(taskId, state) {
  return `BLOCKED: task ${taskId} has ${state.fails} review FAILs since its last pass (the latest at ${state.lastFailAt}) and no decision since, so a further swe spawn would repeat the approach that failed. Before spawning swe again, do one of: write a decision naming the change of approach (discussion_append kind='decision' task_id=${taskId}); task_retry with a redesigned spec; split the task into smaller tasks; or ask the Human (a Human comment on the issue waives this).`;
}
function denyPreToolUse(reason) {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    })}
`,
    code: 0
  };
}
function denyUnreadable(gate, env) {
  return { stdout: `${denyDbUnavailable(gate, env)}
`, code: 0 };
}
function reworkLimitVerdict(gate, db, taskId, env) {
  const state = readState(db, taskId, env);
  if (state === GATE_READ_ERROR) return denyUnreadable(gate, env);
  if (state === null || state.fails < REWORK_FAIL_LIMIT || state.waived) return ALLOW;
  return denyPreToolUse(denyReason2(taskId, state));
}
var reworkLimit = (payload, env) => {
  if (jqAlternatives(payload, [["tool_name"]]) !== "Agent") return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "swe") return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [["tool_input", "prompt"]]));
  const taskId = sqlInt(m?.[1] ?? "");
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME5, env);
  return reworkLimitVerdict(GATE_NAME5, db, taskId, env);
};

// src/hooks/swe-resume-gate.ts
var GATE_NAME6 = "swe-resume-gate";
function effortMismatchReason(agentId, target) {
  return `BLOCKED: swe ${agentId} ran task ${target.task_id} at effort ${target.run_effort}; the task's effort is now ${target.task_effort}. A resumed swe keeps the effort it was spawned at, so resuming it would ignore the change. Spawn a fresh swe at the task's effort instead: Agent(subagent_type='swe', effort='${target.task_effort}', prompt starting 'task_id=${target.task_id}').`;
}
var sweResumeGate = (payload, env) => {
  if (jqAlternatives(payload, [["tool_name"]]) !== "SendMessage") return ALLOW;
  const to = jqAlternatives(payload, [["tool_input", "to"]]);
  if (to === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME6, env);
  const out2 = gateRead(
    db,
    `SELECT json_object('task_id', r.task_id, 'status', t.status, 'run_effort', r.effort, 'task_effort', t.effort)
       FROM agent_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_type = 'swe' AND r.spawn_id = '${sqlQuote(to)}'
      ORDER BY r.id DESC LIMIT 1;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return denyUnreadable(GATE_NAME6, env);
  if (out2 === "") return ALLOW;
  const target = JSON.parse(out2.split("\n")[0]);
  if (target.status === "closed") return ALLOW;
  const verdict = reworkLimitVerdict(GATE_NAME6, db, String(target.task_id), env);
  if (verdict !== ALLOW) return verdict;
  if (target.run_effort !== null && target.task_effort !== null && target.run_effort !== target.task_effort) {
    return denyPreToolUse(effortMismatchReason(to, target));
  }
  return ALLOW;
};

// src/hooks/task-overrun-alert.ts
var GATE_NAME7 = "task-overrun-alert";
var OVERRUN_ENV = "TMB_TASK_OVERRUN_MIN";
var DEFAULT_OVERRUN_MIN = 60;
var EVENT = "task_overrun_alerted";
var FROM_NODE = `hook:${GATE_NAME7}`;
var MS_PER_MIN = 6e4;
function thresholdMin(env) {
  const raw = env[OVERRUN_ENV] ?? "";
  return /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_OVERRUN_MIN;
}
function overruns(db, now, limitMin, env) {
  const out2 = gateRead(
    db,
    `SELECT COALESCE(json_group_array(json_object(
         'id', t.id, 'issue_id', t.issue_id, 'branch_id', t.branch_id, 'status', t.status, 'created_at', t.created_at,
         'attempts', (SELECT COUNT(*) FROM agent_runs WHERE task_id = t.id AND ${SWE_SPAWN_SQL}),
         'fail', (SELECT feedback FROM validation_attempts v WHERE v.task_id = t.id AND v.verdict = 'fail' ORDER BY v.id DESC LIMIT 1))), '[]')
       FROM tasks t
      WHERE t.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.event_type = 'task_overrun_alerted' AND json_valid(a.content_json)
                         AND json_extract(a.content_json, '$.task_id') = t.id);`,
    env
  );
  if (out2 === GATE_READ_ERROR || out2 === "") return null;
  const rows = JSON.parse(out2);
  const found = [];
  for (const r of rows) {
    const ms = elapsedMs(r.created_at, now);
    if (ms === null || ms <= limitMin * MS_PER_MIN) continue;
    const firstLine2 = (r.fail ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    found.push({
      taskId: r.id,
      issueId: r.issue_id,
      branchId: r.branch_id,
      minutes: Math.floor(ms / MS_PER_MIN),
      attempts: r.attempts,
      blocker: firstLine2 === "" ? `status ${r.status}` : firstLine2
    });
  }
  return found.sort((a, b) => a.taskId - b.taskId);
}
function claim(db, found, now, env) {
  const statements = [];
  for (const o of found) {
    const content = jqCompact({ task_id: o.taskId, minutes: o.minutes, attempts: o.attempts, blocker: o.blocker });
    const guard2 = dedupeGuard(EVENT, content, ["$.task_id"], { caller: GATE_NAME7 });
    const row = auditSql(
      {
        issueId: String(o.issueId),
        branchId: o.branchId,
        fromNode: FROM_NODE,
        eventType: EVENT,
        summary: `task ${o.taskId} running ${o.minutes} min`,
        contentJson: content
      },
      guard2.sql,
      { caller: GATE_NAME7, env, now: nowIso(now) }
    );
    if (guard2.code !== 0 || row.code !== 0) return null;
    statements.push(row.sql, `SELECT ${o.taskId} WHERE changes() = 1;`);
  }
  const w = dbWrite(db, statements.join("\n"), { caller: GATE_NAME7, env });
  if (!w.ok) return null;
  return new Set(w.stdout.split("\n").map((l) => sqlInt(l.trim())).filter((id) => id !== "").map(Number));
}
function alertLine(o) {
  return `TMB: task ${o.taskId} has been running ${o.minutes} min (attempts: ${o.attempts} swe spawns; blocker: ${o.blocker}). Decide with the Human whether to continue, redesign the spec or split the task.`;
}
function makeTaskOverrunAlert(clock = () => /* @__PURE__ */ new Date()) {
  return (payload, env) => {
    if (agentRole(payload) !== "bro") return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const now = clock();
    const found = overruns(db, now, thresholdMin(env), env);
    if (found === null || found.length === 0) return ALLOW;
    const claimed = claim(db, found, now, env);
    const emit = claimed === null ? found : found.filter((o) => claimed.has(o.taskId));
    if (emit.length === 0) return ALLOW;
    const event = jqAlternatives(payload, [["hook_event_name"]]) || "UserPromptSubmit";
    return {
      stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: emit.map(alertLine).join("\n") } })}
`,
      code: 0
    };
  };
}
var taskOverrunAlert = makeTaskOverrunAlert();

// src/hooks/registry.ts
var GATES = /* @__PURE__ */ new Map([
  ["askuserquestion-length-lint", askuserquestionLengthLint],
  ["containment-guard", containmentGuard],
  ["ensure-mcp-deps-installed", ensureMcpDepsInstalled],
  [GATE_NAME2, gitPushGuard],
  [GATE_NAME3, codeReviewerPreflight],
  [GATE_NAME4, codeReviewerSpawnNote],
  [GATE_NAME5, reworkLimit],
  [GATE_NAME6, sweResumeGate],
  [GATE_NAME7, taskOverrunAlert]
]);
function findGate(name3) {
  return GATES.get(name3);
}

// src/hooks/run.ts
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
async function runHook(name3, findGate2, env, io) {
  try {
    const gate = findGate2(name3);
    if (!gate) {
      io.writeStderr(`TMB hooks: unknown gate '${oneLine(name3)}' \u2014 not run
`);
      return 1;
    }
    const result = await gate(io.readStdin(), env);
    io.writeStdout(result.stdout);
    return result.code;
  } catch (err2) {
    const detail = err2 instanceof Error ? err2.message : String(err2);
    io.writeStderr(`TMB hooks: gate '${oneLine(name3)}' failed: ${oneLine(detail)}
`);
    return 1;
  }
}

// src/hooks/index.ts
var name2 = process.argv[2] ?? "";
var installWorker = name2 === GATE_NAME && process.argv[3] === INSTALL_FLAG;
var worker = (_payload, env) => ({ stdout: "", code: runInstallWorker(env) });
process.exitCode = await runHook(name2, installWorker ? () => worker : findGate, process.env, {
  readStdin: () => installWorker ? "" : readFileSync6(0, "utf8"),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text)
});
//# sourceMappingURL=hooks.js.map
