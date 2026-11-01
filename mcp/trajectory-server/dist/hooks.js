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
  for (let i2 = 0, n3 = result.length; i2 < n3; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
function marshalNode(node, index7 = 0) {
  let address = TRANSFER_BUFFER + index7 * SIZE_OF_NODE;
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
  const index7 = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index7,
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
function parseAnyPredicate(steps, index7, operator, textPredicates) {
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
    textPredicates[index7].push((captures) => {
      const nodes1 = [];
      const nodes2 = [];
      for (const c of captures) {
        if (c.name === captureName1) nodes1.push(c.node);
        if (c.name === captureName2) nodes2.push(c.node);
      }
      const compare = /* @__PURE__ */ __name((n1, n22, positive) => {
        return positive ? n1.text === n22.text : n1.text !== n22.text;
      }, "compare");
      return matchAll ? nodes1.every((n1) => nodes2.some((n22) => compare(n1, n22, isPositive))) : nodes1.some((n1) => nodes2.some((n22) => compare(n1, n22, isPositive)));
    });
  } else {
    const captureName = steps[1].name;
    const stringValue = steps[2].value;
    const matches = /* @__PURE__ */ __name((n3) => n3.text === stringValue, "matches");
    const doesNotMatch = /* @__PURE__ */ __name((n3) => n3.text !== stringValue, "doesNotMatch");
    textPredicates[index7].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName) nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
function parseMatchPredicate(steps, index7, operator, textPredicates) {
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
  const regex2 = new RegExp(steps[2].value);
  textPredicates[index7].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    const test = /* @__PURE__ */ __name((text, positive) => {
      return positive ? regex2.test(text) : !regex2.test(text);
    }, "test");
    if (nodes.length === 0) return !isPositive;
    return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
  });
}
function parseAnyOfPredicate(steps, index7, operator, textPredicates) {
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
  textPredicates[index7].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    if (nodes.length === 0) return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
function parseIsPredicate(steps, index7, operator, assertedProperties, refutedProperties) {
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
  if (!properties[index7]) properties[index7] = {};
  properties[index7][steps[1].value] = steps[2]?.value ?? null;
}
function parseSetDirective(steps, index7, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index7]) setProperties[index7] = {};
  setProperties[index7][steps[1].value] = steps[2]?.value ?? null;
}
function parsePattern(index7, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
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
        parseAnyPredicate(steps, index7, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index7, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index7, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index7, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index7, setProperties);
        break;
      default:
        predicates[index7].push({ operator, operands: steps.slice(1) });
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
      child(index7) {
        marshalNode(this);
        C._ts_node_child_wasm(this.tree[0], index7);
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
      namedChild(index7) {
        marshalNode(this);
        C._ts_node_named_child_wasm(this.tree[0], index7);
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
      fieldNameForChild(index7) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index7);
        if (!address) return null;
        return C.AsciiToString(address);
      }
      /** Get the field name of this node's named child at the given index. */
      fieldNameForNamedChild(index7) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index7);
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
      firstChildForIndex(index7) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index7, "i32");
        C._ts_node_first_child_for_byte_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the node's first named child that contains or starts after the given byte offset. */
      firstNamedChildForIndex(index7) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index7, "i32");
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
        for (let i2 = 0, n3 = typesBySymbol.length; i2 < n3; i2++) {
          if (types.includes(typesBySymbol[i2])) {
            symbols.push(i2);
          }
        }
        const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
        for (let i2 = 0, n3 = symbols.length; i2 < n3; i2++) {
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
      constructor(kind, info2, index7, length) {
        super(_QueryError.formatMessage(kind, info2));
        this.kind = kind;
        this.info = info2;
        this.index = index7;
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
            const capture6 = captures[captureIndex];
            const setProperties = this.setProperties[patternIndex];
            capture6.setProperties = setProperties;
            const assertedProperties = this.assertedProperties[patternIndex];
            capture6.assertedProperties = assertedProperties;
            const refutedProperties = this.refutedProperties[patternIndex];
            capture6.refutedProperties = refutedProperties;
            result.push(capture6);
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
        for (let i2 = 0, n3 = this.types.length; i2 < n3; i2++) {
          if (C._ts_language_symbol_type(this[0], i2) < 2) {
            this.types[i2] = C.UTF8ToString(C._ts_language_symbol_name(this[0], i2));
          }
        }
        this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
        for (let i2 = 0, n3 = this.fields.length; i2 < n3; i2++) {
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
        var readyPromise = new Promise((resolve4, reject) => {
          readyPromiseResolve = resolve4;
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
                return new Promise((resolve4, reject) => {
                  var xhr = new XMLHttpRequest();
                  xhr.open("GET", url, true);
                  xhr.responseType = "arraybuffer";
                  xhr.onload = () => {
                    if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                      resolve4(xhr.response);
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
            return new Promise((resolve4, reject) => {
              Module["instantiateWasm"](info2, (mod, inst) => {
                receiveInstance(mod, inst);
                resolve4(mod.exports);
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
          var str2 = "";
          while (idx < endPtr) {
            var u0 = heapOrArray[idx++];
            if (!(u0 & 128)) {
              str2 += String.fromCharCode(u0);
              continue;
            }
            var u1 = heapOrArray[idx++] & 63;
            if ((u0 & 224) == 192) {
              str2 += String.fromCharCode((u0 & 31) << 6 | u1);
              continue;
            }
            var u2 = heapOrArray[idx++] & 63;
            if ((u0 & 240) == 224) {
              u0 = (u0 & 15) << 12 | u1 << 6 | u2;
            } else {
              u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
            }
            if (u0 < 65536) {
              str2 += String.fromCharCode(u0);
            } else {
              var ch = u0 - 65536;
              str2 += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
            }
          }
          return str2;
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
        var uleb128Encode = /* @__PURE__ */ __name((n3, target) => {
          if (n3 < 128) {
            target.push(n3);
          } else {
            target.push(n3 % 128 | 128, n3 >> 7);
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
        function _tree_sitter_parse_callback(inputBufferAddress, index7, row, column, lengthAddress) {
          const INPUT_BUFFER_SIZE = 10 * 1024;
          const string = Module.currentParseCallback(index7, {
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
        var lengthBytesUTF8 = /* @__PURE__ */ __name((str2) => {
          var len = 0;
          for (var i2 = 0; i2 < str2.length; ++i2) {
            var c = str2.charCodeAt(i2);
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
        var stringToUTF8Array = /* @__PURE__ */ __name((str2, heap, outIdx, maxBytesToWrite) => {
          if (!(maxBytesToWrite > 0)) return 0;
          var startIdx = outIdx;
          var endIdx = outIdx + maxBytesToWrite - 1;
          for (var i2 = 0; i2 < str2.length; ++i2) {
            var u = str2.charCodeAt(i2);
            if (u >= 55296 && u <= 57343) {
              var u1 = str2.charCodeAt(++i2);
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
        var stringToUTF8 = /* @__PURE__ */ __name((str2, outPtr, maxBytesToWrite) => stringToUTF8Array(str2, HEAPU8, outPtr, maxBytesToWrite), "stringToUTF8");
        var stackAlloc = /* @__PURE__ */ __name((sz) => __emscripten_stack_alloc(sz), "stackAlloc");
        var stringToUTF8OnStack = /* @__PURE__ */ __name((str2) => {
          var size = lengthBytesUTF8(str2) + 1;
          var ret = stackAlloc(size);
          stringToUTF8(str2, ret, size);
          return ret;
        }, "stringToUTF8OnStack");
        var AsciiToString = /* @__PURE__ */ __name((ptr) => {
          var str2 = "";
          while (1) {
            var ch = HEAPU8[ptr++];
            if (!ch) return str2;
            str2 += String.fromCharCode(ch);
          }
        }, "AsciiToString");
        var stringToUTF16 = /* @__PURE__ */ __name((str2, outPtr, maxBytesToWrite) => {
          maxBytesToWrite ??= 2147483647;
          if (maxBytesToWrite < 2) return 0;
          maxBytesToWrite -= 2;
          var startPtr = outPtr;
          var numCharsToWrite = maxBytesToWrite < str2.length * 2 ? maxBytesToWrite / 2 : str2.length;
          for (var i2 = 0; i2 < numCharsToWrite; ++i2) {
            var codeUnit = str2.charCodeAt(i2);
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
          C.currentParseCallback = (index7) => callback.slice(index7);
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
import { existsSync as existsSync6 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function parserLoadCount() {
  return loads;
}
function wasmDir() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  for (const dir of [join4(here, "parsing"), here]) {
    if (existsSync6(join4(dir, RUNTIME_WASM))) return dir;
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
import { readFileSync as readFileSync24 } from "node:fs";

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
  return readdirSync(path).reduce((sum2, name3) => sum2 + treeBytes(join2(path, name3)), 0);
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

// src/hooks/lib/jq-key-order.ts
var INTEGER_LIKE_KEY = /"(?:\d|\\u003\d)+"\s*:/;
var inputOrder = /* @__PURE__ */ new WeakMap();
var anyReordered = false;
var isRawJson = (value) => JSON.isRawJSON?.(value) ?? false;
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
function skipSpace(text, start2) {
  let i2 = start2;
  while (/\s/.test(text[i2] ?? "")) i2 += 1;
  return i2;
}
function scan(text, start2) {
  const open = text[start2];
  if (open !== "{" && open !== "[") return { end: valueEnd(text, start2) };
  const fields = /* @__PURE__ */ new Map();
  const items = [];
  let i2 = skipSpace(text, start2 + 1);
  while (text[i2] !== "}" && text[i2] !== "]") {
    if (open === "{") {
      const keyEnd = valueEnd(text, i2);
      const child = scan(text, skipSpace(text, skipSpace(text, keyEnd) + 1));
      fields.set(JSON.parse(text.slice(i2, keyEnd)), child);
      i2 = child.end;
    } else {
      const child = scan(text, i2);
      items.push(child);
      i2 = child.end;
    }
    i2 = skipSpace(text, i2);
    if (text[i2] === ",") i2 = skipSpace(text, i2 + 1);
  }
  return open === "{" ? { end: i2 + 1, fields } : { end: i2 + 1, items };
}
function remember(value, shape) {
  if (value === null || typeof value !== "object") return;
  if (shape.items) shape.items.forEach((item, i2) => remember(value[i2], item));
  if (!shape.fields) return;
  const order2 = [...shape.fields.keys()];
  for (const [key2, field6] of shape.fields) remember(value[key2], field6);
  if (Object.keys(value).some((key2, i2) => key2 !== order2[i2])) {
    inputOrder.set(value, order2);
    anyReordered = true;
  }
}
function parseKeepingKeyOrder(text, reviver) {
  const value = JSON.parse(text, reviver);
  if (!INTEGER_LIKE_KEY.test(text)) return value;
  try {
    remember(value, scan(text, 0));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return value;
}
function keysInOrder(value) {
  return inputOrder.get(value) ?? Object.keys(value);
}
function render(value, indent, at2) {
  if (value === null || typeof value !== "object" || isRawJson(value)) return JSON.stringify(value) ?? "null";
  const inner4 = at2 + indent;
  const record = value;
  const [open, close2] = Array.isArray(value) ? "[]" : "{}";
  const body2 = Array.isArray(value) ? value.map((v) => render(v, indent, inner4)) : keysInOrder(value).filter((key2) => record[key2] !== void 0).map((key2) => `${JSON.stringify(key2)}:${indent === "" ? "" : " "}${render(record[key2], indent, inner4)}`);
  if (body2.length === 0) return `${open}${close2}`;
  return indent === "" ? `${open}${body2.join(",")}${close2}` : `${open}
${inner4}${body2.join(`,
${inner4}`)}
${at2}${close2}`;
}
function stringifyInOrder(value, indent = 0) {
  return anyReordered ? render(value, " ".repeat(indent), "") : JSON.stringify(value, null, indent);
}

// src/hooks/lib/project-env.ts
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
  if (value !== null && typeof value === "object") return stringifyInOrder(value, 2);
  return String(value);
}
function pluginName2(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  return root === "" ? DEFAULT_PLUGIN_NAME : manifestName(`${root}/.claude-plugin/plugin.json`);
}
function resolvePluginName(env = process.env) {
  return manifestName(`${env.CLAUDE_PLUGIN_ROOT ?? ""}/.claude-plugin/plugin.json`);
}
function commandSubstitution(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}
function manifestName(manifest) {
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
var LOCALE_CATEGORIES = ["LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"];
function localeInstalled(name3, category) {
  if (name3 === "C" || name3 === "POSIX") return true;
  return !name3.includes("/") && existsSync2(`/usr/share/locale/${name3}/${category}`);
}
function setlocaleUtf8(env = process.env) {
  const pick = (category) => env.LC_ALL || env[category] || env.LANG || "C";
  if (!LOCALE_CATEGORIES.every((category) => localeInstalled(pick(category), category))) return false;
  return /(^|\.)utf-?8$/i.test(pick("LC_CTYPE"));
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

// src/hooks/bro-turn-usage.ts
import { readFileSync as readFileSync7, statSync as statSync6 } from "node:fs";

// src/hooks/lib/audit.ts
import { accessSync as accessSync4, constants as constants4, readFileSync as readFileSync5, statSync as statSync4 } from "node:fs";
import { performance as performance4 } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// src/hooks/lib/db.ts
import { accessSync as accessSync3, closeSync as closeSync2, constants as constants3, existsSync as existsSync3, openSync as openSync2, readFileSync as readFileSync4, readSync, realpathSync as realpathSync3, statSync as statSync3 } from "node:fs";

// src/hooks/lib/jq.ts
function jsonValues(text, reviver) {
  const values = [];
  let i2 = 0;
  for (; ; ) {
    while (i2 < text.length && /\s/.test(text[i2])) i2 += 1;
    if (i2 >= text.length) return values;
    const end = valueEnd(text, i2);
    if (end < 0) return values;
    try {
      values.push(parseKeepingKeyOrder(text.slice(i2, end), reviver));
    } catch {
      return values;
    }
    i2 = end;
  }
}
function jsonStream(text) {
  const values = [];
  let i2 = 0;
  for (; ; ) {
    while (i2 < text.length && /[ \t\n\r]/.test(text[i2])) i2 += 1;
    if (i2 >= text.length) return { values, complete: true };
    const end = valueEnd(text, i2);
    if (end < 0) return { values, complete: false };
    try {
      values.push(parseKeepingKeyOrder(text.slice(i2, end)));
    } catch {
      return { values, complete: false };
    }
    i2 = end;
  }
}
function jqRawElements(text) {
  const out2 = [];
  for (const value of jsonStream(text).values) {
    if (value === null || typeof value !== "object") continue;
    for (const v of Array.isArray(value) ? value : keysInOrder(value).map((key2) => value[key2])) out2.push(jqRawText(v));
  }
  return out2.join("\n");
}
var JqError2 = class extends Error {
};
function index(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value) || isRawJson(value)) throw new JqError2(`Cannot index ${typeof value}`);
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
function jqMap(text, filter, reviver) {
  const out2 = [];
  for (const value of jsonValues(text, reviver)) {
    try {
      out2.push(filter(value));
    } catch (e) {
      if (!(e instanceof JqError2)) throw e;
    }
  }
  return out2;
}
function jqIndex(value, key2) {
  return index(value, key2);
}
function jqOr(value, fallback) {
  return truthy(value) ? value : fallback;
}
function jqFieldOr(text, key2, fallback = "") {
  return jqMap(text, (value) => jqRawText(jqOr(index(value, key2), fallback))).join("\n");
}
function jqContentStrings(text) {
  const out2 = [];
  for (const value of jsonValues(text)) {
    try {
      const v = getPath(value, ["message", "content"]);
      const content = truthy(v) ? v : [];
      out2.push(typeof content === "string" ? content : stringifyInOrder(content));
    } catch (e) {
      if (!(e instanceof JqError2)) throw e;
    }
  }
  return out2;
}
function jqCompact(value) {
  return stringifyInOrder(value).replace(/\x7f/g, "\\u007f");
}
function jqNumberLiteral(source) {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return source;
  const [, sign, int, frac = "", exp = "0"] = m;
  const coefficient = `${int}${frac}`.replace(/^0+(?=\d)/, "");
  const e = Number(exp) - frac.length;
  const adjusted = e + coefficient.length - 1;
  if (e <= 0 && adjusted >= -6) {
    if (e === 0) return `${sign}${coefficient}`;
    const point = coefficient.length + e;
    return point > 0 ? `${sign}${coefficient.slice(0, point)}.${coefficient.slice(point)}` : `${sign}0.${"0".repeat(-point)}${coefficient}`;
  }
  const mantissa = coefficient.length > 1 ? `${coefficient[0]}.${coefficient.slice(1)}` : coefficient;
  return `${sign}${mantissa}E${adjusted >= 0 ? "+" : "-"}${Math.abs(adjusted)}`;
}
var rawJson = JSON.rawJSON;
var jqLiteralNumbers = rawJson ? (_key, value, context4) => typeof value === "number" && typeof context4?.source === "string" ? rawJson(jqNumberLiteral(context4.source)) : value : void 0;

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
import { performance as performance3 } from "node:perf_hooks";

// src/hooks/lib/deadline.ts
import { performance as performance2 } from "node:perf_hooks";
var armed = null;
function armDeadline(at2, now = () => performance2.now()) {
  armed = { at: at2, now, expired: false };
}
function disarmDeadline() {
  const expired = armed?.expired ?? false;
  armed = null;
  return expired;
}
function spawnLimit(ownMs, killSignal = "SIGTERM") {
  const left = armed ? Math.max(1, Math.ceil(armed.at - armed.now())) : void 0;
  if (left === void 0 || ownMs !== void 0 && ownMs < left) {
    return ownMs === void 0 ? null : { timeout: ownMs, killSignal, byDeadline: false };
  }
  return { timeout: left, killSignal, byDeadline: true };
}
function spawnOptions(limit) {
  return limit ? { timeout: limit.timeout, killSignal: limit.killSignal } : {};
}
function noteSpawn(limit, r) {
  const cut4 = r.error?.code === "ETIMEDOUT" || r.signal !== null;
  if (cut4 && limit?.byDeadline && armed) armed.expired = true;
  return cut4;
}

// src/hooks/lib/sqlite-shell.ts
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
  const limit = spawnLimit(call.killAfterMs, "SIGKILL");
  const r = spawnSync2("sqlite3", cliArgs(call), {
    env,
    input: call.sql === void 0 ? call.script ?? "" : void 0,
    stdio: [call.sql === void 0 ? "pipe" : "ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...spawnOptions(limit)
  });
  noteSpawn(limit, r);
  const stdout = r.stdout ?? "";
  const stderr2 = r.stderr ?? "";
  const errno = r.error?.code;
  if (errno === "ENOENT") return { code: NOT_FOUND_CODE, stdout: "", stderr: "sqlite3: command not found\n" };
  if (errno === "ETIMEDOUT" || r.signal === "SIGKILL") return { code: KILLED_CODE, stdout, stderr: "" };
  if (r.error) return { code: 1, stdout, stderr: stderr2 || `${r.error.message}
` };
  return { code: r.status ?? 1, stdout, stderr: stderr2 };
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
      const close2 = sql.indexOf("*/", i2 + 2);
      if (close2 < 0) {
        unterminated = true;
        i2 = sql.length;
      } else {
        i2 = close2 + 2;
      }
      tokens.push({ kind: "ws", start: start2, end: i2 });
    } else if (ch === "-" && sql[i2 + 1] === "-") {
      const nl = sql.indexOf("\n", i2);
      i2 = nl < 0 ? sql.length : nl;
      tokens.push({ kind: "ws", start: start2, end: i2 });
    } else if (ch === "[" || ch === "`" || ch === '"' || ch === "'") {
      const close2 = sql.indexOf(ch === "[" ? "]" : ch, i2 + 1);
      if (close2 < 0) {
        unterminated = true;
        i2 = sql.length;
      } else {
        i2 = close2 + 1;
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
    this.deadline = killAfterMs === void 0 ? Infinity : performance3.now() + killAfterMs;
    this.applyTimeout(timeoutMs);
  }
  applyTimeout(ms) {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
  }
  checkDeadline() {
    if (performance3.now() >= this.deadline) throw new Killed();
  }
  setTimeout(ms) {
    this.busyMs = ms;
    this.applyTimeout(ms);
  }
  beforeStatement() {
    this.checkDeadline();
    if (this.deadline !== Infinity) {
      this.applyTimeout(Math.min(this.busyMs, Math.ceil(this.deadline - performance3.now())));
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
var BUDGET_KILLED = 124;
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
    const n3 = readSync(fd, buf, 0, 2, 18);
    return [...buf.subarray(0, n3)].join("") === "22";
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
function dbReadBudget(db, budgetMs, script, env = process.env) {
  if (db === "" || !isFile2(db)) return { code: 1, out: "" };
  let ms = digitsOr(budgetMs, DEFAULT_READ_TIMEOUT_MS);
  if (ms <= 0) ms = 1;
  const input = `${stripTrailingNewlines(script)}
`;
  const run5 = (ro) => {
    const r2 = sqliteRun({ target: db, readonly: ro, timeoutMs: ms, script: input, killAfterMs: ms }, env);
    return { code: r2.code === 127 ? 1 : r2.code, out: stripTrailingNewlines(r2.stdout) };
  };
  let r;
  if (walCold(db)) {
    r = run5(false);
  } else {
    r = run5(true);
    if (r.code !== 0 && r.code !== BUDGET_KILLED && walCold(db)) r = run5(false);
  }
  return r;
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
function stateDir(env = process.env) {
  const db = dbPath(env);
  return db === null ? null : posixDirname(db);
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
function dbPathAdvisory(hook = "", env = process.env, onWarning) {
  const db = dbPath(env, onWarning);
  if (db === null) return null;
  if (dbState(env) === "error") {
    onWarning?.(`${hook || "hook"}: trajectory DB unavailable (${db}) \u2014 skipped`);
    return null;
  }
  return db;
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
function sqlLikeEscape(value = "") {
  return stripTrailingNewlines(value.replace(/[\\%_]/g, "\\$&").replace(/'/g, "''"));
}
var TASK_STATUS_LIST = /^[a-z_', ]*$/;
function taskBySlug(db, slug, col = "id", statuses = "", env = process.env, onWarning) {
  if (db === "" || slug === "") return "";
  if (col !== "id" && col !== "branch_id") return "";
  if (!TASK_STATUS_LIST.test(statuses)) return "";
  let where = `branch_id LIKE '%/${sqlLikeEscape(slug)}' ESCAPE '\\'`;
  if (statuses !== "") where += ` AND status IN (${statuses})`;
  const rows = sqliteRo(db, `SELECT id || '|' || branch_id FROM tasks WHERE ${where} ORDER BY id DESC;`, env);
  if (rows === "") return "";
  const lines2 = rows.split("\n");
  const count = lines2.filter((l) => l !== "").length;
  if (count > 1 && onWarning) {
    const branches = lines2.map((l) => l.split("|")[1] ?? l).join(",");
    onWarning(`tmb: worktree slug "${slug}" matches ${count} tasks (${branches}); using the newest`);
  }
  const first = lines2[0];
  const bar = first.indexOf("|");
  if (col === "id") return bar < 0 ? first : first.slice(0, bar);
  return bar < 0 ? first : first.slice(bar + 1);
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

// src/hooks/lib/audit.ts
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
function isFile3(path) {
  try {
    return statSync4(path).isFile();
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
  if (db === "" || !isFile3(db)) {
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
  const start2 = performance4.now();
  const left = () => budget - (spentMs.get(env) ?? 0) - (performance4.now() - start2);
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
  spentMs.set(env, (spentMs.get(env) ?? 0) + (performance4.now() - start2));
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

// src/hooks/lib/host.ts
import { accessSync as accessSync5, constants as constants5, statSync as statSync5 } from "node:fs";
function commandOnPath(name3, env = process.env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    const candidate = `${dir === "" ? "." : dir}/${name3}`;
    try {
      if (!statSync5(candidate).isFile()) continue;
      accessSync5(candidate, constants5.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function sleepSeconds(raw) {
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return;
  const ms = Math.round(Number(raw) * 1e3);
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function commandSubstitution2(text) {
  return text.replaceAll("\0", "").replace(/\n+$/, "");
}
function firstLine(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// src/hooks/tool-output-size.ts
import { readFileSync as readFileSync6 } from "node:fs";
var GATE_NAME2 = "tool-output-size";
var CHARS_PER_TOKEN = 4;
var UNKNOWN_TOOL = "unknown";
var CANDIDATE_MARK = '"tool_';
function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const c of content) {
    const block2 = c;
    if (block2 && typeof block2 === "object" && block2.type === "text" && typeof block2.text === "string") chars += block2.text.length;
  }
  return chars;
}
function parseEntry(line) {
  try {
    const entry = JSON.parse(line);
    return entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
  } catch {
    return null;
  }
}
function toolOutputSizes(transcriptText, sinceMs) {
  const names = /* @__PURE__ */ new Map();
  const results = [];
  let parsed = false;
  const others = [];
  for (const line of transcriptText.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.includes(CANDIDATE_MARK)) {
      if (!parsed) others.push(line);
      continue;
    }
    const entry = parseEntry(line);
    if (entry === null) continue;
    parsed = true;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const inWindow = sinceMs === null || !Number.isNaN(ts) && ts >= sinceMs;
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block2 = raw;
      if (block2.type === "tool_use" && typeof block2.id === "string" && typeof block2.name === "string") {
        names.set(block2.id, block2.name);
      } else if (block2.type === "tool_result" && inWindow) {
        results.push({ toolUseId: typeof block2.tool_use_id === "string" ? block2.tool_use_id : "", chars: resultChars(block2.content) });
      }
    }
  }
  if (!parsed && !others.some((line) => parseEntry(line) !== null)) return null;
  const totals = /* @__PURE__ */ new Map();
  for (const r of results) {
    const name3 = names.get(r.toolUseId) ?? UNKNOWN_TOOL;
    const t = totals.get(name3) ?? { calls: 0, chars: 0 };
    t.calls += 1;
    t.chars += r.chars;
    totals.set(name3, t);
  }
  return [...totals].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([tool_name, t]) => ({
    tool_name,
    calls: t.calls,
    result_chars: t.chars,
    est_tokens: Math.ceil(t.chars / CHARS_PER_TOKEN)
  }));
}
function readTranscript(path) {
  if (path === "") return null;
  try {
    return readFileSync6(path, "utf8");
  } catch {
    return null;
  }
}
function runTarget(env) {
  const agentType = env.TMB_STOP_AGENT_TYPE ?? "";
  if (agentType === "bro") {
    const session = env.TMB_STOP_SESSION_ID ?? "";
    if (session === "") return null;
    return {
      where: `agent_type = 'bro' AND task_id IS NULL AND session_id = '${sqlQuote(session)}'`,
      transcriptKey: "transcript_path",
      sinceMs: null
    };
  }
  if (agentType !== "swe" && agentType !== "code-reviewer") return null;
  const taskId = sqlInt(env.TMB_STOP_TASK_ID ?? "");
  const spawnId = env.TMB_STOP_SPAWN_ID ?? "";
  if (taskId === "" || spawnId === "") return null;
  const since = env.TMB_STOP_SINCE ?? "";
  const sinceMs = since === "" ? null : Date.parse(since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) return null;
  return {
    where: `task_id = ${taskId} AND agent_type = '${agentType}' AND spawn_id = '${sqlQuote(spawnId)}'`,
    transcriptKey: "agent_transcript_path",
    sinceMs
  };
}
function rewriteSql(runId, rows) {
  const del = `DELETE FROM agent_run_tool_output WHERE run_id = ${runId};`;
  if (rows.length === 0) return del;
  const values = rows.map((r) => `(${runId}, '${sqlQuote(r.tool_name)}', ${r.calls}, ${r.result_chars}, ${r.est_tokens})`).join(",\n       ");
  return `${del}
INSERT INTO agent_run_tool_output (run_id, tool_name, calls, result_chars, est_tokens)
VALUES ${values};`;
}
function toolOutputSize(payload, env) {
  try {
    const target = runTarget(env);
    if (target === null) return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const text = readTranscript(jqAlternatives(payload, [[target.transcriptKey]]));
    if (text === null) return ALLOW;
    const rows = toolOutputSizes(text, target.sinceMs);
    if (rows === null) return ALLOW;
    const found = gateRead(db, `SELECT id FROM agent_runs WHERE ${target.where} ORDER BY id DESC LIMIT 1;`, env);
    const runId = found === GATE_READ_ERROR ? "" : sqlInt(found);
    if (runId === "") return ALLOW;
    dbWrite(db, rewriteSql(runId, rows), { caller: GATE_NAME2, env });
  } catch {
  }
  return ALLOW;
}

// src/hooks/bro-turn-usage.ts
var GATE_NAME3 = "bro-turn-usage";
var ISO = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z\n?$/;
var STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
var MODEL_STRIP = /[^A-Za-z0-9._:@/[\]-]/gu;
var DBL_MAX = Number.MAX_VALUE;
var JqError3 = class extends Error {
};
function isFile4(path) {
  try {
    return statSync6(path).isFile();
  } catch {
    return false;
  }
}
function index2(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError3(`Cannot index with ${key2}`);
  const v = value[key2];
  return v === void 0 ? null : v;
}
function truthy2(v) {
  return v !== null && v !== void 0 && v !== false;
}
function jqKeyOr(text, key2, fallback) {
  const out2 = [];
  for (const value of jsonValues(text)) {
    try {
      const v = index2(value, key2);
      out2.push(truthy2(v) ? jqRawText(v) : fallback);
    } catch (e) {
      if (!(e instanceof JqError3)) throw e;
    }
  }
  return stripTrailingNewlines(out2.join("\n"));
}
function typeRank(v) {
  if (v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "string") return 4;
  return Array.isArray(v) ? 5 : 6;
}
function jqCompare(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 4) return byteCompare(a, b);
  if (ra === 5) {
    const x = a;
    const y = b;
    for (let i2 = 0; i2 < Math.min(x.length, y.length); i2 += 1) {
      const c = jqCompare(x[i2], y[i2]);
      if (c !== 0) return c;
    }
    return x.length - y.length;
  }
  if (ra === 6) {
    const x = a;
    const y = b;
    const kx = Object.keys(x).sort(byteCompare);
    const ky = Object.keys(y).sort(byteCompare);
    const c = jqCompare(kx, ky);
    if (c !== 0) return c;
    for (const k of kx) {
      const d = jqCompare(x[k], y[k]);
      if (d !== 0) return d;
    }
  }
  return 0;
}
function jqNumber(v) {
  return v === Infinity ? DBL_MAX : v === -Infinity ? -DBL_MAX : v;
}
function n(v) {
  return typeof v === "number" && jqNumber(v) >= 0 ? Math.floor(jqNumber(v)) : 0;
}
function jqIntText(x) {
  if (Object.is(x, -0)) return "-0";
  if (!Number.isFinite(x)) return x > 0 ? "1.7976931348623157e+308" : "-1.7976931348623157e+308";
  if (x === 0) return "0";
  const sign = x < 0 ? "-" : "";
  const [mant, exp] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const decpt = Number(exp) + 1;
  if (decpt > digits.length + 15 || decpt <= -4) {
    const e = Number(exp);
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}
function iso(v) {
  if (typeof v !== "string") return null;
  const m = ISO.exec(v);
  if (m === null) return null;
  return `${m[1]}.${`${m[3] ?? ""}000`.slice(0, 3)}Z`;
}
function model(v) {
  return typeof v === "string" && !v.startsWith("<") ? v.replace(MODEL_STRIP, "") : "";
}
function add(values) {
  return values.reduce((s, v) => s + v);
}
function toolUses(message) {
  let content = index2(message, "content");
  if (!truthy2(content)) content = [];
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block2 of content) if (index2(block2, "type") === "tool_use") count += 1;
  return count;
}
function reduce(values) {
  const main = values.filter((v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v;
    return !truthy2(o.isSidechain) && o.message !== void 0 && o.message !== null;
  });
  const stamps = main.map((v) => iso(v.timestamp)).filter((s) => s !== null);
  const entries = [];
  main.forEach((v, i2) => {
    const message = v.message;
    const usage = index2(message, "usage");
    if (usage === null) return;
    const mid = index2(message, "id");
    const id = truthy2(mid) ? mid : truthy2(v.uuid) ? v.uuid : `line-${i2}`;
    const ts = iso(v.timestamp);
    const m = model(index2(message, "model"));
    const tu = toolUses(message);
    if (ts !== null) entries.push({ id, u: usage, m, tu });
  });
  const sorted = [...entries].sort((a, b) => jqCompare(a.id, b.id));
  const groups = [];
  for (const e of sorted) {
    const g = groups.at(-1);
    if (g !== void 0 && jqCompare(g[0].id, e.id) === 0) g.push(e);
    else groups.push([e]);
  }
  const rows = groups.map((g) => {
    const lastEntry = g[g.length - 1];
    const u = lastEntry.u;
    return {
      ti: n(index2(u, "input_tokens")),
      to: n(index2(u, "output_tokens")),
      cr: n(index2(u, "cache_read_input_tokens")),
      cc: n(index2(u, "cache_creation_input_tokens")),
      tu: add(g.map((e) => e.tu)),
      m: lastEntry.m
    };
  });
  const byModel = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (r.m === "") continue;
    const tok = r.ti + r.to + r.cr + r.cc;
    byModel.set(r.m, byModel.has(r.m) ? byModel.get(r.m) + tok : tok);
  }
  const ranked = [...byModel.entries()].sort((a, b) => jqCompare([-a[1], a[0]], [-b[1], b[0]]));
  if (ranked.length === 0 || !(add(rows.map((r) => r.to)) > 0)) return null;
  const sorted2 = [...stamps].sort(byteCompare);
  return {
    first: sorted2[0],
    last: sorted2[sorted2.length - 1],
    tokensIn: jqIntText(add(rows.map((r) => r.ti))),
    tokensOut: jqIntText(add(rows.map((r) => r.to))),
    cacheRead: jqIntText(add(rows.map((r) => r.cr))),
    cacheCreation: jqIntText(add(rows.map((r) => r.cc))),
    toolUses: jqIntText(add(rows.map((r) => r.tu))),
    model: ranked[0][0]
  };
}
function turnUsage(transcript) {
  const { values, complete } = jsonStream(transcript);
  if (!complete) return null;
  try {
    return reduce(values);
  } catch (e) {
    if (e instanceof JqError3) return null;
    throw e;
  }
}
function pluginVersion(env) {
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (root === "" || !isFile4(manifest)) return "";
  let text;
  try {
    text = readFileSync7(manifest, "utf8");
  } catch {
    return "";
  }
  const out2 = [];
  for (const value of jsonValues(text)) {
    try {
      const v = index2(value, "version");
      if (truthy2(v)) out2.push(jqRawText(v));
    } catch (e) {
      if (!(e instanceof JqError3)) throw e;
    }
  }
  return stripTrailingNewlines(out2.join("\n"));
}
function usageValid(u) {
  return STAMP.test(u.first) && STAMP.test(u.last) && [u.tokensIn, u.tokensOut, u.cacheRead, u.cacheCreation, u.toolUses].every((v) => /^[0-9]+$/.test(v));
}
function usageSql(db, sessionId, u, env) {
  const projectRoot2 = posixDirname(posixDirname(posixDirname(db)));
  const rootSql = dbLocation(projectRoot2, env) === db ? `'${sqlQuote(projectRoot2)}'` : "NULL";
  const version = pluginVersion(env);
  const versionSql = version !== "" ? `'${sqlQuote(version)}'` : "NULL";
  const session = sqlQuote(sessionId);
  const sessionRow = `agent_type = 'bro' AND task_id IS NULL AND session_id = '${session}'`;
  const duration = `MAX(0, CAST(ROUND((julianday('${u.last}') - julianday('${u.first}')) * 86400000) AS INTEGER))`;
  const model3 = `'${u.model}'`;
  return `
UPDATE agent_runs
   SET tokens_in             = ${u.tokensIn},
       tokens_out            = ${u.tokensOut},
       cache_read_tokens     = ${u.cacheRead},
       cache_creation_tokens = ${u.cacheCreation},
       tool_uses             = ${u.toolUses},
       started_at            = '${u.first}',
       completed_at          = '${u.last}',
       duration_ms           = ${duration},
       usage_source          = 'transcript',
       model                 = ${model3},
       host                  = 'claude',
       root_dir              = COALESCE(${rootSql}, root_dir),
       exit_reason           = 'completed'
 WHERE ${sessionRow};

INSERT INTO agent_runs (agent_type, task_id, issue_id, session_id, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, started_at, completed_at, duration_ms,
                        usage_source, model, host, root_dir, exit_reason, plugin_version)
SELECT 'bro', NULL, NULL, '${session}', ${u.tokensIn}, ${u.tokensOut}, ${u.cacheRead}, ${u.cacheCreation}, ${u.toolUses},
       '${u.first}', '${u.last}', ${duration}, 'transcript', ${model3}, 'claude', ${rootSql}, 'completed',
       ${versionSql}
 WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE ${sessionRow});
`;
}
var broTurnUsage = (payload, env) => {
  if ((env.TMB_DISABLE_BRO_TURN_USAGE_HOOK ?? "0") === "1") return ALLOW;
  const db = dbPath(env) ?? "";
  if (db === "" || !isFile4(db)) return ALLOW;
  const input = commandSubstitution2(payload);
  const sessionId = jqKeyOr(input, "session_id", "");
  const transcript = jqKeyOr(input, "transcript_path", "");
  if (sessionId === "" || transcript === "" || !isFile4(transcript)) return ALLOW;
  let text;
  try {
    text = readFileSync7(transcript, "utf8");
  } catch {
    return ALLOW;
  }
  const usage = turnUsage(text);
  if (usage === null || !usageValid(usage)) return ALLOW;
  const r = dbWrite(db, usageSql(db, sessionId, usage, env), { env, caller: GATE_NAME3 });
  if (!r.ok) {
    process.stderr.write(`${r.error}
`);
  } else {
    try {
      toolOutputSize(payload, { ...env, TMB_STOP_AGENT_TYPE: "bro", TMB_STOP_SESSION_ID: sessionId });
    } catch {
    }
  }
  return { stdout: r.stdout, code: 0 };
};

// src/hooks/attribution-footer.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { accessSync as accessSync6, constants as constants6, statSync as statSync8 } from "node:fs";

// src/hooks/cmd-analysis/path.ts
import { existsSync as existsSync4, lstatSync as lstatSync2, readlinkSync as readlinkSync2 } from "node:fs";
var MAX_HOPS = 40;
function isLink(p) {
  try {
    return lstatSync2(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function pathCanonical(path) {
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
      const link = readlinkSync2(next);
      if (link.startsWith("/")) cur = "";
      rest = `${link}/${rest}`;
      continue;
    }
    if (existsSync4(next)) cur = next;
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

// src/hooks/lib/lint-shell.ts
import { existsSync as existsSync5 } from "node:fs";
var JqError4 = class extends Error {
};
function jqIndex2(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError4(`Cannot index ${typeof value} with "${key2}"`);
  return Object.hasOwn(value, key2) ? value[key2] : null;
}
function jqPath(...keys) {
  return (value) => keys.reduce((v, key2) => jqIndex2(v, key2), value);
}
function jqTruthy(value) {
  return value !== null && value !== void 0 && value !== false;
}
function wellFormed(text) {
  return text.replace(new RegExp("\\p{Cs}", "gu"), "\uFFFD");
}
function shellCapture2(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}
function jqRawLines(text, filter) {
  const lines2 = [];
  for (const value of jsonValues(text)) {
    try {
      lines2.push(wellFormed(jqRawText(filter(value))));
    } catch (e) {
      if (!(e instanceof JqError4)) throw e;
    }
  }
  return shellCapture2(lines2.join("\n"));
}
function jqRawOr(text, filters) {
  return jqRawLines(text, (value) => {
    for (const f of filters) {
      const v = f(value);
      if (jqTruthy(v)) return v;
    }
    return "";
  });
}
function jqJoinLines(items) {
  return items.map((v) => {
    if (v === null || v === void 0) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
    throw new JqError4("cannot be added");
  }).join("\n");
}
function jqEachOptional(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value);
  return [];
}
var LOCALE_CATEGORIES2 = ["LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"];
function localeLoads(name3, category) {
  if (name3 === "C" || name3 === "POSIX") return true;
  return !name3.includes("/") && existsSync5(`/usr/share/locale/${name3}/${category}`);
}
function grepMultibyte(env) {
  const name3 = (category) => env.LC_ALL || env[category] || env.LANG || "C";
  if (!LOCALE_CATEGORIES2.every((c) => localeLoads(name3(c), c))) return false;
  return /(^|\.)utf-?8$/i.test(name3("LC_CTYPE"));
}
var ASCII_SPACE = " \\t\\n\\v\\f\\r";
var UNICODE_SPACE = "\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
function grepSpace(multibyte) {
  return multibyte ? ASCII_SPACE + UNICODE_SPACE : ASCII_SPACE;
}
function grepAlnum(multibyte) {
  return multibyte ? "\\p{L}\\p{Nd}" : "A-Za-z0-9";
}
function awkSpace(env) {
  return ctypeUtf8(env) ? `${ASCII_SPACE}\\u00a0` : ASCII_SPACE;
}
function anyLine(text, re) {
  return text.split("\n").some((line) => re.test(line));
}
function preToolContext(ctx) {
  return `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: wellFormed(ctx) } })}
`;
}

// src/hooks/lib/git.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { statSync as statSync7 } from "node:fs";
var GIT_MAX_BUFFER = 256 * 1024 * 1024;
function gitRun(dir, args2, env = process.env, input = "", stderr2 = "ignore") {
  const limit = spawnLimit();
  const r = spawnSync3("git", ["-C", dir, ...args2], {
    encoding: "utf8",
    env,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["pipe", "pipe", stderr2],
    ...spawnOptions(limit)
  });
  noteSpawn(limit, r);
  return { code: r.error ? -1 : r.status ?? -1, stdout: r.stdout ?? "" };
}
function gitOut(dir, args2, env = process.env, input = "") {
  return gitRun(dir, args2, env, input).stdout.replace(/\n+$/, "");
}
function gitOk(dir, args2, env = process.env, stderr2 = "ignore") {
  return gitRun(dir, args2, env, "", stderr2).code === 0;
}
function isDir(path) {
  if (path === "") return false;
  try {
    return statSync7(path).isDirectory();
  } catch {
    return false;
  }
}
function cdPwd(path, pwd) {
  if (!isDir(path === "" ? "." : path)) return "";
  const abs = path.startsWith("/") ? path : `${pwd.replace(/\/$/, "")}/${path}`;
  const out2 = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out2.pop();
    else out2.push(part);
  }
  return `/${out2.join("/")}`;
}

// src/hooks/attribution-footer.ts
var GATE_NAME4 = "attribution-footer";
var TMB_FOOTER = "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code), powered by [Bro](https://github.com/trustmybot/plugin)";
var KINDS = [
  { cli: "gh", group: "pr", urlPath: "/pull/" },
  { cli: "gh", group: "issue", urlPath: "/issues/" },
  { cli: "glab", group: "mr", urlPath: "/-/merge_requests/" },
  { cli: "glab", group: "issue", urlPath: "/-/issues/" }
];
function normalizeFooter(body2, env = process.env) {
  const text = shellCapture2(body2);
  const kept = text === "" ? [] : text.split("\n").filter((l) => !(l.includes("\u{1F916} Generated with [Claude Code]") && !l.includes("powered by Bro")));
  const stripped = shellCapture2(kept.map((l) => `${l}
`).join(""));
  if (stripped !== "" && stripped.split("\n").some((l) => l.includes(TMB_FOOTER))) return stripped;
  const blank2 = new RegExp(`^[${awkSpace(env)}]*$`, "u");
  const lines2 = stripped === "" ? [] : stripped.split("\n");
  let last = lines2.length;
  while (last > 0 && blank2.test(lines2[last - 1])) last -= 1;
  const trimmed = shellCapture2(lines2.slice(0, last).map((l) => `${l}
`).join(""));
  return trimmed === "" ? TMB_FOOTER : `${trimmed}

${TMB_FOOTER}`;
}
function onPath3(name3, env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    const file = `${dir === "" ? "." : dir}/${name3}`;
    try {
      if (!statSync8(file).isFile()) continue;
      accessSync6(file, constants6.X_OK);
      return file;
    } catch {
      continue;
    }
  }
  return null;
}
function run2(file, args2, cwd, env) {
  const r = spawnSync4(file, args2, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 30 });
  return { stdout: r.stdout ?? "", ok: r.error === void 0 && r.status === 0 };
}
function glabDescription(json) {
  const { values, complete } = jsonStream(json);
  const lines2 = [];
  let failed = false;
  for (const value of values) {
    try {
      const v = jqIndex2(value, "description");
      lines2.push(wellFormed(jqRawText(jqTruthy(v) ? v : "")));
      failed = false;
    } catch (e) {
      if (!(e instanceof JqError4)) throw e;
      failed = true;
    }
  }
  if (!complete || failed) return null;
  return shellCapture2(lines2.join("\n"));
}
function toolResponse(payload) {
  return jqRawLines(payload, (value) => {
    const response = jqPath("tool_response")(value);
    return typeof response === "string" ? response : jqCompact(response ?? null);
  });
}
function created(command, kind, multibyte) {
  const edge = `[^${grepAlnum(multibyte)}_-]`;
  const space2 = `[${grepSpace(multibyte)}]+`;
  const re = new RegExp(`(^|${edge})${kind.cli}${space2}${kind.group}${space2}create(${edge}|$)`, "u");
  return command.split("\n").some((line) => re.test(line));
}
function createdArtifact(response, kind, multibyte) {
  const re = new RegExp(`https://([^${grepSpace(multibyte)}"]+)${kind.urlPath}([0-9]+)`, "u");
  for (const line of response.split("\n")) {
    const m = re.exec(line);
    if (m) return { number: m[2], repoPath: m[1] };
  }
  return null;
}
function targetingRepo(kind, repoPath, env) {
  return kind.cli === "gh" ? { ...env, GH_REPO: repoPath } : { ...env, GITLAB_REPO: `https://${repoPath}` };
}
var attributionFooter = (payload, env) => {
  if (jqRawOr(payload, [jqPath("tool_name")]) !== "Bash") return ALLOW;
  const command = jqRawOr(payload, [jqPath("tool_input", "command")]);
  const response = toolResponse(payload);
  if (command === "") return ALLOW;
  const multibyte = grepMultibyte(env);
  const kind = KINDS.find((k) => created(command, k, multibyte));
  if (kind === void 0) return ALLOW;
  const artifact = createdArtifact(response, kind, multibyte);
  if (artifact === null) return ALLOW;
  const { number, repoPath } = artifact;
  const cli = onPath3(kind.cli, env);
  if (cli === null) return ALLOW;
  const startDir = payloadCwd(payload, env);
  const cwd = isDir(startDir) ? startDir : void 0;
  const forgeEnv = targetingRepo(kind, repoPath, env);
  let orig;
  if (kind.cli === "gh") {
    const view = run2(cli, [kind.group, "view", number, "--json", "body", "-q", ".body"], cwd, forgeEnv);
    if (!view.ok) return ALLOW;
    orig = shellCapture2(view.stdout);
  } else {
    const view = run2(cli, [kind.group, "view", number, "-F", "json"], cwd, forgeEnv);
    const description = view.ok ? glabDescription(view.stdout) : null;
    if (description === null) return ALLOW;
    orig = description;
  }
  const updated = shellCapture2(normalizeFooter(orig, env));
  if (updated === orig) return ALLOW;
  const write2 = kind.cli === "gh" ? [kind.group, "edit", number, "--body", updated] : [kind.group, "update", number, "--description", updated];
  run2(cli, write2, cwd, forgeEnv);
  return ALLOW;
};

// src/hooks/code-quality-lint.ts
var GATE_NAME5 = "code-quality-lint";
var TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
var SOURCE_EXTS = [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
var TS_EXTS = /* @__PURE__ */ new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
var SKIPPED_DIRS = ["/node_modules/", "/dist/", "/build/", "/__pycache__/", "/target/", "/fixtures/", "/__fixtures__/"];
var PY_CHECKS = [
  { pattern: "^[S]*except[S]*:", message: "bare 'except:' \u2014 catch a specific exception or re-raise" },
  { pattern: "^[S]*except[S]+Exception[S]*[:as ]", message: "'except Exception' is too broad \u2014 catches SystemExit/KeyboardInterrupt" }
];
var PY_LATER_CHECKS = [
  { pattern: `f['"](SELECT|INSERT|UPDATE|DELETE|MERGE)[S]`, message: "f-string SQL \u2014 use parameterized queries to prevent injection" },
  { pattern: "datetime\\.utcnow\\(\\)", message: "datetime.utcnow() returns naive datetime \u2014 use datetime.now(timezone.utc)" },
  { pattern: "def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\[\\]", message: "mutable default argument [] \u2014 use None and assign in body" },
  { pattern: "def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\{\\}", message: "mutable default argument {} \u2014 use None and assign in body" }
];
var TS_CHECKS = [
  {
    pattern: "catch[S]*\\([S]*[A-Za-z_][A-Za-z0-9_]*[S]*:[S]*any[S]*\\)",
    message: "catch (e: any) \u2014 use 'unknown' and narrow with instanceof"
  },
  { pattern: "`(SELECT|INSERT|UPDATE|DELETE|MERGE)[^`]*[$][{]", message: "template-string SQL with ${...} \u2014 use parameterized queries" },
  { pattern: `setTimeout\\([S]*['"]`, message: "setTimeout with string argument \u2014 use a function reference" }
];
var MARKER_CHECK = {
  pattern: "(TODO|FIXME|HACK|XXX)([S]|:|$)",
  message: "TODO/FIXME/HACK \u2014 finish the work or escalate; don't ship the marker"
};
function regex(pattern, multibyte) {
  return new RegExp(pattern.replace(/\[S\]/g, `[${grepSpace(multibyte)}]`), "u");
}
function newContent(payload) {
  return jqRawOr(payload, [
    jqPath("tool_input", "content"),
    jqPath("tool_input", "new_string"),
    (value) => jqJoinLines(jqEachOptional(jqPath("tool_input", "edits")(value)).map((edit) => jqIndex2(edit, "new_string")))
  ]);
}
function pythonFindings(content, multibyte) {
  const found = PY_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message);
  const call = regex("subprocess\\.run\\([^)]*\\)", multibyte);
  const timeout = regex("timeout[S]*=", multibyte);
  const unbounded = content.split("\n").some((line) => call.test(line) && !timeout.test(line));
  if (anyLine(content, /subprocess\.run\(/) && unbounded) found.push("subprocess.run without timeout= \u2014 risk of indefinite hang");
  return found.concat(PY_LATER_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message));
}
var codeQualityLint = (payload, env) => {
  if ((env.TMB_SKIP_CQ_LINT ?? "0") === "1") return ALLOW;
  if (!TOOLS.has(jqRawOr(payload, [jqPath("tool_name")]))) return ALLOW;
  const target = jqRawOr(payload, [jqPath("tool_input", "file_path")]);
  if (target === "" || !SOURCE_EXTS.some((ext2) => target.endsWith(ext2))) return ALLOW;
  if (SKIPPED_DIRS.some((d) => target.includes(d))) return ALLOW;
  const content = newContent(payload);
  if (content === "") return ALLOW;
  const ext = target.slice(target.lastIndexOf(".") + 1);
  const multibyte = grepMultibyte(env);
  const findings = [];
  if (ext === "py") findings.push(...pythonFindings(content, multibyte));
  else if (TS_EXTS.has(ext)) findings.push(...TS_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message));
  if (anyLine(content, regex(MARKER_CHECK.pattern, multibyte))) findings.push(MARKER_CHECK.message);
  if (findings.length === 0) return ALLOW;
  const ctx = `code-quality-lint: ${target}${findings.map((f) => `
 - ${f}`).join("")}
Set TMB_SKIP_CQ_LINT=1 to bypass.`;
  return { stdout: preToolContext(ctx), code: 0 };
};

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
var QM = "";
var QM_LITERAL = "$" + ENC[8] + ENC[9];
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
  if (c === QM) return QM_LITERAL;
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
        out2 += c === QM ? QM_LITERAL : c;
        continue;
      }
      const next = i2 + 1 < to ? src[i2 + 1] : void 0;
      out2 += QM + neutral(next);
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
    let at2 = from;
    for (const sub of substitutions(node, [])) {
      if (sub.startIndex < from || sub.endIndex > to) continue;
      const start2 = this.opener(sub);
      out2 += this.quoted(at2, start2, true);
      const open = this.src.startsWith("$(", start2) ? 2 : 1;
      out2 += QO + this.range(sub, start2 + open, sub.endIndex - 1) + QC;
      at2 = sub.endIndex;
    }
    return out2 + this.quoted(at2, to, true);
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
    let at2 = from;
    const queue = [...spans].sort((a, b) => a.start - b.start);
    while (queue.length) {
      const span = queue.shift();
      if (span.start < at2) continue;
      out2 += this.plain(at2, span.start);
      const { node } = span;
      if (span.node.type === "heredoc_redirect" && span.start === node.startIndex && span.end === node.endIndex) {
        const h = this.heredoc(node);
        out2 += h.text;
        at2 = h.skipTo;
        queue.push(...h.rest.filter((s) => s.start >= at2 && s.end <= to));
        queue.sort((a, b) => a.start - b.start);
        continue;
      }
      at2 = span.end;
      switch (node.type) {
        case "heredoc_redirect":
        case "comment":
          break;
        case "string":
          out2 += QM + this.dquoted(node, span.start + 1, span.end - 1);
          break;
        case "translated_string":
          out2 += "$" + QM + this.dquoted(node, span.start + 2, span.end - 1);
          break;
        case "raw_string":
          out2 += QM + this.quoted(span.start + 1, span.end - 1, false);
          break;
        case "ansi_c_string":
          out2 += QM + this.quoted(span.start + 2, span.end - 1, true);
          break;
      }
    }
    return out2 + this.plain(at2, to);
  }
};
var EXPANSIONS = ["simple_expansion", "expansion", "command_substitution", "arithmetic_expansion", "process_substitution"];
var expands = (node) => node.descendantsOfType(EXPANSIONS).length > 0;
function heldKey(word) {
  return decode(word).replaceAll(QM, "").replace(/\x07/g, "$(").replace(/\x08/g, ")");
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
function lineAt(src, at2) {
  const end = src.indexOf("\n", at2);
  return src.slice(src.lastIndexOf("\n", at2 - 1) + 1, end < 0 ? src.length : end);
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
  const n3 = w.length;
  while (k < n3) {
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
    while (k < n3 && w[k].startsWith("-")) {
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
    if ((a === "timeout" || a === "gtimeout") && k < n3) k++;
  }
  return { k, dirs };
}

// src/hooks/cmd-analysis/statements.ts
var SEP = "";
var LOOP_OPEN = "{";
var LOOP_CLOSE = "}";
var UNBALANCED = "!";
var WSEP = "";
var ALT = "";
var MAX_GROWTH = 8;
var MAX_DIRS = 8;
var VSEP = "";
var VEQ = "";
var BAD = "";
var VPLAIN = /^(cd|git|echo|true|false|ls|cat|pwd|mkdir|touch)$/;
var VBAD = "*?[](){<>`";
var HD_MARK = /<<[\x1a\x1e]/g;
var VSPECIAL = /^(IFS|PWD|OLDPWD|RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|BASHPID|PPID|UID|EUID|GROUPS|HISTCMD|PIPESTATUS|FUNCNAME|BASH_[A-Z_]*)$/;
var KEYWORD = /^(\{|\}|!|if|then|else|elif|do|while|until|fi|done|esac)$/;
var NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
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
    if (part === ".." && out2.length === 0 && lead === "") continue;
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
  body2 = unmark(body2).replaceAll(QM, "");
  if (/[;&|()`\n]/.test(body2) || body2.includes(QO) || body2.includes(QC)) return "";
  body2 = body2.replace(/[ \t]+/g, SEP);
  if (body2.startsWith(SEP)) body2 = body2.slice(1);
  if (body2.endsWith(SEP)) body2 = body2.slice(0, -1);
  if (body2 === "") return "";
  return SEP + dir + SEP + body2;
}
function statementsEnc(buf, base2, home, assign) {
  const frames = { ext: [], runs: [], grew: /* @__PURE__ */ new Set(), lost: /* @__PURE__ */ new Set() };
  for (; ; ) {
    frames.grew.clear();
    const records2 = scan2(buf, base2, home, assign, frames);
    if (frames.grew.size === 0) return records2;
    for (const fo of frames.grew) if (++frames.runs[fo] === MAX_GROWTH) frames.lost.add(fo);
  }
}
function scan2(buf, base2, home, assign, frames) {
  const records2 = [];
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
  let s = base2.indexOf(SEP);
  if (s >= 0) {
    old = base2.slice(s + 1);
    base2 = base2.slice(0, s);
  }
  s = old.indexOf(SEP);
  if (s >= 0) {
    cwhy = old.slice(s + 1);
    old = old.slice(0, s);
  }
  let alts = base2.split(ALT);
  let cur = alts.shift();
  let oalts = [];
  let sp = 0;
  let bt = false;
  let stmt = "";
  let qsp = 0;
  const stack = [];
  const ostack = [];
  const wstack = [];
  const owstack = [];
  const astack = [];
  const oastack = [];
  const q = [];
  const emit3 = (dir, text) => records2.push({ dir, stmt: text });
  const loops = [];
  const fids = [];
  const fent = [];
  let nf = 0;
  let unbal = false;
  let wq = [];
  function loopkw(k) {
    const top = loops.length > 0 ? loops[loops.length - 1] : "";
    if (k === "while" || k === "until") {
      loops.push("w");
      fopen();
    } else if (k === "do") {
      if (top === "w") loops[loops.length - 1] = "o";
      else if (top === "f") {
        loops[loops.length - 1] = "o";
        fopen();
      } else {
        unbal = true;
        loops.push("o");
        fopen();
      }
    } else if (k === "{") {
      if (top === "f") {
        loops[loops.length - 1] = "b";
        fopen();
      } else loops.push("g");
    } else if (k === "done") {
      if (top === "o") {
        loops.pop();
        fclose();
      } else unbal = true;
    } else if (k === "}") {
      if (top === "b") {
        loops.pop();
        fclose();
      } else if (top === "g") loops.pop();
      else unbal = true;
    }
  }
  function fopen() {
    const fo = nf++;
    fids.push(fo);
    frames.ext[fo] ??= [];
    frames.runs[fo] ??= 0;
    alts = [...alts];
    for (const t of frames.ext[fo]) altadd(alts, t, cur, cwhy);
    if (frames.lost.has(fo)) lose();
    bound();
    fent[fo] = { cur, why: cwhy, alts: [...alts] };
    emit3(LOOP_OPEN, "do");
  }
  function fclose() {
    const fo = fids.pop();
    const e = fent[fo];
    const ends = cur === e.cur && cwhy === e.why ? [...alts] : [cur, ...alts];
    const known = e.cur === "-" && e.why !== "" ? e.alts : [e.cur, ...e.alts];
    alts = [...e.alts];
    for (const t of ends) {
      if (!known.includes(t) && frames.runs[fo] < MAX_GROWTH && !frames.ext[fo].includes(t)) {
        frames.ext[fo].push(t);
        frames.grew.add(fo);
      }
      altadd(alts, t, e.cur, e.why);
    }
    cur = e.cur;
    cwhy = e.why;
    bound();
    emit3(LOOP_CLOSE, "done");
  }
  function lose() {
    cur = "-";
    cwhy = "";
    alts = [];
  }
  function bound() {
    if (alts.length >= MAX_DIRS) lose();
  }
  function altadd(as, t, d, dw) {
    if (t === d && (t !== "-" || dw === "")) return;
    if (!as.includes(t)) as.push(t);
  }
  function cdalts(as, p, d, dw) {
    const out2 = [];
    for (const a of as) {
      const t = resolve4(a, p);
      if (t === "-" && d === "-" && dw.includes(WSEP)) {
        const aw = whyof(a, "", p);
        if (aw.includes(WSEP) && aw.slice(aw.indexOf(WSEP)) === dw.slice(dw.indexOf(WSEP))) {
          if (aw.slice(0, aw.indexOf(WSEP)) !== dw.slice(0, dw.indexOf(WSEP))) dw = "-" + dw.slice(dw.indexOf(WSEP));
          continue;
        }
      }
      altadd(out2, t, d, dw);
    }
    return [out2, dw];
  }
  function here() {
    return alts.length > 0 ? "-" : cur;
  }
  function altTok(as) {
    return as.map((a) => ALT + a).join("");
  }
  function forhead(w, k) {
    loops.push("f");
    let c = 0;
    for (k++; k < w.length && c < 2; k++) {
      if (w[k] === "") continue;
      if (++c === 2 && !wq[k] && (w[k] === "do" || w[k] === "{")) loopkw(w[k]);
    }
  }
  function loopprefix(w, first) {
    let c = 0;
    for (let k = first + 1; k < w.length && c < 2; k++) {
      if (w[k] === "") continue;
      c++;
      if (wq[k]) continue;
      if (w[k] === "for" || w[k] === "select") {
        forhead(w, k);
        return;
      }
      if (/^(while|until|\{)$/.test(w[k])) {
        loopkw(w[k]);
        return;
      }
    }
  }
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
    return srcmark(buf.slice(pos + 1, j), here());
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
        const mark = srcmark(buf.slice(k + 2, j), here());
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
      } else if (hit = NAME.exec(rest)) {
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
  function resolve4(d, p) {
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
    if (!vplainexp(stmt.replaceAll(QM, ""))) vok = false;
    stmt = unmark(stmt);
    const csure = !cond;
    cond = false;
    const w = splitWords(stmt);
    wq = w.map((word) => word.includes(QM));
    for (let k = 0; k < w.length; k++) w[k] = w[k].replaceAll(QM, "");
    const n3 = w.length;
    stmt = "";
    let first = 0;
    asg = "";
    let cdw = "";
    const aw = [];
    let plain = true;
    const waspiped = piped;
    piped = false;
    lastout = "";
    lastdir = here();
    let sawwhile = false;
    while (first < n3) {
      if (w[first] === "") {
        first++;
        continue;
      }
      if (w[first] === "while") sawwhile = true;
      if (KEYWORD.test(w[first])) {
        if (assign && !wq[first]) loopkw(w[first]);
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
        while (k < n3 && w[k].startsWith("-")) k++;
        if (k < n3 && ASSIGNMENT.test(w[k])) {
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
    if (first >= n3) {
      let ok2 = plain;
      if (vtop && plain) {
        for (const a of aw) if (!assignword(a, !csure)) ok2 = false;
      }
      if (assign && asg !== "") {
        emit3("=" + cur + altTok(alts) + SEP + (oalts.length > 0 ? "-" : old), asg);
        if (!chained) {
          old = "-";
          owhy = "";
          oalts = [];
        }
      }
      vend(ok2);
      return;
    }
    let a0 = w[first];
    if (assign && !wq[first] && (a0 === "for" || a0 === "select")) forhead(w, first);
    else if (assign && !wq[first] && (a0 === "coproc" || a0 === "function")) loopprefix(w, first);
    let ok = plain && aw.length === 0;
    if (ok && a0 === "export") {
      for (let k = first + 1; k < n3; k++) {
        if (w[k] === "") continue;
        if (!ASSIGNMENT.test(w[k])) ok = false;
        else if (vtop && !assignword(w[k], !csure)) ok = false;
      }
    } else if (ok) {
      ok = VPLAIN.test(a0);
    }
    let out2 = a0;
    for (let k = first + 1; k < n3; k++) if (w[k] !== "") out2 += " " + w[k];
    if (cdw !== "") {
      out2 = cdw + " " + out2;
      a0 = "";
    }
    lastout = out2;
    let d = cur;
    let da = alts;
    const o = oalts.length > 0 ? "-" : old;
    let dw = cwhy;
    if (a0 === "cd" || a0 === "pushd") {
      let p = "";
      for (let k = first + 1; k < n3; k++) {
        if (w[k] === "") continue;
        if (/^-[LPe@]+$/.test(w[k])) continue;
        p = w[k];
        break;
      }
      if (p === "-" && a0 === "cd") {
        [cur, old] = [old, cur];
        [cwhy, owhy] = [owhy, cwhy];
        [alts, oalts] = [oalts, alts];
      } else if (p === "" || p === "-") {
        old = cur;
        owhy = cwhy;
        oalts = alts;
        cur = "-";
        alts = [];
        cwhy = p === "" && a0 === "cd" ? "-" + WSEP + "$HOME" : "";
      } else {
        old = cur;
        owhy = cwhy;
        oalts = alts;
        const t = resolve4(cur, p);
        cwhy = t === "-" ? whyof(cur, cwhy, p) : "";
        cur = t;
        [alts, cwhy] = cdalts(oalts, p, cur, cwhy);
      }
    } else if (a0 === "popd") {
      old = cur;
      owhy = cwhy;
      oalts = alts;
      cur = "-";
      alts = [];
      cwhy = "";
    } else if (assign && a0 === "read") {
      let mk = sawwhile ? donesrc(i2) : "";
      if (mk === "" && waspiped) mk = pipesrc;
      if (mk !== "" && mk !== "!") out2 += " " + mk;
    } else if (assign && a0 === "xargs") {
      if (waspiped && pipesrc !== "") out2 += " " + pipesrc;
    } else if (a0 === "git") {
      for (let k = first + 1; k < n3; k++) {
        if (w[k] === "") continue;
        if (w[k] === "-C") {
          const t = resolve4(d, w[k + 1] ?? "");
          dw = t === "-" ? whyof(d, dw, w[k + 1] ?? "") : "";
          d = t;
          [da, dw] = cdalts(da, w[k + 1] ?? "", d, dw);
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
    emit3(d + altTok(da) + (assign ? SEP + o + (d === "-" && dw !== "" ? SEP + dw : "") : ""), out2);
    if (!chained) {
      old = "-";
      owhy = "";
      oalts = [];
    }
    vend(ok);
  }
  function push() {
    ostack[sp + 1] = old;
    wstack[sp + 1] = cwhy;
    owstack[sp + 1] = owhy;
    astack[sp + 1] = alts;
    oastack[sp + 1] = oalts;
    stack[++sp] = cur;
  }
  function pop() {
    if (sp > 0) {
      old = ostack[sp];
      cwhy = wstack[sp];
      owhy = owstack[sp];
      alts = astack[sp];
      oalts = oastack[sp];
      cur = stack[sp--];
    }
  }
  for (i2 = 0; i2 < buf.length; i2++) {
    const c = buf[i2];
    const nx = buf[i2 + 1] ?? "";
    const prev = i2 > 0 ? buf[i2 - 1] : "";
    if (c === QO) {
      qsp++;
      q[qsp] = { stmt, cur, old, start: i2 + 1, sp, why: cwhy, owhy, alts, oalts };
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
      alts = f.alts;
      oalts = f.oalts;
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
  if (assign && (unbal || loops.length > 0)) emit3(UNBALANCED, "unbalanced");
  return records2.filter((r) => r.stmt !== "");
}

// src/hooks/cmd-analysis/git.ts
var MAX_DEPTH = 3;
var SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;
var ENCODED = /[\x01-\x06\x0e-\x11\x13\x15\x16]/g;
var HD_MARK2 = /<<[\x1a\x1e]/g;
function readWords(s) {
  return (s.split("\n")[0] ?? "").split(/[ \t]+/).filter((w) => w !== "");
}
function readStmt(stmt) {
  return stmt.replace(/^\t+|\t+$/g, "");
}
function inner(stmt) {
  const words2 = readWords(stmt);
  const argv0 = words2[0] ?? "";
  if (SHELL.test(argv0)) {
    for (let i2 = 1; i2 < words2.length; i2++) {
      const w = words2[i2];
      if (w === "-c" || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words2[i2 + 1] ?? "";
      if (!w.startsWith("-")) return "";
    }
    return "";
  }
  if (argv0 === "eval") return (stmt.startsWith("eval") ? stmt.slice(4) : stmt).replace(/^ /, "");
  return "";
}
function listing(parser2, cmd, base2, depth, home) {
  if (cmd.trim() === "") return [];
  const encoded = encode(parser2, cmd);
  if (!encoded.ok) return null;
  const out2 = [];
  for (const record of statementsEnc(encoded.text, base2, home, false)) {
    const stmt = readStmt(record.stmt);
    if (stmt === "") continue;
    const body2 = depth < MAX_DEPTH && !record.dir.startsWith("=") ? inner(stmt) : "";
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
  if (!isDir(cwd)) return "-";
  if (gitOk(cwd, ["rev-parse", "--git-dir"], env)) {
    const n3 = gitOut(cwd, ["worktree", "list", "--porcelain"], env).split("\n").filter((l) => l.startsWith("worktree ")).length;
    if (n3 > 1) return "?";
  }
  return cwd;
}
async function cmdStatements(command, cwd, env = process.env) {
  const parser2 = await bashParser();
  const listed2 = listing(parser2, command, "@", 0, env.HOME ?? "");
  if (listed2 === null) return { ok: false };
  let state;
  const statements2 = listed2.map(({ dir, stmt }) => {
    if (dir.startsWith("@/")) dir = isDir(cwd) ? `${cwd.replace(/\/$/, "")}${dir.slice(1)}` : "-";
    else if (dir === "@") dir = state ??= cwdState(cwd, env);
    return { dir, stmt: stmt.replace(HD_MARK2, "<<").replace(ENCODED, "_") };
  });
  return { ok: true, statements: statements2 };
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
  while (!isDir(dir)) {
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

// src/hooks/cmd-analysis/commit-message.ts
var MAX_DEPTH2 = 3;
var SHELL2 = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;
function readWords2(s) {
  return (s.split("\n")[0] ?? "").split(/[ \t]+/).filter((w) => w !== "");
}
function readStmt2(stmt) {
  return stmt.replace(/^\t+|\t+$/g, "");
}
function inner2(stmt) {
  const words2 = readWords2(stmt);
  const argv0 = words2[0] ?? "";
  if (SHELL2.test(argv0)) {
    for (let i2 = 1; i2 < words2.length; i2++) {
      const w = words2[i2];
      if (w === "-c" || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words2[i2 + 1] ?? "";
      if (!w.startsWith("-")) return "";
    }
    return "";
  }
  if (argv0 === "eval") return (stmt.startsWith("eval") ? stmt.slice(4) : stmt).replace(/^ /, "");
  return "";
}
function statements(parser2, cmd, base2, depth, home) {
  if (cmd.trim() === "") return [];
  const encoded = encode(parser2, cmd);
  if (!encoded.ok) return null;
  const out2 = [];
  for (const record of statementsEnc(encoded.text, base2, home, false)) {
    const stmt = readStmt2(record.stmt);
    if (stmt === "") continue;
    const body2 = depth < MAX_DEPTH2 && !record.dir.startsWith("=") ? inner2(stmt) : "";
    if (body2 === "") {
      out2.push(stmt);
      continue;
    }
    const nested = statements(parser2, decode(body2).replace(/\n+$/, ""), record.dir, depth + 1, home);
    if (nested === null) return null;
    out2.push(...nested);
  }
  return out2;
}
function messageArg(subcommand) {
  const words2 = readWords2(subcommand).slice(1);
  for (let i2 = 0; i2 < words2.length; i2++) {
    const w = words2[i2];
    if (w === "-m" || w === "--message") return words2[i2 + 1] ?? "";
    if (w.startsWith("--message=")) return w.slice("--message=".length);
    if (w.startsWith("-m")) return w.slice(2);
    if (/^-[a-zA-Z].*m$/s.test(w)) return words2[i2 + 1] ?? "";
  }
  return "";
}
async function gitCommitMessage(command, env = process.env) {
  const parser2 = await bashParser();
  const listed2 = statements(parser2, command, "-", 0, env.HOME ?? "");
  if (listed2 === null) return { ok: false };
  for (const stmt of listed2) {
    const subcommand = gitSubcommand(stmt);
    if (subcommand !== "commit" && !subcommand.startsWith("commit ")) continue;
    const message = decode(messageArg(subcommand)).replace(/\n+$/, "");
    const built = message.includes("$(") || message.includes("`");
    return { ok: true, subcommand, message: built ? "" : message };
  }
  return { ok: true, subcommand: "", message: "" };
}

// src/hooks/git-guards.ts
import { accessSync as accessSync7, constants as constants7, realpathSync as realpathSync4, statSync as statSync12 } from "node:fs";

// src/hooks/cmd-analysis/lister.ts
import { statSync as statSync11 } from "node:fs";

// src/hooks/lib/repo.ts
import { statSync as statSync9 } from "node:fs";
function isFile5(path) {
  if (path === "") return false;
  try {
    return statSync9(path).isFile();
  } catch {
    return false;
  }
}
function firstLine2(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}
function readable2(db, env) {
  return isFile5(db) && haveSqlite(env);
}
var CD_PREFIX = /^[ \t\v\f\r]*cd[ \t\v\f\r]+/;
var CD_TARGETS = [/^"([^"]+)"/, /^'([^']+)'/, /^([^ \t\v\f\r&;]+)/];
var GIT_C = /git -C ([^ \t\v\f\r]+)/;
function cdTarget(line) {
  const prefix = CD_PREFIX.exec(line);
  if (!prefix) return null;
  const rest = line.slice(prefix[0].length);
  let best = null;
  for (const re of CD_TARGETS) {
    const m = re.exec(rest);
    if (m && (best === null || m[0].length > best[0].length)) best = m;
  }
  return best === null ? null : best[1];
}
function cmdCwd(cmd, input, env = process.env) {
  const base2 = payloadCwd(input, env);
  const lines2 = cmd.split("\n");
  let cdPath = null;
  for (const line of lines2) {
    cdPath = cdTarget(line);
    if (cdPath !== null) break;
  }
  if (cdPath === null) {
    cdPath = "";
    for (const line of lines2) {
      const m = GIT_C.exec(line);
      if (m) {
        cdPath = m[1].replace(/['"]/g, "");
        break;
      }
    }
  }
  if (cdPath === "") return base2;
  if (cdPath.startsWith("/")) return cdPath;
  return `${base2.replace(/\/$/, "")}/${cdPath}`;
}
function forgeCommandDir(cmd, input, env = process.env) {
  const base2 = payloadCwd(input, env);
  const leading = cmd.split("\n").find((line) => line.trim() !== "");
  const cdPath = leading === void 0 ? null : cdTarget(leading);
  if (cdPath === null) return base2;
  return cdPath.startsWith("/") ? cdPath : `${base2.replace(/\/$/, "")}/${cdPath}`;
}
function forgeRepoDir(cmd, input, env = process.env) {
  let dir = forgeCommandDir(cmd, input, env);
  if (dir === "") return "";
  while (!isDir(dir) && dir !== "/" && dir !== ".") dir = posixDirname(dir);
  return gitOut(dir, ["rev-parse", "--show-toplevel"], env) || dir;
}
function repoDefaultBranch(root, env = process.env) {
  if (root === "") return "";
  const remote = gitOut(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], env).replace(/^origin\//gm, "");
  if (remote !== "") return remote;
  for (const cand of ["main", "master", "dev"]) {
    if (gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${cand}`], env)) return cand;
  }
  return gitOut(root, ["symbolic-ref", "--short", "HEAD"], env) || "main";
}
function repoGitRoot(target, env = process.env) {
  if (target === "") return "";
  while (!isDir(target) && target !== "/" && target !== ".") target = posixDirname(target);
  if (!isDir(target)) return "";
  const common = gitOut(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  if (common !== "") return cdPwd(posixDirname(common), shellPwd(env));
  return gitOut(target, ["rev-parse", "--show-toplevel"], env);
}
function repoNameForRoot(db, root, env = process.env) {
  if (!readable2(db, env) || root === "") return "";
  const name3 = firstLine2(sqliteRo(db, `SELECT name FROM repos WHERE path = '${sqlQuote(root)}' LIMIT 1;`, env));
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
  return firstLine2(
    sqliteRo(
      db,
      `SELECT COALESCE(target_branch,''), COALESCE(branching_model,''), COALESCE(protected_branches,'') FROM repos WHERE name = '${sqlQuote(name3)}' LIMIT 1;`,
      env
    )
  );
}
function repoIsRegistered(db, root, env = process.env) {
  return readable2(db, env) && root !== "" && repoNameForRoot(db, root, env) !== "";
}
function repoSinglePath(db, env = process.env) {
  if (!readable2(db, env)) return "";
  if (sqliteRo(db, "SELECT COUNT(*) FROM repos;", env) !== "1") return "";
  return firstLine2(sqliteRo(db, "SELECT path FROM repos LIMIT 1;", env));
}
function repoPathByName(db, name3, env = process.env) {
  if (!readable2(db, env) || name3 === "") return "";
  return firstLine2(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name3)}' LIMIT 1;`, env));
}
function repoResolvePath(db, name3, env = process.env) {
  return (name3 === "" ? "" : repoPathByName(db, name3, env)) || repoSinglePath(db, env);
}
var REMOTES_SQL = "COALESCE((SELECT json_group_array(json_object('name', rr.name, 'provider', rr.provider, 'url', rr.url)) FROM (SELECT name, provider, url FROM repo_remotes WHERE repo = r.name ORDER BY is_primary DESC, rowid) rr), '[]')";
function repoRemotes(db, gitRoot, env = process.env) {
  if (!readable2(db, env)) return "";
  const name3 = gitRoot === "" ? "" : repoNameForRoot(db, gitRoot, env);
  let out2 = "";
  if (name3 !== "") {
    out2 = firstLine2(sqliteRo(db, `SELECT ${REMOTES_SQL} FROM repos r WHERE r.name = '${sqlQuote(name3)}' LIMIT 1;`, env));
  }
  if (out2 === "" && sqliteRo(db, "SELECT COUNT(*) FROM repos;", env) === "1") {
    out2 = firstLine2(sqliteRo(db, `SELECT ${REMOTES_SQL} FROM repos r LIMIT 1;`, env));
  }
  return out2;
}

// src/hooks/lib/target-task.ts
import { createHash } from "node:crypto";

// src/hooks/lib/agent-context.ts
import { existsSync as existsSync7, lstatSync as lstatSync3, readlinkSync as readlinkSync3, statSync as statSync10 } from "node:fs";
var MAX_LINK_HOPS = 40;
function isFile6(path) {
  try {
    return statSync10(path).isFile();
  } catch {
    return false;
  }
}
function isSymlink(path) {
  try {
    return lstatSync3(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function agentTranscript(input = "") {
  const own = jqAlternatives(input, [["agent_transcript_path"]]);
  if (own !== "" && isFile6(own)) return own;
  const main = jqAlternatives(input, [["transcript_path"]]);
  const id = jqAlternatives(input, [["agent_id"]]);
  if (main === "" || id === "" || !/^[A-Za-z0-9_-]+$/.test(id)) return "";
  const t = `${main.endsWith(".jsonl") ? main.slice(0, -".jsonl".length) : main}/subagents/agent-${id}.jsonl`;
  return isFile6(t) ? t : "";
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
  const fields = `COALESCE(t.branch_id, '') || '|' || COALESCE(t.repo, '') || '|'
           || COALESCE(r.name, '') || '|' || COALESCE(r.path, '')`;
  const from = `
      FROM tasks t
      LEFT JOIN repos r ON r.name = CASE
          WHEN COALESCE(t.repo, '') <> '' THEN t.repo
          WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT name FROM repos)
        END
     WHERE t.id = ${task} LIMIT 1;`;
  let recordedHex = "";
  let row = gateRead(db, `SELECT hex(COALESCE(t.worktree_path, '')) || '|' || ${fields}${from}`, env);
  if (row === GATE_READ_ERROR) {
    row = gateRead(db, `SELECT ${fields}${from}`, env);
  } else if (row !== "") {
    const bar = row.indexOf("|");
    recordedHex = row.slice(0, bar);
    row = row.slice(bar + 1);
  }
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
  const recorded = Buffer.from(recordedHex, "hex").toString("utf8");
  return {
    code: 0,
    repo: name3,
    repoRoot,
    worktree: recorded !== "" ? recorded : `${repoRoot}/.claude/worktrees/${branchSlug(branch)}`,
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
    const run5 = callerRun(input, resolved, env);
    if (run5 === GATE_READ_ERROR) return { code: 2, role, ...blank2, missing: "the trajectory DB read failed (agent_runs)" };
    const bar = run5.indexOf("|");
    task = sqlInt(bar < 0 ? run5 : run5.slice(0, bar));
  }
  if (task === "") {
    const missing = transcript !== "" ? `no task_id: the spawn transcript ${transcript} carries no task_id=<N>` : "no task_id: the payload names no spawn transcript (agent_transcript_path, or transcript_path plus agent_id) and no agent_runs row is bound to this agent_id";
    return { code: 1, role, ...blank2, missing };
  }
  return { role, taskId: task, ...taskLocation(resolved, task, env) };
}
function pathCanonical2(path = "") {
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
      const link = readlinkSync3(here).replace(/\n+$/, "");
      if (link.startsWith("/")) cur = "";
      rest = `${link}/${rest}`;
      continue;
    }
    if (existsSync7(here)) cur = here;
    else tail = `/${part}`;
  }
  if (cur + tail === "") cur = "/";
  return `${cur}${tail}`;
}
function ctxInWorktree(path, worktree) {
  if (worktree === "" || path === "") return false;
  const c = pathCanonical2(path);
  const w = pathCanonical2(worktree);
  if (c === w) return true;
  return c.startsWith(`${w.endsWith("/") ? w.slice(0, -1) : w}/`);
}

// src/hooks/lib/target-task.ts
var WORKTREE_MARK = "/.claude/worktrees/";
var WORKTREE_ROOT = /^(.*\/.claude\/worktrees\/[^/]+).*$/;
function worktreeRootForTarget(target) {
  if (!target.includes(WORKTREE_MARK)) return "";
  return stripTrailingNewlines(
    target.split("\n").map((line) => line.replace(WORKTREE_ROOT, "$1")).join("\n")
  );
}
function resolveTaskIdForTarget(target, input, db = "", env = process.env) {
  const resolved = db !== "" ? db : dbPath(env) ?? "";
  const wt = worktreeRootForTarget(target);
  let task = "";
  if (resolved !== "" && haveSqlite(env) && wt !== "") {
    const branch = gitOut(wt, ["rev-parse", "--abbrev-ref", "HEAD"], env);
    if (branch !== "" && branch !== "HEAD") {
      task = sqlInt(
        sqliteRo(
          resolved,
          `
        SELECT id FROM tasks
         WHERE branch_id = '${sqlQuote(branch)}'
         ORDER BY id DESC
         LIMIT 1;
      `,
          env
        )
      );
    }
    if (task === "") {
      const slug = stripTrailingNewlines(posixBasename(wt));
      task = sqlInt(taskBySlug(resolved, slug, "id", "", env, (line) => process.stderr.write(`${line}
`)));
    }
  }
  if (task === "" && input !== "") {
    task = taskIdFromTranscript(stripTrailingNewlines(jqAlternatives(input, [["agent_transcript_path"]])));
  }
  return task;
}
function pathDigest(path) {
  return createHash("sha256").update(stripTrailingNewlines(pathCanonical2(path)), "utf8").digest("hex");
}

// src/hooks/cmd-analysis/surface.ts
var WRITE_SHAPES = [
  ">",
  ">>",
  ">|",
  "&>",
  "exec N>",
  "heredoc into a redirect",
  "tee",
  "tee -a",
  "sed -i",
  "perl -i",
  "dd of=",
  "truncate",
  "cp",
  "mv",
  "install",
  "rsync",
  "git mv",
  "ln",
  "mkdir",
  "rm",
  "touch",
  "tar -C / make -C / env -C / npm --prefix",
  "git commit / reset / checkout / stash / clean / bisect / submodule update / \u2026 in its -C dir or own dir",
  "git init <dir> / format-patch -o / archive -o / checkout-index --prefix",
  "python -c / node -e / perl -e / ruby -e with a write mode",
  "a program fed to python / node / perl / ruby / sh through a heredoc",
  "find -exec / -execdir / -ok / -delete / -fprint",
  "fd -x / -X",
  "xargs fed by find or fd"
];
var PROMPT_FILES = /* @__PURE__ */ new Set(["CLAUDE.md", "CODEX.md", "CURSOR.md", "GEMINI.md"]);
function writeShapes() {
  return WRITE_SHAPES.join(", ");
}
function surfaceRoot(abs, env = process.env) {
  if (abs.includes("/.claude/worktrees/")) return worktreeRootForTarget(abs);
  const parent = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  let dir = parent(abs);
  while (dir !== "" && !isDir(dir)) dir = parent(dir);
  if (dir === "") dir = "/";
  return stripTrailingNewlines(repoGitRoot(dir, env));
}
function isPromptSurfacePath(p, root = "", env = process.env) {
  if (PROMPT_FILES.has(p.slice(p.lastIndexOf("/") + 1))) return true;
  let rel = "";
  if (p.startsWith("/")) {
    const abs = stripTrailingNewlines(pathCanonical(p));
    let r = root === "" ? surfaceRoot(abs, env) : root;
    if (r !== "") {
      r = stripTrailingNewlines(pathCanonical(r));
      const prefix = `${r.endsWith("/") ? r.slice(0, -1) : r}/`;
      if (abs.startsWith(prefix)) rel = abs.slice(prefix.length);
    }
  } else rel = p.startsWith("./") ? p.slice(2) : p;
  if (rel === "") {
    if (!p.endsWith(".md")) return false;
    return /\/(agents|skills|commands|templates|rules)\//.test(`/${p.startsWith("/") ? p.slice(1) : p}`);
  }
  return /^(agents|skills|commands|templates|rules)\/[^]*\.md$/.test(rel) || /^\.claude\/(agents|skills|commands|rules)\/[^]*\.md$/.test(rel);
}

// src/hooks/cmd-analysis/lister.ts
var NAME2 = /^[A-Za-z_][A-Za-z0-9_]*$/;
var SURFACES = ["agents", "skills", "commands", "templates", "rules", ".claude/agents", "CLAUDE.md"];
var PROMPT_FILES2 = ["CLAUDE.md", "CODEX.md", "CURSOR.md", "GEMINI.md"];
var EXEC_REDIRECT = /^(>|>>|>\||<|<<<|&>|&>>|[0-9]>|[0-9]>>|[0-9]<)$/;
var EXEC_REDIRECT_WORD = /^(>|<|&>|[0-9]>|[0-9]<)/;
var RG_VALUE = /^(-t|--type|-T|--type-not|--type-add|-j|--threads|-d|--max-depth|--max-filesize|--ignore-file|--sort|--sortr|-E|--encoding)$/;
var FD_VALUE = /^(-e|--extension|-t|--type|-d|--max-depth|--min-depth|--exact-depth|-S|--size|--changed-within|--changed-before|-o|--owner|-j|--threads|--max-results|-c|--color|--ignore-file|--and)$/;
var PLACEHOLDER = /\{\}|\{\/\}|\{\/\/\}|\{\.\}|\{\/\.\}/;
var basename2 = (w) => w.replace(/.*\//, "");
var trimSlash = (s) => s.replace(/\/$/, "");
var isDir2 = (p) => statSync11(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
var isFile7 = (p) => statSync11(p, { throwIfNoEntry: false })?.isFile() ?? false;
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
function findModel(mode, args2, raw, acts, m) {
  const n3 = args2.length;
  let k = 0;
  let bad = false;
  let ok = false;
  const prune2 = [];
  while (k < n3) {
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
  while (k < n3 && !/^(-.*|\(|!|,)$/s.test(args2[k])) m.paths.push(args2[k++]);
  while (k < n3) {
    const w = args2[k++];
    switch (w) {
      case "-exec":
      case "-execdir":
      case "-ok":
      case "-okdir": {
        if (mode !== "exec") return false;
        const run5 = [];
        let prev = "";
        while (k < n3) {
          const x = raw[k++];
          if (x === "" || x === "+" && prev === "{}") break;
          run5.push(x);
          prev = x;
        }
        if (run5.length > 0) acts.push("x" + run5.join(" "));
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
        if (args2[k + 1] === "-prune") prune2.push("R:" + (args2[k] ?? ""));
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
  m.excl.push(...prune2);
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
  const n3 = args2.length;
  let k = 0;
  let gdir = dir;
  while (k < n3) {
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
  const n3 = args2.length;
  let k = 0;
  let ok = false;
  let nocase = false;
  while (k < n3) {
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
  const n3 = args2.length;
  let k = 0;
  let ok = false;
  let bad = false;
  while (k < n3) {
    const w = args2[k++];
    if (w === "-x" || w === "--exec" || w === "-X" || w === "--exec-batch") {
      if (mode !== "exec") return false;
      const run5 = [];
      let hit = false;
      while (k < n3) {
        const x = raw[k++];
        if (x === "") break;
        if (PLACEHOLDER.test(x)) hit = true;
        run5.push(x);
      }
      if (!hit) run5.push("{}");
      acts.push("x" + run5.join(" "));
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
function listerBind(host, name3, dirtok, mode, words2, acts) {
  if (mode === "loop" && (host.root === "" || !NAME2.test(name3))) return null;
  const dec2 = mode === "loop" ? words2 : words2.map(decode);
  let dir = "";
  if (dirtok.startsWith("/")) dir = dirtok;
  else if (dirtok === "@") dir = host.cwd;
  else if (dirtok.startsWith("@/") && host.cwd !== "") dir = `${trimSlash(host.cwd)}/${dirtok.slice(2)}`;
  if (dir === "" && mode !== "exec") return null;
  const args2 = [];
  const raw = [];
  let skip2 = false;
  for (let k = 1; k < words2.length; k++) {
    const w = dec2[k] ?? "";
    if (mode === "exec") {
      if (skip2) {
        skip2 = false;
        continue;
      }
      if (EXEC_REDIRECT.test(words2[k])) {
        skip2 = true;
        continue;
      }
      if (EXEC_REDIRECT_WORD.test(words2[k])) continue;
      raw.push(words2[k]);
    } else {
      if (w === "2>/dev/null") continue;
      if (w === "2>") {
        if (words2[k + 1] !== "/dev/null") return null;
        k++;
        continue;
      }
      if (/[<>`]/.test(w)) return null;
    }
    args2.push(w);
  }
  const cmd = basename2(words2[0] ?? "");
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
  if (!NAME2.test(name3)) return null;
  const rootc = host.rootc();
  const rootTrim = trimSlash(rootc);
  let bound = rootc;
  const git2 = cmd === "git";
  if (git2) {
    bound = pathCanonical(m.gdir);
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
      w = pathCanonical(w);
      if (!(w + "/").startsWith(trimSlash(bound) + "/")) return null;
      if (w.startsWith(rootTrim)) w = w.slice(rootTrim.length);
      const at2 = git2 ? trimSlash(p) : trimSlash(v);
      if (isPromptSurfacePath(`${rootTrim}${trimSlash(w)}/x.md`, rootc)) vals.push(`${at2}/*.md`);
      else if (cmd !== "ls") {
        const rel = w.replace(/^\//, "");
        for (const d of SURFACES) {
          const sub = rel !== "" && d.startsWith(rel + "/") ? d.slice(rel.length + 1) : d;
          if (d === "CLAUDE.md") {
            if (rel !== "" || !isFile7(`${rootTrim}/${d}`)) continue;
          } else if (!isDir2(`${rootTrim}/${d}`) || rel !== "" && sub === d) continue;
          if (m.excl.some((e) => exclCovers(e, d, sub, v, host.root, rootc))) continue;
          if (m.pats.length > 0) {
            const names = d === "CLAUDE.md" ? ["CLAUDE.md"] : ["x.md", "SKILL.md", "CLAUDE.md"];
            if (!m.pats.some((pat) => names.some((v2) => patMatches(pat, v2)))) continue;
          }
          vals.push(`${at2}/${d === "CLAUDE.md" ? d : `${sub}/*.md`}`);
        }
      }
      if (git2) continue;
      vals.push(v, `${trimSlash(v)}/*`);
      for (const pat of m.pats) {
        const body2 = pat.slice(2);
        if (body2 === "" || body2.includes("/") || body2.startsWith("!")) continue;
        if (PROMPT_FILES2.some((f) => patMatches(pat, f))) vals.push(`${trimSlash(v)}/${body2}`);
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
function substr(s, m, n3) {
  const start2 = Math.max(m, 1);
  const end = n3 === void 0 ? s.length + 1 : Math.min(m + n3, s.length + 1);
  return end <= start2 ? "" : s.slice(start2 - 1, end - 1);
}
function index3(s, t) {
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
  at(k, n3 = 1) {
    return substr(this.s, k, n3);
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
    this.bt(v, this.lang === "perl" ? o !== Q1 && /[$@]/.test(v) : index3(v, "#{") > 0);
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
    const at2 = rest.search(PY_IMPORT_ANY);
    if (at2 < 0) return [0, -1];
    let len = -1;
    for (const re of PY_IMPORT) {
      re.lastIndex = at2;
      const m = re.exec(rest);
      if (m && m[0].length > len) len = m[0].length;
    }
    return [at2 + 1, len];
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
    const at2 = nm.search(/(\.|::)[^.:]*$/);
    if (at2 >= 0) {
      this.snPre = nm.slice(0, at2);
      this.snLast = nm.slice(at2 + (nm[at2] === ":" ? 2 : 1));
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
    const at2 = nm.search(/(\.|::)[^.:]*$/);
    if (at2 >= 0) last = nm.slice(at2 + (nm[at2] === ":" ? 2 : 1));
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
    const n3 = s.length;
    let tq = false;
    let closed = false;
    let v = "";
    let j;
    const q3 = qc + qc + qc;
    if (this.py && this.at(this.ip, 3) === q3) {
      tq = true;
      j = this.ip + 3;
    } else j = this.ip + 1;
    while (j <= n3) {
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
      this.ip = n3 + 1;
      return;
    }
    let interp = false;
    if (this.py && /[fF]/.test(pfx) && index3(v, "{")) interp = true;
    if (this.lang === "perl" && (qc === '"' || qc === "`") && /[$@]/.test(v)) interp = true;
    if (this.lang === "ruby" && (qc === '"' || qc === "`") && index3(v, "#{")) interp = true;
    if (this.lang === "node" && qc === "`" && index3(v, "${")) interp = true;
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
    const n3 = s.length;
    let j = this.ip + 1;
    const st = this.ip;
    while (j <= n3) {
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
    if (lang === "perl" && nm === "qx" && ch !== "" && index3(`()[]{}<>/|!~^%+@:-"${Q1}`, ch)) {
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
    const n3 = s.length;
    this.prescan();
    while (this.ip <= n3 && !this.anom) {
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
        const j = index3(substr(s, ip), "\n");
        if (!j) break;
        this.ip += j - 1;
        continue;
      }
      if (lang === "node" && this.at(ip, 2) === "/*") {
        const j = index3(substr(s, ip + 2), "*/");
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
        while (this.ip <= n3 && /[0-9A-Za-z_.]/.test(this.at(this.ip))) this.ip++;
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
  while ((i2 = index3(v, "\\")) > 0) {
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
  while ((i2 = index3(v, "\\")) > 0) {
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
  const at2 = name3.lastIndexOf(".");
  return wkind(name3.slice(at2 + 1), at2 < 0 ? "" : name3.slice(0, at2)) !== "" || new Scanner(lang).isproc(name3);
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
  let at2 = node;
  while (at2.type === type) {
    const prop = field(at2, property);
    const obj = field(at2, object);
    if (!prop || !obj) break;
    parts2.unshift(prop.text);
    at2 = obj;
  }
  return { root: at2, parts: parts2 };
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
        const base2 = mod.text.replace(/\s+/g, "");
        for (const name3 of node.childrenForFieldName("name")) {
          if (!name3) continue;
          const dotted = name3.type === "aliased_import" ? field(name3, "name") : name3;
          const alias = name3.type === "aliased_import" ? field(name3, "alias") : name3;
          if (dotted && alias) this.binds.add(alias.text, { kind: "import", q: `${base2}.${dotted.text.replace(/\s+/g, "")}` });
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
    const at2 = q.lastIndexOf(".");
    const last = q.slice(at2 + 1);
    return at2 > 0 && last !== "replace" && PY_METHODS.has(last) && this.safeValue(q.slice(0, at2)) && q.slice(0, at2).includes(".");
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
        const base2 = field(node, "value");
        if (base2?.type !== "identifier" || this.binds.resolve(base2.text)?.kind !== "local") return this.fail();
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
    const at2 = q.lastIndexOf(".");
    return at2 > 0 && JS_METHODS.has(q.slice(at2 + 1)) && JS_SAFE_VALUE.test(q.slice(0, at2));
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
    const at2 = callee === "JSON.parse" || callee === "JSON.stringify" || method === "replace" || method === "replaceAll" ? 1 : JS_CALLBACK_METHODS.has(method) ? 0 : -1;
    if (at2 >= 0 && list.some((a) => a.type === "spread_element")) this.fail();
    list.forEach((a, i2) => {
      if (i2 === at2 && !this.callback(a) && !(method.startsWith("replace") && a.type !== "arrow_function" && a.type !== "identifier" && a.type !== "member_expression" && a.type !== "function_expression" && a.type !== "call_expression" && a.type !== "subscript_expression")) this.fail();
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
  const close2 = CLOSER[open] ?? open;
  let depth = 1;
  for (let k = i2; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === close2 && --depth === 0) return k;
    else if (c === open && close2 !== open) depth++;
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
  const fail2 = { ok: false, judged: false };
  const toks = lexScript(perl, src);
  if (!toks) return fail2;
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
      if (tk.text === "&" && !(!perl && next?.t === "sym")) return fail2;
      if (tk.text === ".(" || tk.text === "&." || tk.text === "->" && (!perl || next?.text === "(" || next?.t === "v")) return fail2;
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
        if (toks[j]?.text === "=" || toks[j]?.t === "p" && /^[.+\-*/x|&^]$/.test(toks[j].text) && toks[j + 1]?.text === "=") return fail2;
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
      if (toks[j + 1]?.text === "=") return fail2;
    }
    if (SCRIPT_WORDS.has(name3)) continue;
    const sleep4 = perl ? perlSleepSelect(toks, k) : 0;
    if (sleep4) {
      k += sleep4 - 1;
      continue;
    }
    let dotted = name3;
    for (let j = k; !perl && member(toks[j - 1]) && toks[j - 2]?.t === "w"; j -= 2) dotted = `${toks[j - 2].text}.${dotted}`;
    if (!judgedCall(lang, dotted.replace(/::/g, "."))) return fail2;
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
  const n3 = s[i2 + 1] ?? "";
  if (c === "`") {
    const e = s.indexOf("`", i2 + 1);
    return e < 0 ? -1 : e + 1;
  }
  if (c === "\x07") return closeAt(s, i2 + 1, quotes, "\x07", "\b");
  if (c !== "$") return -1;
  if (n3 === "(") return closeAt(s, i2 + 2, quotes, "(", ")");
  if (n3 === "{") return closeAt(s, i2 + 2, quotes, "{", "}");
  if (/[A-Za-z_]/.test(n3)) return i2 + 1 + /^[A-Za-z0-9_]*/.exec(s.slice(i2 + 1))[0].length;
  return /[0-9@*#?$!-]/.test(n3) ? i2 + 2 : -1;
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
        const n3 = src[j] === "\\" ? 2 : 1;
        body2 += src.slice(j, j + n3);
        j += n3;
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
  const scan3 = chomp(scanned.join("\n"));
  const has = (line) => `
${scan3}
`.includes(`
${line}
`);
  const cd = has("C");
  const run5 = has("R");
  const names = scan3.split("\n").flatMap((line) => line.startsWith("F	") ? [line.slice(2)] : []);
  const lexed = names.length > 0 && (lang === "py" || lang === "node") && !has("A") && !run5 ? lex(lang === "py", program) : void 0;
  const held = new Map(names.map((name3) => [name3, lexed && heldLiterals(lexed, name3)]));
  const unread = has("A") || has("F") || [...held.values()].includes(void 0);
  let fail2 = unread || held.size > 0;
  if (!has("W")) {
    if (!program.split("\n").some((line) => SHAPE.test(line))) return { lines: [], computed: false };
    fail2 = true;
  }
  let out2 = "";
  let src = "";
  for (const line of scan3.split("\n")) {
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
  if (fail2) {
    const writes = grepO(program, WRITES).map((m) => /^[^'"]*['"][^'"]+['"]/.exec(m)?.[0]).filter((m) => m !== void 0).map((m) => /['"][^'"]+['"]$/.exec(m)?.[0]).filter((m) => m !== void 0);
    const reads = grepO(grepO(program, READS).join("\n"), QUOTED);
    out2 += progLiterals(src, reads, writes, raw).join("\n");
    if (run5) out2 += "\n$(proc)";
    for (const lits of held.values()) for (const lit of lits ?? []) out2 += `
${lit}`;
  }
  let lines2 = out2.split("\n");
  if (cd) lines2 = lines2.filter((l) => !blank(l)).map((l) => (/^[/~$]/.test(l) ? "" : "$(proc)/") + l);
  const seen = /* @__PURE__ */ new Set();
  lines2 = lines2.filter((l) => !blank(l) && !seen.has(l) && seen.add(l) !== void 0);
  if (lines2.length > 0) return { lines: lines2, computed: unread };
  return { lines: operands ? ["-"] : [], computed: fail2 };
}
var PROGRAM_FLAG = {
  py: /^-[bBdEhiIOPqRsSuvx]*c(.*)$/s,
  node: /^(?:-e|-p|-pe|--eval|--print)(?:=(.*))?$/s,
  perl: /^-[nlpaswWtTUcX]*[eE](.*)$/s,
  ruby: /^-[nlpaswWdv]*e(.*)$/s
};
function interpWrites(words2, procWrites, held = () => false) {
  const argv0 = basename3(words2[0] ?? "");
  let lang;
  let pyopt = false;
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) {
    lang = "py";
    pyopt = true;
  } else if (argv0 === "node" || argv0 === "nodejs") lang = "node";
  else if (argv0 === "perl") lang = "perl";
  else if (argv0 === "ruby") lang = "ruby";
  else return [];
  const n3 = words2.length;
  let k = 1;
  let optarg = false;
  const encoded = [];
  const carriers = [];
  const take = (flagWord, attached, next) => {
    encoded.push(attached ? attached : next ?? "");
    carriers.push(attached ? flagWord : next ?? "");
  };
  while (k < n3) {
    const w = words2[k++];
    if (pyopt) {
      const m2 = /^-[bBdEhiIOPqRsSuvx]*m(.*)$/s.exec(w);
      if (m2) {
        pyopt = false;
        if (PY_RUNNERS.test(chomp(decode(m2[1] || (words2[k] ?? ""))))) return ["$(proc)"];
      } else if (optarg) optarg = false;
      else if (w === "-W" || w === "-X") optarg = true;
      else if (!w.startsWith("-")) pyopt = false;
    }
    const m = PROGRAM_FLAG[lang].exec(w);
    if (m) {
      take(w, m[1], m[1] ? void 0 : words2[k++]);
      break;
    }
  }
  if (lang === "perl" || lang === "ruby") {
    for (let j = k; j < n3; j++) {
      const m = PROGRAM_FLAG[lang].exec(words2[j]);
      if (m) take(words2[j], m[1], m[1] ? void 0 : words2[++j]);
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
  for (; k < n3; k++) if (!words2[k].startsWith("-")) out2.push(...decode(words2[k]).split("\n"));
  if (found.computed) out2.push(COMPUTED + argv0);
  return [...out2, ...unproven];
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
    const at2 = (j) => j < nw ? w[j] : void 0;
    if (at2(k) === "mv") {
      for (let j = k + 1; j < nw; j++) if (!w[j].startsWith("-")) nonopt.push(w[j]);
      if (nonopt.length >= 2) put(nonopt[nonopt.length - 1]);
    } else if (at2(k) === "worktree" && at2(k + 1) === "add") {
      for (let j = k + 2; j < nw; j++) {
        if (/^(-b|-B|--reason)$/.test(w[j])) {
          j++;
          continue;
        }
        if (w[j].startsWith("-")) continue;
        put(w[j]);
        break;
      }
    } else if (at2(k) === "worktree" && (at2(k + 1) === "remove" || at2(k + 1) === "move")) {
      for (let j = k + 2; j < nw; j++) {
        if (w[j] === "--reason") {
          j++;
          continue;
        }
        if (!w[j].startsWith("-")) put(w[j]);
      }
    } else if (at2(k) === "clone") {
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
  const n3 = line.length;
  let i2 = 0;
  while (i2 < n3) {
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
        while (i2 < n3 && /[0-9-]/.test(line[i2])) i2++;
        continue;
      }
      want = 1;
      continue;
    }
    let word = "";
    while (i2 < n3) {
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
  let skip2 = false;
  let ops = [];
  for (const w of args2) {
    if (skip2) {
      skip2 = false;
      continue;
    }
    if (w === "--") continue;
    if (tool === "sed") {
      if (w.startsWith("--in-place") || w.startsWith("-i") || /^-[a-zA-Z].*i$/s.test(w)) inplace = true;
      else if (/^(-e|-f|--expression|--file|-l)$/.test(w)) {
        hasprog = true;
        skip2 = true;
      } else if (w.startsWith("--expression=") || w.startsWith("--file=")) hasprog = true;
      else if (/^-[a-zA-Z].*[ef]$/s.test(w)) {
        hasprog = true;
        skip2 = true;
      } else if (!w.startsWith("-")) ops.push(w);
    } else {
      if (w.startsWith("--")) continue;
      if (/^-.*[eE]$/s.test(w)) {
        if (w.includes("i")) inplace = true;
        hasprog = true;
        skip2 = true;
      } else if (/^-.*i/s.test(w)) inplace = true;
      else if (!w.startsWith("-")) ops.push(w);
    }
  }
  if (!inplace || ops.length === 0) return [];
  if (!hasprog) ops = ops.slice(1);
  return ops;
}
function gitTree(chain2, words2) {
  const n3 = words2.length;
  let cdir = "";
  let tree = "";
  let k = 1;
  let usetree = true;
  let dir = "";
  let outs = [];
  const at2 = (j) => words2[j] ?? "";
  while (k < n3) {
    const w = words2[k];
    if (w === "-C") {
      cdir = under(cdir, at2(k + 1));
      k += 2;
    } else if (w === "--work-tree") {
      tree = at2(k + 1);
      k += 2;
    } else if (w.startsWith("--work-tree=")) {
      tree = w.slice("--work-tree=".length);
      k++;
    } else if (/^(-c|--git-dir|--namespace|--config-env)$/.test(w)) k += 2;
    else if (w.startsWith("-")) k++;
    else break;
  }
  const sub = at2(k);
  const next = at2(k + 1);
  if (/^(add|am|checkout|cherry-pick|clean|commit|merge|mergetool|pull|rebase|reset|restore|revert|rm|switch)$/.test(sub)) {
  } else if (sub === "stash") {
    if (next === "list" || next === "show") return [];
  } else if (sub === "apply") {
    const all = ` ${words2.slice(k).join(" ")} `;
    if (!all.includes(" --apply ") && /( --check | --stat | --numstat | --summary )/.test(all)) return [];
  } else if (sub === "bisect") {
    if (/^(|log|view|visualize|terms|help)$/.test(next)) return [];
  } else if (sub === "sparse-checkout") {
    if (/^(|list|check-rules)$/.test(next)) return [];
  } else if (sub === "submodule") {
    let j = k + 1;
    while (j < n3 && words2[j].startsWith("-")) j++;
    if (!/^(update|add|deinit|absorbgitdirs)$/.test(at2(j))) return [];
  } else if (sub === "read-tree") {
    let j = k + 1;
    for (; j < n3; j++) {
      const w = words2[j];
      if (w === "--") break;
      if (w.startsWith("--")) continue;
      if (/^-.*u/s.test(w)) break;
    }
    if (!(j < n3 && words2[j] !== "--")) return [];
  } else if (sub === "checkout-index") {
    for (let j = k + 1; j < n3; j++) {
      if (/^--prefix=./s.test(words2[j])) {
        outs.push(words2[j].slice("--prefix=".length));
        usetree = false;
      }
    }
  } else if (sub === "init") {
    usetree = false;
    for (let j = k + 1; j < n3; j++) {
      const w = words2[j];
      if (w === "--separate-git-dir") {
        outs.push(at2(j + 1));
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
    for (let j = k + 1; j < n3; j++) {
      const w = words2[j];
      if (fp && w === "--stdout") return [];
      if (w === "-o" || w === "--output" || fp && w === "--output-directory") {
        outs.push(at2(j + 1));
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
function extraWrites(chain2, words2, interp) {
  const out2 = [];
  let ops = [];
  const tool = basename4(words2[0]);
  if (tool === "sed" || tool === "perl") out2.push(...inplaceFiles(tool, words2.slice(1)));
  else if (tool === "mv") ops = words2.slice(1);
  else if (tool === "git") {
    let k = 1;
    while (k < words2.length) {
      if (words2[k] === "-C" || words2[k] === "-c") k += 2;
      else if (words2[k].startsWith("-")) k++;
      else break;
    }
    if (words2[k] === "mv") ops = words2.slice(k + 1);
    out2.push(...gitTree(chain2, words2));
  }
  const srcs = ops.filter((w) => !w.startsWith("-"));
  if (srcs.length >= 2) out2.push(...srcs.slice(0, -1));
  out2.push(...interp(words2));
  return out2;
}
function stmtWritePaths(stmt, chain2, interp) {
  const paths = writeTargets(stmt);
  const { pre, words: words2 } = unwrapStatement(stmt);
  if (words2.length <= 1) return { paths, words: words2 };
  if (pre === "") paths.push(...extraWrites(chain2, words2, interp));
  else for (const p of extraWrites(true, words2, interp)) if (p !== "") paths.push(under(pre, p));
  return { paths, words: words2 };
}

// src/hooks/cmd-analysis/write-paths.ts
var BAD2 = "";
var MAX_DEPTH3 = 3;
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
function inner3(stmt) {
  const words2 = shellWords(stmt);
  const argv0 = words2[0] ?? "";
  if (basename5(argv0) === "watch") {
    let i2 = 1;
    while (i2 < words2.length && words2[i2].startsWith("-")) {
      const w = words2[i2++];
      if (w === "--") break;
      if (WATCH_VALUE.test(w)) i2++;
    }
    return words2.slice(i2).join(" ");
  }
  if (/^(.*\/)?(bash|sh|zsh|dash|ksh)$/.test(argv0)) {
    for (let i2 = 1; i2 < words2.length; i2++) {
      const w = words2[i2];
      if (w === "-c" || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words2[i2 + 1] ?? "";
      if (!w.startsWith("-")) return "";
    }
    return "";
  }
  if (argv0 === "eval") return stmt.slice(4).replace(/^ /, "");
  const builtin = /^(builtin|command)[ \t]+eval(?:[ \t]+|$)/.exec(stmt);
  return builtin ? stmt.slice(builtin[0].length) : "";
}
function evalArgs(words2) {
  if (words2[0] === "eval") return words2.slice(1);
  if ((words2[0] === "builtin" || words2[0] === "command") && words2[1] === "eval") return words2.slice(2);
  return void 0;
}
var SET_IN_TEXT = /(?<![A-Za-z0-9_$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?[ \t]*(?:[-+*/%&^|]|<<|>>)?=(?!=)/g;
var STEPPED = /(?:\+\+|--)[ \t]*([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:\+\+|--)/g;
function setInText(text) {
  const names = [...text.matchAll(SET_IN_TEXT)].map((m) => m[1]);
  if (/\(\(|\$\[|\[|^let\b/.test(text)) for (const m of text.matchAll(STEPPED)) names.push(m[1] ?? m[2]);
  return names;
}
function stdinProgram(words2) {
  const argv0 = basename5(words2[0]);
  let kind;
  if (/^(python|python3|python[23]\..*)$/s.test(argv0)) kind = "py";
  else if (argv0 === "node" || argv0 === "nodejs") kind = "node";
  else if (argv0 === "perl") kind = "perl";
  else if (argv0 === "ruby") kind = "ruby";
  else if (/^(sh|bash|zsh|dash|ksh)$/.test(argv0)) kind = "sh";
  else return { kind: "", info: false };
  const none = { kind: "", info: false };
  let info2 = false;
  let skip2 = false;
  for (let k = 1; k < words2.length; k++) {
    const w = words2[k];
    if (skip2) {
      skip2 = false;
      continue;
    }
    if (w === "<<<") {
      skip2 = true;
      continue;
    }
    if (w.startsWith("<<")) continue;
    if (/^(<|>|>>|>\||&>|&>>|[0-9]<|[0-9]>|[0-9]>>)$/.test(w)) {
      skip2 = true;
      continue;
    }
    if (/^(<|>|&>|[0-9]<|[0-9]>)/.test(w)) continue;
    if (w === "-" || w === "--") return { kind, info: info2 };
    if (INFO[kind].test(w)) info2 = true;
    const kw = `${kind}:${w}`;
    if (w.startsWith("--")) {
      if (/^node:--(eval|print)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(test|run|watch|watch-path)(=.*)?$/s.test(kw)) return none;
      if (/^node:--(require|import|loader|input-type)$/.test(kw)) skip2 = true;
      continue;
    }
    if (w.startsWith("-")) {
      if (/^(py:-.*c|py:-.*m$|node:-[ep]$|perl:-.*[eE]|ruby:-.*e|sh:-.*c)/s.test(kw)) return none;
      if (/^py:-[bBdEhiIOPqRsSuvVx]*m/.test(kw)) return none;
      if (/^sh:-.*s/s.test(kw)) return { kind, info: info2 };
      if (/^(py:-[WX]|node:-r|ruby:-[rI]|perl:-[IM]|sh:-[oO])$/.test(kw)) skip2 = true;
      continue;
    }
    return none;
  }
  return { kind, info: info2 };
}
var stdinInterp = (words2) => stdinProgram(words2).kind;
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
  /** _tmb_cmd_var_get: every recorded value of <name>, each once, or null when never assigned. */
  varGet(vars, name3) {
    const values = /* @__PURE__ */ new Set();
    for (const line of vars.split("\n")) if (line.startsWith(name3 + "	")) values.add(after(line, "	"));
    return values.size > 0 ? chomp2([...values].join("\n") + "\n") : null;
  }
  /** _tmb_cmd_expand: every value a word expands to (at most 16), or the variable that stops it (any one in an unbalanced level). */
  expand(word, level) {
    let rest = word;
    let acc = [""];
    const fail2 = (unres) => ({ ok: false, unres });
    for (; ; ) {
      const at2 = rest.search(/[$`]/);
      if (at2 < 0) {
        acc = acc.map((a) => a + rest);
        break;
      }
      const lit = rest.slice(0, at2);
      rest = rest.slice(at2);
      acc = acc.map((a) => a + lit);
      let name3;
      let def = null;
      let cut4 = "";
      if (rest.startsWith("$(proc)")) return fail2("$(proc)");
      if (rest.startsWith("$(alias-write)")) return fail2("$(alias-write)");
      if (rest.startsWith("`") || rest.startsWith("$(")) return fail2("$()");
      if (rest.startsWith("${")) {
        let a = rest.slice(2);
        if (!a.includes("}")) return fail2(rest);
        rest = after(a, "}");
        a = before(a, "}");
        name3 = /^[A-Za-z0-9_]*/.exec(a)[0];
        const op = a.slice(name3.length);
        if (name3 === "" || /^[0-9]/.test(name3)) return fail2("${" + a + "}");
        if (op === "") {
        } else if (op.startsWith(":-") || op.startsWith(":=")) def = op.slice(2);
        else if (op.startsWith("-") || op.startsWith("=")) def = op.slice(1);
        else if (op.startsWith("%")) {
          cut4 = op.slice(1).replace(/^%/, "");
          if (cut4 === "" || /[^A-Za-z0-9._-]/.test(cut4)) return fail2(name3);
        } else return fail2(name3);
      } else if (/^\$[A-Za-z_]/.test(rest)) {
        const a = rest.slice(1);
        name3 = /^[A-Za-z0-9_]*/.exec(a)[0];
        rest = a.slice(name3.length);
      } else if (/^\$[0-9@*#?$!-]/.test(rest)) return fail2(rest.slice(0, 2));
      else {
        acc = acc.map((a) => a + "$");
        rest = rest.slice(1);
        continue;
      }
      if (this.unbalanced) return fail2(name3);
      let vals = this.varGet(level.vars, name3);
      if (vals !== null) {
        if (vals.includes(BAD2)) return fail2(name3);
      } else if (def !== null) {
        if (/[$`]/.test(def)) return fail2(name3);
        vals = def;
      } else {
        vals = this.envVar(name3, level);
        if (vals === null) return fail2(name3);
      }
      const next = [];
      for (const a of acc) {
        for (const v of vals.split("\n")) next.push(a + (cut4 !== "" && v.endsWith(cut4) ? v.slice(0, -cut4.length) : v));
      }
      if (next.length > 16) return fail2(name3);
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
    let base2 = "";
    if (!p.startsWith("/")) {
      if (dir === "-") return p === "." ? "UNRESOLVED:PWD:$PWD\n" : `UNRESOLVED:PWD:$PWD/${p}
`;
      if (dir === "@") base2 = cwd;
      else if (dir.startsWith("@/")) base2 = (cwd === "" ? "" : `${cwd.replace(/\/$/, "")}/`) + dir.slice(2);
      else base2 = dir;
    }
    if (raw) {
      if (p === "." && base2 !== "") return base2 + "\n";
      return (base2 === "" ? "" : `${base2.replace(/\/$/, "")}/`) + p + "\n";
    }
    return ((base2 === "" ? "" : base2 + "/") + p).split("\n").map(normalize).join("\n") + "\n";
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
        const base2 = chomp2(this.join(dir, "."));
        if (base2 !== ".") p = `${base2.replace(/\/$/, "")}/${p}`;
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
      rootc: () => this.rootc ??= pathCanonical(root),
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
  execWrites(outer, dir, mark, words2, tok, depth) {
    const level = { ...outer };
    const tool = basename5(words2[0]);
    const acts = [];
    let name3;
    if (tool === "find") name3 = "find_path";
    else if (tool === "fd" || tool === "fdfind") name3 = "fd_path";
    else if (tool === "xargs") {
      name3 = "xargs_arg";
      const n3 = words2.length;
      let k = 1;
      let rep = "";
      let noin = false;
      while (k < n3) {
        const p = words2[k];
        if (p === "--") {
          k++;
          break;
        }
        if (p === "-I" || p === "-J") {
          rep = words2[k + 1] ?? "";
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
      if (k >= n3) return;
      const rv2 = "${" + name3 + "}";
      let cmd = words2.slice(k).join(" ");
      cmd = rep !== "" ? cmd.split(rep).join(rv2) : `${cmd} ${rv2}`;
      acts.push("x" + cmd);
      if (noin || mark === "" || !this.loopSource(level, name3, mark)) level.vars += `${name3}	${BAD2}
`;
    } else return;
    if (tool !== "xargs" && !this.bind(level, name3, listerBind(this.listerHost(level), name3, dir, "exec", words2, acts))) {
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
    const body2 = inner3(unwrapStatement(cmd).words.join(" "));
    if (body2 === "") return;
    const text = dec(body2);
    if (depth >= MAX_DEPTH3) {
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
      const { words: words2 } = unwrapStatement(record.stmt);
      if (words2.length === 0) continue;
      if (/[$`]/.test(dec(words2[0]))) {
        out2.push("$(proc)");
        continue;
      }
      if (!cmd.includes("<<") && stdinInterp(words2) !== "") out2.push("$(proc)");
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
  listing(cmd, base2, depth) {
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) return [];
    const out2 = [];
    for (const record of statementsEnc(encoded.text, base2, this.opts.env.HOME ?? "", true)) {
      if (/^\t*$/.test(record.stmt)) continue;
      const body2 = depth < MAX_DEPTH3 && !record.dir.startsWith("=") ? inner3(record.stmt) : "";
      if (body2 !== "") out2.push(...this.listing(dec(body2), record.dir, depth + 1));
      else out2.push(record);
    }
    return out2;
  }
  /** The `heldKey` of every word of the command `run` is in whose text the shell fills in part of. */
  held = /* @__PURE__ */ new Set();
  /** _TMB_CMD_UNBAL: the level running, or one it runs within, has loop frames that do not balance. */
  unbalanced = false;
  isHeld(word) {
    return this.held.has(heldKey(word));
  }
  interp = (words2) => interpWrites(
    words2,
    (cmd) => this.procWrites(cmd),
    (w) => this.isHeld(w)
  );
  /**
   * _tmb_cmd_track_vars. The TS poisons the names a declare-like builtin sets
   * with an option other than -x / -r / -g / -t (`declare -n`, `-a`, `-i`,
   * ...), and those mapfile / readarray, getopts and unset set (GH 1739).
   */
  trackVars(level, words2) {
    switch (basename5(words2[0])) {
      case "export":
      case "declare":
      case "typeset":
      case "local":
      case "readonly": {
        const plain = words2.slice(1).every((w) => !/^[-+]/.test(w) || /^[-+][xrgt]+$/.test(w));
        for (const w of words2.slice(1)) {
          if (!/^[A-Za-z_].*=/s.test(w)) continue;
          if (plain) this.varSet(level, before(w, "="), dec(after(w, "=")));
          else this.poison(level, before(w, "="));
        }
        if (!plain) for (const w of words2.slice(1)) this.poison(level, w);
        return;
      }
      case "mapfile":
      case "readarray":
        for (const w of [...words2.slice(1), "MAPFILE"]) this.poison(level, w);
        return;
      case "unset":
        for (const w of words2.slice(1)) this.poison(level, w);
        return;
      case "getopts":
        this.poison(level, words2[2] ?? "");
        return;
      case "for": {
        if (words2[2] !== "in") {
          level.vars += `${words2[1] ?? ""}	${BAD2}
`;
          return;
        }
        const name3 = words2[1] ?? "";
        const rest = words2.slice(3);
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
        let skip2 = false;
        const names = [];
        for (const w of words2.slice(1)) {
          if (skip2) {
            skip2 = false;
            continue;
          }
          if (w.startsWith(SEP)) mk = w;
          else if (w === "-d") skip2 = true;
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
        if (words2[1] === "-v") level.vars += `${words2[2] ?? ""}	${BAD2}
`;
        return;
    }
  }
  /** _tmb_cmd_write_paths_in */
  run(cmd, base2, depth, vars) {
    const encoded = encode(this.parser, cmd);
    if (!encoded.ok) {
      this.out += parseLine(cmd);
      return;
    }
    const outer = this.held;
    const unbalanced = this.unbalanced;
    this.held = encoded.held;
    try {
      this.runEncoded(encoded.text, encoded.heredocs, base2, depth, vars);
    } finally {
      this.held = outer;
      this.unbalanced = unbalanced;
    }
  }
  /** The names a statement's words may set beyond what `trackVars` follows; a declare-like builtin's own `name=` words are its to judge. */
  poisonSet(level, words2) {
    const declares = /^(export|declare|typeset|local|readonly)$/.test(basename5(words2[0]));
    for (const w of words2) {
      if (declares && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
      for (const name3 of setInText(dec(w))) this.poison(level, name3);
    }
  }
  /**
   * _tmb_cmd_loop_vars: at a loop's `{`, adds to the level every value its
   * records (`loop`, the first at 1-based index `from + 1`) assign, nested
   * loops included, pass after pass until one adds none, so a use that
   * precedes an in-body assignment also sees what a later pass assigns
   * (GH 1944). A name still gaining values after 8 passes is poisoned.
   */
  loopVars(level, loop, from, bodies, depth) {
    const { cwd } = this.opts;
    const saved = { pwd: this.pwd, oldtok: level.oldtok, why: level.why };
    level.vars = varsUniq(level.vars);
    const seed = new Set(level.vars.split("\n"));
    let converged = false;
    for (let pass = 0; pass < 8 && !converged; pass++) {
      const prev = level.vars;
      loop.forEach((record, k) => {
        if (record.dir === LOOP_OPEN || record.dir === LOOP_CLOSE || record.dir === UNBALANCED) return;
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
        const words2 = shellWords(record.stmt);
        if (words2.length === 0) return;
        if (dir.startsWith("=")) {
          this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
            this.pwd = dirPath(d, cwd);
            for (const w of words2) this.varSet(level, before(w, "="), dec(after(w, "=")));
          });
          return;
        }
        this.poisonSet(level, words2);
        for (const h of bodies.get(from + k + 1) ?? []) if (h.expands) for (const name3 of setInText(h.body)) this.poison(level, name3);
        const body2 = inner3(record.stmt);
        if (body2 !== "" && (!evalArgs(words2) && heldProgram(body2) || depth < MAX_DEPTH3)) return;
        this.eachDir(level, dir.split(ALT), why, (d) => {
          this.pwd = dirPath(d, cwd);
          this.trackVars(level, words2);
        });
      });
      level.vars = varsUniq(level.vars);
      converged = level.vars === prev;
    }
    if (!converged) {
      for (const line of level.vars.split("\n")) if (line !== "" && !seed.has(line)) this.poison(level, before(line, "	"));
    }
    this.pwd = saved.pwd;
    level.oldtok = saved.oldtok;
    level.why = saved.why;
  }
  /**
   * Runs `fn` for each dir a statement may run in (a loop's back-edge can
   * list more than one, GH 1977), with its why on the first only; each run
   * starts from the variables the statement found and keeps what it adds.
   */
  eachDir(level, dirs, why, fn) {
    const vars = level.vars;
    let added = "";
    dirs.forEach((d, n3) => {
      level.vars = vars;
      level.why = n3 === 0 ? why : "";
      fn(d);
      added += level.vars.slice(vars.length);
    });
    level.vars = vars + added;
    level.why = why;
  }
  runEncoded(text, heredocs2, base2, depth, vars) {
    const level = { vars, oldtok: "-", why: "" };
    const { cwd } = this.opts;
    const records2 = statementsEnc(text, base2, this.opts.env.HOME ?? "", true).filter((r) => !/^\t*$/.test(r.stmt));
    const bodies = heredocAlign(heredocs2, records2);
    if (records2.some((r) => r.dir === UNBALANCED)) this.unbalanced = true;
    let idx = 0;
    for (const record of records2) {
      idx++;
      if (record.dir === LOOP_OPEN) {
        this.loopVars(level, loopBody(records2, idx), idx, bodies, depth);
        continue;
      }
      if (record.dir === LOOP_CLOSE || record.dir === UNBALANCED) continue;
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
      let words2 = shellWords(record.stmt);
      if (words2.length === 0) continue;
      if (dir.startsWith("=")) {
        this.eachDir(level, dir.slice(1).split(ALT), why, (d) => {
          this.pwd = dirPath(d, cwd);
          for (const w of words2) this.varSet(level, before(w, "="), dec(after(w, "=")));
        });
        continue;
      }
      const tok = dir + SEP + old + (why === "" ? "" : SEP + why);
      const dirs = dir.split(ALT);
      const each = (fn) => this.eachDir(level, dirs, why, (d) => fn(d, d === "-" && level.why === "", d + SEP + old + (level.why === "" ? "" : SEP + level.why)));
      const body2 = inner3(record.stmt);
      const evaluated = evalArgs(words2);
      this.poisonSet(level, words2);
      for (const h of bodies.get(idx) ?? []) if (h.expands) for (const name3 of setInText(h.body)) this.poison(level, name3);
      const argv0 = unwrapStatement(record.stmt).words[0] ?? "";
      if (/[$`\x07]/.test(decode(argv0))) this.out += unprovenLine(dec(record.stmt));
      if (evaluated?.some((w) => this.isHeld(w))) this.out += unprovenLine(dec(record.stmt));
      else if (body2 !== "" && !evaluated && this.isHeld(body2)) this.out += unprovenLine(`${basename5(dec(words2[0]))} ${dec(body2)}`);
      const ownWords = body2 !== "" && !evaluated && basename5(words2[0]) !== "watch";
      if (ownWords) {
        each((d, chain2) => {
          for (const p of stmtWritePaths(record.stmt, chain2, this.interp).paths) if (p !== "") this.emit(level, d, dec(p));
        });
      }
      if (body2 !== "" && !evaluated && heldProgram(body2)) {
        this.out += computedLine(`${basename5(dec(words2[0]))} ${dec(body2)}`);
        continue;
      }
      if (body2 !== "" && depth < MAX_DEPTH3) {
        this.run(dec(body2), tok, depth + 1, level.vars);
        continue;
      }
      if (body2 !== "") this.out += computedLine(dec(body2));
      let stmt = record.stmt;
      let mark = "";
      if (basename5(words2[0]) === "xargs" && words2[words2.length - 1].startsWith(SEP)) {
        mark = words2[words2.length - 1];
        words2 = words2.slice(0, -1);
        stmt = words2.join(" ");
      }
      if (!ownWords) {
        each((d, chain2) => {
          for (const p of stmtWritePaths(stmt, chain2, this.interp).paths) if (p !== "") this.emit(level, d, dec(p));
        });
      }
      if (/^(find|fd|fdfind|xargs)$/.test(basename5(words2[0]))) each((d, _, t) => this.execWrites(level, d, mark, words2, t, depth));
      const { kind, info: info2 } = stdinProgram(words2);
      if (kind !== "") {
        const progs = [];
        const herestring = (w) => {
          progs.push({ prog: dec(w), held: heldProgram(w), partly: this.isHeld(w) });
        };
        for (let w = 0; w < words2.length; w++) {
          if (words2[w] === "<<<") herestring(words2[w + 1] ?? "");
          else if (words2[w].startsWith("<<<")) herestring(words2[w].slice(3));
        }
        for (const h of bodies.get(idx) ?? []) progs.push({ prog: h.body, held: heldProgram(h.body), partly: h.expands });
        if (progs.length === 0 && !info2) this.out += computedLine(basename5(dec(words2[0])));
        const shownArgv0 = basename5(dec(words2[0]));
        for (const { prog, held, partly } of progs) {
          if (held) this.out += computedLine(`${shownArgv0} ${prog}`);
          else if (kind === "sh") {
            if (partly) this.out += unprovenLine(`${shownArgv0} ${prog}`);
            if (depth < MAX_DEPTH3) this.run(prog, tok, depth + 1, level.vars);
            else this.out += computedLine(prog);
          } else {
            const found = progWrites(kind, prog, false, (c) => this.procWrites(c));
            each((d) => {
              for (const p of found.lines) if (p !== "") this.emit(level, d, p);
            });
            if (found.computed) this.out += computedLine(shownArgv0);
            if (partly || found.unproven) this.out += unprovenLine(`${shownArgv0} ${prog}`);
          }
        }
      }
      each((d) => {
        this.pwd = dirPath(d, cwd);
        this.trackVars(level, words2);
      });
    }
  }
};
function loopBody(records2, from) {
  let depth = 0;
  let k = from;
  for (; k < records2.length; k++) {
    if (records2[k].dir === LOOP_OPEN) depth++;
    else if (records2[k].dir === LOOP_CLOSE && depth-- === 0) break;
  }
  return records2.slice(from, k);
}
function varsUniq(vars) {
  const lines2 = [...new Set(vars.split("\n").filter((l) => l !== ""))];
  return lines2.length === 0 ? "" : lines2.join("\n") + "\n";
}
function heredocAlign(heredocs2, records2) {
  const out2 = /* @__PURE__ */ new Map();
  if (heredocs2.length === 0) return out2;
  const used = /* @__PURE__ */ new Set();
  let p = -1;
  records2.forEach((record, i2) => {
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

// src/hooks/cmd-analysis/forge.ts
var READERS = /* @__PURE__ */ new Set([
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "gawk",
  "jq",
  "yq",
  "test",
  "[",
  "[[",
  "man",
  "which",
  "type",
  "wc",
  "sort",
  "cut",
  "tr"
]);
var WRITES2 = {
  "gh issue": ["create", "close", "edit", "delete", "comment", "reopen", "transfer", "lock", "unlock", "pin", "unpin", "develop"],
  "gh pr": ["create", "merge", "close", "edit", "comment", "reopen", "ready", "review", "lock", "unlock"],
  "gh release": ["create", "edit", "delete", "delete-asset", "upload"],
  "gh repo": ["create", "delete", "edit", "fork", "rename", "archive", "unarchive", "sync"],
  "gh label": ["create", "edit", "delete", "clone"],
  "glab issue": ["create", "close", "update", "edit", "delete", "note", "reopen"],
  "glab mr": ["create", "merge", "close", "update", "edit", "delete", "note", "reopen", "approve", "rebase"],
  "glab release": ["create", "update", "delete", "upload"],
  "glab repo": ["create", "delete", "archive", "fork", "transfer"]
};
var API_VERBS = /* @__PURE__ */ new Set(["POST", "PATCH", "PUT", "DELETE"]);
function readWords3(s) {
  return (s.split("\n")[0] ?? "").split(/[ \t]+/).filter((w) => w !== "");
}
function base(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}
function isForge(word) {
  const b = base(word);
  return b === "gh" || b === "glab";
}
function ghMutationFrom(w) {
  const n3 = w.length;
  const tool = base(w[0] ?? "");
  let k = 1;
  let skipval = false;
  let group = "";
  let action = "";
  while (k < n3) {
    const a = w[k];
    k += 1;
    if (skipval) {
      skipval = false;
      continue;
    }
    if (a === "-R" || a === "--repo") {
      skipval = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (group === "") {
      group = a;
      if (group === "api") break;
      continue;
    }
    action = a;
    break;
  }
  if (group === "api") {
    let verb = "";
    let fields = false;
    while (k < n3) {
      const a = w[k];
      k += 1;
      if (a === "-X" || a === "--method") {
        verb = w[k] ?? "";
        k += 1;
      } else if (a.startsWith("--method=")) verb = a.slice("--method=".length);
      else if (a.startsWith("-X")) verb = a.slice(2);
      else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a)) {
        fields = true;
        k += 1;
      } else if (/^(-f|-F|--field=|--raw-field=|--input=)/.test(a)) fields = true;
    }
    verb = verb.toUpperCase();
    if (verb === "" && fields) verb = "POST";
    return API_VERBS.has(verb) ? verb : "";
  }
  const writes = WRITES2[`${tool} ${group}`];
  if (!writes || action === "" || !writes.includes(action)) return "";
  return `${group} ${action}`;
}
function ghMutationIn(words2) {
  const cmd = words2.join(" ");
  if (cmd === "") return "";
  const w = readWords3(cmd.replaceAll("_", " "));
  for (let k = 0; k < w.length; k++) {
    if (!isForge(w[k])) continue;
    const found = ghMutationFrom(w.slice(k));
    if (found !== "") return found;
  }
  return "";
}
function rebaseExec(g) {
  for (let k = 1; k < g.length; k++) {
    const a = g[k];
    let found = "";
    if (a === "--ex" || a === "--exe" || a === "--exec") {
      found = ghMutationIn([g[k + 1] ?? ""]);
      k += 1;
    } else if (/^--(ex|exe|exec)=/.test(a)) found = ghMutationIn([a.slice(a.indexOf("=") + 1)]);
    else if (a.startsWith("--")) found = "";
    else if (a.startsWith("-") && a.slice(1).includes("x")) {
      const rest = a.slice(a.indexOf("x") + 1);
      if (rest !== "") found = ghMutationIn([rest]);
      else {
        found = ghMutationIn([g[k + 1] ?? ""]);
        k += 1;
      }
    }
    if (found !== "") return found;
  }
  return "";
}
function gitMutation(words2) {
  const g = readWords3(gitSubcommand(words2.join(" ")));
  if (`${g[0] ?? ""} ${g[1] ?? ""}` === "bisect run") return ghMutationIn(g.slice(2));
  if (g[0] === "submodule") {
    let k = 1;
    while (k < g.length && g[k].startsWith("-")) k += 1;
    if (g[k] !== "foreach") return "";
    k += 1;
    while (k < g.length && g[k].startsWith("-")) k += 1;
    return ghMutationIn(g.slice(k));
  }
  return g[0] === "rebase" ? rebaseExec(g) : "";
}
function ghMutation(stmt) {
  const w = readWords3(stmt);
  let k = 0;
  while (k < w.length && /^[A-Za-z_][^]*=/.test(w[k])) k += 1;
  if (k >= w.length) return "";
  const head = base(w[k]);
  if (head === "git") return gitMutation(w.slice(k));
  if (READERS.has(head)) return "";
  for (; k < w.length; k++) {
    if (!isForge(w[k])) continue;
    const found = ghMutationFrom(w.slice(k));
    if (found !== "") return found;
  }
  return "";
}

// src/hooks/cmd-analysis/strip-literals.ts
var NEUTRAL2 = /* @__PURE__ */ new Set([" ", "	", "<", ">", "|", ";", "&", "(", ")", "`"]);
var COMMENT_BEFORE = /* @__PURE__ */ new Set([" ", "	", ";", "&", "|", "("]);
var WORD_END = /* @__PURE__ */ new Set([" ", "	", ";", "&", "|", "<", ">", "(", ")"]);
var SQ = "'";
function neutral2(c) {
  return NEUTRAL2.has(c) ? "_" : c;
}
function stripLiterals(cmd) {
  let state = "";
  let inbody = false;
  let cur = 0;
  let sp = 0;
  const delim = [];
  const tabs = [];
  const pd = [];
  const subBt = [];
  let printed = "";
  const subopen = (bt) => {
    sp += 1;
    pd[sp] = 0;
    subBt[sp] = bt;
    return "$(";
  };
  const subclose = () => {
    sp -= 1;
    state = "d";
    return ")";
  };
  for (const line of cmd.split("\n")) {
    if (inbody) {
      const t = tabs[cur] ? line.replace(/^\t+/, "") : line;
      if (t === delim[cur]) {
        cur += 1;
        if (cur >= delim.length) {
          inbody = false;
          delim.length = 0;
          tabs.length = 0;
          cur = 0;
        }
      }
      continue;
    }
    let out2 = "";
    let i2 = 0;
    const n3 = line.length;
    while (i2 < n3) {
      const c = line[i2];
      const next = line[i2 + 1] ?? "";
      if (state === "s") {
        if (c === SQ) state = "";
        else out2 += neutral2(c);
        i2 += 1;
        continue;
      }
      if (state === "a") {
        if (c === "\\") {
          out2 += neutral2(next);
          i2 += 2;
          continue;
        }
        if (c === SQ) state = "";
        else out2 += neutral2(c);
        i2 += 1;
        continue;
      }
      if (state === "d") {
        if (c === "\\") {
          out2 += neutral2(next);
          i2 += 2;
          continue;
        }
        if (c === "$" && next === "(") {
          out2 += subopen(false);
          state = "";
          i2 += 2;
          continue;
        }
        if (c === "`") {
          out2 += subopen(true);
          state = "";
          i2 += 1;
          continue;
        }
        if (c === '"') state = "";
        else out2 += neutral2(c);
        i2 += 1;
        continue;
      }
      if (sp > 0) {
        if (subBt[sp] && c === "`") {
          out2 += subclose();
          i2 += 1;
          continue;
        }
        if (!subBt[sp] && c === "(") pd[sp] += 1;
        if (!subBt[sp] && c === ")") {
          if (pd[sp] === 0) {
            out2 += subclose();
            i2 += 1;
            continue;
          }
          pd[sp] -= 1;
        }
      }
      if (c === "$" && next === SQ) {
        state = "a";
        i2 += 2;
        continue;
      }
      if (c === "\\") {
        out2 += next;
        i2 += 2;
        continue;
      }
      if (c === SQ) {
        state = "s";
        i2 += 1;
        continue;
      }
      if (c === '"') {
        state = "d";
        i2 += 1;
        continue;
      }
      if (c === "#" && (i2 === 0 || COMMENT_BEFORE.has(line[i2 - 1]))) break;
      if (line.startsWith("<<<", i2)) {
        out2 += "<<<";
        i2 += 3;
        continue;
      }
      if (line.startsWith("<<", i2)) {
        let j = i2 + 2;
        let strip = false;
        if (line[j] === "-") {
          strip = true;
          j += 1;
        }
        while (j < n3 && (line[j] === " " || line[j] === "	")) j += 1;
        let w = "";
        while (j < n3) {
          const d = line[j];
          if (WORD_END.has(d)) break;
          if (d !== SQ && d !== '"' && d !== "\\") w += d;
          j += 1;
        }
        if (w !== "") {
          delim.push(w);
          tabs.push(strip);
        }
        out2 += `<<${w}`;
        i2 = j;
        continue;
      }
      out2 += c;
      i2 += 1;
    }
    printed += state === "" ? `${out2}
` : `${out2}_`;
    if (delim.length > 0 && state === "") {
      inbody = true;
      cur = 0;
    }
  }
  return printed;
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

// src/hooks/git-guards.ts
var GATE_NAME6 = "git-guards";
var NEEDS_GUARD = /(^|[^A-Za-z0-9_./-])(git|gh|glab)([ \t\n\v\f\r]|$)/;
var SPACE = "[ \\t\\n\\v\\f\\r]";
var NONSPACE = "[^ \\t\\n\\v\\f\\r]";
var GUARDED_SUB = /^(commit|merge|rebase|cherry-pick|push)( |$)|^(checkout -b|switch -c) /;
var INTEGRATION_SUB = /^(merge|rebase|cherry-pick)( |$)/;
var FF_SYNC_QUIET = /* @__PURE__ */ new Set(["-q", "--quiet", "-v", "--verbose", "--stat", "--no-stat", "-n", "--progress", "--no-progress"]);
var FF_SYNC_COMPANIONS = /* @__PURE__ */ new Set(["cd", "echo", "printf", "true", "false", "test", "[", "pwd"]);
var FF_SYNC_GIT_READS = /* @__PURE__ */ new Set(["fetch", "status", "log", "diff", "show", "rev-parse"]);
var NON_ASCII = /[^\x00-\x7f]/;
var SWITCH_TAIL = /* @__PURE__ */ new Set(["", " ", ";", "|", "&", ")"]);
var PARSE_REASON = "BLOCKED: the git guard could not parse this command, so it cannot tell which statements run git, gh or glab, or in which checkout. Split it into simpler commands or fix its quoting, then retry.";
var MALFORMED_REASON = "BLOCKED: this repo's protected_branches is malformed JSON. Fix the repos row or re-run bro onboarding.";
function needsGitGuard(command) {
  return NEEDS_GUARD.test(command);
}
var Denied = class {
  constructor(result) {
    this.result = result;
  }
  result;
};
function deny(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return new Denied({ stdout: `${jqCompact(decision)}
`, code: 0 });
}
function readRow(line) {
  const s = line.replace(/^\t+/, "");
  const tab = s.indexOf("	");
  if (tab < 0) return { dir: s, stmt: "" };
  return { dir: s.slice(0, tab), stmt: s.slice(tab).replace(/^\t+|\t+$/g, "") };
}
function words(s) {
  return (s.split("\n")[0] ?? "").split(/[ \t]+/).filter((w) => w !== "");
}
function optionValue(s, find, strip) {
  const m = new RegExp(find).exec(s);
  return m ? m[0].replace(new RegExp(strip), "") : "";
}
function cutField(text, n3) {
  const fields = text.split("\n").map((line) => line.includes("|") ? line.split("|")[n3 - 1] ?? "" : line);
  return stripTrailingNewlines(fields.join("\n"));
}
function physicalDir(dir) {
  try {
    if (!statSync12(dir).isDirectory()) return "";
    accessSync7(dir, constants7.X_OK);
    return realpathSync4.native(dir);
  } catch {
    return "";
  }
}
function inlineLandings(text) {
  const leadC = new RegExp(`^git${SPACE}+-C(${SPACE}|$)`);
  const commit = new RegExp(`^git${SPACE}+commit(${SPACE}|$)`);
  const create = [new RegExp(`^git${SPACE}+checkout${SPACE}+-b${SPACE}`), new RegExp(`^git${SPACE}+switch${SPACE}+-c${SPACE}`)];
  const change = new RegExp(`^git${SPACE}+(checkout|switch)(${SPACE}|$)`);
  const split2 = new RegExp(`${SPACE}+`);
  let landings = "";
  let current = "";
  let known = false;
  let saw = false;
  for (const s of text.split("\n")) {
    if (leadC.test(s) && /(commit|checkout|switch)/.test(s)) return "";
    if (commit.test(s)) {
      saw = true;
      if (!known) return "";
      landings += `${current}
`;
    } else if (create.some((re) => re.test(s))) {
      const tok = s.split(split2);
      const j = tok.findIndex((t) => t === "-b" || t === "-c");
      const name3 = j >= 0 && j < tok.length - 1 ? tok[j + 1] : "";
      if (name3 === "") return "";
      current = name3;
      known = true;
    } else if (change.test(s)) {
      const name3 = s.split(split2)[2] ?? "";
      if (name3 === "" || name3.startsWith("-")) return "";
      current = name3;
      known = true;
    }
  }
  return saw ? stripTrailingNewlines(landings) : "";
}
function ffSyncOtherOk(stmt) {
  if (stmt.includes(">") || stmt.includes("<")) return false;
  const w0 = words(stmt)[0] ?? "";
  if (FF_SYNC_COMPANIONS.has(w0)) return true;
  if (w0 !== "git") return false;
  if (stmt.includes(":")) return false;
  return FF_SYNC_GIT_READS.has(gitSubcommand(stmt).split(" ")[0]);
}
var GitGuards = class {
  constructor(command, cwd, db, env, lines2) {
    this.command = command;
    this.cwd = cwd;
    this.db = db;
    this.env = env;
    this.lines = lines2;
    const rows = lines2.map(readRow);
    this.dirs = rows.map((r) => r.dir);
    this.stmts = rows.map((r) => r.stmt);
    this.landings = inlineLandings(stripTrailingNewlines(lines2.map((l) => l.includes("	") ? l.slice(l.indexOf("	") + 1) : l).join("\n")));
    this.dbReadable = db !== "" && isFile8(db) && haveSqlite(env);
  }
  command;
  cwd;
  db;
  env;
  lines;
  dirs;
  stmts;
  landings;
  dbReadable;
  gitRoot = "";
  prTarget = "";
  protectedBranches = "";
  git(dir, ...args2) {
    return gitOut(dir, args2, this.env);
  }
  gitOk(dir, ...args2) {
    return gitOk(dir, args2, this.env);
  }
  /** load_policy: the repos row of <root>, or false for no root or an unregistered repo. */
  loadPolicy(root) {
    if (root === "") return false;
    this.gitRoot = root;
    this.prTarget = "";
    let raw = "";
    if (this.dbReadable) {
      if (!repoIsRegistered(this.db, root, this.env)) return false;
      const row = repoResolve(this.db, root, this.env);
      this.prTarget = cutField(row, 1);
      raw = cutField(row, 3);
    }
    const defaultBranch = repoDefaultBranch(root, this.env);
    this.prTarget ||= defaultBranch;
    raw ||= jqCompact([defaultBranch]);
    const parsed = jsonStream(raw);
    if (!parsed.complete || !Array.isArray(parsed.values[parsed.values.length - 1])) throw deny(MALFORMED_REASON);
    this.protectedBranches = stripTrailingNewlines(jqRawElements(raw));
    return true;
  }
  branchIsProtected(branch) {
    return this.protectedBranches.split("\n").includes(branch);
  }
  /** dir_branch: the branch checked out in <dir>, else the newest task whose branch_id ends in /<basename of dir>. */
  dirBranch(dir) {
    const branch = this.git(dir, "branch", "--show-current");
    if (branch !== "" || !this.dbReadable) return branch;
    return taskBySlug(this.db, posixBasename(dir), "branch_id", "", this.env, (line) => process.stderr.write(`${line}
`)).replace(/\n/g, "");
  }
  dirInWorktree(dir) {
    const top = this.git(dir, "rev-parse", "--show-toplevel");
    return top !== "" && physicalDir(top) !== physicalDir(this.gitRoot);
  }
  /** need_dir: deny an ambiguous dir; false for an unknown or missing one. */
  needDir(dir, stmt, unresolved) {
    if (dir === "?") throw new Denied({ stdout: denyAmbiguousGitTarget(stmt, unresolved), code: 0 });
    if (dir === "-" || dir === "") return false;
    return isDir(dir);
  }
  /** rule2_protected_bases: protected_branches ∪ target ∪ repos.pr_target ∪ every task's parent_branch_id. */
  rule2ProtectedBases() {
    const out2 = [...this.protectedBranches.split("\n"), this.prTarget];
    if (this.dbReadable) {
      const name3 = repoNameForRoot(this.db, this.gitRoot, this.env);
      if (name3 !== "" && sqliteRo(this.db, "SELECT 1 FROM pragma_table_info('repos') WHERE name='pr_target' LIMIT 1;", this.env) !== "") {
        out2.push(
          ...sqliteRo(this.db, `SELECT pr_target FROM repos WHERE name = '${sqlQuote(name3)}' AND pr_target IS NOT NULL AND pr_target != '';`, this.env).split("\n")
        );
      }
      const filter = name3 === "" ? "repo IS NULL" : `(repo = '${sqlQuote(name3)}' OR repo IS NULL)`;
      out2.push(
        ...sqliteRo(
          this.db,
          `SELECT DISTINCT parent_branch_id FROM tasks WHERE parent_branch_id IS NOT NULL AND parent_branch_id != '' AND ${filter};`,
          this.env
        ).split("\n")
      );
    }
    return new Set(out2.filter((b) => !/^[ \t\n\v\f\r]*$/.test(b)));
  }
  rule2Recovery(dir) {
    if (dir === "-" || dir === "?" || dir === "" || !isDir(dir)) return "";
    if (this.git(dir, "remote", "-v") !== "") {
      return ` Push your feature branch and open a PR into ${this.prTarget}: git push origin <branch> && gh pr create --base ${this.prTarget} --head <branch>.`;
    }
    return " This repo has no remote \u2014 leave the branch unmerged and surface it to the Human for integration.";
  }
  /** ff_sync_switch: the local branch statement <i> switches to right before `&&` and the merge, "" otherwise. */
  ffSyncSwitch(i2, dir) {
    if (i2 < 0 || (this.dirs[i2] ?? "") !== dir) return "";
    const stmt = this.stmts[i2];
    const w = words(stmt);
    if (w[0] !== "git") return "";
    let k = w[1] === "-C" ? 3 : 1;
    if (w[k] !== "switch" && w[k] !== "checkout") return "";
    k += 1;
    if (w[k] === "-q" || w[k] === "--quiet") k += 1;
    const name3 = w[k] ?? "";
    if (name3 === "" || name3.startsWith("-") || k + 1 !== w.length) return "";
    if (!this.gitOk(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name3}`)) return "";
    if (NON_ASCII.test(this.command)) return "";
    const flat = stripLiterals(this.command).replace(/\n/g, ";").replace(/[ \t]+/g, " ");
    const needle = `${stmt} && ${this.stmts[i2 + 1] ?? ""}`;
    const at2 = flat.indexOf(needle);
    if (at2 < 0) return "";
    const tail = flat.slice(at2 + needle.length);
    if (tail.includes(needle) || !SWITCH_TAIL.has(tail.slice(0, 1))) return "";
    const head = flat.slice(0, at2).replace(/ +$/, "");
    return head === "" || head.endsWith(";") || head.endsWith("&&") ? name3 : "";
  }
  /** ff_upstream_sync: statement <idx> fast-forwards a branch to its own remote-tracking upstream. */
  ffUpstreamSync(idx, dir, sub) {
    const own = this.dirs[idx] ?? "";
    if (own === "-" || own === "?" || own === "") return false;
    let target = "";
    let ff = false;
    for (const w of words(sub.startsWith("merge") ? sub.slice(5) : sub)) {
      if (w === "--ff-only") ff = true;
      else if (FF_SYNC_QUIET.has(w)) continue;
      else if (w.startsWith("-")) return false;
      else if (target !== "") return false;
      else target = w;
    }
    if (!ff || target === "") return false;
    let branch = this.ffSyncSwitch(idx - 1, own);
    const skip2 = branch === "" ? -1 : idx - 1;
    for (let j = 0; j < this.stmts.length; j++) {
      if (j === idx || j === skip2 || this.stmts[j] === "") continue;
      if (!ffSyncOtherOk(this.stmts[j])) return false;
    }
    branch ||= this.git(dir, "branch", "--show-current");
    if (branch === "" || !this.gitOk(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) return false;
    const remote = this.git(dir, "config", "--get", `branch.${branch}.remote`);
    if (remote === "" || remote === ".") return false;
    const up = this.git(dir, "rev-parse", "--symbolic-full-name", `${branch}@{u}`);
    if (!/^refs\/remotes\/[\s\S]/.test(up)) return false;
    if (target === "@{u}" || target === "@{upstream}") return true;
    return this.git(dir, "rev-parse", "--symbolic-full-name", target) === up;
  }
  ghRule(stmt, dir, unresolved) {
    const pr = this.prTarget;
    const base2 = optionValue(stmt, `--base[= ]${NONSPACE}+`, "--base[= ]+");
    if (base2 !== "" && base2 === pr) return;
    if (pr === "dev" && base2 === "main") {
      let head = optionValue(stmt, `--head[= ]${NONSPACE}+`, "--head[= ]+");
      if (head === "" && this.needDir(dir, stmt, unresolved)) head = this.git(dir, "branch", "--show-current");
      if (head !== "dev") {
        throw deny(
          `BLOCKED: only 'dev \u2192 main' is permitted as a release merge. Feature branches must PR to ${pr}: gh pr create --base ${pr} --head <branch>. Got --head=${head}.`
        );
      }
      return;
    }
    throw deny(
      `BLOCKED: PRs must target ${pr} branch. Use: gh pr create --base ${pr} --head <branch>. (Dev \u2192 main release merges are allowed when PR_TARGET=dev.)`
    );
  }
  glabRule(stmt, dir, unresolved) {
    const pr = this.prTarget;
    const target = optionValue(stmt, `--target-branch[= ]${NONSPACE}+`, "--target-branch[= ]+") || optionValue(stmt, `(^|${SPACE})-b[= ]${NONSPACE}+`, `^${SPACE}*-b[= ]+`);
    let source = optionValue(stmt, `--source-branch[= ]${NONSPACE}+`, "--source-branch[= ]+") || optionValue(stmt, `(^|${SPACE})-s[= ]${NONSPACE}+`, `^${SPACE}*-s[= ]+`);
    if (target === pr) return;
    if (pr === "dev" && target === "main") {
      if (source === "" && this.needDir(dir, stmt, unresolved)) source = this.git(dir, "branch", "--show-current");
      if (source !== "dev") {
        throw deny(
          `BLOCKED: only 'dev \u2192 main' is permitted as a release merge. Feature branches must MR to ${pr}: glab mr create --target-branch ${pr} --source-branch <branch>. Got --source-branch=${source}.`
        );
      }
      return;
    }
    throw deny(
      `BLOCKED: MRs must target ${pr} branch. Use: glab mr create --target-branch ${pr} --source-branch <branch>. (Dev \u2192 main release merges are allowed when PR_TARGET=dev.)`
    );
  }
  integrationRule(idx, sub, stmt, dir, unresolved) {
    if (!this.needDir(dir, stmt, unresolved) || this.dirInWorktree(dir)) return;
    const reason = `BLOCKED: local merge/rebase/cherry-pick in the main checkout is not allowed \u2014 integration is PR-only.${this.rule2Recovery(dir)}`;
    if (sub === "merge" || sub.startsWith("merge ")) {
      if (this.ffUpstreamSync(idx, dir, sub)) return;
      throw deny(`${reason} To sync a branch with its own upstream, run git pull --ff-only (or git merge --ff-only @{u}) on that branch.`);
    }
    throw deny(reason);
  }
  commitRule(stmt, dir, unresolved) {
    const bases = this.rule2ProtectedBases();
    let branch;
    if (this.landings !== "") {
      branch = this.landings.split("\n").find((b) => bases.has(b)) ?? "";
    } else {
      if (!this.needDir(dir, stmt, unresolved)) return;
      branch = this.dirBranch(dir);
      if (!bases.has(branch)) branch = "";
    }
    if (branch !== "") throw deny(`BLOCKED: ${branch} is a shared workflow base \u2014 no direct commits/merges/rebases.${this.rule2Recovery(dir)}`);
  }
  forcePushRule(sub, stmt, dir, unresolved) {
    let force = false;
    const pos = [];
    for (const a of words(sub.startsWith("push") ? sub.slice(4) : sub)) {
      if (a === "--force" || a === "--force-with-lease" || a.startsWith("--force-with-lease=") || a === "-f") force = true;
      else if (!a.startsWith("-")) pos.push(a);
    }
    if (!force) return;
    let target = pos[0] === "origin" || pos[0] === "upstream" ? pos[1] ?? "" : "";
    if (target === "") {
      if (!this.needDir(dir, stmt, unresolved)) return;
      target = this.git(dir, "branch", "--show-current");
    }
    if (target !== "" && this.branchIsProtected(target)) throw deny(`BLOCKED: Force push to ${target} is forbidden. This is destructive and irreversible.`);
  }
  newBranchRule(stmt, dir, unresolved) {
    if (!this.needDir(dir, stmt, unresolved)) return;
    const branch = this.dirBranch(dir);
    let t = this.prTarget;
    if (!this.gitOk(dir, "rev-parse", "--verify", "--quiet", t) && !this.gitOk(dir, "rev-parse", "--verify", "--quiet", `origin/${t}`)) {
      const fallback = repoDefaultBranch(this.gitRoot, this.env);
      if (fallback !== "") t = fallback;
    }
    if (branch !== "" && branch !== t) {
      throw deny(`BLOCKED: New branches must be created from ${t}. Currently on '${branch}'. Run: git checkout ${t} && git pull origin ${t} first.`);
    }
    if (branch === "") throw deny(`BLOCKED: Detached HEAD detected. Run: git checkout -B ${t} origin/${t} to reattach, then create your feature branch.`);
    if (this.git(dir, "remote", "get-url", "origin") === "") return;
    gitRun(dir, ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=5", "fetch", "origin", t, "--quiet"], this.env);
    const local = this.git(dir, "rev-parse", "--verify", t);
    const remote = this.git(dir, "rev-parse", "--verify", `origin/${t}`);
    if (local !== "" && remote !== "" && local !== remote) throw deny(`BLOCKED: Local ${t} is behind origin/${t}. Run: git pull origin ${t} first.`);
  }
  judge(idx) {
    const stmt = this.stmts[idx];
    if (stmt === "") return;
    const sub = gitSubcommand(stmt);
    let forge = "";
    if (stmt === "gh pr create" || stmt.startsWith("gh pr create ")) forge = "gh";
    else if (stmt === "glab mr create" || stmt.startsWith("glab mr create ")) forge = "glab";
    if (!GUARDED_SUB.test(sub) && forge === "") return;
    let dir = this.dirs[idx];
    let unresolved = false;
    if (dir === "-") {
      unresolved = true;
      dir = cwdState(this.cwd, this.env);
    }
    if (!this.loadPolicy(stmtRepoRoot(dir, this.cwd, this.env))) return;
    if (forge === "gh") return this.ghRule(stmt, dir, unresolved);
    if (forge === "glab") return this.glabRule(stmt, dir, unresolved);
    if (INTEGRATION_SUB.test(sub)) return this.integrationRule(idx, sub, stmt, dir, unresolved);
    if (sub === "commit" || sub.startsWith("commit ")) return this.commitRule(stmt, dir, unresolved);
    if (sub === "push" || sub.startsWith("push ")) return this.forcePushRule(sub, stmt, dir, unresolved);
    if (sub.startsWith("checkout -b ") || sub.startsWith("switch -c ")) return this.newBranchRule(stmt, dir, unresolved);
  }
  run() {
    try {
      for (let idx = 0; idx < this.lines.length; idx++) this.judge(idx);
    } catch (e) {
      if (e instanceof Denied) return e.result;
      throw e;
    }
    return ALLOW;
  }
};
function isFile8(path) {
  try {
    return statSync12(path).isFile();
  } catch {
    return false;
  }
}
var gitGuards = async (payload, env) => {
  const command = stripTrailingNewlines(jqAlternatives(payload, [["tool_input", "command"]]).replace(/\0/g, ""));
  if (!needsGitGuard(command)) return ALLOW;
  const cwd = payloadCwd(payload, env);
  const listed2 = await cmdStatements(command, cwd, env);
  if (!listed2.ok) return deny(PARSE_REASON).result;
  const text = stripTrailingNewlines(listed2.statements.map(({ dir, stmt }) => `${dir}	${stmt}`).join("\n"));
  if (text === "") return ALLOW;
  return new GitGuards(command, cwd, dbPath(env) ?? "", env, text.split("\n")).run();
};

// src/hooks/commit-msg-lint.ts
var GATE_NAME7 = "commit-msg-lint";
var TYPES = "feat|fix|improvement|refactor|docs|test|perf|chore|build|ci|style|revert";
var SKIPPED_MODES = [" --amend", " --no-edit", " --fixup", " --squash", " --merge"];
var AWK_FIELD_SEP = /[ \t\n]+/;
var BUILT_MESSAGE = /\$\(|`/;
function parseDeny() {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PARSE_REASON } };
  return `${jqCompact(decision)}
`;
}
function splitSubject(line, env) {
  if (line === "") return { prefix: "", rest: "" };
  const fields = line.split(AWK_FIELD_SEP).filter((f) => f !== "");
  const rebuilt = ["", ...fields.slice(1)].join(" ");
  const rest = rebuilt.replace(new RegExp(`^[${awkSpace(env)}]+`, "u"), "");
  return { prefix: fields[0] ?? "", rest };
}
function prefixOk(prefix) {
  return /^:[a-z0-9_+-]+:$/.test(prefix) || /[^\t\n\v\f\r\x20-\x7e]/.test(prefix);
}
function restOk(rest, multibyte) {
  return new RegExp(`^(${TYPES})(\\([a-z0-9._/-]+\\))?:[${grepSpace(multibyte)}].+`, "su").test(rest);
}
function charCount(s, env) {
  return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s, "utf8");
}
var commitMsgLint = async (payload, env) => {
  if ((env.TMB_SKIP_COMMIT_MSG_LINT ?? "0") === "1") return ALLOW;
  if (jqRawOr(payload, [jqPath("tool_name")]) !== "Bash") return ALLOW;
  const command = jqRawOr(payload, [jqPath("tool_input", "command")]);
  if (!command.includes("commit")) return ALLOW;
  const commit = await gitCommitMessage(command, env);
  if (!commit.ok) return BUILT_MESSAGE.test(command) ? ALLOW : { stdout: parseDeny(), code: 0 };
  if (commit.subcommand === "") return ALLOW;
  const padded = ` ${commit.subcommand} `;
  if (SKIPPED_MODES.some((mode) => padded.includes(mode))) return ALLOW;
  if (commit.message === "") return ALLOW;
  const firstLine3 = commit.message.split("\n")[0];
  const { prefix, rest } = splitSubject(firstLine3, env);
  let violation = "";
  if (!prefixOk(prefix) || !restOk(rest, grepMultibyte(env))) {
    violation = `commit subject does not match '<emoji> <type>(<scope>): <description>' (allowed types: ${TYPES})`;
  } else {
    const length = charCount(firstLine3, env);
    if (length > 72) violation = `commit subject is ${length} chars (>72)`;
  }
  if (violation === "") return ALLOW;
  const ctx = `commit-msg-lint: ${violation}. Subject seen: "${firstLine3}". Set TMB_SKIP_COMMIT_MSG_LINT=1 to bypass.`;
  return { stdout: preToolContext(ctx), code: 0 };
};

// src/hooks/containment-guard.ts
import { lstatSync as lstatSync4, statSync as statSync13 } from "node:fs";
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
  return capture(pathCanonical2(path));
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
    target = statSync13(dir);
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
var Denied2 = class {
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
      reason = `BLOCKED: containment \u2014 ${path} is outside this run's root ${this.root}. TMB agents write only under their root (the task worktree for swe, the project for bro); put scratch files in ${stripSlash(this.root)}/${TMB_STATE_HOST_DIR}/${pluginName2(this.env)}/scratch/ (or /tmp/claude-${this.uid}).`;
    }
    const decision = jqCompact({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    });
    throw new Denied2({ stdout: `${written.stdout}${decision}
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
    const cut4 = raw.search(/[$`]/);
    const lit = cut4 < 0 ? raw : raw.slice(0, cut4);
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
      const at2 = acc || "/";
      if (under2(at2, stripSlash(this.root)) || under2(at2, stripSlash(this.rootC))) {
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
async function judgeBash(g, input, analyze2) {
  const command = jqField2(input, ["tool_input", "command"]);
  const writes = command === "" ? [] : await analyze2(command, { cwd: g.cwd, raw: true, root: g.root, env: g.runEnv });
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
async function guard(input, env, analyze2) {
  const g = new Guard(env);
  g.toolName = jqField2(input, ["tool_name"]);
  if (!JUDGED_TOOLS.has(g.toolName)) return;
  const state = dbState(env);
  if (state === "unresolved") return;
  if (state === "error") throw new Denied2({ stdout: `${denyDbUnavailable(HOOK, env)}
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
      throw new Denied2({ stdout: `${denyDbUnavailable(HOOK, env)}
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
  const tmpdir2 = runTmpdir(input, g);
  if (tmpdir2 !== (env.TMPDIR ?? "")) g.runEnv = { ...env, TMPDIR: tmpdir2 };
  if (/^\/./s.test(tmpdir2)) g.hostTmpC = canonical(tmpdir2);
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
  await judgeBash(g, input, analyze2);
}
function containmentGuardWith(analyze2) {
  return async (payload, env) => {
    try {
      await guard(payload, { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: RUN_BUDGET_MS }, analyze2);
      return ALLOW;
    } catch (e) {
      if (e instanceof Denied2) return e.result;
      throw e;
    }
  };
}
var containmentGuard = containmentGuardWith(writePaths);

// src/hooks/deferred-tools-drift-warn.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { lstatSync as lstatSync5, readdirSync as readdirSync2, statSync as statSync14 } from "node:fs";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var GATE_NAME8 = "deferred-tools-drift-warn";
var ANCESTRY_GUARD = 40;
var SERVER_PATTERN = "trajectory-server/dist/index.js";
var INT64_MAX = 2n ** 63n - 1n;
var INT64_MIN = -(2n ** 63n);
var ArithError = class extends Error {
};
function run3(cmd, args2, env) {
  const r = spawnSync5(cmd, args2, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.stdout ?? "";
}
function testInt(text) {
  const m = /^[ \t\n]*([-+]?[0-9]+)[ \t\n]*$/.exec(text);
  if (m === null) return null;
  const v = BigInt(m[1]);
  return v > INT64_MAX || v < INT64_MIN ? null : v;
}
function walkable(pid) {
  const v = testInt(pid);
  return pid !== "" && v !== null && v > 1n;
}
function isCcCommand(cmd) {
  return /^(?:claude|claude .*|.*\/claude|.*\/claude .*)$/s.test(cmd);
}
function procPpid(pid, env) {
  return stripTrailingNewlines(run3("ps", ["-o", "ppid=", "-p", pid], env).replaceAll(" ", ""));
}
function procCmd(pid, env) {
  return stripTrailingNewlines(run3("ps", ["-o", "command=", "-p", pid], env));
}
function nearestCcAncestor(start2, env) {
  let pid = start2;
  let guard2 = 0;
  while (walkable(pid)) {
    guard2 += 1;
    if (guard2 > ANCESTRY_GUARD) break;
    if (isCcCommand(procCmd(pid, env))) return pid;
    pid = procPpid(pid, env);
  }
  return "";
}
function chainContains(start2, target, env) {
  if (target === "") return false;
  let pid = start2;
  let guard2 = 0;
  while (walkable(pid)) {
    guard2 += 1;
    if (guard2 > ANCESTRY_GUARD) break;
    if (pid === target) return true;
    pid = procPpid(pid, env);
  }
  return false;
}
function resolveOwnServer(env) {
  const ownCc = nearestCcAncestor(env.TMB_DRIFT_SELF_PID || String(process.pid), env);
  if (ownCc === "") return "";
  for (const line of run3("pgrep", ["-f", SERVER_PATTERN], env).split("\n")) {
    const pid = line.trim();
    if (pid === "" || pid === ownCc) continue;
    if (chainContains(pid, ownCc, env)) return pid;
  }
  return "";
}
function base10(part) {
  if (!/^[0-9]+$/.test(part)) throw new ArithError(part);
  return BigInt(part);
}
function arithDigits(text) {
  if (text.length > 1 && text.startsWith("0")) {
    if (!/^[0-7]+$/.test(text)) throw new ArithError(text);
    return BigInt(`0o${text}`);
  }
  return BigInt(text);
}
function etimeSeconds(raw) {
  const dash = raw.indexOf("-");
  const days = dash < 0 ? "0" : raw.slice(0, dash);
  const rest = dash < 0 ? raw : raw.slice(dash + 1);
  const head = (s) => s.includes(":") ? s.slice(0, s.indexOf(":")) : s;
  const tail = (s) => s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
  if ((rest.match(/:/g) ?? []).length === 2) {
    const rest2 = tail(rest);
    return base10(days) * 86400n + base10(head(rest)) * 3600n + base10(head(rest2)) * 60n + base10(tail(rest2));
  }
  return base10(days) * 86400n + base10(head(rest)) * 60n + base10(tail(rest));
}
function serverStart(pid, env) {
  const now = BigInt(Math.floor(Date.now() / 1e3));
  const etimes = run3("ps", ["-o", "etimes=", "-p", pid], env).replaceAll(" ", "").replace(/\n+$/, "");
  let start2;
  if (etimes !== "" && /^[0-9]+$/.test(etimes)) {
    start2 = now - arithDigits(etimes);
  } else {
    const raw = run3("ps", ["-o", "etime=", "-p", pid], env).replaceAll(" ", "").replace(/\n+$/, "");
    if (raw === "") return null;
    const elapsed = etimeSeconds(raw);
    if (elapsed < 0n) return null;
    start2 = now - elapsed;
  }
  return start2 > 0n ? start2 : null;
}
function epochOperand(text) {
  const m = /^[ \t\n\v\f\r]*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (m === null) return null;
  const digits = m[2];
  const v = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits.startsWith("0") ? BigInt(`0o${digits}`) : BigInt(digits);
  return m[1] === "-" ? -v : v;
}
function referenceNs(start2) {
  const year = new Date(Number(start2) * 1e3).getFullYear();
  if (!Number.isFinite(year) || year < 1970 || year > 9999) return null;
  return start2 * 1000000000n;
}
function newerJs(dir, refNs) {
  let count = 0;
  const visit = (path, name3) => {
    let st;
    try {
      st = lstatSync5(path, { bigint: true });
    } catch {
      return;
    }
    if (name3.endsWith(".js") && st.mtimeNs > refNs) count += 1;
    if (!st.isDirectory()) return;
    let names;
    try {
      names = readdirSync2(path);
    } catch {
      return;
    }
    for (const child of names) visit(`${path}/${child}`, child);
  };
  visit(dir, dir.replace(/\/+$/, "").slice(dir.replace(/\/+$/, "").lastIndexOf("/") + 1) || dir);
  return count;
}
function isDir3(path) {
  try {
    return statSync14(path).isDirectory();
  } catch {
    return false;
  }
}
function pluginRoot() {
  return installRoot(posixDirname(fileURLToPath3(import.meta.url))) ?? "";
}
function driftContext(count, pid) {
  return `[tmb deferred-tools drift] ${count} MCP tool source file(s) on disk are newer than the running trajectory-server child (PID ${pid}). CC's deferred-tools registry is session-scoped and only a new session replays tool discovery. Workaround (Tier 2): fully quit and relaunch Claude Code to bind the new tools. See #98.`;
}
var deferredToolsDriftWarn = (_payload, env) => {
  let pid = env.TMB_MCP_PID_OVERRIDE ?? "";
  if (pid === "") {
    if (!commandOnPath("pgrep", env)) return ALLOW;
    pid = resolveOwnServer(env);
    if (pid === "") return ALLOW;
  }
  const toolDir = env.TMB_TOOL_DIR_OVERRIDE || `${pluginRoot()}/mcp/trajectory-server/dist/tools`;
  if (!isDir3(toolDir)) return ALLOW;
  let start2;
  const override = env.TMB_MCP_START_OVERRIDE ?? "";
  if (override !== "") {
    start2 = epochOperand(override);
  } else {
    try {
      start2 = serverStart(pid, env);
    } catch (e) {
      if (e instanceof ArithError) return ALLOW;
      throw e;
    }
  }
  if (start2 === null) return ALLOW;
  const ref = referenceNs(start2);
  if (ref === null) return ALLOW;
  const count = newerJs(toolDir, ref);
  if (count === 0) return ALLOW;
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: driftContext(count, pid) } })}
`,
    code: 0
  };
};

// src/hooks/ensure-gitignore.ts
import { appendFileSync, readFileSync as readFileSync8, statSync as statSync15, writeFileSync as writeFileSync2 } from "node:fs";
var GATE_NAME9 = "ensure-gitignore";
var RULE = "# TMB plugin runtime state \u2014 never commit\n.claude/\n";
var IGNORED = /^\.claude(\/\*?)?$/;
function isFile9(path) {
  try {
    return statSync15(path).isFile();
  } catch {
    return false;
  }
}
function listsClaudeDir(text) {
  return text.split("\n").some((line) => IGNORED.test(line));
}
function alreadyIgnored(gitignore) {
  if (!isFile9(gitignore)) return false;
  try {
    return listsClaudeDir(readFileSync8(gitignore, "latin1"));
  } catch {
    return false;
  }
}
function ensureIgnored(root) {
  const gitignore = `${root}/.gitignore`;
  if (alreadyIgnored(gitignore)) return;
  try {
    if (isFile9(gitignore)) appendFileSync(gitignore, `
${RULE}`);
    else writeFileSync2(gitignore, RULE);
  } catch {
  }
  process.stderr.write(`tmb: ensured .claude/ is in ${gitignore}
`);
}
function candidateDirs(env) {
  const project = projectRoot(env);
  if (project === "") return [];
  const dirs = [project];
  const db = dbPath(env) ?? "";
  if (db !== "" && isFile9(db) && haveSqlite(env)) {
    for (const p of sqliteRo(db, "SELECT path FROM repos WHERE path IS NOT NULL AND path <> '';", env).split("\n")) {
      if (p !== "") dirs.push(repoPathAbs(db, p));
    }
  }
  return dirs;
}
var ensureGitignore = (_payload, env) => {
  const seen = /* @__PURE__ */ new Set();
  for (const d of candidateDirs(env)) {
    if (!isDir(d)) continue;
    const r = gitRun(d, ["rev-parse", "--show-toplevel"], env);
    if (r.code !== 0) continue;
    const root = r.stdout.replace(/\n+$/, "");
    if (root === "" || seen.has(root)) continue;
    seen.add(root);
    ensureIgnored(root);
  }
  return ALLOW;
};

// src/hooks/git-push-guard.ts
var GATE_NAME10 = "git-push-guard";
var SOURCE_PATHS = [":(top)", ":(top,exclude,glob)mcp/*/dist/**", ":(top,exclude)dashboard/dist"];
var FORCE = / --force | -f | --force-with-lease | --force-with-lease=/;
var HEX = /^[0-9a-f]+$/;
var SWE_REASON = "BLOCKED: SWE must never push. Bro handles the push gate after code-reviewer passes. Commit in your worktree and call task_update_status(completed).";
var CODE_REVIEWER_REASON = `BLOCKED: ${CODE_REVIEWER_ROLE} must not push. The push decision belongs to bro after the verdict row. Bro reads the validation_attempts verdict and handles the push when all tasks are signed.`;
var WORKTREE_REASON = "BLOCKED: push from .claude/worktrees/ is forbidden. Bro pushes from the main checkout after reaped the detached-HEAD commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`.";
var DB_REASON = "BLOCKED: trajectory DB unavailable \u2014 the push gate could not read task review state (sqlite3 error), so it refuses to fail open. Check the trajectory DB and retry the push.";
var PARSE_REASON2 = "BLOCKED: the push gate could not parse this command, so it cannot tell which statements push or from which checkout. Split it into simpler commands or fix its quoting, then retry the push.";
function deny2(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}
function lines(text) {
  return text.split("\n");
}
function field2(line, n3) {
  return line.split("|")[n3 - 1] ?? "";
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
  pairByPaths(dir, taskRows2, shas, spec) {
    const bySet = /* @__PURE__ */ new Map();
    const taskInput = `${lines(taskRows2).map((r) => field2(r, 1)).join("\n")}
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
  taskMatches(dir, taskRows2, pairs, spec) {
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
    for (const row of lines(taskRows2)) {
      const bar = row.indexOf("|");
      task.set(bar < 0 ? "" : row.slice(0, bar), bar < 0 ? row : row.slice(bar));
    }
    const seen = /* @__PURE__ */ new Set();
    const out2 = [];
    for (const row of lines(pairs)) {
      const words2 = row.trim().split(/\s+/).filter((w) => w !== "");
      const sha = words2[0] ?? "";
      if (!pid.has(sha) || seen.has(sha)) continue;
      seen.add(sha);
      let m = "";
      for (const cand of words2.slice(1)) {
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
    const n3 = Math.max(checked.length, taskLines.length);
    for (let i2 = 0; i2 < n3; i2++) {
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
    let base2 = existing(target);
    if (base2 === "") {
      const fallback = remoteDefault();
      if (fallback !== "") base2 = existing(fallback);
    }
    return base2;
  }
  pushedShas(dir) {
    const upstream = gitOut(dir, ["log", "@{u}..HEAD", "--pretty=%H"], this.env);
    if (upstream !== "") return upstream;
    const base2 = this.baseRef(dir);
    return gitOut(dir, ["log", base2 === "" ? "HEAD" : `${base2}..HEAD`, "--pretty=%H"], this.env);
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
    if (unsigned === GATE_READ_ERROR) return deny2(DB_REASON);
    if (unsigned !== "") {
      const rows2 = lines(unsigned);
      const list2 = rows2.map((r) => `  - task_id=${field2(r, 1)}  ${field2(r, 2)}  (${field2(r, 3)})`).join("\n");
      return deny2(
        `BLOCKED: pushing ${rows2.length} unsigned commit(s). The following tasks lack a code-reviewer pass verdict:

${list2}
Run: @bro review before push

bro will spawn code-reviewer for each unsigned task. On all-pass the push will proceed. On any fail bro surfaces what needs fixing.`
      );
    }
    const unchecked = this.uncheckedRebases(dir, pushed);
    if (unchecked === GATE_READ_ERROR) return deny2(DB_REASON);
    if (unchecked === "") return null;
    const rows = lines(unchecked);
    const list = rows.map((r) => {
      const why = field2(r, 4) === "1" ? "no passing verification run for this commit" : "the task has no passing review";
      const kind = field2(r, 5) === "src" ? "rebase with regenerated dist" : "rebase";
      return `  - ${field2(r, 1)}  ${kind} of task_id=${field2(r, 2)}  ${field2(r, 3)}  (${why})`;
    }).join("\n");
    return deny2(
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
  if (!listed2.ok) return deny2(PARSE_REASON2);
  const pushes = listed2.statements.filter(({ stmt }) => {
    const sub = gitSubcommand(stmt);
    return (sub === "push" || sub.startsWith("push ")) && !FORCE.test(` ${sub} `);
  });
  if (pushes.length === 0) return ALLOW;
  const role = agentRole(payload);
  if (role === "swe") return deny2(SWE_REASON);
  if (role === CODE_REVIEWER_ROLE) return deny2(CODE_REVIEWER_REASON);
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`)) ?? "";
  const guard2 = new Guard2(db, cwd, env);
  for (const { dir, stmt } of pushes) {
    if (dir === "?") return { stdout: denyAmbiguousGitTarget(stmt), code: 0 };
    if (dir === "-") return { stdout: denyAmbiguousGitTarget(stmt, true), code: 0 };
    if (dir.includes("/.claude/worktrees/")) return deny2(WORKTREE_REASON);
    if (db === "" || !haveSqlite(env)) continue;
    const verdict = guard2.judge(dir);
    if (verdict) return verdict;
  }
  return ALLOW;
};

// src/hooks/mcp-health-check.ts
import { spawnSync as spawnSync6 } from "node:child_process";
import { appendFileSync as appendFileSync2, existsSync as existsSync8, mkdirSync as mkdirSync2, readdirSync as readdirSync3, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync17, writeFileSync as writeFileSync3 } from "node:fs";

// src/hooks/lib/install.ts
import { readFileSync as readFileSync9, statSync as statSync16 } from "node:fs";
var DEFAULT_NAME = "tmb";
var JqError5 = class extends Error {
};
function installPluginName(env = process.env) {
  return stripTrailingNewlines(pluginName2(env)) || DEFAULT_NAME;
}
function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || `${homeDir(env)}/.claude`;
}
function installedJson(env = process.env) {
  return env.TMB_INSTALLED_JSON || `${configDir(env)}/plugins/installed_plugins.json`;
}
function canonicalDir(dir) {
  return realdir(dir);
}
function isDir4(path) {
  try {
    return statSync16(path).isDirectory();
  } catch {
    return false;
  }
}
function readText(path) {
  try {
    return readFileSync9(path, "utf8");
  } catch {
    return null;
  }
}
function index4(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError5(`Cannot index with ${key2}`);
  const v = value[key2];
  return v === void 0 ? null : v;
}
function field3(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}
function tsvEscape(text) {
  return text.replace(/[\\\t\n\r]/g, (c) => ({ "\\": "\\\\", "	": "\\t", "\n": "\\n", "\r": "\\r" })[c] ?? c);
}
function* pluginEntries(doc, prefix) {
  let plugins = index4(doc, "plugins");
  if (plugins === null || plugins === false) plugins = {};
  if (Array.isArray(plugins)) {
    if (plugins.length > 0) throw new JqError5("startswith on a number");
    return;
  }
  if (typeof plugins !== "object") throw new JqError5("has no keys");
  for (const [key2, value] of Object.entries(plugins)) {
    if (key2.startsWith(prefix)) yield [key2, value];
  }
}
function elements(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value);
  return [];
}
function jqRows(path, rows) {
  const text = readText(path);
  if (text === null) return [];
  const out2 = [];
  for (const doc of jsonStream(text).values) {
    try {
      rows(doc, (row) => out2.push(row));
    } catch (e) {
      if (!(e instanceof JqError5)) throw e;
    }
  }
  return out2;
}
function installCandidates(env = process.env) {
  const json = installedJson(env);
  try {
    if (!statSync16(json).isFile()) return [];
  } catch {
    return [];
  }
  const prefix = `${installPluginName(env)}@`;
  const raw = jqRows(json, (doc, push) => {
    for (const [, value] of pluginEntries(doc, prefix)) {
      for (const e of elements(value)) {
        push([
          field3(index4(e, "scope"), "user"),
          field3(index4(e, "projectPath"), "-"),
          field3(index4(e, "installPath"), "-"),
          field3(index4(e, "installedAt"), "-"),
          field3(index4(e, "version"), "-")
        ].map(tsvEscape));
      }
    }
  });
  const out2 = [];
  for (const [scope, project, install, at2, version] of raw) {
    if (install === "-" || !isDir4(install)) continue;
    out2.push({ scope, project: project === "-" ? project : canonicalDir(project), install, at: at2, version });
  }
  return out2;
}
function rowLine(r) {
  return [r.scope, r.project, r.install, r.at, r.version].join("	");
}
function newestFirst(rows) {
  return [...rows].sort((a, b) => byteCompare(b.at, a.at) || byteCompare(rowLine(a), rowLine(b)));
}
function projectInstalls(env = process.env) {
  const project = env.CLAUDE_PROJECT_DIR ?? "";
  if (project === "") return [];
  const here = canonicalDir(project);
  return newestFirst(installCandidates(env).filter((r) => (r.scope === "project" || r.scope === "local") && r.project === here));
}
function userInstalls(env = process.env) {
  return newestFirst(installCandidates(env).filter((r) => r.scope === "user"));
}
function installVersion(row) {
  return row.version !== "" && row.version !== "-" ? row.version : posixBasename(row.install);
}
function isObject3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function enabledPlugins(here, env) {
  const merged = {};
  for (const file of [`${configDir(env)}/settings.json`, `${here}/.claude/settings.json`, `${here}/.claude/settings.local.json`]) {
    for (const part of jqRows(file, (doc, push) => {
      let v = index4(doc, "enabledPlugins");
      if (v === null || v === false) v = {};
      push(isObject3(v) ? v : {});
    })) {
      for (const [k, v] of Object.entries(part)) {
        delete merged[k];
        merged[k] = v;
      }
    }
  }
  return merged;
}
function duplicateInstalls(project, env = process.env) {
  if (project === "") return [];
  const name3 = installPluginName(env);
  const here = canonicalDir(project);
  const on = enabledPlugins(here, env);
  const prefix = `${name3}@`;
  const raw = jqRows(installedJson(env), (doc, push) => {
    for (const [key2, value] of pluginEntries(doc, prefix)) {
      if (on[key2] !== true) continue;
      for (const e of elements(value)) {
        push([
          key2,
          field3(index4(e, "scope"), "user"),
          field3(index4(e, "projectPath"), "-"),
          field3(index4(e, "installPath"), "-"),
          field3(index4(e, "version"), "-")
        ].map(tsvEscape));
      }
    }
  });
  const ranked = [];
  for (const [key2, scope, proj, install, version] of raw) {
    let rank = 1;
    if (scope === "project" || scope === "local") {
      if (proj === "-" || canonicalDir(proj) !== here) continue;
      rank = 0;
    }
    const at2 = key2.indexOf("@");
    const mkt = at2 < 0 ? key2 : key2.slice(at2 + 1);
    ranked.push({
      line: [mkt, String(rank), version, install, scope].join("	"),
      mkt,
      rank,
      row: { marketplace: mkt, version, install, scope }
    });
  }
  ranked.sort((a, b) => byteCompare(a.mkt, b.mkt) || a.rank - b.rank || byteCompare(a.line, b.line));
  const seen = /* @__PURE__ */ new Set();
  const rows = ranked.filter((r) => !seen.has(r.mkt) && seen.add(r.mkt)).map((r) => r.row);
  return rows.length > 1 ? rows : [];
}
function duplicateNames(rows) {
  return rows.map((r) => `${r.marketplace}@${r.version}`).join(", ");
}
function duplicateDisableCmds(rows, env = process.env) {
  const name3 = installPluginName(env);
  return rows.map((r) => `claude plugin disable ${name3}@${r.marketplace} --scope ${r.scope}`).join("; ");
}
function userSettingsJson(env = process.env) {
  return `${configDir(env)}/settings.json`;
}
var LEGACY_USER_HOOKS_DOC = "docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks";
var HOOK_NAME = /--hook[ \t]+([A-Za-z0-9._-]+)/;
function leftover(hook) {
  return hook._tmb_managed === true || typeof hook.command === "string" && hook.command.includes("resolve-hook.sh");
}
function hookName(command) {
  if (typeof command !== "string") return "?";
  const text = command.includes("resolve-hook.sh") ? command.split("resolve-hook.sh")[1] ?? "" : command;
  return HOOK_NAME.exec(text)?.[1] ?? "?";
}
function leftoverPaths(doc) {
  let hooks = index4(doc, "hooks");
  if (hooks === null || hooks === false) hooks = {};
  if (!isObject3(hooks)) return [];
  const out2 = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, i2) => {
      if (!isObject3(group)) return;
      const inner4 = group.hooks;
      if (!Array.isArray(inner4)) return;
      inner4.forEach((hook, j) => {
        if (isObject3(hook) && leftover(hook)) out2.push(["hooks", ev, i2, "hooks", j]);
      });
    });
  }
  return out2;
}
function commandPaths(value, at2 = [], out2 = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i2) => commandPaths(v, [...at2, i2], out2));
  } else if (isObject3(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "command") out2.push([...at2, k]);
      commandPaths(v, [...at2, k], out2);
    }
  }
  return out2;
}
function getPath2(value, path) {
  let v = value;
  for (const key2 of path) v = v[key2];
  return v;
}
function versionPart(text) {
  const t = text.trim();
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith("-") ? -Number.MAX_VALUE : Number.MAX_VALUE;
  return /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t) ? Number(t) : -1;
}
function belowV110(version) {
  const parts2 = (version.split("-")[0] ?? "").split(".").map(versionPart);
  const floor = [1, 1, 0];
  for (let i2 = 0; i2 < Math.min(parts2.length, floor.length); i2 += 1) {
    if (parts2[i2] !== floor[i2]) return parts2[i2] < floor[i2];
  }
  return parts2.length < floor.length;
}
function legacyHookRows(settings) {
  let text;
  try {
    text = readFileSync9(settings, "utf8");
  } catch {
    return null;
  }
  const stream = jsonStream(text);
  if (!stream.complete) return null;
  const want = /* @__PURE__ */ new Map();
  let n3 = 0;
  let orphans = 0;
  try {
    for (const doc of stream.values) {
      const left = leftoverPaths(doc);
      if (left.length === 0) continue;
      const keys = new Set(left.map((p) => JSON.stringify(p)));
      for (const path of commandPaths(doc)) {
        n3 += 1;
        const owner = path.slice(0, -1);
        if (keys.has(JSON.stringify(owner))) want.set(n3, hookName(getPath2(doc, owner).command));
      }
      for (const p of left) if (!Object.hasOwn(getPath2(doc, p), "command")) orphans += 1;
    }
  } catch (e) {
    if (e instanceof JqError5) return null;
    throw e;
  }
  if (n3 === 0 && orphans === 0) return [];
  const rows = [];
  let k = 0;
  text.split("\n").forEach((line, i2) => {
    for (const _ of line.matchAll(/"command"[ \t]*:/g)) {
      k += 1;
      const name3 = want.get(k);
      if (name3 !== void 0) rows.push({ line: String(i2 + 1), name: name3 });
    }
  });
  for (let i2 = k + 1; i2 <= n3; i2 += 1) {
    const name3 = want.get(i2);
    if (name3 !== void 0) rows.push({ line: "?", name: name3 });
  }
  for (let i2 = 0; i2 < orphans; i2 += 1) rows.push({ line: "?", name: "?" });
  return rows;
}
function legacyUserHooks(project, env = process.env) {
  const none = { hooks: [], projects: [] };
  const hooks = legacyHookRows(userSettingsJson(env));
  if (hooks === null || hooks.length === 0) return none;
  const here = project === "" ? "" : canonicalDir(project);
  const prefix = `${installPluginName(env)}@`;
  const raw = jqRows(installedJson(env), (doc, push) => {
    for (const [, value] of pluginEntries(doc, prefix)) {
      for (const e of elements(value)) {
        const p = index4(e, "projectPath");
        const v = index4(e, "version");
        if (typeof p !== "string" || p === "" || typeof v !== "string") continue;
        if (belowV110(v)) push([tsvEscape(p), tsvEscape(v)]);
      }
    }
  });
  const projects = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [p, v] of raw) {
    if (!isDir4(p)) continue;
    const path = canonicalDir(p);
    if (path === here || seen.has(path)) continue;
    seen.add(path);
    projects.push({ path, version: v });
  }
  return { hooks, projects };
}
function legacyHookEntries(hooks) {
  return hooks.map((h) => `line ${h.line} ${h.name}`).join(", ");
}
function legacyHookProjects(projects) {
  return projects.map((p) => `${p.path} (${p.version})`).join(", ");
}
function activeInstall(env = process.env, onStderr = () => {
}) {
  const self2 = env.CLAUDE_PLUGIN_ROOT ?? "";
  if (self2 !== "" && !/\/plugins\/cache\//.test(self2) && !installCandidates(env).some((r) => r.install === self2)) return self2;
  const projects = projectInstalls(env);
  if (projects.length > 0) {
    if (projects.length > 1) {
      onStderr(`TMB: two project installs for ${env.CLAUDE_PROJECT_DIR ?? ""} \u2014 using ${projects[0].install} (newest), ignoring ${projects[1].install}
`);
    }
    return projects[0].install;
  }
  return userInstalls(env)[0]?.install ?? self2;
}

// src/hooks/mcp-health-check.ts
var GATE_NAME11 = "mcp-health-check";
var DEFAULT_SAMPLES = 3;
var LOG_ROTATE_BYTES = 1048576;
var NOTICE_MAX_AGE_MIN = 1440;
var MAX_TEST_INT = 2n ** 63n - 1n;
var NOT_DETECTED = "trajectory-server not detected yet at SessionStart; if a trajectory tool returns is_error, load tmb_recovery \xA7B";
function eventName(input) {
  const out2 = [];
  for (const value of jsonValues(input)) {
    if (value === null) out2.push("unknown");
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value;
    const hit = [v.hook_event_name, v.hookEventName, v.event].find((x) => x !== void 0 && x !== null && x !== false);
    out2.push(hit === void 0 ? "unknown" : jqRawText(hit));
  }
  return stripTrailingNewlines(out2.join("\n")) || "unknown";
}
function sampleCount(raw) {
  const v = raw === void 0 ? String(DEFAULT_SAMPLES) : raw;
  if (!/^[0-9]+$/.test(v)) return DEFAULT_SAMPLES;
  if (BigInt(v) > MAX_TEST_INT) return 0;
  return Number(v);
}
function pgrepLines(pattern, env) {
  const r = spawnSync6("pgrep", ["-f", pattern], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return (r.stdout ?? "").split("\n").length - 1;
}
function samplePgrep(env) {
  if (!commandOnPath("pgrep", env)) return { count: -1, taken: 0 };
  const samples = sampleCount(env.TMB_MCP_HEALTH_SAMPLES);
  const interval = env.TMB_MCP_HEALTH_INTERVAL_S ?? "1.2";
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  const pattern = root !== "" ? `${root}/mcp/trajectory-server/dist/index.js` : "trajectory-server/dist/index.js";
  let count = 0;
  let taken = 0;
  while (taken < samples) {
    if (taken > 0) sleepSeconds(interval);
    taken += 1;
    count = pgrepLines(pattern, env);
    if (count > 0) break;
  }
  return { count, taken };
}
function noticeMarker(sessionId, env) {
  if (sessionId === "" || sessionId.includes("/") || sessionId.startsWith(".")) return "";
  const dir = stateDir(env);
  return dir === null ? "" : `${dir}/sessions/${sessionId}.install-notice`;
}
function pruneNotices(dir, now) {
  let names;
  try {
    names = readdirSync3(dir);
  } catch {
    return;
  }
  for (const name3 of names) {
    if (!name3.endsWith(".install-notice")) continue;
    const path = `${dir}/${name3}`;
    try {
      const st = statSync17(path);
      if (!st.isFile()) continue;
      if (Math.ceil((now - st.mtimeMs) / 6e4) > NOTICE_MAX_AGE_MIN) rmSync2(path, { force: true });
    } catch {
    }
  }
}
function installNotice(event, sessionId, env) {
  const user = userInstalls(env)[0];
  if (user === void 0) return "";
  const project = projectInstalls(env)[0];
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  let notice2 = project !== void 0 ? `TMB: user-scope TMB v${installVersion(user)} ignored \u2014 project install v${installVersion(project)} in use.` : `TMB installed at user scope; \`--scope project\` is recommended (see ${root !== "" ? `${root}/` : ""}docs/reference/INSTALL.md).`;
  const marker = noticeMarker(sessionId, env);
  if (marker !== "" && existsSync8(marker)) {
    notice2 = "";
  } else if (marker !== "" && event === "SessionStart") {
    const dir = posixDirname(marker);
    try {
      mkdirSync2(dir, { recursive: true });
      pruneNotices(dir, Date.now());
      writeFileSync3(marker, "");
    } catch {
    }
  }
  return notice2;
}
function duplicateWarning(env) {
  const rows = duplicateInstalls(env.CLAUDE_PROJECT_DIR ?? "", env);
  if (rows.length === 0) return "";
  return `TMB WARNING: ${rows.length} copies of the ${installPluginName(env)} plugin are enabled for this project (${duplicateNames(rows)}). Claude Code registers the hooks of only one of them (which one is not documented) and skips the other's with a plugin load error, so TMB's gates may be missing while its MCP tools still work. Remedy: keep one copy and disable the others from the project root, one of: ${duplicateDisableCmds(rows, env)}; then fully quit and relaunch Claude Code.`;
}
function utcStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function appendLog(event, sessionId, sample, env) {
  const dir = stateDir(env);
  if (dir === null) return;
  const logs = `${dir}/logs`;
  try {
    mkdirSync2(logs, { recursive: true });
  } catch {
    return;
  }
  const log = `${logs}/mcp-health.log`;
  try {
    const st = statSync17(log);
    if (st.isFile() && st.size > LOG_ROTATE_BYTES) renameSync2(log, `${log}.1`);
  } catch {
  }
  const line = jqCompact({
    ts: utcStamp(/* @__PURE__ */ new Date()),
    event,
    mcp_alive: sample.count > 0 ? true : sample.count === 0 ? false : null,
    pgrep_count: sample.count,
    samples: sample.taken,
    session_id: sessionId,
    db_path: dbPath(env) ?? ""
  });
  try {
    appendFileSync2(log, `${line}
`);
  } catch {
  }
}
var mcpHealthCheck = (payload, env) => {
  const input = commandSubstitution2(payload);
  const event = eventName(input);
  const sessionId = stripTrailingNewlines(jqAlternatives(input, [["session_id"], ["sessionId"]]));
  const sample = samplePgrep(env);
  let context4 = sample.count === 0 ? NOT_DETECTED : "";
  for (const part of [installNotice(event, sessionId, env), duplicateWarning(env)]) {
    if (part !== "") context4 = context4 !== "" ? `${context4}

${part}` : part;
  }
  appendLog(event, sessionId, sample, env);
  if (context4 === "" || event !== "SessionStart") return ALLOW;
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context4 } })}
`,
    code: 0
  };
};

// src/hooks/code-reviewer-preflight.ts
import { spawnSync as spawnSync8 } from "node:child_process";

// src/utils/git-refs.ts
import { execFileSync, spawnSync as spawnSync7 } from "node:child_process";

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
function normalizeBase(repoPath, base2) {
  if (!base2.startsWith("origin/") || refResolves(repoPath, `refs/heads/${base2}`)) return base2;
  return base2.slice("origin/".length);
}
function resolveBaseRef(repoPath, rawBase) {
  const base2 = normalizeBase(repoPath, rawBase);
  if (refResolves(repoPath, `origin/${base2}`)) return `origin/${base2}`;
  if (refResolves(repoPath, `refs/heads/${base2}`)) return base2;
  return null;
}
function gitOut2(repoPath, args2) {
  const res = spawnSync7("git", ["-C", repoPath, ...args2], {
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
var GATE_NAME12 = "code-reviewer-preflight";
var BYPASS_ENV = "TMB_SKIP_CODE_REVIEWER_PREFLIGHT";
var GIT_TIMEOUT_MS = 1e4;
var GIT_MAX_BUFFER2 = 256 * 1024 * 1024;
var MAX_LISTED = 10;
var DOC_PATH = /^(?:(?:agents|skills|docs)\/.*\.md|CLAUDE\.md|README\.md)$/;
var TOOL_SOURCE = /^mcp\/[^/]+\/src\/tools\/(?:[^/]+\/)*[^/]+\.ts$/;
var TOOL_NAME = /^\s*name:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]\s*,?\s*$/gm;
var CHANGELOG_DIR = "changelog.d";
var REGEN_DRIVER = "tmb-regen";
function git(repo, args2, env) {
  const r = spawnSync8("git", ["-C", repo, ...args2], {
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
function deny3(failure2) {
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
  return { stdout: `${denyDbUnavailable(GATE_NAME12, env)}
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
  const r = spawnSync8("git", ["-C", repo, "cat-file", "--batch"], {
    input: `${oids.join("\n")}
`,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER2
  });
  if (r.error || r.status !== 0) return null;
  const out2 = r.stdout;
  let at2 = 0;
  while (at2 < out2.length) {
    const eol = out2.indexOf(10, at2);
    if (eol < 0) return null;
    const [oid, type, size] = out2.subarray(at2, eol).toString("utf8").split(" ");
    if (type === void 0 || size === void 0) return null;
    const start2 = eol + 1;
    const end = start2 + Number(size);
    contents.set(oid, out2.subarray(start2, end).toString("utf8"));
    at2 = end + 1;
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
function removedInDiff(repo, base2, commit, env) {
  const diff = git(repo, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", base2, commit], env);
  if (diff.code !== 0) return `git diff ${base2}..${commit} failed: ${diff.stderr.trim()}`;
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
  const before2 = treeBlobs(repo, base2, env);
  const after2 = treeBlobs(repo, commit, env);
  if (!before2 || !after2) return `git ls-tree of ${base2} or ${commit} failed`;
  const sources = (blobs) => [...blobs].filter(([p]) => TOOL_SOURCE.test(p) && !p.includes("/test/")).map(([, oid]) => oid);
  const contents = readBlobs(repo, [.../* @__PURE__ */ new Set([...sources(before2), ...sources(after2)])], env);
  if (!contents) return "git cat-file of the tool sources failed";
  const kept = toolNames(after2, contents);
  return { paths, tools: [...toolNames(before2, contents)].filter((t) => !kept.has(t)).sort() };
}
function staleDocRefs(repo, base2, commit, env) {
  const removed = removedInDiff(repo, base2, commit, env);
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
function nonRegenPaths(repo, rev, paths, env) {
  const r = git(repo, ["check-attr", `--source=${rev}`, "-z", "merge", "--", ...paths], env);
  if (r.code !== 0) return null;
  const fields = nulFields(r.stdout);
  if (fields.length % 3 !== 0) return null;
  const regen = /* @__PURE__ */ new Set();
  for (let i2 = 0; i2 < fields.length; i2 += 3) {
    if (fields[i2 + 1] === "merge" && fields[i2 + 2] === REGEN_DRIVER) regen.add(fields[i2]);
  }
  return paths.filter((p) => !regen.has(p));
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
    return deny3({ check: "sha_mismatch", expected: recorded || null, actual: `branch tip unresolvable: ${location.missing}` });
  }
  const repo = location.repoRoot;
  const branch = task.branch;
  const tip = revParse(repo, `refs/heads/${branch}`, env);
  const commit = recorded === "" ? null : revParse(repo, recorded, env);
  if (commit === null || tip !== commit) {
    return deny3({
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
    return deny3({
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
    return deny3({
      check: "base_conflict",
      expected: `${commit} merges cleanly into the PR target`,
      actual: `no PR target ref resolves in ${repo}`
    });
  }
  const merge = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", targetTip, commit], env);
  if (merge.code !== 0) {
    const conflicted = [...new Set(nulFields(merge.stdout).slice(1).filter((p) => p !== ""))];
    const blocking = merge.code === 1 && conflicted.length > 0 ? nonRegenPaths(repo, commit, conflicted, env) : null;
    if (blocking === null || blocking.length > 0) {
      return deny3({
        check: "base_conflict",
        expected: `${commit} merges cleanly into ${targetRef} (${targetTip})`,
        actual: merge.code !== 1 || conflicted.length === 0 ? `git merge-tree exited ${merge.code}: ${merge.stderr.trim()}` : blocking === null ? `conflicts in ${listed(conflicted)}; git check-attr of their merge attribute failed` : `conflicts in ${listed(blocking)}`
      });
    }
  }
  const mergeBase = git(repo, ["merge-base", targetTip, commit], env).stdout.trim();
  if (mergeBase === "") {
    return deny3({
      check: "base_conflict",
      expected: `${commit} shares history with ${targetRef} (${targetTip})`,
      actual: "no merge-base"
    });
  }
  const stale = staleDocRefs(repo, mergeBase, commit, env);
  if (typeof stale === "string" || stale.length > 0) {
    return deny3({
      check: "stale_doc_ref",
      expected: `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${commit} mentions a path or MCP tool that ${mergeBase}..${commit} removes`,
      actual: typeof stale === "string" ? stale : listed(stale)
    });
  }
  if (hasChangelogDir(repo, commit, env) || hasChangelogDir(repo, mergeBase, env)) {
    const added = git(repo, ["diff", "--no-ext-diff", "--name-only", "--no-renames", "--diff-filter=A", mergeBase, commit, "--", `${CHANGELOG_DIR}/`], env);
    if (added.code !== 0 || added.stdout.trim() === "") {
      return deny3({
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
var GATE_NAME13 = "code-reviewer-spawn-note";
var BYPASS_ENV2 = "TMB_SKIP_CODE_REVIEWER_SPAWN_NOTE";
var ANCHORS = ["task_id", "commit_sha", "branch_id", "repo", "repo_path", "attempt_n", "subagent_session_id"];
var ANCHOR_RE = new RegExp(`\\b(?:${ANCHORS.join("|")})\\s*=\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\S+)`, "g");
function spawnProse(prompt) {
  return prompt.replace(ANCHOR_RE, " ").replace(/\s+/g, " ").trim();
}
function denyReason(proseChars) {
  return `BLOCKED: the code-reviewer spawn prompt carries ${proseChars} characters of prose beyond its anchors (${ANCHORS.map((a) => `${a}=`).join(", ")}); the cap is ${SPAWN_NOTE_MAX_CHARS}. The reviewer reads the spec, discussions and swe's completion report from task_brief. Store the remaining context as spawn_note (at most ${SPAWN_NOTE_MAX_CHARS} chars) with bro_atomic_close, where task_brief returns it, and respawn with the anchors and at most ${SPAWN_NOTE_MAX_CHARS} chars of prose.`;
}
function deny4(reason) {
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
  return prose.length > SPAWN_NOTE_MAX_CHARS ? deny4(denyReason(prose.length)) : ALLOW;
};

// src/task-rework.ts
var SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";
var REWORK_FAIL_LIMIT = 2;
var SWE_RUN_LIMIT = 6;
var ISSUE_FAIL_LIMIT = 4;
function elapsedMs(createdAt, endedAt) {
  const start2 = Date.parse(createdAt);
  const end = endedAt.getTime();
  if (Number.isNaN(start2) || Number.isNaN(end)) return null;
  return Math.max(0, end - start2);
}

// src/hooks/rework-limit.ts
var GATE_NAME14 = "rework-limit";
function readState(db, taskId, env) {
  const out2 = gateRead(
    db,
    `WITH t AS (SELECT id, issue_id FROM tasks WHERE id = ${taskId}),
          human AS (SELECT MAX(d.created_at) AS at FROM discussions d, t
                     WHERE (d.task_id = t.id OR (d.task_id IS NULL AND d.issue_id = t.issue_id))
                       AND d.author = 'human' AND d.kind = 'decision'),
          since AS (SELECT COALESCE(MAX(v.id), 0) AS pass_id FROM validation_attempts v, t
                     WHERE v.task_id = t.id AND v.verdict = 'pass')
     SELECT json_object(
       'task_fails', (SELECT COUNT(*) FROM validation_attempts v, t, since, human
                       WHERE v.task_id = t.id AND v.verdict = 'fail' AND v.id > since.pass_id
                         AND (human.at IS NULL OR v.created_at > human.at)),
       'task_runs', (SELECT COUNT(*) FROM agent_runs r, t, human
                      WHERE r.task_id = t.id AND ${SWE_SPAWN_SQL} AND COALESCE(r.stop_cause, '') <> 'budget'
                        AND (human.at IS NULL OR r.started_at > human.at)),
       'issue_fails', (SELECT COUNT(*) FROM validation_attempts v JOIN tasks x ON x.id = v.task_id, t, human
                        WHERE x.issue_id = t.issue_id AND v.verdict = 'fail'
                          AND NOT EXISTS (SELECT 1 FROM validation_attempts p
                                           WHERE p.task_id = v.task_id AND p.verdict = 'pass' AND p.id > v.id)
                          AND (human.at IS NULL OR v.created_at > human.at)),
       'waived_at', (SELECT at FROM human))
     FROM t;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (out2 === "") return null;
  const row = JSON.parse(out2.split("\n")[0]);
  return { taskFails: row.task_fails, taskRuns: row.task_runs, issueFails: row.issue_fails, waivedAt: row.waived_at };
}
function trippedLimits(state) {
  const tripped = [];
  if (state.taskFails >= REWORK_FAIL_LIMIT) {
    tripped.push(`task FAILs: ${state.taskFails} review FAILs on the task since its last pass (limit ${REWORK_FAIL_LIMIT})`);
  }
  if (state.taskRuns >= SWE_RUN_LIMIT) {
    tripped.push(`task runs: ${state.taskRuns} swe runs of the task, budget handbacks aside (limit ${SWE_RUN_LIMIT})`);
  }
  if (state.issueFails >= ISSUE_FAIL_LIMIT) {
    tripped.push(`issue FAILs: ${state.issueFails} review FAILs across the issue's tasks (limit ${ISSUE_FAIL_LIMIT})`);
  }
  return tripped;
}
function denyReason2(taskId, state, tripped = trippedLimits(state)) {
  const since = state.waivedAt === null ? "" : ` since the Human's last waiver at ${state.waivedAt}`;
  return `BLOCKED: task ${taskId} is at the rework limit${since}: ${tripped.join("; ")}. A further swe run would repeat an approach that keeps failing. Stop and report the task to the Human with its findings; only the Human lifts this limit, by typing \`waive task ${taskId}\`. No agent action lifts it.`;
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
  if (state === null) return ALLOW;
  const tripped = trippedLimits(state);
  if (tripped.length === 0) return ALLOW;
  return denyPreToolUse(denyReason2(taskId, state, tripped));
}
var reworkLimit = (payload, env) => {
  if (jqAlternatives(payload, [["tool_name"]]) !== "Agent") return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "swe") return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [["tool_input", "prompt"]]));
  const taskId = sqlInt(m?.[1] ?? "");
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME14, env);
  return reworkLimitVerdict(GATE_NAME14, db, taskId, env);
};

// src/hooks/require-feature-branch-active.ts
import { posix } from "node:path";
var GATE_NAME15 = "require-feature-branch-active";
function cutField2(text, n3) {
  const lines2 = text.split("\n").map((line) => line.includes("|") ? line.split("|")[n3 - 1] ?? "" : line);
  return stripTrailingNewlines(lines2.join("\n"));
}
function resolveRepo(db, taskId, repo, env) {
  const workspaceRoot = posix.dirname(posix.dirname(posix.dirname(db)));
  if (repo !== "") {
    const found = gateRead(db, `SELECT path FROM repos WHERE name = '${sqlQuote(repo)}' LIMIT 1;`, env);
    if (found === GATE_READ_ERROR) return denyUnreadable(GATE_NAME15, env);
    const abs2 = found.split("\n")[0] || `${workspaceRoot}/${repo}`;
    if (isDir(`${abs2}/.git`)) return abs2;
    return denyPreToolUse(
      `BLOCKED: cannot resolve repo for task ${taskId}. tasks.repo=${repo} does not point to a git repo at ${abs2}. Verify the path is correct.`
    );
  }
  const single = gateRead(db, "SELECT CASE WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT path FROM repos LIMIT 1) END;", env);
  if (single === GATE_READ_ERROR) return denyUnreadable(GATE_NAME15, env);
  const abs = single || workspaceRoot;
  if (isDir(`${abs}/.git`)) return abs;
  return denyPreToolUse(
    `BLOCKED: cannot resolve repo for task ${taskId}. tasks.repo IS NULL and no single registered repo could be resolved. For a multi-repo workspace, set the task's repo (task_create repo=<name>) so it maps to a repos row.`
  );
}
var requireFeatureBranchActive = (payload, env) => {
  if ((env.TMB_ALLOW_BRANCH_MISMATCH ?? "0") === "1") return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "swe") return ALLOW;
  const rawId = /task_id=([0-9]+)/.exec(jqAlternatives(payload, [["tool_input", "prompt"]]))?.[1] ?? "";
  const taskId = sqlInt(rawId);
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || db === "" || !haveSqlite(env)) return ALLOW;
  const row = gateRead(db, `SELECT branch_id, repo, parent_branch_id FROM tasks WHERE id=${taskId};`, env);
  if (row === GATE_READ_ERROR) return denyUnreadable(GATE_NAME15, env);
  if (row === "") return ALLOW;
  const expected = cutField2(row, 1);
  const repoAbs = resolveRepo(db, rawId, cutField2(row, 2), env);
  if (typeof repoAbs !== "string") return repoAbs;
  if (gitOk(repoAbs, ["show-ref", "--verify", "--quiet", `refs/heads/${expected}`], env, "inherit")) return ALLOW;
  const base2 = cutField2(row, 3) || "<base>";
  const baseRef = gitOk(repoAbs, ["remote", "get-url", "origin"], env) ? `origin/${base2}` : base2;
  return denyPreToolUse(
    `BLOCKED: SWE spawn for task ${rawId} needs branch ${expected} to exist first \u2014 bro pre-creates it ("git -C ${repoAbs} branch ${expected} ${baseRef}") and stays on ${base2}; SWE's worktree owns the branch.`
  );
};

// src/hooks/lib/effort.ts
var configuredEffort = (key2, fallback) => `COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$') END AS v
                               FROM plugin_config WHERE key = '${key2}')
               WHERE v IN ('low','medium','high')), '${fallback}')`;
function effortDefaults(db, env = process.env) {
  return gateRead(
    db,
    `SELECT ${configuredEffort("swe_default_effort", "medium")} || '|' || ${configuredEffort("reviewer_effort", "high")};`,
    env
  );
}

// src/hooks/require-task-spec.ts
var GATE_NAME16 = "require-task-spec";
function promptTaskId(prompt) {
  return /task_id[=:][ \t\v\f\r]*([0-9]+)/.exec(prompt)?.[1] ?? "";
}
var CONTRACT_FILE = /(\.sql$|(^|\/)schema\.[^/]*$|(^|\/)(migrations|migration|migrate)\/|(^|\/)db\.ts$)/i;
var UNICODE_SPACE_POINTS = [
  160,
  5760,
  8192,
  8193,
  8194,
  8195,
  8196,
  8197,
  8198,
  8199,
  8200,
  8201,
  8202,
  8203,
  8232,
  8233,
  8239,
  8287,
  12288,
  65279
];
var UNICODE_SPACES = new RegExp(`[${String.fromCodePoint(...UNICODE_SPACE_POINTS)}]`, "g");
var CONTRACT_BODY = /(add +column|new[ _-]+(column|tool|field|table))/i;
function needsContract(body2, files) {
  if (files.split("\n").some((f) => CONTRACT_FILE.test(f))) return true;
  return CONTRACT_BODY.test(body2.replace(UNICODE_SPACES, " ").replace(/[\n\r\t\v\f]/g, " "));
}
function hasLine(body2, label) {
  const line = new RegExp(`^[ \\t\\v\\f\\r>*+-]*([0-9]+[.)][ \\t\\v\\f\\r]+)?[\`*_]*${label}:[\`*_]*([^\\n]*)$`);
  return body2.split("\n").some((l) => /[^ \t\v\f\r`*_]/.test(line.exec(l)?.[2] ?? ""));
}
function rawField(value) {
  return value === null || value === void 0 || value === false ? "" : stripTrailingNewlines(jqRawText(value));
}
function deny5(reason) {
  return denyPreToolUse(reason);
}
function worktreeState(repo, branch, env) {
  const ref = `branch refs/heads/${branch}`;
  let entry = 0;
  let main = false;
  let linked = false;
  for (const line of gitOut(repo, ["worktree", "list", "--porcelain"], env).split("\n")) {
    if (line.startsWith("worktree ")) entry += 1;
    if (line === ref) {
      if (entry === 1) main = true;
      else linked = true;
    }
  }
  return linked ? "linked" : main ? "main" : "none";
}
function worktreeDeny(db, taskId, safeId, env) {
  const wt = gateRead(
    db,
    `SELECT json_object('branch', COALESCE(t.branch_id, ''),
      'path', COALESCE((SELECT path FROM repos WHERE name = t.repo), CASE WHEN COALESCE(t.repo, '') = '' AND (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT path FROM repos LIMIT 1) END, ''))
    FROM tasks t WHERE t.id = ${safeId};`,
    env
  );
  if (wt === GATE_READ_ERROR) return denyUnreadable(GATE_NAME16, env);
  let row;
  try {
    row = wt === "" ? {} : JSON.parse(wt);
  } catch {
    return denyUnreadable(GATE_NAME16, env);
  }
  const branch = rawField(row.branch);
  const path = rawField(row.path);
  const repo = path === "" ? env.CLAUDE_PROJECT_DIR ?? "" : repoPathAbs(db, path);
  if (repo === "" || branch === "") return null;
  if (gitOut(repo, ["rev-parse", "--is-inside-work-tree"], env) !== "true") return null;
  const state = worktreeState(repo, branch, env);
  if (state === "linked") return null;
  const expected = `${repo.replace(/\/$/, "")}/.claude/worktrees/${branchSlug(branch)}`;
  const sw = state === "main" ? ` The main checkout currently has ${branch} checked out; switch the main checkout back to its base branch first (git cannot attach a branch that is checked out elsewhere).` : "";
  return deny5(
    `BLOCKED: task_id=${taskId} is pending and branch ${branch} has no linked worktree (expected ${expected}).${sw} Call task_reopen(task_id=${taskId}, reason="<why>") to create the worktree, then respawn swe.`
  );
}
function specShapeVerdict(db, taskId, safeId, env) {
  const spec = gateRead(
    db,
    `SELECT json_object('body', COALESCE(spec_body, ''),
    'files', CASE WHEN json_valid(COALESCE(files, '')) THEN json(files) ELSE json('[]') END)
  FROM tasks WHERE id = ${safeId};`,
    env
  );
  if (spec === GATE_READ_ERROR) return denyUnreadable(GATE_NAME16, env);
  let row;
  try {
    row = spec === "" ? {} : JSON.parse(spec);
  } catch {
    return denyUnreadable(GATE_NAME16, env);
  }
  const body2 = rawField(row.body);
  const files = Array.isArray(row.files) ? stripTrailingNewlines(row.files.filter((f) => typeof f === "string").join("\n")) : "";
  if (!needsContract(body2, files)) return ALLOW;
  if (hasLine(body2, "Nullable")) return ALLOW;
  const missing = [hasLine(body2, "Writer") ? "" : "Writer:", hasLine(body2, "Populated") ? "" : "Populated:"].filter((m) => m !== "").join(" and ");
  if (missing === "") return ALLOW;
  const waived = gateRead(
    db,
    `SELECT count(*) FROM audit
  WHERE event_type = 'spec_shape_gate_waived' AND from_node = 'bro' AND json_valid(content_json)
    AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ${safeId}
    AND json_extract(content_json, '$.gate') = 'spec_shape'
    AND length(trim(COALESCE(json_extract(content_json, '$.reason'), ''))) >= 10;`,
    env
  );
  if (waived === GATE_READ_ERROR) return denyUnreadable(GATE_NAME16, env);
  if (Number(waived || "0") > 0) return ALLOW;
  let ref = gateRead(
    db,
    `SELECT COALESCE(issue_id, '<issue>') || '|' || COALESCE(branch_id, '<branch>') FROM tasks WHERE id = ${safeId};`,
    env
  );
  if (ref === GATE_READ_ERROR || ref === "") ref = "<issue>|<branch>";
  const bar = ref.indexOf("|");
  const issue = bar < 0 ? ref : ref.slice(0, bar);
  const branch = bar < 0 ? ref : ref.slice(bar + 1);
  return deny5(
    `BLOCKED: task_id=${taskId} adds a column, field, tool, table or migration, and its spec_body is missing a ${missing} line. Under ## Success Criteria, name each new item with \`Writer: <tool/hook/function>\` and \`Populated: <verification[] command proving a non-null sample or count > 0>\`, or \`Nullable: <reason>\`; fix it with task_update_spec. To waive, bro first records audit_append(event_type="spec_shape_gate_waived", from_node="bro", issue_id=${issue}, branch_id="${branch}", summary=<why>, content_json={"task_id":${taskId},"gate":"spec_shape","reason":"<why, >= 10 chars>"}) and then respawns.`
  );
}
var requireTaskSpec = (payload, env) => {
  if (normalizeRole(jqAlternatives(payload, [["tool_input", "subagent_type"]])) !== "swe") return ALLOW;
  const taskId = promptTaskId(jqAlternatives(payload, [["tool_input", "prompt"]]));
  if (taskId === "") {
    return deny5(
      "BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through bro (bro plans, then spawns SWE with task_id)."
    );
  }
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null || !haveSqlite(env)) return ALLOW;
  const safeId = sqlInt(taskId);
  const row = gateRead(db, `SELECT status, LENGTH(COALESCE(spec_body, '')) FROM tasks WHERE id = ${safeId};`, env);
  if (row === GATE_READ_ERROR) return denyUnreadable(GATE_NAME16, env);
  if (row === "") return deny5(`BLOCKED: task_id=${taskId} does not exist in the tasks table.`);
  const fields = row.split(/[|\n]/);
  const status = fields[0] ?? "";
  const bodyLen = (fields[1] ?? "").trim();
  if (status === "running") {
    const live = gateRead(
      db,
      `SELECT id || ' (started ' || COALESCE(started_at, '?') || ')' FROM agent_runs
    WHERE task_id = ${safeId} AND agent_type = 'swe' AND completed_at IS NULL
      AND NOT ((spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
               AND started_at IS NOT NULL AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds'))
    ORDER BY id DESC LIMIT 1;`,
      env
    );
    if (live === GATE_READ_ERROR) return denyUnreadable(GATE_NAME16, env);
    if (live !== "") {
      return deny5(
        `BLOCKED: task_id=${taskId} is running with a live swe run: agent_runs ${live}. Wait for that swe to return; if it is gone, move the task to failed (task_update_status) and task_reopen it.`
      );
    }
  }
  if (status !== "pending" && status !== "running") {
    return deny5(
      `BLOCKED: task_id=${taskId} has status=${status}, expected pending, or running with no live swe run. Reopen finished work with task_reopen.`
    );
  }
  if (/^-?[0-9]+$/.test(bodyLen || "0") && Number(bodyLen || "0") === 0) {
    return deny5(
      `BLOCKED: task_id=${taskId} has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.`
    );
  }
  if (status === "pending") {
    const blocked = worktreeDeny(db, taskId, safeId, env);
    if (blocked !== null) return blocked;
  }
  return specShapeVerdict(db, taskId, safeId, env);
};

// src/hooks/require-spawn-effort.ts
var GATE_NAME17 = "require-spawn-effort";
function toolInputRaw(payload, key2) {
  return stripTrailingNewlines(
    jqMap(payload, (v) => jqRawText(jqOr(jqIndex(jqIndex(v, "tool_input"), key2), ""))).join("\n")
  );
}
function givenEffort(payload) {
  return stripTrailingNewlines(
    jqMap(
      payload,
      (v) => {
        const effort = jqOr(jqIndex(jqIndex(v, "tool_input"), "effort"), "");
        return typeof effort === "string" ? effort : jqCompact(effort);
      },
      jqLiteralNumbers
    ).join("\n")
  );
}
function denyMismatch(who, expected, given, change) {
  const passed = given !== "" ? `passed effort="${given}"` : "passed no effort";
  return denyPreToolUse(
    `BLOCKED: ${who} runs at effort "${expected}", but the Agent call ${passed}. Pass effort="${expected}" on the Agent call. ${change}`
  );
}
function sweVerdict(payload, given, env) {
  const taskId = sqlInt(promptTaskId(toolInputRaw(payload, "prompt")));
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const expected = gateRead(db, `SELECT effort FROM tasks WHERE id = ${taskId};`, env);
  if (expected === GATE_READ_ERROR) {
    if (gateRead(db, "SELECT name FROM pragma_table_info('tasks') WHERE name = 'effort';", env) === "") {
      return denyPreToolUse(
        "BLOCKED: the trajectory DB predates the typed-effort schema (tasks.effort is missing): the TMB plugin was updated but the MCP server has not migrated the DB yet. Restart Claude Code so the server migrates the DB, then retry the spawn."
      );
    }
    return denyUnreadable(GATE_NAME17, env);
  }
  if (expected === "" || given === expected) return ALLOW;
  return denyMismatch(
    `task_id=${taskId} (tasks.effort)`,
    expected,
    given,
    `To run it at another effort, change the task first: task_reopen(task_id=${taskId}, effort=...) for rework, task_retry(effort=...) for a retry.`
  );
}
function reviewerVerdict(given, env) {
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const defaults = effortDefaults(db, env);
  if (defaults === GATE_READ_ERROR || defaults === "") return denyUnreadable(GATE_NAME17, env);
  const bar = defaults.indexOf("|");
  const expected = bar < 0 ? defaults : defaults.slice(bar + 1);
  if (given === expected) return ALLOW;
  return denyMismatch(
    "code-reviewer (plugin_config.reviewer_effort, high when unset)",
    expected,
    given,
    'To change it for every review, config_set(key="reviewer_effort", value=...).'
  );
}
var requireSpawnEffort = (payload, env) => {
  const subagent = toolInputRaw(payload, "subagent_type");
  const given = givenEffort(payload);
  if (/(^|:)swe$/.test(subagent)) return sweVerdict(payload, given, env);
  if (normalizeRole(subagent.slice(subagent.lastIndexOf(":") + 1)) === CODE_REVIEWER_ROLE) return reviewerVerdict(given, env);
  return ALLOW;
};

// src/hooks/substrate-preflight.ts
var GATE_NAME18 = "substrate-preflight";
var PROBES = [
  ["jq", "most PreToolUse gates and the bro/swe doctrine hooks are inoperative"],
  ["sqlite3", "task/spawn gates cannot verify state"],
  ["git", "branch guards and commit-message lint are inoperative"],
  ["node", "MCP trajectory-server and scan tooling cannot start"]
];
var OFFLINE_NOTE = "TMB: operating locally \u2014 no remote configured; remote/push ops are skipped.";
function noRemoteUrl(remotesJson) {
  const out2 = [];
  for (const value of jsonValues(remotesJson)) {
    let items;
    if (Array.isArray(value)) items = value;
    else if (value !== null && typeof value === "object") items = Object.values(value);
    else continue;
    let has = false;
    let failed = false;
    for (const item of items) {
      if (item === null) continue;
      if (typeof item !== "object" || Array.isArray(item)) {
        failed = true;
        break;
      }
      const url = item.url;
      if (url !== void 0 && url !== null && url !== "") has = true;
    }
    if (!failed) out2.push(String(has));
  }
  return out2.join("\n") === "false";
}
function offlineNote(env) {
  if (!commandOnPath("sqlite3", env) || !commandOnPath("jq", env)) return "";
  const db = dbPath(env);
  if (db === null || db === "") return "";
  const remotes = repoRemotes(db, repoGitRoot(projectRoot(env), env), env);
  return remotes !== "" && noRemoteUrl(remotes) ? OFFLINE_NOTE : "";
}
var substratePreflight = (_payload, env) => {
  const missing = PROBES.filter(([bin]) => !commandOnPath(bin, env)).map(([bin, why]) => `missing ${bin} \u2014 ${why}`);
  const offline = offlineNote(env);
  if (missing.length === 0 && offline === "") return ALLOW;
  const parts2 = [];
  if (missing.length > 0) parts2.push(`TMB DEGRADED: ${missing.join("; ")}. Install the missing tools to restore enforcement.`);
  if (offline !== "") parts2.push(offline);
  const escaped = parts2.join(" ").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return { stdout: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${escaped}"}}
`, code: 0 };
};

// src/hooks/naming-lint.ts
import { existsSync as existsSync9 } from "node:fs";
var GATE_NAME19 = "naming-lint";
var TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var FIXED_NAMES = /* @__PURE__ */ new Set([
  "__init__.py",
  "__main__.py",
  "conftest.py",
  "setup.py",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
  "index.cjs"
]);
var FIXED_PREFIXES = ["CHANGELOG", "LICENSE", "README", "TODO", "NOTICE", "AUTHORS", "."];
var SKIPPED_DIRS2 = [
  "/node_modules/",
  "/dist/",
  "/build/",
  "/.next/",
  "/__pycache__/",
  "/target/",
  "/fixtures/",
  "/snapshots/",
  "/__snapshots__/",
  "/migrations/"
];
var SNAKE = /^[a-z][a-z0-9_]*$/;
var KEBAB = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
var PASCAL = /^[A-Z][A-Za-z0-9]*$/;
function basename6(path) {
  if (path.length > 1 && path.startsWith("-")) return "";
  return shellCapture2(posixBasename(path));
}
function violationFor(ext, name3) {
  switch (ext) {
    case "py":
    case "sql":
      return anyLine(name3, SNAKE) ? "" : `${ext} files use snake_case (got '${name3}')`;
    case "sh":
    case "bash":
      return anyLine(name3, KEBAB) ? "" : `shell scripts use kebab-case (got '${name3}')`;
    case "ts":
    case "js":
    case "mjs":
    case "cjs":
      return anyLine(name3, KEBAB) ? "" : `${ext} modules use kebab-case (got '${name3}')`;
    case "tsx":
    case "jsx":
      return anyLine(name3, KEBAB) || anyLine(name3, PASCAL) ? "" : `${ext} files use kebab-case (route/hook) or PascalCase (component); got '${name3}'`;
    default:
      return "";
  }
}
var namingLint = (payload, env) => {
  if ((env.TMB_SKIP_NAMING_LINT ?? "0") === "1") return ALLOW;
  if (!TOOLS2.has(jqRawOr(payload, [jqPath("tool_name")]))) return ALLOW;
  const target = jqRawOr(payload, [jqPath("tool_input", "file_path"), jqPath("tool_input", "notebook_path")]);
  if (target === "" || existsSync9(target)) return ALLOW;
  const base2 = basename6(target);
  const dot = base2.lastIndexOf(".");
  const name3 = dot < 0 ? base2 : base2.slice(0, dot);
  const ext = dot < 0 ? base2 : base2.slice(dot + 1);
  if (FIXED_NAMES.has(base2) || FIXED_PREFIXES.some((p) => base2.startsWith(p))) return ALLOW;
  if (SKIPPED_DIRS2.some((d) => target.includes(d))) return ALLOW;
  const violation = violationFor(ext, name3);
  if (violation === "") return ALLOW;
  const ctx = `naming-lint: ${target} \u2014 ${violation}. Set TMB_SKIP_NAMING_LINT=1 to bypass when the project's local convention differs.`;
  return { stdout: preToolContext(ctx), code: 0 };
};

// src/hooks/swe-boundary.ts
import { lstatSync as lstatSync6, readdirSync as readdirSync4, readFileSync as readFileSync10, rmSync as rmSync3, statSync as statSync18 } from "node:fs";

// src/hooks/lib/scope-fence.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync3 } from "node:fs";
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i2 = 0; i2 < 256; i2++) {
    let c = i2 << 24;
    for (let k = 0; k < 8; k++) c = c & 2147483648 ? c << 1 ^ 79764919 : c << 1;
    table[i2] = c >>> 0;
  }
  return table;
})();
function cksum(text) {
  const bytes = Buffer.from(text, "utf8");
  let crc = 0;
  const step = (b) => {
    crc = (crc << 8 ^ CRC_TABLE[(crc >>> 24 ^ b) & 255]) >>> 0;
  };
  for (const b of bytes) step(b);
  for (let n3 = bytes.length; n3 > 0; n3 = Math.floor(n3 / 256)) step(n3 & 255);
  return String(~crc >>> 0);
}
function rawElements(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  let items = [];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed !== null && typeof parsed === "object") items = Object.values(parsed);
  return items.map((v) => typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
function localeCollates(env) {
  const locale = env.LC_ALL || env.LC_COLLATE || env.LANG || "C";
  return !locale.includes("/") && locale !== "C" && locale !== "POSIX" && existsSync10(`/usr/share/locale/${locale}/LC_COLLATE`);
}
function sortUnique(items, env = process.env) {
  const compare = localeCollates(env) ? new Intl.Collator("en").compare : (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  const out2 = [];
  for (const item of [...items].sort(compare)) {
    if (out2.length === 0 || compare(out2[out2.length - 1], item) !== 0) out2.push(item);
  }
  return out2;
}
var ScopeFence = class {
  constructor(env = process.env) {
    this.env = env;
  }
  env;
  state = "none";
  dirs = [];
  tests = false;
  /** tmb_scope_fence_load <db> <task_id>. */
  load(db, taskId) {
    this.state = "none";
    this.dirs = [];
    this.tests = false;
    const task = sqlInt(taskId);
    if (task === "") return;
    const files = gateRead(db, `SELECT COALESCE(files, '[]') FROM tasks WHERE id = ${task} LIMIT 1;`, this.env);
    if (files === GATE_READ_ERROR) {
      this.state = "error";
      return;
    }
    if (files === "") return;
    for (const line of rawElements(files).join("\n").split("\n")) {
      const dir = line.replace(/\/+$/, "");
      if (dir === "") continue;
      this.dirs.push(dir);
      if (dir === "tests" || dir.startsWith("tests/")) this.tests = true;
    }
    this.state = this.dirs.length === 0 ? "empty" : "ok";
  }
  /** tmb_scope_fence_allows <rel>: the path is a listed entry or beneath one. */
  allows(rel) {
    if (this.dirs.some((allowed) => rel === allowed || rel.startsWith(`${allowed}/`))) return true;
    return this.tests && (rel === "tests" || rel.startsWith("tests/"));
  }
  /** tmb_scope_fence_note <task_id> <rel>: the note the first time this task writes <rel>, "" after. */
  note(taskId, rel) {
    const task = sqlInt(taskId);
    if (task === "" || rel === "") return "";
    const state = stateDir(this.env);
    if (state === null) return "";
    const parent = `${state}/locks/scope-notes/${task}`;
    try {
      mkdirSync3(parent, { recursive: true });
      mkdirSync3(`${parent}/${cksum(rel)}`);
    } catch {
      return "";
    }
    const dirs = sortUnique(this.dirs, this.env).join(",").replaceAll(",", ", ");
    return `${rel} is outside this task's files[] (${dirs}); list it and why in your report`;
  }
};

// src/hooks/swe-boundary.ts
var GATE_NAME20 = "swe-boundary";
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var FORCE2 = / --force | -f | --force-with-lease | --force-with-lease=/;
var GLOB_CHAR2 = /[*?[]/;
var PUSH_REASON = "BLOCKED: SWE must never push. Bro handles the push gate after code-reviewer passes. Commit in your worktree and call task_update_status(completed).";
var GH_REASON = "BLOCKED: SWE may not run gh/glab mutating commands (create/close/edit/merge/delete/api POST|PATCH|PUT|DELETE). Read-only gh commands (view, list, status) are allowed. Mutations go through bro.";
var PARSE_REASON3 = "BLOCKED: swe-boundary could not parse this command, so it cannot tell whether it pushes, runs a gh/glab mutation or writes a prompt-surface path. Split it into simpler commands or fix its quoting.";
function claudeMdReason(target) {
  return `BLOCKED: SWE may not edit CLAUDE.md at the repo root (Human-owned; prompt_bearing does not lift this). Target: ${target}. Propose the change in your report; the Human applies it.`;
}
function capture2(text) {
  return stripTrailingNewlines(text.replace(/\0/g, ""));
}
function field4(input, ...paths) {
  return capture2(jqAlternatives(input, paths));
}
function canonical2(path) {
  return capture2(pathCanonical2(path));
}
function deny6(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}
function context2(text, prefix = "") {
  return { stdout: `${prefix}${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } })}
`, code: 0 };
}
function stripDir(s, dir) {
  return s.startsWith(`${dir}/`) ? s.slice(dir.length + 1) : s;
}
function ownDir(path) {
  try {
    if (lstatSync6(path).isSymbolicLink()) return false;
    const st = statSync18(path);
    return st.isDirectory() && st.uid === (process.geteuid?.() ?? -1);
  } catch {
    return false;
  }
}
function arith(value) {
  if (/^0[0-9]+$/.test(value)) return /^[0-7]+$/.test(value) ? parseInt(value, 8) : null;
  return Number(value);
}
function sessionOf(input) {
  const session = field4(input, ["session_id"]);
  return session === "" || session.includes("/") || session.startsWith(".") ? "" : session;
}
var ArithmeticAbort = class {
  constructor(message) {
    this.message = message;
  }
  message;
};
var Boundary = class {
  constructor(input, env) {
    this.input = input;
    this.env = env;
    this.toolName = field4(input, ["tool_name"]);
    this.swe = agentRole(input) === "swe";
  }
  input;
  env;
  toolName;
  swe;
  callerTask = "";
  worktree = "";
  ctxState = "ok";
  missing = "";
  wtD = "";
  target = "";
  /** null when resolved, else the gate's whole answer (a DB read error). */
  resolve() {
    if (!this.swe || !haveSqlite(this.env)) return null;
    const ctx = agentContext(this.input, "", this.env);
    switch (ctx.code) {
      case 0:
        this.callerTask = ctx.taskId;
        this.worktree = ctx.worktree;
        return null;
      case 2:
        return { stdout: `${denyDbUnavailable(GATE_NAME20, this.env)}
`, code: 0 };
      case 3:
        this.ctxState = "nodb";
        return null;
      default:
        this.ctxState = "missing";
        this.callerTask = ctx.taskId;
        this.missing = ctx.missing;
        return null;
    }
  }
  dbPath() {
    return dbPath(this.env, (line) => process.stderr.write(`${line}
`)) ?? "";
  }
  taskFor(target, db) {
    return this.callerTask !== "" ? this.callerTask : resolveTaskIdForTarget(target, this.input, db, this.env);
  }
  wtOf(path) {
    return ctxInWorktree(path, this.worktree) ? this.worktree : worktreeRootForTarget(path);
  }
  dbDenied() {
    return { stdout: `${denyDbUnavailable(GATE_NAME20, this.env)}
`, code: 0 };
  }
  /** prompt_bearing of <task>: "1" lifts, GATE_READ_ERROR denies. */
  promptBearing(db, task) {
    const value = gateRead(db, `
        SELECT COALESCE(prompt_bearing, 0) FROM tasks WHERE id = ${task} LIMIT 1;
      `, this.env);
    return value === GATE_READ_ERROR ? value : value || "0";
  }
  async bash() {
    const command = field4(this.input, ["tool_input", "command"]);
    const cwd = payloadCwd(this.input, this.env);
    const listed2 = await cmdStatements(command, cwd, this.env);
    if (!listed2.ok) return deny6(PARSE_REASON3);
    let push = false;
    let mutating = false;
    for (const { stmt } of listed2.statements) {
      const sub = gitSubcommand(stmt);
      if ((sub === "push" || sub.startsWith("push ")) && !FORCE2.test(` ${sub} `)) push = true;
      if (ghMutation(stmt) !== "") mutating = true;
    }
    if (push) return deny6(PUSH_REASON);
    if (mutating) return deny6(GH_REASON);
    const root = this.worktree || capture2(projectRoot(this.env));
    let surface2 = "";
    let anchor = "";
    let rootClaudeMd = "";
    let unresolved = "";
    const fence = [];
    const lines2 = (await writePaths(command, { cwd, root, env: this.env })).join("\n").split("\n");
    for (const path of lines2) {
      if (path === "") continue;
      if (path.startsWith("UNRESOLVED:")) {
        const rest = path.slice("UNRESOLVED:".length);
        const colon = rest.indexOf(":");
        if (unresolved === "" && !Object.hasOwn(NEVER_JUDGED, colon < 0 ? rest : rest.slice(0, colon))) {
          unresolved = colon < 0 ? path : rest.slice(colon + 1);
        }
        continue;
      }
      let wt = this.wtOf(path);
      let rel = stripDir(path, wt);
      if (wt === "" || rel === path) {
        wt = "";
        rel = path;
      }
      if (wt !== "" && rel === "CLAUDE.md") rootClaudeMd = path;
      if (surface2 === "" && isPromptSurfacePath(rel, wt, this.env)) {
        surface2 = path;
        anchor = wt === "" ? "" : path;
      }
      if (wt !== "") fence.push(path);
    }
    if (rootClaudeMd !== "") return deny6(claudeMdReason(rootClaudeMd));
    const db = surface2 !== "" || unresolved !== "" || fence.length > 0 ? this.dbPath() : "";
    if ((surface2 !== "" || unresolved !== "") && dbState(this.env) === "error") return this.dbDenied();
    let lifted = false;
    if (surface2 !== "" || unresolved !== "") {
      const task = this.taskFor(anchor, db);
      if (task !== "" && db !== "" && haveSqlite(this.env)) {
        const pb = this.promptBearing(db, task);
        if (pb === GATE_READ_ERROR) return this.dbDenied();
        lifted = pb === "1";
      }
    }
    if (surface2 !== "" && !lifted) {
      const glob = surface2.search(GLOB_CHAR2);
      if (glob >= 0) {
        const over = capture2(posixDirname(`${surface2.slice(0, glob)}x`));
        return deny6(
          `BLOCKED: a loop or glob over ${over} reaches prompt-surface paths (${surface2}); scope the listing below agents/, skills/, commands/, templates/ and rules/, exclude them in the source (-not -path '*/agents/*', --glob '!agents/**', ':!agents'), or inline the paths. Sanctioned route for intentional prompt edits: a prompt_bearing=1 task.`
        );
      }
      return deny6(
        `BLOCKED: SWE may not write prompt-surface files via Bash (${writeShapes()}). Target: ${surface2}. Sanctioned routes: use a prompt_bearing=1 task for intentional prompt edits, or pr_monitor_worktree for reviewer experiments. Reads (cat/grep/sed -n) are always allowed.`
      );
    }
    if (unresolved !== "" && !lifted) {
      return deny6(
        `BLOCKED: write target "${unresolved}" ${UNJUDGED_PHRASE} depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command.`
      );
    }
    if (fence.length === 0 || db === "" || !haveSqlite(this.env)) return ALLOW;
    const scope = new ScopeFence(this.env);
    let fenceWt = "";
    let fenceTask = "";
    const notes = [];
    for (const path of fence) {
      const wt = this.wtOf(path);
      if (wt !== fenceWt) {
        fenceWt = wt;
        fenceTask = this.taskFor(path, db);
        scope.load(db, fenceTask);
      }
      if (scope.state !== "ok") continue;
      const rel = stripDir(path, wt);
      if (scope.allows(rel)) continue;
      const note2 = scope.note(fenceTask, rel);
      if (note2 !== "") notes.push(note2);
    }
    return notes.length === 0 ? ALLOW : context2(`TMB: ${notes.join("; ")}`);
  }
  scratchpadAllows(abs, session, base2) {
    if (session === "") return false;
    const target = canonical2(abs);
    const rest = stripDir(target, base2);
    const slash = rest.indexOf("/");
    const project = slash < 0 ? rest : rest.slice(0, slash);
    const scratch = `${base2}/${project}/${session}/scratchpad`;
    const inner4 = stripDir(target, scratch);
    return rest !== target && project !== "" && project !== rest && inner4 !== target && inner4 !== "" && ownDir(scratch);
  }
  scratchHint(session, base2, uid) {
    const fallback = `/tmp/claude-${uid}/<project>/<session_id>/scratchpad`;
    if (session === "") return fallback;
    let names;
    try {
      names = readdirSync4(base2).filter((n3) => !n3.startsWith("."));
    } catch {
      return fallback;
    }
    const found = names.map((n3) => `${base2}/${n3}/${session}/scratchpad`).filter(ownDir);
    return found.length === 1 ? found[0] : fallback;
  }
  bypassCheck() {
    const session = sessionOf(this.input);
    if (session === "") return ALLOW;
    const state = stateDir(this.env);
    if (state === null) return ALLOW;
    const abs = this.target.startsWith("/") ? this.target : `${payloadCwd(this.input, this.env)}/${this.target}`;
    const record = `${canonical2(state)}/locks/boundary-denies/${session}/${pathDigest(abs)}`;
    let text;
    try {
      if (!statSync18(record).isFile()) return ALLOW;
      text = readFileSync10(record, "utf8");
    } catch {
      return ALLOW;
    }
    const lines2 = text.split("\n");
    const gate = lines2[0] ?? "";
    const deniedAt = lines2.length > 1 ? lines2[1] ?? "" : "";
    const drop = () => {
      rmSync3(record, { force: true });
      return ALLOW;
    };
    if (!/^[0-9]+$/.test(deniedAt)) return drop();
    let window2 = this.env.TMB_BYPASS_WINDOW_MIN || "10";
    if (!/^[0-9]+$/.test(window2) || window2 === "0") window2 = "10";
    const at2 = arith(deniedAt);
    if (at2 === null) throw new ArithmeticAbort(`${deniedAt}: value too great for base (error token is "${deniedAt}")`);
    const windowMin = arith(window2);
    if (windowMin === null) throw new ArithmeticAbort(`${window2}: value too great for base (error token is "${window2}")`);
    if (Math.floor(Date.now() / 1e3) - at2 > windowMin * 60) return drop();
    const db = capture2(dbPath(this.env) ?? "");
    if (db === "" || !haveSqlite(this.env)) return ALLOW;
    const task = this.taskFor(this.target, db);
    let issue = "-1";
    if (task !== "") issue = sqlInt(capture2(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${task};`, this.env))) || "-1";
    const rel = this.wtD === "" ? this.target : stripDir(this.target, this.wtD);
    const content = jqCompact({
      tool: this.toolName,
      path: this.target,
      denied_gate: gate,
      denied_at: Number(deniedAt),
      session_id: session,
      task_id: task === "" ? null : Number(task)
    });
    const written = auditAppend(
      db,
      {
        issueId: issue,
        branchId: "",
        fromNode: `hook:${GATE_NAME20}`,
        eventType: "hook_block_bypassed",
        summary: `${this.toolName} to ${rel} after ${gate} denied a Bash write to it`,
        contentJson: content
      },
      { caller: GATE_NAME20, env: this.env }
    );
    if (!written.ok) {
      if (written.error !== "") process.stderr.write(`${written.error}
`);
      return { stdout: written.stdout, code: 0 };
    }
    rmSync3(record, { force: true });
    return context2(
      `TMB: ${this.toolName} to ${this.target} follows a ${gate} Bash deny in this session; recorded as hook_block_bypassed. A hook block is a hard stop: report it to bro instead of rewriting the file with another tool.`,
      written.stdout
    );
  }
  edit() {
    this.target = field4(this.input, ["tool_input", "file_path"], ["tool_input", "notebook_path"]);
    const target = this.target;
    if (target === "") return ALLOW;
    if (this.ctxState === "missing") {
      return deny6(
        `BLOCKED: swe-boundary cannot resolve this swe's worktree: ${this.missing}. An swe works out of <repos.path of tasks.repo>/.claude/worktrees/<branch slug>, found from the task_id=<N> in its spawn prompt; until that resolves, Edit/Write is denied. Target: ${target}. Report this to bro.`
      );
    }
    const abs = target.startsWith("/") ? target : `${payloadCwd(this.input, this.env)}/${target}`;
    if (this.worktree !== "" && !ctxInWorktree(abs, this.worktree)) {
      const session = sessionOf(this.input);
      const uid = process.geteuid?.() ?? 0;
      const base2 = `${canonical2("/tmp")}/claude-${uid}`;
      if (this.scratchpadAllows(abs, session, base2)) return ALLOW;
      const hint = this.scratchHint(session, base2, uid);
      return deny6(
        `BLOCKED: SWE may only edit files inside its assigned worktree (${this.worktree}) of task ${this.callerTask}. Target '${target}' is outside the worktree. Scratch files go in this session's scratchpad, ${hint}/.`
      );
    }
    let subject;
    if (this.worktree !== "") {
      this.wtD = this.worktree;
      subject = stripDir(canonical2(abs), canonical2(this.worktree));
    } else {
      this.wtD = worktreeRootForTarget(target);
      subject = this.wtD === "" ? target : stripDir(target, this.wtD);
    }
    if (this.wtD !== "" && subject === "CLAUDE.md") return deny6(claudeMdReason(target));
    if (!isPromptSurfacePath(subject, this.wtD, this.env)) return this.bypassCheck();
    const db = this.dbPath();
    if (dbState(this.env) === "error") return this.dbDenied();
    if (db !== "" && haveSqlite(this.env)) {
      const task = this.taskFor(target, db);
      if (task !== "") {
        const pb = this.promptBearing(db, task);
        if (pb === GATE_READ_ERROR) return this.dbDenied();
        if (pb === "1") return this.bypassCheck();
      }
    }
    return deny6(
      `BLOCKED: SWE may not edit prompt-surface files (agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, CODEX/CURSOR/GEMINI.md). Target: ${target}. If this task intentionally modifies agent prompts, set prompt_bearing=1 in task_create_batch.`
    );
  }
};
var sweBoundary = async (payload, env) => {
  const b = new Boundary(payload, env);
  const early = b.resolve();
  if (early) return early;
  if (b.toolName === "Bash" && b.swe) return b.bash();
  if (!EDIT_TOOLS.has(b.toolName) || !b.swe) return ALLOW;
  try {
    return b.edit();
  } catch (e) {
    if (!(e instanceof ArithmeticAbort)) throw e;
    process.stderr.write(`${e.message}
`);
    return ALLOW;
  }
};

// src/hooks/swe-resume-gate.ts
var GATE_NAME21 = "swe-resume-gate";
function effortMismatchReason(agentId, target) {
  return `BLOCKED: swe ${agentId} ran task ${target.task_id} at effort ${target.run_effort}; the task's effort is now ${target.task_effort}. A resumed swe keeps the effort it was spawned at, so resuming it would ignore the change. Spawn a fresh swe at the task's effort instead: Agent(subagent_type='swe', effort='${target.task_effort}', prompt starting 'task_id=${target.task_id}').`;
}
var sweResumeGate = (payload, env) => {
  if (jqAlternatives(payload, [["tool_name"]]) !== "SendMessage") return ALLOW;
  const to = jqAlternatives(payload, [["tool_input", "to"]]);
  if (to === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return denyUnreadable(GATE_NAME21, env);
  const out2 = gateRead(
    db,
    `SELECT json_object('task_id', r.task_id, 'status', t.status, 'run_effort', r.effort, 'task_effort', t.effort)
       FROM agent_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.agent_type = 'swe' AND r.spawn_id = '${sqlQuote(to)}'
      ORDER BY r.id DESC LIMIT 1;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return denyUnreadable(GATE_NAME21, env);
  if (out2 === "") return ALLOW;
  const target = JSON.parse(out2.split("\n")[0]);
  if (target.status === "closed") return ALLOW;
  const verdict = reworkLimitVerdict(GATE_NAME21, db, String(target.task_id), env);
  if (verdict !== ALLOW) return verdict;
  if (target.run_effort !== null && target.task_effort !== null && target.run_effort !== target.task_effort) {
    return denyPreToolUse(effortMismatchReason(to, target));
  }
  return ALLOW;
};

// src/hooks/swe-stop-cause.ts
import { readFileSync as readFileSync11 } from "node:fs";
var GATE_NAME22 = "swe-stop-cause";
var STOP_DETAIL_MAX_CHARS = 500;
var HOOK_DENY_RE = /^PreToolUse:\S+ hook error:/;
var SKIPPED_TOOL_RE = /(^|__)(task_update_status|task_brief)$/;
var STATUS_TOOL_RE = /(^|__)task_update_status$/;
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c && typeof c === "object" && typeof c.text === "string" ? c.text : "").filter((t) => t !== "").join("\n");
}
function isCompletedReport(name3, input) {
  return STATUS_TOOL_RE.test(name3) && typeof input === "object" && input !== null && input.status === "completed";
}
function hookBlockDetail(transcriptText, sinceMs) {
  const names = /* @__PURE__ */ new Map();
  const reportUses = /* @__PURE__ */ new Set();
  let reported = false;
  let last = null;
  for (const line of transcriptText.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const inWindow = !Number.isNaN(ts) && ts >= sinceMs;
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block2 = raw;
      if (block2.type === "tool_use" && typeof block2.id === "string" && typeof block2.name === "string") {
        names.set(block2.id, block2.name);
        if (inWindow && isCompletedReport(block2.name, block2.input)) reportUses.add(block2.id);
      } else if (block2.type === "tool_result" && inWindow) {
        const toolUseId2 = typeof block2.tool_use_id === "string" ? block2.tool_use_id : "";
        if (reportUses.has(toolUseId2) && block2.is_error !== true) reported = true;
        if (SKIPPED_TOOL_RE.test(names.get(toolUseId2) ?? "")) continue;
        last = { toolUseId: toolUseId2, isError: block2.is_error === true, text: resultText(block2.content) };
      }
    }
  }
  if (reported || !last || !last.isError || !HOOK_DENY_RE.test(last.text)) return null;
  return last.text.slice(0, STOP_DETAIL_MAX_CHARS);
}
function readTranscript2(path) {
  if (path === "") return "";
  try {
    return readFileSync11(path, "utf8");
  } catch {
    return "";
  }
}
function stopCause(db, taskId, sinceMs, transcriptPath, env) {
  const at2 = gateRead(
    db,
    `SELECT json_extract(checkpoint, '$.at') FROM tasks WHERE id = ${taskId} AND json_valid(checkpoint);`,
    env
  );
  if (at2 === GATE_READ_ERROR) return void 0;
  const atMs = at2 === "" ? NaN : Date.parse(at2);
  if (!Number.isNaN(atMs) && atMs >= sinceMs) return { cause: "budget", detail: null };
  const detail = hookBlockDetail(readTranscript2(transcriptPath), sinceMs);
  return detail === null ? null : { cause: "hook_block", detail };
}
var sqlText = (v) => v === null ? "NULL" : `'${sqlQuote(v)}'`;
function sweStopCause(payload, env) {
  try {
    const taskId = sqlInt(env.TMB_STOP_TASK_ID ?? "");
    const spawnId = env.TMB_STOP_SPAWN_ID ?? "";
    const sinceMs = Date.parse(env.TMB_STOP_SINCE ?? "");
    if (taskId === "" || spawnId === "" || Number.isNaN(sinceMs)) return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const stop2 = stopCause(db, taskId, sinceMs, jqAlternatives(payload, [["agent_transcript_path"]]), env);
    if (stop2 === void 0) return ALLOW;
    dbWrite(
      db,
      `UPDATE agent_runs SET stop_cause = ${sqlText(stop2?.cause ?? null)}, stop_detail = ${sqlText(stop2?.detail ?? null)}
        WHERE id = (SELECT id FROM agent_runs
                     WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${sqlQuote(spawnId)}'
                     ORDER BY id DESC LIMIT 1);`,
      { caller: GATE_NAME22, env }
    );
  } catch {
  }
  return ALLOW;
}

// src/hooks/task-overrun-alert.ts
var GATE_NAME23 = "task-overrun-alert";
var OVERRUN_ENV = "TMB_TASK_OVERRUN_MIN";
var DEFAULT_OVERRUN_MIN = 60;
var EVENT = "task_overrun_alerted";
var FROM_NODE = `hook:${GATE_NAME23}`;
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
    const firstLine3 = (r.fail ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    found.push({
      taskId: r.id,
      issueId: r.issue_id,
      branchId: r.branch_id,
      minutes: Math.floor(ms / MS_PER_MIN),
      attempts: r.attempts,
      blocker: firstLine3 === "" ? `status ${r.status}` : firstLine3
    });
  }
  return found.sort((a, b) => a.taskId - b.taskId);
}
function claim(db, found, now, env) {
  const statements2 = [];
  for (const o of found) {
    const content = jqCompact({ task_id: o.taskId, minutes: o.minutes, attempts: o.attempts, blocker: o.blocker });
    const guard2 = dedupeGuard(EVENT, content, ["$.task_id"], { caller: GATE_NAME23 });
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
      { caller: GATE_NAME23, env, now: nowIso(now) }
    );
    if (guard2.code !== 0 || row.code !== 0) return null;
    statements2.push(row.sql, `SELECT ${o.taskId} WHERE changes() = 1;`);
  }
  const w = dbWrite(db, statements2.join("\n"), { caller: GATE_NAME23, env });
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
    const emit3 = claimed === null ? found : found.filter((o) => claimed.has(o.taskId));
    if (emit3.length === 0) return ALLOW;
    const event = jqAlternatives(payload, [["hook_event_name"]]) || "UserPromptSubmit";
    return {
      stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: emit3.map(alertLine).join("\n") } })}
`,
      code: 0
    };
  };
}
var taskOverrunAlert = makeTaskOverrunAlert();

// src/hooks/liveness-probe.ts
import { mkdirSync as mkdirSync5, readdirSync as readdirSync6, readFileSync as readFileSync13, renameSync as renameSync3, statSync as statSync20, writeFileSync as writeFileSync5 } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

// src/hooks/lib/persona.ts
import { accessSync as accessSync8, constants as constants8, lstatSync as lstatSync7, mkdirSync as mkdirSync4, readdirSync as readdirSync5, readFileSync as readFileSync12, realpathSync as realpathSync5, statSync as statSync19, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join5 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
var STALE_MINUTES = 1440;
var OLD_BLOCK = "<!-- tmb:persona start";
var OLD_BLOCK_NOTE = "[The project's CLAUDE.md still holds a <!-- tmb:persona --> block from an older /onboard. It is no longer needed, since this hook delivers the persona; tell the Human they may delete it.]";
var NO_ROOT = "unresolved (no CLAUDE_PROJECT_DIR and no trajectory DB)";
function commandOnPath2(name3, env = process.env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    const candidate = `${dir === "" ? "." : dir}/${name3}`;
    try {
      if (!statSync19(candidate).isFile()) continue;
      accessSync8(candidate, constants8.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function physicalDir2(dir) {
  if (dir === "") return "";
  const abs = isAbsolute3(dir) ? dir : join5(process.cwd(), dir);
  try {
    if (!statSync19(abs).isDirectory()) return "";
    accessSync8(abs, constants8.X_OK);
    return realpathSync5.native(abs);
  } catch {
    return "";
  }
}
function isFile10(path) {
  try {
    return statSync19(path).isFile();
  } catch {
    return false;
  }
}
function sedField(text, key2) {
  const re = new RegExp(`^[\\s\\S]*"${key2}"[ \\t\\v\\f\\r]*:[ \\t\\v\\f\\r]*"([^"]*)"[\\s\\S]*$`);
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return "";
}
function manifestField(root, key2, haveJq) {
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile10(manifest)) return "";
  let text;
  try {
    text = readFileSync12(manifest, "utf8");
  } catch {
    return "";
  }
  return commandSubstitution(haveJq ? jqAlternatives(text, [[key2]]) : sedField(text, key2));
}
function defaultPluginRoot() {
  try {
    return installRoot(posixDirname(fileURLToPath4(import.meta.url))) ?? "";
  } catch {
    return "";
  }
}
function personaInit(env = process.env, haveJq = commandOnPath2("jq", env)) {
  const pluginRoot5 = env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot();
  if (pluginRoot5 === "") return null;
  let project = env.CLAUDE_PROJECT_DIR || shellPwd(env);
  const projectReal = physicalDir2(project);
  const pluginReal = physicalDir2(pluginRoot5);
  if (pluginReal !== "" && projectReal === pluginReal) return null;
  if (projectReal !== "") project = projectReal;
  const version = manifestField(pluginRoot5, "version", haveJq);
  const name3 = manifestField(pluginRoot5, "name", haveJq) || (haveJq ? pluginName2(env) : "tmb");
  return { haveJq, pluginRoot: pluginRoot5, source: `${pluginRoot5}/CLAUDE.md`, project, pluginName: name3, pluginVersion: version };
}
function personaSessionId(input, haveJq) {
  const sid = commandSubstitution(haveJq ? jqAlternatives(input, [["session_id"]]) : sedField(input, "session_id"));
  return sid === "" || sid.includes("/") || sid.startsWith(".") ? "" : sid;
}
function personaMarker(p, sessionId, suffix) {
  return `${p.project}/${TMB_STATE_HOST_DIR}/${p.pluginName}/sessions/${sessionId}.${suffix}`;
}
function pruneStaleMarkers(dir, matches, now = Date.now()) {
  let names;
  try {
    names = readdirSync5(dir);
  } catch {
    return;
  }
  for (const name3 of names) {
    if (!matches(name3)) continue;
    const path = `${dir}/${name3}`;
    try {
      const st = lstatSync7(path);
      if (st.isFile() && now - st.mtimeMs > STALE_MINUTES * 6e4) unlinkSync(path);
    } catch {
    }
  }
}
function touchEmpty(path) {
  try {
    writeFileSync4(path, "");
  } catch {
  }
}
function personaMark(p, sessionId, suffix) {
  if (sessionId === "") return;
  try {
    if (!statSync19(p.project).isDirectory()) return;
  } catch {
    return;
  }
  const marker = personaMarker(p, sessionId, suffix);
  const dir = posixDirname(marker);
  try {
    mkdirSync4(dir, { recursive: true });
  } catch {
    return;
  }
  pruneStaleMarkers(dir, (name3) => name3.includes(".persona"));
  touchEmpty(marker);
}
function readable3(path) {
  try {
    accessSync8(path, constants8.R_OK);
    return true;
  } catch {
    return false;
  }
}
function holdsOldBlock(claudeMd) {
  if (!isFile10(claudeMd)) return false;
  try {
    return readFileSync12(claudeMd).includes(OLD_BLOCK);
  } catch {
    return false;
  }
}
function personaContext(p, env = process.env) {
  if (!readable3(p.source)) return null;
  let body2;
  try {
    body2 = commandSubstitution(readFileSync12(p.source, "utf8"));
  } catch {
    return null;
  }
  if (body2 === "") return null;
  const lines2 = [`[Persona loaded by the TMB persona hook from the ${p.pluginName} plugin's CLAUDE.md, v${p.pluginVersion || "unknown"}]`];
  if (holdsOldBlock(`${p.project}/CLAUDE.md`)) lines2.push(OLD_BLOCK_NOTE);
  lines2.push(`Project root (<project> in TMB prompts): ${projectRoot(env) || NO_ROOT}`);
  return `${lines2.join("\n")}

${body2}`;
}
function personaEmit(p, event, context4) {
  if (!p.haveJq) return `${context4}
`;
  return `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: context4 } })}
`;
}

// src/hooks/liveness-probe.ts
var RUN_SILENT_ENV = "TMB_RUN_SILENT_MIN";
var DEFAULT_RUN_SILENT_MIN = 30;
var EVENT2 = "liveness_finding_reported";
var MS_PER_MIN2 = 6e4;
var MAX_LOAD_FACTOR = 4;
var COMMAND_CHARS = 200;
var SYSTEM_ISSUE = "-1";
var SNAPSHOT_SUFFIX = ".liveness-snapshot.json";
var MARKER_INFIX = ".liveness-";
var UNBOUND_SPAWN = "tool_use:";
var TASK_OUTPUT = /(?:^|\/)tasks\/([^/]+)\.output$/;
var SHELL_SYNTAX = ";&()<>`$*?~\\\n{}";
function silentLimitMs(env, load1, ncpu) {
  const raw = env[RUN_SILENT_ENV] ?? "";
  const base2 = /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_RUN_SILENT_MIN;
  const ratio = ncpu > 0 ? load1 / ncpu : 1;
  const factor = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 1), MAX_LOAD_FACTOR) : 1;
  return base2 * factor * MS_PER_MIN2;
}
function pipelineWords(command) {
  const text = command.replace(/\s2>(?:\/dev\/null|&1)(?=\s|\||$)/g, "");
  const words2 = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const flush = () => {
    if (inWord) words2.push(word);
    word = "";
    inWord = false;
  };
  for (let i2 = 0; i2 < text.length; i2 += 1) {
    const c = text[i2];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "`" || c === "$" && /[\w{(@*#?!$-]/.test(text[i2 + 1] ?? "")) return null;
      else if (c === "\\") {
        i2 += 1;
        word += text[i2] ?? "";
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "	") {
      flush();
    } else if (c === "|") {
      flush();
      words2.push("|");
    } else if (SHELL_SYNTAX.includes(c)) {
      return null;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== "") return null;
  flush();
  const hasEmptyStage = words2[0] === "|" || words2[words2.length - 1] === "|" || words2.some((w, i2) => w === "|" && words2[i2 + 1] === "|");
  return hasEmptyStage ? null : words2;
}
function tailFollowTarget(command) {
  const words2 = pipelineWords(command);
  if (words2 === null || words2[0] !== "tail") return null;
  const end = words2.indexOf("|");
  const args2 = words2.slice(1, end < 0 ? void 0 : end);
  let follows = false;
  let target = null;
  for (let i2 = 0; i2 < args2.length; i2 += 1) {
    const arg = args2[i2];
    const count = /^-([fFqv]*)[nc]([+-]?\d+)?$/.exec(arg);
    if (count) {
      if (/[fF]/.test(count[1])) follows = true;
      if (count[2] === void 0) {
        i2 += 1;
        if (!/^[+-]?\d+$/.test(args2[i2] ?? "")) return null;
      }
    } else if (/^-[fFqv]+$/.test(arg)) {
      if (/[fF]/.test(arg)) follows = true;
    } else if (arg.startsWith("-") || target !== null) {
      return null;
    } else {
      target = arg;
    }
  }
  return follows ? target : null;
}
function subagentTranscript(mainTranscript, agentId) {
  return `${mainTranscript.replace(/\.jsonl$/, "")}/subagents/agent-${agentId}.jsonl`;
}
function boundAgentId(run5) {
  return run5.spawnId === null || run5.spawnId === "" || run5.spawnId.startsWith(UNBOUND_SPAWN) ? null : run5.spawnId;
}
function isOwnRun(run5, input) {
  if (run5.sessionId !== null) return run5.sessionId === input.sessionId;
  const agentId = boundAgentId(run5);
  return agentId !== null && input.transcriptPath !== "" && input.mtimeMs(subagentTranscript(input.transcriptPath, agentId)) !== null;
}
function silentMs(lastMs, now) {
  return lastMs === null ? null : Math.max(0, now.getTime() - lastMs);
}
function isoMs(iso2) {
  if (!iso2) return null;
  const ms = Date.parse(iso2);
  return Number.isNaN(ms) ? null : ms;
}
function runFinding(run5, input, limitMs) {
  const own = isOwnRun(run5, input);
  const main = own ? input.transcriptPath : input.mainTranscripts.get(run5.sessionId ?? "");
  if (main === void 0) return null;
  if (!own) {
    const mainSilent = silentMs(input.mtimeMs(main), input.now);
    if (mainSilent === null || mainSilent <= limitMs) return null;
  }
  const agentId = boundAgentId(run5);
  const transcriptMs = agentId !== null && main !== "" ? input.mtimeMs(subagentTranscript(main, agentId)) : null;
  const silent = silentMs(transcriptMs ?? isoMs(run5.startedAt), input.now);
  if (silent === null || silent <= limitMs) return null;
  return {
    kind: "subagent",
    findingId: String(run5.id),
    issueId: run5.issueId,
    branchId: run5.branchId,
    runId: run5.id,
    taskId: run5.taskId,
    agentType: run5.agentType,
    agentId,
    shellId: null,
    command: null,
    silentMin: Math.floor(silent / MS_PER_MIN2),
    reason: transcriptMs === null ? "no transcript found, so this counts from its start" : "its transcript has gone silent"
  };
}
function taskFinding(task, input, limitMs) {
  const transcriptMs = input.transcriptPath === "" ? null : input.mtimeMs(subagentTranscript(input.transcriptPath, task.id));
  const silent = silentMs(transcriptMs ?? isoMs(task.firstSeen), input.now);
  if (silent === null || silent <= limitMs) return null;
  return {
    kind: "subagent",
    findingId: task.id,
    issueId: null,
    branchId: null,
    runId: null,
    taskId: null,
    agentType: null,
    agentId: task.id,
    shellId: null,
    command: null,
    silentMin: Math.floor(silent / MS_PER_MIN2),
    reason: transcriptMs === null ? "no transcript found, so this counts from when it was first seen" : "its transcript has gone silent"
  };
}
function shellFinding(task, running, input, limitMs) {
  const target = tailFollowTarget(task.command ?? "");
  if (target === null) return null;
  const seenFor = silentMs(isoMs(task.firstSeen), input.now);
  if (seenFor === null || seenFor <= limitMs) return null;
  let silent = seenFor;
  let reason;
  const output = TASK_OUTPUT.exec(target);
  if (target === "/dev/null") {
    reason = "it follows /dev/null, which never gets a line";
  } else if (output) {
    if (running.has(output[1])) return null;
    reason = `it follows the output of task ${output[1]}, which is no longer running`;
  } else {
    if (!target.startsWith("/")) return null;
    const fileSilent = silentMs(input.mtimeMs(target), input.now);
    if (fileSilent === null || fileSilent <= limitMs) return null;
    silent = fileSilent;
    reason = `the file it follows has gone silent: ${target}`;
  }
  return {
    kind: "shell",
    findingId: task.id,
    issueId: null,
    branchId: null,
    runId: null,
    taskId: null,
    agentType: null,
    agentId: null,
    shellId: task.id,
    command: task.command ?? null,
    silentMin: Math.floor(silent / MS_PER_MIN2),
    reason
  };
}
function probe(input) {
  const limitMs = silentLimitMs(input.env, input.load1, input.ncpu);
  const live = input.backgroundTasks.filter((t) => t.status === "running");
  const running = new Set(live.map((t) => t.id));
  const runAgents = new Set(input.runs.map((r) => r.spawnId));
  const found = [
    ...input.runs.filter((r) => r.agentType !== "bro").map((r) => runFinding(r, input, limitMs)),
    ...live.filter((t) => t.type === "subagent" && !runAgents.has(t.id)).map((t) => taskFinding(t, input, limitMs)),
    ...live.filter((t) => t.type === "shell").map((t) => shellFinding(t, running, input, limitMs))
  ];
  return found.filter((f) => f !== null);
}
function regularFileMtimeMs(path) {
  try {
    const st = statSync20(path);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}
function findMainTranscripts(sessionIds, env) {
  const found = /* @__PURE__ */ new Map();
  if (sessionIds.length === 0 || !env.HOME) return found;
  const projects = `${env.HOME}/.claude/projects`;
  let folders;
  try {
    folders = readdirSync6(projects);
  } catch {
    return found;
  }
  for (const folder of folders) {
    for (const id of sessionIds) {
      if (found.has(id)) continue;
      const path = `${projects}/${folder}/${id}.jsonl`;
      if (regularFileMtimeMs(path) !== null) found.set(id, path);
    }
  }
  return found;
}
function openRuns(db, env) {
  const out2 = gateRead(
    db,
    `SELECT COALESCE(json_group_array(json_object(
         'id', r.id, 'task_id', r.task_id, 'issue_id', COALESCE(r.issue_id, t.issue_id), 'branch_id', t.branch_id,
         'agent_type', r.agent_type, 'spawn_id', r.spawn_id, 'session_id', r.session_id, 'started_at', r.started_at)), '[]')
       FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.completed_at IS NULL AND r.agent_type <> 'bro';`,
    env
  );
  if (out2 === GATE_READ_ERROR || out2 === "") return null;
  return JSON.parse(out2).map((r) => ({
    id: r.id,
    taskId: r.task_id,
    issueId: r.issue_id,
    branchId: r.branch_id,
    agentType: r.agent_type,
    spawnId: r.spawn_id,
    sessionId: r.session_id,
    startedAt: r.started_at
  }));
}
function findingKey(kind, findingId) {
  return `${kind}:${findingId}`;
}
function reportedKeys(db, env) {
  const out2 = gateRead(
    db,
    `SELECT COALESCE(json_group_array(json_extract(content_json, '$.kind') || ':' || json_extract(content_json, '$.finding_id')), '[]')
       FROM audit WHERE event_type = 'liveness_finding_reported' AND json_valid(content_json);`,
    env
  );
  if (out2 === GATE_READ_ERROR || out2 === "") return null;
  return new Set(JSON.parse(out2));
}
function sweep(db, ctx, env) {
  const runs = openRuns(db, env);
  const reported = reportedKeys(db, env);
  if (runs === null || reported === null) return null;
  const others = [...new Set(runs.map((r) => r.sessionId).filter((s) => s !== null && s !== ctx.sessionId))];
  const input = {
    now: ctx.now,
    load1: loadavg()[0],
    ncpu: availableParallelism(),
    env,
    sessionId: ctx.sessionId,
    transcriptPath: ctx.transcriptPath,
    runs,
    backgroundTasks: ctx.tasks,
    mainTranscripts: findMainTranscripts(others, env),
    mtimeMs: regularFileMtimeMs
  };
  return {
    watching: ctx.tasks.some((t) => t.status === "running") || runs.some((r) => isOwnRun(r, input)),
    findings: probe(input).filter((f) => !reported.has(findingKey(f.kind, f.findingId)))
  };
}
function claimLivenessFinding(db, findings, now, env, gate) {
  const statements2 = [];
  for (const f of findings) {
    const content = jqCompact({
      kind: f.kind,
      finding_id: f.findingId,
      run_id: f.runId,
      task_id: f.taskId,
      agent_type: f.agentType,
      agent_id: f.agentId,
      shell_id: f.shellId,
      command: f.command,
      silent_min: f.silentMin,
      reason: f.reason
    });
    const guard2 = dedupeGuard(EVENT2, content, ["$.kind", "$.finding_id"], { caller: gate });
    const row = auditSql(
      {
        issueId: f.issueId === null ? SYSTEM_ISSUE : String(f.issueId),
        branchId: f.branchId ?? "",
        fromNode: `hook:${gate}`,
        eventType: EVENT2,
        summary: `${f.kind} ${f.findingId} silent ${f.silentMin} min`,
        contentJson: content
      },
      guard2.sql,
      { caller: gate, env, now: nowIso(now) }
    );
    if (guard2.code !== 0 || row.code !== 0) return null;
    statements2.push(row.sql, `SELECT '${sqlQuote(findingKey(f.kind, f.findingId))}' WHERE changes() = 1;`);
  }
  const w = dbWrite(db, statements2.join("\n"), { caller: gate, env });
  if (!w.ok) return null;
  const claimed = new Set(w.stdout.split("\n").map((l) => l.trim()));
  return findings.filter((f) => claimed.has(findingKey(f.kind, f.findingId)));
}
function oneLineCommand(command) {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > COMMAND_CHARS ? `${flat.slice(0, COMMAND_CHARS)}...` : flat;
}
function findingLine(f) {
  if (f.kind === "shell") {
    return `- shell ${f.shellId} (\`${oneLineCommand(f.command ?? "")}\`): silent ${f.silentMin} min; ${f.reason}.`;
  }
  const who = [
    f.runId === null ? null : `run ${f.runId}`,
    f.taskId === null ? null : `task ${f.taskId}`,
    f.agentType,
    f.agentId === null ? "agent id unbound" : `agent ${f.agentId}`
  ].filter((part) => part !== null);
  return `- ${who.join(", ")}: silent ${f.silentMin} min; ${f.reason}.`;
}
function findingReport(findings) {
  return [
    "TMB liveness: these look dead or hung.",
    ...findings.map(findingLine),
    "This is a report only: nothing was killed, closed or failed. Verify each one, tell the Human once, and use task_recover for a dead swe run."
  ].join("\n");
}
function isDir5(path) {
  try {
    return statSync20(path).isDirectory();
  } catch {
    return false;
  }
}
function livenessSessionsDir(env) {
  const project = env.CLAUDE_PROJECT_DIR ? `${env.CLAUDE_PROJECT_DIR}/${TMB_STATE_HOST_DIR}/${pluginName2(env)}` : "";
  if (project !== "" && isDir5(project)) return `${project}/sessions`;
  const db = dbPath(env);
  return db === null ? null : `${posixDirname(db)}/sessions`;
}
function writeStateFile(sessionsDir, name3, text) {
  try {
    mkdirSync5(sessionsDir, { recursive: true });
    const tmp = `${sessionsDir}/${name3}.${process.pid}.tmp`;
    writeFileSync5(tmp, text);
    renameSync3(tmp, `${sessionsDir}/${name3}`);
  } catch {
  }
}
function readStateFile(sessionsDir, name3) {
  try {
    return readFileSync13(`${sessionsDir}/${name3}`, "utf8");
  } catch {
    return null;
  }
}
function backgroundTasksOf(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((t) => {
    if (typeof t?.id !== "string" || t.type !== "shell" && t.type !== "subagent") return [];
    const { status } = t;
    return [{
      id: t.id,
      type: t.type,
      status: typeof status === "string" ? status : "",
      description: typeof t.description === "string" ? t.description : "",
      ...typeof t.command === "string" ? { command: t.command } : {},
      ...typeof t.firstSeen === "string" ? { firstSeen: t.firstSeen } : {}
    }];
  });
}
function readSnapshot(sessionsDir, sessionId) {
  const text = readStateFile(sessionsDir, `${sessionId}${SNAPSHOT_SUFFIX}`);
  if (text === null) return [];
  try {
    return backgroundTasksOf(JSON.parse(text));
  } catch {
    return [];
  }
}
function writeSnapshot(sessionsDir, sessionId, payloadTasks, now) {
  const seen = new Map(readSnapshot(sessionsDir, sessionId).map((t) => [t.id, t.firstSeen]));
  const tasks = backgroundTasksOf(payloadTasks).filter((t) => t.status === "running").map((t) => ({ ...t, firstSeen: seen.get(t.id) ?? now.toISOString() }));
  writeStateFile(sessionsDir, `${sessionId}${SNAPSHOT_SUFFIX}`, JSON.stringify(tasks));
  pruneStaleMarkers(sessionsDir, (name3) => name3.includes(MARKER_INFIX));
  return tasks;
}

// src/hooks/plugin-hooks-marker.ts
import { mkdirSync as mkdirSync6, statSync as statSync21 } from "node:fs";
var GATE_NAME24 = "plugin-hooks-marker";
var SUFFIX = ".plugin-hooks";
function safeSessionId(input) {
  const sid = commandSubstitution(jqAlternatives(commandSubstitution(input), [["session_id"]]));
  return sid === "" || sid.includes("/") || sid.startsWith(".") ? "" : sid;
}
function isDir6(path) {
  try {
    return statSync21(path).isDirectory();
  } catch {
    return false;
  }
}
function pluginHooksMarker(payload, env) {
  try {
    const sessionId = safeSessionId(payload);
    if (sessionId === "") return ALLOW;
    let stateDir2;
    if (env.CLAUDE_PROJECT_DIR) {
      stateDir2 = `${env.CLAUDE_PROJECT_DIR}/${TMB_STATE_HOST_DIR}/${pluginName2(env)}`;
    } else {
      const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
      if (db === null) return ALLOW;
      stateDir2 = posixDirname(db);
    }
    if (!isDir6(stateDir2)) return ALLOW;
    const sessions = `${stateDir2}/sessions`;
    try {
      mkdirSync6(sessions, { recursive: true });
    } catch {
      return ALLOW;
    }
    pruneStaleMarkers(sessions, (name3) => name3.endsWith(SUFFIX));
    touchEmpty(`${sessions}/${sessionId}${SUFFIX}`);
  } catch {
  }
  return ALLOW;
}

// src/hooks/liveness-alert.ts
var GATE_NAME25 = "liveness-alert";
var THROTTLE_MS = 5 * 6e4;
var THROTTLE_SUFFIX = ".liveness-throttle";
function throttled(lastProbe, now) {
  if (lastProbe === null) return false;
  const since = now.getTime() - Number(lastProbe);
  return since >= 0 && since < THROTTLE_MS;
}
function makeLivenessAlert(clock = () => /* @__PURE__ */ new Date()) {
  return (payload, env) => {
    if (agentRole(payload) !== "bro") return ALLOW;
    const sessionId = safeSessionId(payload);
    const sessionsDir = sessionId === "" ? null : livenessSessionsDir(env);
    if (sessionsDir === null) return ALLOW;
    const now = clock();
    const throttleFile = `${sessionId}${THROTTLE_SUFFIX}`;
    if (throttled(readStateFile(sessionsDir, throttleFile), now)) return ALLOW;
    writeStateFile(sessionsDir, throttleFile, String(now.getTime()));
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const transcriptPath = jqAlternatives(payload, [["transcript_path"]]);
    const found = sweep(db, { now, sessionId, transcriptPath, tasks: readSnapshot(sessionsDir, sessionId) }, env);
    if (found === null || found.findings.length === 0) return ALLOW;
    const claimed = claimLivenessFinding(db, found.findings, now, env, GATE_NAME25);
    if (claimed === null || claimed.length === 0) return ALLOW;
    const event = jqAlternatives(payload, [["hook_event_name"]]) || "UserPromptSubmit";
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: findingReport(claimed) } })}
`, code: 0 };
  };
}
var livenessAlert = makeLivenessAlert();

// src/hooks/liveness-sentinel.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
var GATE_NAME26 = "liveness-sentinel";
var POLL_ENV = "TMB_LIVENESS_POLL_S";
var DEFAULT_POLL_S = 60;
var TOKEN_SUFFIX = ".liveness-token";
function pollMs(env) {
  const raw = env[POLL_ENV] ?? "";
  const seconds2 = /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_POLL_S;
  return seconds2 * 1e3;
}
function payloadFields(payload) {
  const [value] = jsonValues(payload);
  const transcript = value?.transcript_path;
  return { backgroundTasks: value?.background_tasks, transcriptPath: typeof transcript === "string" ? transcript : "" };
}
function makeLivenessSentinel(clock = () => /* @__PURE__ */ new Date()) {
  return async (payload, env) => {
    const sessionId = safeSessionId(payload);
    const sessionsDir = sessionId === "" ? null : livenessSessionsDir(env);
    if (sessionsDir === null) return ALLOW;
    const { backgroundTasks, transcriptPath } = payloadFields(payload);
    const tasks = writeSnapshot(sessionsDir, sessionId, backgroundTasks, clock());
    if (env.CLAUDE_CODE_SESSION_ATTENDED !== "1") return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const tokenFile = `${sessionId}${TOKEN_SUFFIX}`;
    const token = randomUUID2();
    writeStateFile(sessionsDir, tokenFile, token);
    const parent = process.ppid;
    for (; ; ) {
      if (readStateFile(sessionsDir, tokenFile) !== token || process.ppid !== parent) return ALLOW;
      const now = clock();
      const found = sweep(db, { now, sessionId, transcriptPath, tasks }, env);
      if (found !== null) {
        if (found.findings.length > 0) {
          const claimed = claimLivenessFinding(db, found.findings, now, env, GATE_NAME26);
          if (claimed === null || claimed.length === 0) return ALLOW;
          return { stdout: "", code: 2, stderr: `${findingReport(claimed)}
` };
        }
        if (!found.watching) return ALLOW;
      }
      await sleep(pollMs(env));
    }
  };
}
var livenessSentinel = makeLivenessSentinel();

// src/hooks/activation-routine.ts
import { spawnSync as spawnSync9 } from "node:child_process";
import { readFileSync as readFileSync14, statSync as statSync22 } from "node:fs";

// src/hooks/cmd-analysis/harness-turn.ts
var HARNESS_MARKS = [
  "<task-notification>",
  "[SYSTEM NOTIFICATION",
  "Another Claude session sent a message",
  "[Subagent hand-back]",
  "<agent-message",
  "<cross-session-message"
];
function isHarnessTurn(prompt) {
  return HARNESS_MARKS.some((mark) => prompt.includes(mark));
}

// src/hooks/activation-routine.ts
var GATE_NAME27 = "activation-routine";
var HALT_TEXT = "\u26D4 MCP trajectory-server is not running at this prompt \u2014 trajectory tools (state reads and writes) are unreachable. Bro: HALT. Do not dispatch work; load tmb_recovery \xA7B and follow it. The read-only sqlite3 fallback (bro-sqlite-readonly.sh) stays available for emergency reads.";
var FIRST_RUN_LINE = "onboarded=<no \u2014 FIRST CONTACT, auto-fire /onboard before any reply>";
var SESSION_ID_LINE = /^[A-Za-z0-9_-]{8,64}$/;
var TOOL_CALLS_LIMIT = 150;
var CONTEXT_PER_CALL_LIMIT = 6e4;
var LocaleGrep = class {
  constructor(utf8) {
    this.utf8 = utf8;
    this.word = utf8 ? "[\\p{L}\\p{Nd}_]" : "[A-Za-z0-9_]";
    this.flags = utf8 ? "u" : "";
  }
  utf8;
  word;
  flags;
  /** <source> with `\b` as grep's word boundary under this locale. */
  regex(source, ignoreCase = false) {
    const w = this.word;
    const boundary = `(?:(?<!${w})(?=${w})|(?<=${w})(?!${w}))`;
    const body2 = source.replace(/\\b/g, boundary).replace(/(^|[^\\])\./g, "$1[^\\n]");
    return new RegExp(body2, `${this.flags}${ignoreCase ? "i" : ""}`);
  }
  /** The lines of <bytes> as grep sees them: undefined for a line it cannot match. */
  lines(bytes) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const out2 = [];
    let start2 = 0;
    while (start2 <= bytes.length) {
      let end = bytes.indexOf(10, start2);
      if (end < 0) end = bytes.length;
      if (end === bytes.length && start2 === end && start2 > 0) break;
      const line = bytes.subarray(start2, end);
      if (!this.utf8) out2.push(line.toString("latin1"));
      else {
        try {
          out2.push(decoder.decode(line));
        } catch {
          out2.push(void 0);
        }
      }
      start2 = end + 1;
    }
    return out2;
  }
  test(bytes, re) {
    return this.lines(bytes).some((line) => line !== void 0 && re.test(line));
  }
};
function readTranscript3(path) {
  if (path === "") return null;
  try {
    if (!statSync22(path).isFile()) return null;
    return readFileSync14(path);
  } catch {
    return null;
  }
}
function isStickyBro(transcript, grep) {
  if (transcript === null) return false;
  if (grep.test(transcript, grep.regex("exit bro mode|stop being bro", true))) return false;
  return grep.test(transcript, grep.regex("Entering bro mode.")) || grep.test(transcript, grep.regex("@bro\\b", true));
}
function saysBro(prompt, grep) {
  return !isHarnessTurn(prompt) && grep.test(Buffer.from(`${prompt}
`, "utf8"), grep.regex("\\bbro\\b", true));
}
function serverDown(env) {
  if (!commandOnPath2("pgrep", env)) return false;
  try {
    return spawnSync9("pgrep", ["-f", "trajectory-server/dist/index.js"], { env, stdio: "ignore" }).status === 1;
  } catch {
    return false;
  }
}
var emit = (context4) => ({
  stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context4 } })}
`,
  code: 0
});
function activationContext(onboardedCount, pending2) {
  let pendingLine = "pending=<none>";
  if (pending2 !== "") {
    const bar = pending2.indexOf("|");
    const id = bar < 0 ? pending2 : pending2.slice(0, bar);
    const objective = bar < 0 ? pending2 : pending2.slice(bar + 1);
    pendingLine = `pending=#${id}: ${objective}`;
  }
  if (onboardedCount === "0") {
    return `[tmb activation routine \u2014 pre-fetched by hook] ${FIRST_RUN_LINE}. ACTION: this is the user's first contact in this project \u2014 call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call issue_resume separately \u2014 onboard_state_get returns everything you need. ${pendingLine}`;
  }
  return `[tmb activation routine \u2014 pre-fetched by hook] onboarded=yes. Use this to compose the welcome banner; do NOT also call issue_resume \u2014 they would be redundant duplicate reads. ${pendingLine}`;
}
function usageWarning(toolUses2, cacheReadTokens) {
  if (toolUses2 <= 0) return "";
  const contextPerCall = Math.ceil(cacheReadTokens / toolUses2);
  const passed = [];
  if (toolUses2 > TOOL_CALLS_LIMIT) passed.push(`${toolUses2} tool calls (limit ${TOOL_CALLS_LIMIT})`);
  if (contextPerCall > CONTEXT_PER_CALL_LIMIT) passed.push(`${contextPerCall} context per call (limit ${CONTEXT_PER_CALL_LIMIT})`);
  if (passed.length === 0) return "";
  return `\u26A0\uFE0F This bro session is past its usage limits: ${passed.join(", ")}. Finish what is in flight, then end the session and resume cold from the DB.`;
}
function sessionUsageWarning(db, sessionId, env) {
  if (!SESSION_ID_LINE.test(sessionId)) return "";
  try {
    const row = sqliteRo(
      db,
      `SELECT COALESCE(tool_uses, 0), COALESCE(cache_read_tokens, 0) FROM agent_runs WHERE agent_type='bro' AND task_id IS NULL AND session_id='${sessionId}' ORDER BY id DESC LIMIT 1;`,
      env
    );
    const usage = /^([0-9]+)\|([0-9]+)$/.exec(row);
    return usage === null ? "" : usageWarning(Number(usage[1]), Number(usage[2]));
  } catch {
    return "";
  }
}
function activationRoutine(payload, env) {
  try {
    const echoed = `${commandSubstitution(payload)}
`;
    const field6 = (key2) => commandSubstitution(jqFieldOr(echoed, key2));
    const prompt = field6("prompt");
    const grep = new LocaleGrep(setlocaleUtf8(env));
    if (!saysBro(prompt, grep) && !isStickyBro(readTranscript3(field6("transcript_path")), grep)) return ALLOW;
    const halt = serverDown(env) ? HALT_TEXT : "";
    const haltOnly = () => halt !== "" ? emit(halt) : ALLOW;
    const db = dbPathAdvisory(GATE_NAME27, env, (line) => process.stderr.write(`${line}
`));
    if (db === null || !haveSqlite(env)) return haltOnly();
    const onboarded = sqliteRo(db, "SELECT COUNT(*) FROM plugin_config WHERE key='onboarded' AND value_json='true';", env);
    const pending2 = sqliteRo(
      db,
      "SELECT id, COALESCE(objective, '') FROM issues WHERE status='open' AND id > 0 ORDER BY id DESC LIMIT 1;",
      env
    );
    let context4 = activationContext(onboarded, pending2);
    if (halt !== "") context4 = `${halt} ${context4}`;
    const sessionId = field6("session_id");
    if (sessionId.split("\n").some((line) => SESSION_ID_LINE.test(line))) context4 = `${context4} session_id=${sessionId}`;
    const warning = sessionUsageWarning(db, sessionId, env);
    if (warning !== "") context4 = `${context4}
${warning}`;
    return emit(context4);
  } catch {
    return ALLOW;
  }
}

// src/hooks/debug-trajectory.ts
var GATE_NAME28 = "debug-trajectory";
var ARGS_MAX_BYTES = 4e3;
var pad = (n3) => String(n3).padStart(2, "0");
function hourStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}`;
}
function argsJson(input) {
  const lines2 = jqMap(input, (value) => `${jqCompact(jqOr(jqIndex(value, "tool_input"), {}))}
`, jqLiteralNumbers).join("");
  return commandSubstitution(Buffer.from(lines2, "utf8").subarray(0, ARGS_MAX_BYTES).toString("utf8")) || "{}";
}
function debugTrajectorySql(sessionId, tool, args2, now) {
  const sid = sqlQuote(sessionId);
  return `INSERT INTO debug_trajectory (session_id, step_n, kind, tool_or_mcp_name, args_json, created_at)
VALUES (
  '${sid}',
  COALESCE((SELECT MAX(step_n) FROM debug_trajectory WHERE session_id='${sid}'), 0) + 1,
  'tool_use',
  '${sqlQuote(tool)}',
  json('${sqlQuote(args2)}'),
  '${sqlQuote(now)}'
);`;
}
function debugTrajectory(payload, env) {
  try {
    if ((env.TMB_EVAL_MODE || "0") !== "1" || (env.TMB_DEBUG_TRAJECTORY || "0") !== "1") return ALLOW;
    const writeEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: "500", TMB_DB_WRITE_RUN_BUDGET_MS: "1200" };
    const db = dbPathAdvisory(GATE_NAME28, writeEnv, (line) => process.stderr.write(`${line}
`));
    if (db === null) return ALLOW;
    const echoed = `${commandSubstitution(payload)}
`;
    const tool = commandSubstitution(jqAlternatives(echoed, [["tool_name"], ["tool"]]));
    if (tool === "" || tool.startsWith("mcp__")) return ALLOW;
    const sessionId = env.CLAUDE_SESSION_ID || hourStamp(/* @__PURE__ */ new Date());
    const w = dbWrite(db, debugTrajectorySql(sessionId, tool, argsJson(echoed), nowIso()), { caller: GATE_NAME28, env: writeEnv });
    if (!w.ok) process.stderr.write(`${w.error}
`);
    return { stdout: w.stdout, code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/session-log-capture.ts
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync7, readFileSync as readFileSync15, statSync as statSync23 } from "node:fs";
var GATE_NAME29 = "session-log-capture";
var CONTINUE = '{"continue": true}\n';
function utcStamp2(date) {
  const iso2 = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = iso2.slice(0, 10);
  return { day, compact: `${day.replace(/-/g, "")}-${iso2.slice(11, 19).replace(/:/g, "")}`, iso: iso2 };
}
function sentinelId(sentinel) {
  try {
    if (!statSync23(sentinel).isFile()) return "";
    return commandSubstitution(readFileSync15(sentinel, "utf8"));
  } catch {
    return "";
  }
}
function logLines(input, ts) {
  return jqMap(
    input,
    (value) => `${jqCompact({
      ts,
      event: "user_prompt",
      prompt: jqOr(jqIndex(value, "prompt"), ""),
      additional_context: jqOr(jqIndex(value, "additionalContext"), "")
    })}
`,
    jqLiteralNumbers
  ).join("");
}
function sessionLogCapture(payload, env) {
  try {
    const plugin = resolvePluginName(env);
    const echoed = `${commandSubstitution(payload)}
`;
    const db = dbPath(env);
    if (db === null || db === "") return ALLOW;
    const workspace = posixDirname(posixDirname(posixDirname(db)));
    const logDir = `${workspace}/.claude/${plugin}/logs`;
    try {
      mkdirSync7(logDir, { recursive: true });
    } catch {
      return ALLOW;
    }
    const now = utcStamp2(/* @__PURE__ */ new Date());
    const sessionId = commandSubstitution(jqFieldOr(echoed, "session_id")) || sentinelId(`${workspace}/.claude/${plugin}/.current-session-id`) || `${now.compact}-${process.pid}`;
    try {
      appendFileSync3(`${logDir}/${now.day}-${sessionId}.jsonl`, logLines(echoed, now.iso));
    } catch {
    }
    return { stdout: CONTINUE, code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/session-start-persona.ts
var GATE_NAME30 = "session-start-persona";
function sessionStartPersona(payload, env) {
  try {
    const input = commandSubstitution(payload);
    const persona = personaInit(env);
    if (persona === null) return ALLOW;
    const context4 = personaContext(persona, env);
    if (context4 === null) return ALLOW;
    const stdout = personaEmit(persona, "SessionStart", context4);
    personaMark(persona, personaSessionId(input, persona.haveJq), "persona");
    return { stdout, code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/user-prompt-persona.ts
import { existsSync as existsSync11 } from "node:fs";
var GATE_NAME31 = "user-prompt-persona";
var PERSONA_UNREADABLE_NOTICE = `{"systemMessage":"TMB could not read the plugin CLAUDE.md that carries bro's persona, so this session runs without it. Start a new Claude Code session to load it."}
`;
function userPromptPersona(payload, env) {
  try {
    const haveJq = commandOnPath2("jq", env);
    const sessionId = personaSessionId(commandSubstitution(payload), haveJq);
    if (sessionId === "") return ALLOW;
    const persona = personaInit(env, haveJq);
    if (persona === null) return ALLOW;
    if (existsSync11(personaMarker(persona, sessionId, "persona"))) return ALLOW;
    const context4 = personaContext(persona, env);
    if (context4 !== null) {
      const stdout = personaEmit(persona, "UserPromptSubmit", context4);
      personaMark(persona, sessionId, "persona");
      return { stdout, code: 0 };
    }
    if (existsSync11(personaMarker(persona, sessionId, "persona-notice"))) return ALLOW;
    personaMark(persona, sessionId, "persona-notice");
    return { stdout: PERSONA_UNREADABLE_NOTICE, code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/prompt-intent-hints.ts
import { statSync as statSync24 } from "node:fs";
import { fileURLToPath as fileURLToPath5, pathToFileURL as pathToFileURL2 } from "node:url";

// src/hooks/lib/jq-raw.ts
var JqUnindexable = class extends Error {
};
var isRawJson2 = (value) => JSON.isRawJSON?.(value) ?? false;
var textReviver = function(key2, value, context4) {
  if (typeof value === "string") return wellFormed(value);
  return jqLiteralNumbers ? jqLiteralNumbers.call(this, key2, value, context4) : value;
};
function jqInput(payload) {
  const text = payload.replace(/\0/g, "");
  const stream = jsonStream(text);
  return { values: jsonValues(text, textReviver).slice(0, stream.values.length), complete: stream.complete };
}
function jqGet(value, ...keys) {
  let v = value;
  for (const key2 of keys) {
    if (v === null || v === void 0) return null;
    if (typeof v !== "object" || Array.isArray(v) || isRawJson2(v)) throw new JqUnindexable(`Cannot index with "${key2}"`);
    v = Object.hasOwn(v, key2) ? v[key2] : null;
  }
  return v ?? null;
}
function jqAlt2(value, fallback) {
  return value !== null && value !== void 0 && value !== false ? value : fallback;
}
function jqTostring(value) {
  return typeof value === "string" ? value : jqCompact(value);
}
function jqRaw2(value) {
  if (typeof value === "string") return value;
  return stringifyInOrder(value, 2).replace(/\x7f/g, "\\u007f");
}
function jqCapture(input, keys, orEmpty2 = false) {
  const lines2 = [];
  for (const value of input.values) {
    let v;
    try {
      v = jqGet(value, ...keys);
    } catch (e) {
      if (e instanceof JqUnindexable) continue;
      throw e;
    }
    const picked = jqAlt2(v, orEmpty2 ? null : "");
    if (picked !== null) lines2.push(jqRaw2(picked));
  }
  return shellCapture2(lines2.join("\n"));
}
function jqNumber2(digits) {
  const raw = JSON.rawJSON;
  const literal = jqNumberLiteral(digits);
  return raw ? raw(literal) : Number(literal);
}

// src/hooks/agent-arg-matches-caller.ts
var GATE_NAME32 = "agent-arg-matches-caller";
var WRITE_RUN_BUDGET_MS = "2500";
var TRAJECTORY_TOOL = /^mcp__.*trajectory-server__/s;
var TOOL_PREFIX = "trajectory-server__";
var TR_UNMAPPED = /[ᲉꟋꟌ꟎꟒꟔ꟚꟜ\u{10D50}-\u{10D65}\u{16EA0}-\u{16EB8}]/u;
var TR_OVERRIDES = /* @__PURE__ */ new Map([
  ["\u0130", "i"],
  ["\u038E", "\u03CE"],
  ["\u038F", "\u03CF"]
]);
function trLower(text, env) {
  if (!setlocaleUtf8(env)) return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return text.replace(new RegExp("\\p{Lu}", "gu"), (c) => {
    const mapped = TR_OVERRIDES.get(c);
    if (mapped !== void 0) return mapped;
    if (TR_UNMAPPED.test(c)) return c;
    const lower = c.toLowerCase();
    return [...lower].length === 1 ? lower : c;
  });
}
function gsubString(value) {
  if (typeof value !== "string") throw new JqUnindexable("cannot be matched, as it is not a string");
  return value.replace(/[\n\r\x1f]/g, " ").replace(/\0/g, "");
}
function fieldsOf(value) {
  return {
    tool: gsubString(jqAlt2(jqGet(value, "tool_name"), "")),
    given: gsubString(jqTostring(jqAlt2(jqGet(value, "tool_input", "agent"), ""))),
    actual: gsubString(jqAlt2(jqAlt2(jqGet(value, "agent_type"), jqGet(value, "subagent_type")), "")),
    task: gsubString(jqTostring(jqAlt2(jqGet(value, "tool_input", "task_id"), "")))
  };
}
function callFields(payload) {
  const input = jqInput(payload);
  if (!input.complete) return null;
  let first = null;
  let lastFailed = false;
  for (const value of input.values) {
    try {
      const f = fieldsOf(value);
      first ??= f;
      lastFailed = false;
    } catch (e) {
      if (!(e instanceof JqUnindexable)) throw e;
      lastFailed = true;
    }
  }
  return lastFailed ? null : first;
}
function denyJson(reason) {
  return `${jqCompact({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
  })}
`;
}
function recordMismatch(env, toolShort, f, actual, caller) {
  const db = dbPath(env);
  if (db === null) return;
  const taskId = sqlInt(f.task);
  let issue = "-1";
  if (taskId !== "") {
    const found = sqlInt(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env));
    if (found !== "") issue = found;
  }
  const content = jqCompact({ tool: toolShort, given: f.given, actual, task_id: taskId === "" ? null : jqNumber2(taskId) });
  auditAppend(
    db,
    {
      issueId: issue,
      branchId: "",
      fromNode: `hook:${GATE_NAME32}`,
      eventType: "agent_arg_mismatch",
      summary: `${toolShort}: agent='${f.given}' but the caller is ${caller}`,
      contentJson: content
    },
    { env: { ...env, TMB_DB_WRITE_RUN_BUDGET_MS: WRITE_RUN_BUDGET_MS }, caller: GATE_NAME32 }
  );
}
var agentArgMatchesCaller = (payload, env) => {
  const f = callFields(payload);
  if (f === null || f.given === "") return ALLOW;
  if (!TRAJECTORY_TOOL.test(f.tool)) return ALLOW;
  const given = trLower(normalizeRole(f.given), env);
  const actual = trLower(normalizeRole(f.actual), env) || "bro";
  if (given === actual) return ALLOW;
  const toolShort = f.tool.slice(f.tool.lastIndexOf(TOOL_PREFIX) + TOOL_PREFIX.length);
  const caller = f.actual === "" ? "the main session (bro)" : `a ${actual} subagent`;
  dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (dbState(env) === "ok") recordMismatch(env, toolShort, f, actual, caller);
  return {
    stdout: denyJson(`BLOCKED: ${toolShort} called with agent='${f.given}' but the caller is ${caller}; pass agent='${actual}'.`),
    code: 0
  };
};

// src/hooks/prompt-intent-hints.ts
var GATE_NAME33 = "prompt-intent-hints";
var SUMMARY_MAX_BYTES = 200;
var C_SPACE = "\\t\\n\\v\\f\\r ";
var UTF8_SPACE = `${C_SPACE}\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000`;
var INJECTED_TAGS = ["system-reminder", "pasted_content", "agent-message"];
var SEARCH_PATTERNS = [
  "why did we",
  "why we chose",
  "why we picked",
  "why we decided",
  "what was the rationale",
  "what is the rationale",
  "what did we decide",
  "what was decided",
  "what was our decision",
  "how did we decide",
  "when did we decide",
  "rationale for",
  "reasoning behind",
  "past decision",
  "prior decision",
  "previous decision",
  "find the discussion",
  "search the discussion",
  "search discussions",
  "recall why",
  "remind me why"
];
var CONCERNS_PATTERNS = [
  "delete the test",
  "remove the test",
  "skip the test",
  "skip the tests",
  "skip validation",
  "skip verification",
  "skip the gate",
  "force push",
  "ignore the gate",
  "just do it",
  "just push it",
  "bypass the check",
  "weaken the assertion",
  "loosen the check",
  "just delete",
  "just remove",
  "switch to approxequal",
  "use approxequal",
  "replace exact equality",
  "change to approx",
  "approxequal with tolerance"
];
var PUSH_PATTERNS = [
  "git push",
  "push it",
  "push the work",
  "push the branch",
  "push the change",
  "push up",
  "push them up",
  "push my work",
  "ship it",
  "ship the work",
  "send it up",
  "time to push"
];
var REONBOARD_PATTERNS = [
  "available on github",
  "available on gitlab",
  "available on a remote",
  "host on github",
  "host on gitlab",
  "host it on github",
  "host it on gitlab",
  "push to github",
  "push to gitlab",
  "put this on github",
  "put this on gitlab",
  "put it on github",
  "put it on gitlab",
  "publish to github",
  "publish to gitlab",
  "switch to remote",
  "go remote",
  "add a remote",
  "set up a remote",
  "set up the remote",
  "add github remote",
  "add gitlab remote",
  "live on a remote",
  "live on github",
  "live on gitlab",
  "lives on a remote",
  "lives on github",
  "lives on gitlab",
  "needs to live on",
  "needs a remote",
  "change my issue tracker",
  "switch issue tracker",
  "switch to gitflow",
  "switch to git-flow",
  "switch to github-flow",
  "switch to github flow",
  "change branching model",
  "change the branching model",
  "switch branching model",
  "change pr target",
  "change the pr target",
  "update pr target",
  "update the pr target"
];
var HEADLESS_PATTERNS = [
  "claude -p",
  "claude --print",
  "headless",
  "non-interactive",
  "noninteractive",
  "in ci",
  "ci run",
  "ci pipeline",
  "github actions",
  "gitlab ci"
];
var HEADLESS_INVOCATIONS = /* @__PURE__ */ new Set(["claude -p", "claude --print"]);
var RESUME_PATTERNS = [
  "keep going",
  "pick it up",
  "pick that up",
  "pick this up",
  "pick up",
  "let's continue",
  "continue the work",
  "continue with",
  "resume",
  "finish that",
  "finish the",
  "finish it",
  "wrap that up",
  "wrap up",
  "still pending",
  "still open",
  "still waiting"
];
var ADR_PATTERNS = [
  "switch to clerk",
  "switch to auth0",
  "switch to okta",
  "swap our auth",
  "switch our auth",
  "change our auth",
  "migrate to postgres",
  "migrate to mysql",
  "migrate from postgres",
  "migrate from mysql",
  "switch to sqlite",
  "switch to postgres",
  "switch to mysql",
  "migrate storage",
  "swap our db",
  "swap the db",
  "switch our db",
  "replace our db",
  "introduce a new service",
  "new service boundary",
  "new module boundary",
  "public api",
  "new public api",
  "change the public api",
  "strategic stack",
  "production db",
  "retention policy",
  "use react instead",
  "use vue instead",
  "use svelte instead",
  "use fastapi instead",
  "use django instead",
  "use flask instead",
  "replatform",
  "extract the storage layer",
  "extract the storage",
  "storage interface",
  "storage backend",
  "backend interface",
  "pluggable backend",
  "pluggable storage",
  "swap between",
  "plugin loader",
  "plugin architecture",
  "dependency inversion"
];
var AUDIT_WORDS = ["audit", "verify", "double-check", "check", "architecture"];
var ADVISORY_SHAPES = [
  "?",
  "should we use",
  "should we keep",
  "should we move",
  "should we commit to",
  "should we",
  "should i",
  "recommend",
  "trade-off",
  "tradeoff",
  "your take",
  "your view",
  "your read",
  "which one",
  "which of",
  "is it safe",
  "is it ok",
  "is it better",
  "implication",
  "better to use"
];
var DOMAINS = [
  ["security", ["security", "vulnerability", "injection", "xss", "csrf", "auth bypass"]],
  ["perf", ["latency", "throughput", "bottleneck", "scaling", " scale", "benchmark"]],
  ["legal", ["legal", "licensing", "compliance", "gdpr", "pii", "copyright"]],
  ["architect", ["architecture decision", "design choice", "adr", "architecture trade", "architectural trade"]],
  ["architect", ["json or sqlite", "sqlite or postgres", "postgres or sqlite", "sqlite vs postgres", "sql or nosql"]]
];
var CHEATCODE_INSTALL_CTX = "[tmb cheatcode-install routing] This is a cheatcode install, NOT agent/consultant creation. Record the per-candidate approval (cheatcode_approve) then call cheatcode_install with the requested scope (default local). Do NOT call agent_resolve / /tmb:agent-create for these names.";
var SEARCH_CTX_TAIL = `

Prefer the *_search MCP tools over linear scans:
- \`discussion_search(query='<key terms>', mode='hybrid')\` returns ranked snippets across ALL issues (keyword + semantic). Use this first.
- \`audit_search(query='<key terms>')\` for event-history grounding.
- \`world_model_search(query='<key terms>')\` for code-context / project-structure grounding.

Only fall back to \`discussion_list(issue_id=N)\` / \`issue_get_with_discussions\` once \`discussion_search\` has narrowed the candidate set \u2014 those tools enumerate, they don't rank. Hybrid mode auto-falls-back to keyword if the embedding model is offline (\`warning: 'semantic_unavailable'\`).`;
var PENDING_SQL = `
        SELECT t.id || '|' || t.branch_id || '|' || substr(COALESCE(t.title, ''), 1, 60)
          FROM tasks t
         WHERE t.status IN ('needs_validation', 'completed', 'closed')
           AND t.commit_sha IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM validation_attempts v
              WHERE v.task_id = t.id
                AND v.verdict = 'pass'
           );
      `;
var RESUME_SQL = `
        SELECT
          t.id,
          t.issue_id,
          COALESCE(t.branch_id, ''),
          replace(substr(COALESCE(t.title, ''), 1, 60), '|', '/'),
          substr(COALESCE(i.objective, ''), 1, 80)
        FROM tasks t
        JOIN issues i ON i.id = t.issue_id
        JOIN audit a ON a.issue_id = i.id AND a.event_type = 'planning_complete'
        WHERE t.status = 'pending'
          AND i.status = 'open'
        ORDER BY a.id DESC
        LIMIT 1;
      `;
var CONSULTANTS_SQL = "SELECT name FROM agents WHERE kind='consultant';";
var ONBOARDED_SQL = "SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true' LIMIT 1;";
var HEADLESS_WANTED_SQL = `SELECT 1 WHERE EXISTS (SELECT 1 FROM plugin_config WHERE key='onboarded' AND value_json='true') AND NOT EXISTS (SELECT 1 FROM plugin_config WHERE key='headless_enforcement' AND value_json='"yes"');`;
function hasNonSpace(text, utf8) {
  return new RegExp(`[^${utf8 ? UTF8_SPACE : C_SPACE}]`, "u").test(text);
}
function stripBashSpans(text) {
  return text.replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, "");
}
function openingTag(s, tag) {
  let k = s.indexOf(`<${tag}`);
  while (k >= 0) {
    const c = s.charAt(k + tag.length + 1);
    if (c === ">" || c === " " || c === "	" || c === "\n") return k;
    k = s.indexOf(`<${tag}`, k + 1);
  }
  return -1;
}
function stripInjectedBlocks(text) {
  let buf = text;
  let out2 = "";
  for (; ; ) {
    let first = -1;
    let tag = "";
    for (const t of INJECTED_TAGS) {
      const k = openingTag(buf, t);
      if (k >= 0 && (first < 0 || k < first)) {
        first = k;
        tag = t;
      }
    }
    if (first < 0) break;
    const closeTag = `</${tag}>`;
    const e = buf.indexOf(closeTag, first);
    if (e < 0) {
      out2 += buf.slice(0, first + 1);
      buf = buf.slice(first + 1);
      continue;
    }
    out2 += `${buf.slice(0, first)} `;
    buf = buf.slice(e + closeTag.length);
  }
  return commandSubstitution(out2 + buf);
}
var AWK_ALNUM = /[A-Za-z0-9]/;
var AWK_SPACE = /[\t\n\v\f\r ]/;
function stripQuotedSpans(text) {
  const n3 = text.length;
  let out2 = "";
  let i2 = 0;
  while (i2 < n3) {
    const c = text[i2];
    let j = -1;
    if (c === "`") {
      j = text.indexOf("`", i2 + 1);
    } else if ((c === "'" || c === '"') && (i2 === 0 || !AWK_ALNUM.test(text[i2 - 1])) && i2 + 1 < n3 && !AWK_SPACE.test(text[i2 + 1])) {
      for (let k = i2 + 2; k < n3; k++) {
        if (text[k] === c && (k === n3 - 1 || !AWK_ALNUM.test(text[k + 1]))) {
          j = k;
          break;
        }
      }
    }
    if (j >= 0) {
      out2 += " ";
      i2 = j + 1;
      continue;
    }
    out2 += c;
    i2 += 1;
  }
  return commandSubstitution(out2);
}
function stripFencedBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, " ");
}
function splitClauses(text) {
  const out2 = [];
  for (const line of text.split("\n")) {
    for (const piece of line.split(/(?<=[.;?!])/)) {
      out2.push({ text: piece.replace(/[.;?!]$/, ""), question: piece.endsWith("?") });
    }
  }
  return out2;
}
function codePointBefore(text, k) {
  if (k <= 0) return "";
  const low = text.charCodeAt(k - 1);
  if (k >= 2 && low >= 56320 && low <= 57343) {
    const high = text.charCodeAt(k - 2);
    if (high >= 55296 && high <= 56319) return text.slice(k - 2, k);
  }
  return text[k - 1];
}
function codePointAt(text, k) {
  if (k >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(k) ?? 0);
}
function globAz(c, utf8) {
  if (c === "") return false;
  if (/^[a-z]$/.test(c)) return true;
  if (!utf8) return false;
  return new RegExp("^\\p{Script=Latin}$", "u").test(c) && !c.normalize("NFD").startsWith("Z");
}
function hasWord(word, text, utf8) {
  let k = text.indexOf(word);
  while (k >= 0) {
    if (!globAz(codePointBefore(text, k), utf8) && !globAz(codePointAt(text, k + word.length), utf8)) return true;
    k = text.indexOf(word, k + 1);
  }
  return false;
}
var awkWord = (c) => /^[a-z0-9_]$/.test(c);
function hasTarget(tail, agent) {
  for (const prep of ["for", "to", "onto"]) {
    const needle = `${prep} ${agent}`;
    let k = tail.indexOf(needle);
    while (k >= 0) {
      const before2 = k === 0 ? "" : tail[k - 1];
      const after2 = tail.charAt(k + needle.length);
      if (!awkWord(before2) && !awkWord(after2) && after2 !== "-") return true;
      k = tail.indexOf(needle, k + 1);
    }
  }
  return false;
}
function capabilityOnAgent(lower, agents) {
  for (const clause of splitClauses(lower)) {
    const s = clause.text.replace(/[ \t]+/g, " ");
    const verb = /install|add/g;
    let m;
    while ((m = verb.exec(s)) !== null) {
      const v = m.index;
      const e = v + m[0].length;
      if ((v === 0 || !awkWord(s[v - 1])) && !awkWord(s.charAt(e))) {
        const tail = s.slice(e);
        for (const agent of agents) if (hasTarget(tail, agent)) return agent;
      }
      verb.lastIndex = v + 1;
    }
  }
  return "";
}
function wholePhrase(pattern) {
  return new RegExp(`(^|[^a-z0-9_])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`);
}
function headlessMatch(promptRaw, env) {
  const open = trLower(stripQuotedSpans(stripFencedBlocks(promptRaw)), env);
  const statements2 = splitClauses(open).filter((c) => !c.question).map((c) => c.text).join("\n");
  return HEADLESS_PATTERNS.find((pat) => wholePhrase(pat).test(HEADLESS_INVOCATIONS.has(pat) ? statements2 : open)) ?? "";
}
function readPipeFields(text, n3) {
  let rest = text.split("\n")[0];
  const out2 = [];
  for (let i2 = 0; i2 < n3 - 1; i2++) {
    const k = rest.indexOf("|");
    out2.push(k < 0 ? rest : rest.slice(0, k));
    rest = k < 0 ? "" : rest.slice(k + 1);
  }
  out2.push(/^[^|]*\|$/.test(rest) ? rest.slice(0, -1) : rest);
  return out2;
}
function pendingList(pending2) {
  return pending2.split("\n").map((line) => {
    const f = line.split("|");
    return `  - task_id=${f[0] ?? ""}  branch=${f[1] ?? ""}  (${f[2] ?? ""})`;
  }).join("\n");
}
function proximityMatch(lowerOpen) {
  const w = lowerOpen.replace(/\n/g, " ").split(/[^a-z0-9]+/);
  for (let i2 = 0; i2 < w.length; i2++) {
    if (w[i2] !== "port" && w[i2] !== "rewrite") continue;
    const want = w[i2] === "port" ? "to" : "in";
    for (let j = i2 + 1; j < w.length && j <= i2 + 6; j++) if (w[j] === want) return `${w[i2]} ... ${want}`;
  }
  return "";
}
function firstIncluded(text, patterns) {
  return patterns.find((pat) => text.includes(pat)) ?? "";
}
function disabled(env, key2) {
  return (env[key2] ?? "0") === "1";
}
function emit2(context4, prefix = "") {
  return {
    stdout: `${prefix}${jqCompact({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context4 } })}
`,
    code: 0
  };
}
function isFile11(path) {
  try {
    return statSync24(path).isFile();
  } catch {
    return false;
  }
}
function defaultPluginRoot2() {
  try {
    return installRoot(posixDirname(fileURLToPath5(import.meta.url))) ?? "";
  } catch {
    return "";
  }
}
async function shimEntries(env) {
  const root = env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot2();
  const mod = `${root}/mcp/trajectory-server/dist/tools/onboard-hooks-shim.js`;
  if (!isFile11(mod)) return "";
  try {
    const shim = await import(pathToFileURL2(mod).href);
    return String(shim.countShimEntries(root));
  } catch {
    return "";
  }
}
var Context = class {
  constructor(env) {
    this.env = env;
  }
  env;
  db;
  /** `tmb_db_path` with sqlite available, else null. */
  database() {
    if (this.db === void 0) this.db = dbPath(this.env);
    return this.db !== null && this.db !== "" && haveSqlite(this.env) ? this.db : null;
  }
  query(sql) {
    const db = this.database();
    return db === null ? "" : commandSubstitution(sqliteRo(db, sql, this.env));
  }
  consultants() {
    return this.query(CONSULTANTS_SQL).split("\n").filter((role) => role !== "").map((role) => trLower(role, this.env));
  }
  /** audit_consultant_spawn_nudged: the audit row, with what sqlite3 printed to pass through on stdout. */
  auditNudge(detail) {
    const db = this.database();
    if (db === null || !isFile11(db)) return "";
    const cut4 = commandSubstitution(Buffer.from(detail, "utf8").subarray(0, SUMMARY_MAX_BYTES).toString("utf8"));
    const written = auditAppend(
      db,
      {
        issueId: "-1",
        branchId: "",
        fromNode: `hook:${GATE_NAME33}`,
        eventType: "consultant_spawn_nudged",
        summary: `Consultant-spawn nudge emitted: ${cut4}`,
        contentJson: "{}"
      },
      { caller: GATE_NAME33, env: this.env }
    );
    if (!written.ok && written.error !== "") process.stderr.write(`${written.error}
`);
    return written.stdout;
  }
};
function cheatcodeInstall(lower, ctx, grep) {
  if (/(^|[^a-z0-9_])(install|add)([^a-z0-9_]|$)/m.test(lower)) {
    const agents = ["swe", "code-reviewer", "bro", ...ctx.consultants()].join(" ").split(/[ \t\n]+/).filter((a) => a !== "");
    const agent = capabilityOnAgent(lower, agents);
    if (agent !== "") {
      return emit2(
        `[tmb cheatcode-routing] This installs a capability ONTO the \`${agent}\` agent \u2014 that is the cheatcode-reuse path. Load \`tmb_cheatcode\`: search/vet/approve the capability (cheatcode_search \u2192 cheatcode_approve) then materialize it onto the agent. This is capability reuse, so it routes through the cheatcode pipeline rather than the build flow.`
      );
    }
  }
  if (lower.includes("in local scope") || lower.includes("in global scope")) return emit2(CHEATCODE_INSTALL_CTX);
  if (!lower.includes("install")) return null;
  const bytes = Buffer.from(`${lower}
`, "utf8");
  const space2 = `[${grep.utf8 ? UTF8_SPACE : C_SPACE}]`;
  if (grep.test(bytes, grep.regex("\\b(install|installing)\\b")) && grep.test(bytes, grep.regex("\\b(plugin|plugins|skill|skills|mcp|cheatcode|cheatcodes)\\b")) && !grep.test(bytes, grep.regex(`\\b(npm|npx|bun|yarn|pnpm|pip|pipx|brew|apt|apt-get|cargo|gem)${space2}+install(ing)?\\b`))) {
    return emit2(CHEATCODE_INSTALL_CTX);
  }
  return null;
}
function namedRole(lower, ctx) {
  for (const role of ctx.consultants()) {
    const shapes = [`${role}'s read`, `${role}'s view`, `${role}'s take`, `${role} agent`, `the ${role} `, `the ${role}.`, `the ${role},`];
    if (shapes.some((shape) => lower.includes(shape))) return role;
  }
  return "";
}
function domainOf(lower, utf8) {
  for (const [domain, keywords] of DOMAINS) if (keywords.some((k) => lower.includes(k))) return domain;
  return hasWord("perf", lower, utf8) ? "perf" : "";
}
function consultantSpawn(lower, ctx, utf8) {
  const role = namedRole(lower, ctx);
  if (role !== "") {
    const passthrough2 = ctx.auditNudge(`named-role ${role}`);
    return emit2(
      `[tmb consultant-spawn enforcement] The user's prompt names the \`${role}\` role. Invoke \`/tmb:agent-create ${role} <one-line restatement of the user question>\` \u2014 the command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant in the same call. Bare \`Agent(subagent_type='${role}')\` without the command bypasses the registry; do NOT take that shortcut.`,
      passthrough2
    );
  }
  const domain = domainOf(lower, utf8);
  if (domain === "" || firstIncluded(lower, ADVISORY_SHAPES) === "") return null;
  const passthrough = ctx.auditNudge(`domain ${domain}`);
  return emit2(
    `[tmb consultant-spawn enforcement] The user's prompt looks like a \`${domain}\` judgment call. Invoke \`/tmb:agent-create <role> <one-line restatement>\` with the role that fits this domain (architect / cto / pm / legal-reviewer / a custom from-scratch role). The slash command resolves the creation mode with agent_resolve, writes the agent file, registers it (the server audits the creation), and spawns the consultant. Answering directly from general knowledge bypasses the consultant gate.`,
    passthrough
  );
}
function pushIntent(lowerOpen, ctx) {
  const matched = firstIncluded(lowerOpen, PUSH_PATTERNS);
  if (matched === "" || ctx.database() === null) return null;
  const pending2 = ctx.query(PENDING_SQL);
  if (pending2 === "") return null;
  return emit2(`\u{1F6A6} push-intent hint: the user's prompt contains '${matched}'. ${pending2.split("\n").length} task(s) await code-reviewer signoff before push:

${pendingList(pending2)}

Before \`git push\`, spawn code-reviewer for each pending task via \`Agent(subagent_type='code-reviewer', isolation=)\` (no worktree \u2014 code-reviewer reviews from the main checkout). On all-pass verdicts the push will clear the git-push-guard. If you skip this, the guard will deny the push and you'll have to redo the work anyway.`);
}
function reonboardIntent(lower, ctx) {
  const matched = firstIncluded(lower, REONBOARD_PATTERNS);
  if (matched === "" || ctx.database() === null || ctx.query(ONBOARDED_SQL) !== "1") return null;
  return emit2(`\u{1F501} reonboard-intent hint: the user's prompt contains '${matched}'. This signals a *reonboard* (project already onboarded \u2014 switching shape, not initial setup).

Policy/config mutations stay Human-gated. Route the Human to \`/onboard\` \u2014 do NOT call \`onboard_apply\` yourself.

REQUIRED FIRST ACTION \u2014 before any reply or git command: call \`onboard_state_get(agent='bro')\`. Your recommendation must cite the current config it returns (branching_model, pr_target, remotes); a reonboard answer composed without reading state is a workflow violation.

Then reply pointing the Human to \`/onboard\`. Do NOT spawn code work (no \`task_create_batch\`, no \`issue_create\`, no \`Agent\` for SWE) and do NOT wire remotes with raw git.`);
}
async function headlessIntent(promptRaw, ctx) {
  const matched = headlessMatch(promptRaw, ctx.env);
  if (matched === "" || ctx.database() === null || ctx.query(HEADLESS_WANTED_SQL) !== "1") return null;
  const settings = `${projectRoot(ctx.env) || "<project>"}/.claude/settings.local.json`;
  const entries = await shimEntries(ctx.env);
  const what = entries !== "" ? `${entries} PreToolUse gate entries` : "TMB's PreToolUse gate entries";
  return emit2(`\u{1F916} headless-intent hint: the user's prompt contains '${matched}'. Plugin hooks do not fire in non-interactive \`claude -p\` runs, and headless enforcement is off for this project.

Ask ONE \`AskUserQuestion\` consent before anything else: may TMB write ${what} into \`${settings}\` so its gates also run in \`claude -p\`? Name that file and the entry count in the question; if TMB creates the file in a git work tree, it is added to \`.gitignore\`.
- Yes \u2192 call \`onboard_apply(agent='bro', headless_enforcement='yes')\` and report \`applied.headless_shim\`.
- No \u2192 write nothing and carry on with the request.

Never call \`onboard_apply\` for this without the Human's answer.`);
}
function resumeIntent(lowerOpen, ctx) {
  const matched = firstIncluded(lowerOpen, RESUME_PATTERNS);
  if (matched === "" || ctx.database() === null) return null;
  const resume = ctx.query(RESUME_SQL);
  if (resume === "") return null;
  const [taskId, issueId, branchId, title, objective] = readPipeFields(resume, 5);
  return emit2(`\u21A9\uFE0F  resume-intent hint: the user's prompt contains '${matched}'. There's a pending task that already has \`planning_complete\` audit \u2014 resume that, do NOT create new tasks or replan.

  task_id=${taskId}
  issue_id=${issueId}
  branch_id=${branchId}
  title='${title}'
  issue.objective='${objective}'

Required workflow:
1. Call \`task_get(task_id=${taskId})\` to load the spec.
2. If the task has no worktree yet, call \`task_reopen(task_id=${taskId}, reason="resume planned task")\`, which creates it; then spawn SWE via \`Agent(subagent_type='swe')\` with \`task_id=${taskId}\` in the prompt. Leave the main checkout on its current branch.
3. Do NOT call \`issue_create\` or \`task_create_batch\` \u2014 replanning is forbidden when planning_complete already exists for this work.`);
}
async function hints(promptRaw, env) {
  const utf8 = setlocaleUtf8(env);
  const lower = trLower(promptRaw, env);
  const lowerOpen = trLower(stripQuotedSpans(promptRaw), env);
  const ctx = new Context(env);
  if (!disabled(env, "TMB_DISABLE_CHEATCODE_INSTALL_HINT")) {
    const r = cheatcodeInstall(lower, ctx, new LocaleGrep(utf8));
    if (r) return r;
  }
  if (!disabled(env, "TMB_DISABLE_CONSULTANT_HINT")) {
    const r = consultantSpawn(lower, ctx, utf8);
    if (r) return r;
  }
  if (!disabled(env, "TMB_DISABLE_SEARCH_HINT")) {
    const matched = firstIncluded(lower, SEARCH_PATTERNS);
    if (matched !== "") {
      return emit2(`\u{1F50E} search-grounding hint: the user's prompt contains '${matched}' \u2014 a retrieval question over past decisions.${SEARCH_CTX_TAIL}`);
    }
  }
  if (!disabled(env, "TMB_DISABLE_CONCERNS_HINT")) {
    const matched = firstIncluded(lowerOpen, CONCERNS_PATTERNS);
    if (matched !== "") {
      return emit2(
        `\u{1F6A8} concerns-protocol hint: the user's prompt contains '${matched}'. This is a doubt-class request \u2014 load \`tmb_concerns-protocol\`. REQUIRED FIRST ACTION before any compliance, edit, or task creation: \`discussion_append(agent='bro', kind='note', body='Concern: \u2026')\` recording what the request risks (or why it is pointless) and your recommendation. Then follow the protocol \u2014 hold for the Human's alignment; a documented decision is not a substitute for the Concern: record.`
      );
    }
  }
  if (!disabled(env, "TMB_DISABLE_PUSH_INTENT_HINT")) {
    const r = pushIntent(lowerOpen, ctx);
    if (r) return r;
  }
  const onboardPrompt = lower.includes("/onboard");
  if (!disabled(env, "TMB_DISABLE_REONBOARD_HINT") && !onboardPrompt) {
    const r = reonboardIntent(lower, ctx);
    if (r) return r;
  }
  if (!disabled(env, "TMB_DISABLE_HEADLESS_HINT") && !onboardPrompt) {
    const r = await headlessIntent(promptRaw, ctx);
    if (r) return r;
  }
  if (!disabled(env, "TMB_DISABLE_RESUME_HINT")) {
    const r = resumeIntent(lowerOpen, ctx);
    if (r) return r;
  }
  if (!disabled(env, "TMB_DISABLE_ADR_HINT")) {
    const matched = firstIncluded(lowerOpen, ADR_PATTERNS) || proximityMatch(lowerOpen);
    if (matched !== "") {
      return emit2(
        `\u{1F3DB}\uFE0F  architectural-change hint: the user's prompt contains '${matched}'. This change crosses TMB's architectural threshold \u2014 load \`tmb_planning\` and follow \xA7"Architectural changes" before speccing the work.`
      );
    }
  }
  if (!disabled(env, "TMB_DISABLE_AUDIT_HINT")) {
    const matched = AUDIT_WORDS.find((word) => hasWord(word, lowerOpen, utf8));
    if (matched !== void 0) {
      return emit2(
        `\u{1F50D} audit-intent hint: the user's prompt contains '${matched}'. Load \`tmb_audit\` and work outputs-first: name the component and the invariants its outputs must satisfy, test each against live data or a dry run before reading code, and report violations architecture-first with their evidence.`
      );
    }
  }
  return ALLOW;
}
async function promptIntentHints(payload, env) {
  try {
    let prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}
`, "prompt"));
    if (prompt === "") return ALLOW;
    const utf8 = setlocaleUtf8(env);
    prompt = commandSubstitution(stripBashSpans(prompt));
    if (!hasNonSpace(prompt, utf8) || isHarnessTurn(prompt)) return ALLOW;
    dbPathAdvisory(GATE_NAME33, env, (line) => process.stderr.write(`${line}
`));
    prompt = stripInjectedBlocks(prompt);
    if (!hasNonSpace(prompt, utf8)) return ALLOW;
    return await hints(prompt, env);
  } catch {
    return ALLOW;
  }
}

// src/hooks/rework-waiver-capture.ts
var GATE_NAME34 = "rework-waiver-capture";
var WAIVER_BODY_MAX_CHARS = 500;
var WAIVER = /\bwaive task #?(\d+)\b/gi;
function waivers(prompt) {
  const seen = /* @__PURE__ */ new Set();
  const found = [];
  for (const line of prompt.split(/\r?\n/)) {
    for (const m of line.matchAll(WAIVER)) {
      const taskId = Number(m[1]);
      if (!Number.isSafeInteger(taskId) || seen.has(taskId)) continue;
      seen.add(taskId);
      found.push({ taskId, body: [...line.trim()].slice(0, WAIVER_BODY_MAX_CHARS).join("") });
    }
  }
  return found;
}
function waiverSql(w, now) {
  return `INSERT INTO discussions (issue_id, author, kind, body, created_at, repo, task_id)
  SELECT t.issue_id, 'human', 'decision', '${sqlQuote(w.body)}', '${now}', (SELECT i.repo FROM issues i WHERE i.id = t.issue_id), t.id
    FROM tasks t WHERE t.id = ${w.taskId};`;
}
function makeReworkWaiverCapture(clock = () => /* @__PURE__ */ new Date()) {
  return (payload, env) => {
    try {
      const prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}
`, "prompt"));
      if (prompt === "" || isHarnessTurn(prompt)) return ALLOW;
      const found = waivers(stripInjectedBlocks(prompt));
      if (found.length === 0) return ALLOW;
      if (!haveSqlite(env)) return ALLOW;
      const db = dbPath(env);
      if (db === null) return ALLOW;
      const now = nowIso(clock());
      dbWrite(db, found.map((w) => waiverSql(w, now)).join("\n"), { caller: GATE_NAME34, env });
      return ALLOW;
    } catch {
      return ALLOW;
    }
  };
}
var reworkWaiverCapture = makeReworkWaiverCapture();

// src/hooks/consultant-persistence-gate.ts
var GATE_NAME35 = "consultant-persistence-gate";
var BACKBONE_ROLES = /* @__PURE__ */ new Set(["bro", "swe", "code-reviewer"]);
var block = (reason) => ({ stdout: `${jqCompact({ decision: "block", reason })}
`, code: 0 });
function recoveryMessage(agent, issueId) {
  return `Consultant persistence gate: you must persist your analysis before returning. Append your analysis via discussion_append(agent='${agent}', issue_id=${issueId}, author='${agent}', kind='analysis', body=<your analysis>) then return.`;
}
function stoppingAgent(echoed) {
  return normalizeRole(
    commandSubstitution(jqAlternatives(echoed, [["agent_type"], ["subagent_type"], ["tool_input", "subagent_type"]]))
  );
}
function consultantPersistenceGate(payload, env) {
  const echoed = `${commandSubstitution(payload)}
`;
  if (commandSubstitution(jqFieldOr(echoed, "stop_hook_active", "false")) === "true") return ALLOW;
  const agent = stoppingAgent(echoed);
  if (agent === "" || BACKBONE_ROLES.has(agent)) return ALLOW;
  const db = dbPath(env);
  if (db === null || db === "" || !haveSqlite(env)) return ALLOW;
  const unavailable = () => block(dbUnavailableReason(GATE_NAME35, env));
  const safeAgent = sqlQuote(agent);
  const isConsultant = gateRead(db, `SELECT COUNT(*) FROM agents WHERE name='${safeAgent}' AND kind='consultant';`, env);
  if (isConsultant === GATE_READ_ERROR) return unavailable();
  if (isConsultant !== "1") return ALLOW;
  const openIssue = gateRead(db, "SELECT id FROM issues WHERE status='open' ORDER BY updated_at DESC, id DESC LIMIT 1;", env);
  if (openIssue === GATE_READ_ERROR) return unavailable();
  const issueId = sqlInt(openIssue);
  if (issueId === "") return ALLOW;
  const discussions = gateRead(db, `SELECT COUNT(*) FROM discussions WHERE author='${safeAgent}' AND issue_id=${issueId};`, env);
  if (discussions === GATE_READ_ERROR) return unavailable();
  if (/^[0-9]+$/.test(discussions) && Number(discussions) >= 1) return ALLOW;
  return block(recoveryMessage(agent, issueId));
}

// src/hooks/roundtable-auq-shape.ts
var GATE_NAME36 = "roundtable-auq-shape";
var MAX_QUESTIONS = 4;
var AWAITING_SQL = `
  SELECT r.id FROM roundtables r
  WHERE r.state = 'awaiting_human'
    AND NOT EXISTS (
      SELECT 1 FROM roundtable_votes v
      WHERE v.roundtable_id = r.id AND v.participant = 'human'
    )
  ORDER BY r.id DESC LIMIT 1;
`;
var LENGTH_ERROR = /* @__PURE__ */ Symbol("length error");
function jqLength(value) {
  if (value === null) return "0";
  if (typeof value === "number") return String(Math.abs(value));
  if (typeof value === "string") return String([...value].length);
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === "object") return String(Object.keys(value).length);
  return LENGTH_ERROR;
}
function bashIntTest(s, compare) {
  return /^-?[0-9]+$/.test(s) && Number.isSafeInteger(Number(s)) && compare(Number(s));
}
function multiSelectAt(questions, i2) {
  const lines2 = [];
  for (const q of questions) {
    if (q !== null && !Array.isArray(q)) continue;
    const element = q === null ? null : q[i2] ?? null;
    try {
      lines2.push(jqOr(jqIndex(element, "multiSelect"), false) === true);
    } catch {
    }
  }
  return lines2.length === 1 && lines2[0];
}
function shapeViolations(echoed) {
  const questions = jqMap(echoed, (value) => jqOr(jqIndex(jqIndex(value, "tool_input"), "questions"), []));
  const lengths = questions.map(jqLength).filter((n3) => n3 !== LENGTH_ERROR);
  const count = lengths.join("\n");
  if (count === "" || bashIntTest(count, (n3) => n3 === 0)) return null;
  const violations = [];
  if (bashIntTest(count, (n3) => n3 > MAX_QUESTIONS)) {
    violations.push(`AUQ has ${count} questions; max ${MAX_QUESTIONS} allowed during ratification`);
  }
  if (!multiSelectAt(questions, 0)) {
    violations.push("Q1 must have multiSelect:true (agreements checkbox) during ratification");
  }
  if (bashIntTest(count, (n3) => n3 > 1)) {
    const longest = Math.max(0, ...questions.map((q) => Array.isArray(q) ? q.length : 0));
    const last = Math.min(Number(count), longest);
    for (let i2 = 1; i2 < last; i2 += 1) {
      if (multiSelectAt(questions, i2)) {
        violations.push(`Q${i2 + 1} must not use multiSelect (disagreement radios only) during ratification`);
      }
    }
  }
  return violations;
}
function shapeAsk(rtId, violations) {
  const message = `roundtable-auq-shape: AskUserQuestion shape is invalid for ratification (roundtable #${rtId} awaiting human).` + violations.map((v) => `
  - ${v}`).join("") + "\n\nExpected shape: Q1 multiSelect=true (agreements); Q2..Qn radio (disagreements); total \u22644.";
  return `${jqCompact({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      additionalContext: message
    }
  })}
`;
}
function roundtableAuqShape(payload, env) {
  try {
    const echoed = `${commandSubstitution(payload)}
`;
    if (commandSubstitution(jqFieldOr(echoed, "tool_name")) !== "AskUserQuestion") return ALLOW;
    const db = dbPath(env);
    if (db === null || db === "" || !haveSqlite(env)) return ALLOW;
    const rtId = sqliteRo(db, AWAITING_SQL, env);
    if (rtId === "") return ALLOW;
    const violations = shapeViolations(echoed);
    if (violations === null || violations.length === 0) return ALLOW;
    return { stdout: shapeAsk(rtId, violations), code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/roundtable-cleanup-postcheck.ts
var GATE_NAME37 = "roundtable-cleanup-postcheck";
var CLOSE_TOOLS = ["roundtable_close", "roundtable_close_with_decisions"];
function roundtableIdField(echoed) {
  return commandSubstitution(
    jqMap(echoed, (value) => jqRawText(jqOr(jqIndex(jqIndex(value, "tool_input"), "roundtable_id"), "")), jqLiteralNumbers).join("\n")
  );
}
function captureSql(rtId) {
  return `SELECT r.issue_id,
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'analysis'),
    (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = r.issue_id AND d.kind = 'decision'),
    (SELECT COUNT(*) FROM roundtable_votes v WHERE v.roundtable_id = r.id),
    (SELECT COUNT(*) FROM audit a WHERE a.event_type = 'roundtable_summary' AND a.issue_id = r.issue_id),
    r.state, COALESCE(r.outcome, '')
  FROM roundtables r WHERE r.id = ${rtId} LIMIT 1;`;
}
var atLeastOne = (count) => /^[0-9]+$/.test(count) && Number(count) >= 1;
function missingSurfaces(row) {
  const [issueId = "", analyses = "", decisions = "", votes = "", summaries = "", state = "", ...rest] = row.split("\n")[0].split("|");
  if (sqlInt(issueId) === "") return null;
  const outcome = rest.join("|");
  const missing = [];
  if (!atLeastOne(analyses)) missing.push("analysis-discussions");
  if (!atLeastOne(decisions)) missing.push("decision-discussions");
  if (state !== "closed") missing.push("roundtable.status=closed");
  if (outcome === "" || outcome === "|") missing.push("roundtable.outcome");
  if (!atLeastOne(votes)) missing.push("votes");
  if (!atLeastOne(summaries)) missing.push("audit(roundtable_summary)");
  return missing;
}
function cleanupContext(rtId, missing) {
  return `${jqCompact({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `[tmb roundtable-cleanup] roundtable_id=${rtId} closed but the following capture surfaces are missing: ${missing.join(" ")}. Re-call the relevant tools (discussion_append for analysis/decision, roundtable_vote, roundtable_summarize, audit_append) so the trajectory is auditable.`
    }
  })}
`;
}
function roundtableCleanupPostcheck(payload, env) {
  try {
    const echoed = `${commandSubstitution(payload)}
`;
    const tool = commandSubstitution(jqFieldOr(echoed, "tool_name"));
    if (!CLOSE_TOOLS.some((name3) => tool.endsWith(name3))) return ALLOW;
    const rtId = sqlInt(roundtableIdField(echoed));
    if (rtId === "") return ALLOW;
    const db = dbPath(env);
    if (db === null || db === "" || !haveSqlite(env)) return ALLOW;
    const missing = missingSurfaces(sqliteRo(db, captureSql(rtId), env));
    if (missing === null || missing.length === 0) return ALLOW;
    return { stdout: cleanupContext(rtId, missing), code: 0 };
  } catch {
    return ALLOW;
  }
}

// src/hooks/roundtable-slash-detect.ts
var GATE_NAME38 = "roundtable-slash-detect";
var SUMMARY_MAX_BYTES2 = 200;
var WRITE_ENV = { TMB_DB_WRITE_TIMEOUT_MS: "5000", TMB_DB_WRITE_RUN_BUDGET_MS: "10200" };
function slashInvoked(prompt) {
  return prompt.startsWith("/roundtable") || prompt.includes("\n/roundtable") || prompt.includes(" /roundtable");
}
function promptSummary(prompt) {
  return commandSubstitution(Buffer.from(prompt, "utf8").subarray(0, SUMMARY_MAX_BYTES2).toString("utf8"));
}
function roundtableSlashDetect(payload, env) {
  try {
    if (!haveSqlite(env)) return ALLOW;
    const prompt = commandSubstitution(jqFieldOr(`${commandSubstitution(payload)}
`, "prompt"));
    if (isHarnessTurn(prompt) || !slashInvoked(prompt)) return ALLOW;
    const db = dbPath(env);
    if (db === null || db === "") return ALLOW;
    const written = auditAppend(
      db,
      {
        issueId: "-1",
        branchId: "",
        fromNode: `hook:${GATE_NAME38}`,
        eventType: "roundtable_slash_invoked",
        summary: `User typed /roundtable: ${promptSummary(prompt)}`,
        contentJson: "{}"
      },
      { caller: GATE_NAME38, env: { ...env, ...WRITE_ENV } }
    );
    if (!written.ok) {
      if (written.error !== "") process.stderr.write(`${written.error}
`);
      process.stderr.write(
        `tmb slash-detect: FAILED to record roundtable_slash_invoked after retrying (${db}) \u2014 roundtable_create's gate will refuse
`
      );
    }
    return ALLOW;
  } catch {
    return ALLOW;
  }
}

// src/hooks/code-reviewer-no-worktree.ts
var GATE_NAME39 = "code-reviewer-no-worktree";
var BYPASS_ENV3 = "TMB_ALLOW_CODE_REVIEWER_WORKTREE";
var DENY_REASON = `code-reviewer must NOT run with isolation="worktree". The push gate reviews the FEATURE branch as it would land in origin \u2014 from the main checkout, not from SWE's per-task worktree. Bro works on the worktree branch as the task-close gate (V1/V2/V3 + bro_atomic_close); code-reviewer reviews afterward, on the bare branch ref before push.

Spawn code-reviewer without isolation (defaults to none) or with an explicit non-worktree isolation. For exceptional override, set ${BYPASS_ENV3}=1.`;
function spawnField(payload, ...keys) {
  return jqRawOr(`${commandSubstitution(payload)}
`, [jqPath(...keys)]);
}
function isCodeReviewerSpawn(payload) {
  return spawnField(payload, "tool_name") === "Agent" && normalizeRole(spawnField(payload, "tool_input", "subagent_type")) === CODE_REVIEWER_ROLE;
}
function spawnDeny(reason) {
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}
`,
    code: 0
  };
}
var codeReviewerNoWorktree = (payload, env) => {
  if (env[BYPASS_ENV3] === "1") return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  return spawnField(payload, "tool_input", "isolation") === "worktree" ? spawnDeny(DENY_REASON) : ALLOW;
};

// src/hooks/code-reviewer-spawn-prompt-shape.ts
var GATE_NAME40 = "code-reviewer-spawn-prompt-shape";
var BYPASS_ENV4 = "TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE";
var RUBBER_STAMP_PHRASES = ["trust the prior verdict", "fast-track if", "rubber.stamp", "prior verdict"];
var ANCHOR_LIST = `${ANCHORS.slice(0, -1).join(", ")}, and ${ANCHORS[ANCHORS.length - 1]}`;
function missingAnchorsReason(missing) {
  return `BLOCKED: code-reviewer spawn prompt missing required anchors:${missing.map((a) => ` ${a}`).join("")}.

Per tmb_push-gate, the prompt MUST contain ${ANCHOR_LIST}, each as name=value, so code-reviewer can load context independently and author its validation_record verdict. Do not pre-summarize findings \u2014 pass only the bare anchors plus a one-line context summary.`;
}
function rubberStampReason(phrase) {
  return `BLOCKED: code-reviewer spawn prompt contains a rubber-stamp shortcut (matched: "${phrase}").

Per tmb_push-gate, the prompt MUST NOT contain the prior verdict text or shortcuts that allow rubber-stamping. The reviewer must derive findings from the spec + diff itself.`;
}
function grepLines(prompt, multibyte) {
  const text = multibyte ? prompt : Buffer.from(prompt, "utf8").toString("latin1");
  return text.split("\n");
}
function missingAnchors(prompt, multibyte) {
  const lines2 = grepLines(prompt, multibyte);
  const flags2 = multibyte ? "u" : "";
  return ANCHORS.filter((anchor) => {
    const re = new RegExp(`(?:^|[^${grepAlnum(multibyte)}_])${anchor}=`, flags2);
    return !lines2.some((line) => re.test(line));
  });
}
function phraseRegExp(phrase, multibyte) {
  const source = [...phrase].map((ch) => ch === "." ? "[^\\n]" : ch.replace(/[\\^$*+?()[\]{}|/]/g, "\\$&")).join("");
  return new RegExp(source, multibyte ? "u" : "");
}
function rubberStampPhrase(prompt, multibyte) {
  const lines2 = grepLines(prompt, multibyte).map((line) => line.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  return RUBBER_STAMP_PHRASES.find((phrase) => lines2.some((line) => phraseRegExp(phrase, multibyte).test(line))) ?? null;
}
var codeReviewerSpawnPromptShape = (payload, env) => {
  if (env[BYPASS_ENV4] === "1") return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  const prompt = spawnField(payload, "tool_input", "prompt");
  const multibyte = grepMultibyte(env);
  const missing = missingAnchors(prompt, multibyte);
  if (missing.length > 0) return spawnDeny(missingAnchorsReason(missing));
  const phrase = rubberStampPhrase(prompt, multibyte);
  return phrase === null ? ALLOW : spawnDeny(rubberStampReason(phrase));
};

// src/hooks/code-reviewer-after-atomic-close.ts
var GATE_NAME41 = "code-reviewer-after-atomic-close";
var BYPASS_ENV5 = "TMB_SKIP_CODE_REVIEWER_CLOSE_GATE";
function notClosedReason(taskId, status) {
  return `BLOCKED: code-reviewer spawn requires task ${taskId} status=closed but actual status=${status}.

Per tmb_planning Step 5 (verify + close, then code-reviewer per tmb_push-gate), the order is:
  1. SWE returns status=completed (lifecycle answer, NOT a DB closure).
  2. bro runs V1 (task_get + git diff), V2 (3 checks), V3 (bro_atomic_close).
  3. ONLY THEN: spawn code-reviewer for the push gate.

SWE returning completed does not close the trajectory task \u2014 that is bro_atomic_close.

Fix: call bro_atomic_close(agent='bro', task_id=${taskId}, commit_sha=<sha>, verification_summary='...') first, then retry this spawn.`;
}
function promptTaskId2(prompt, multibyte) {
  const space2 = grepSpace(multibyte);
  const re = new RegExp(`task_id[${space2}]*=[${space2}]*([0-9]+)`, multibyte ? "u" : "");
  const text = multibyte ? prompt : Buffer.from(prompt, "utf8").toString("latin1");
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return "";
}
var codeReviewerAfterAtomicClose = (payload, env) => {
  if (env[BYPASS_ENV5] === "1") return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  const taskId = sqlInt(promptTaskId2(spawnField(payload, "tool_input", "prompt"), grepMultibyte(env)));
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const status = gateRead(db, `SELECT status FROM tasks WHERE id = ${taskId};`, env);
  if (status === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME41, env)}
`, code: 0 };
  if (status === "" || status === "closed") return ALLOW;
  return spawnDeny(notClosedReason(taskId, status));
};

// src/hooks/swe-verification-gate.ts
import { spawn as spawn2, spawnSync as spawnSync10 } from "node:child_process";
import { accessSync as accessSync9, closeSync as closeSync3, constants as constants9, mkdirSync as mkdirSync8, mkdtempSync, openSync as openSync3, readFileSync as readFileSync16, rmSync as rmSync4, statSync as statSync25, writeFileSync as writeFileSync6 } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { resolve as resolve3 } from "node:path";

// src/hooks/lib/verification-carry.ts
import { realpathSync as realpathSync6 } from "node:fs";
import { basename as basename7, matchesGlob } from "node:path";
import { fileURLToPath as fileURLToPath6 } from "node:url";
var VERIFICATION_INPUTS_PATH = ".config/tmb/verification-inputs.json";
var VERIFICATION_INPUTS_VERSION = 1;
var SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
var PROBE_PREFIX = "[probe ";
function refuse(reason, source = null) {
  return { source_run: source?.id ?? null, source_sha: source?.sha ?? null, carry: [], refused: reason, commands: [] };
}
function parseCommands(json) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === "string" && c !== "") ? parsed : null;
  } catch {
    return null;
  }
}
function parseInputsMap(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "map_invalid";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "map_invalid";
  const map = parsed;
  if (map.version !== VERIFICATION_INPUTS_VERSION) return "map_unknown_version";
  if (!Array.isArray(map.commands)) return "map_invalid";
  const entries = [];
  for (const entry of map.commands) {
    if (entry === null || typeof entry !== "object") return "map_invalid";
    const { match: match2, inputs } = entry;
    if (typeof match2 !== "string" || match2 === "") return "map_invalid";
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((g) => typeof g === "string" && g !== "")) return "map_invalid";
    entries.push({ match: match2, inputs });
  }
  return entries;
}
function sourceRun(db, taskId, head, env) {
  const out2 = gateRead(
    db,
    `SELECT json_object('id', id, 'sha', lower(commit_sha)) FROM verification_runs
      WHERE task_id = ${taskId} AND finished_at IS NOT NULL AND exit_code = 0 AND timed_out = 0
        AND lower(commit_sha) <> '${sqlQuote(head)}'
      ORDER BY finished_at DESC, id DESC LIMIT 1;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return "error";
  if (out2 === "") return null;
  const row = JSON.parse(out2);
  if (typeof row.id !== "number" || typeof row.sha !== "string" || !SHA_RE.test(row.sha)) return null;
  return { id: row.id, sha: row.sha };
}
function passedInSource(db, runId, env) {
  const out2 = gateRead(
    db,
    `SELECT COALESCE(json_group_array(command), '[]') FROM verification_run_commands WHERE run_id = ${runId} AND exit_code = 0;`,
    env
  );
  if (out2 === GATE_READ_ERROR) return "error";
  const commands = parseCommands(out2 === "" ? "[]" : out2);
  return commands === null ? "error" : new Set(commands);
}
function changedPaths(worktree, from, to, env) {
  const r = gitRun(worktree, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"], env);
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter((p) => p !== "");
}
function planCarry(req, env = process.env) {
  const taskId = sqlInt(req.taskId);
  const head = req.head.toLowerCase();
  const commands = parseCommands(req.commandsJson);
  if (req.db === "" || taskId === "" || req.worktree === "" || !SHA_RE.test(head) || commands === null) return refuse("bad_input");
  const actualHead = gitRun(req.worktree, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], env);
  if (actualHead.code !== 0 || actualHead.stdout.trim().toLowerCase() !== head) return refuse("head_mismatch");
  const source = sourceRun(req.db, taskId, head, env);
  if (source === "error") return refuse("db_unreadable");
  if (source === null) return refuse("no_source_run");
  if (gitRun(req.worktree, ["merge-base", "--is-ancestor", source.sha, head], env).code !== 0) return refuse("not_ancestor", source);
  const merges = gitRun(req.worktree, ["rev-list", "--merges", `${source.sha}..${head}`], env);
  if (merges.code !== 0 || merges.stdout.trim() !== "") return refuse("merge_in_range", source);
  const status = gitRun(req.worktree, ["status", "--porcelain"], env);
  if (status.code !== 0 || status.stdout.trim() !== "") return refuse("dirty_worktree", source);
  const changed = changedPaths(req.worktree, source.sha, head, env);
  if (changed === null) return refuse("diff_failed", source);
  if (changed.includes(VERIFICATION_INPUTS_PATH)) return refuse("map_changed", source);
  const mapText = gitRun(req.worktree, ["show", `${head}:${VERIFICATION_INPUTS_PATH}`], env);
  if (mapText.code !== 0) return refuse("map_missing", source);
  const entries = parseInputsMap(mapText.stdout);
  if (typeof entries === "string") return refuse(entries, source);
  const passed = passedInSource(req.db, source.id, env);
  if (passed === "error") return refuse("db_unreadable", source);
  const decisions = commands.map((command, i2) => {
    const decide2 = (reason) => ({ ordinal: i2 + 1, command, carried: reason === null, reason });
    if (command.startsWith(PROBE_PREFIX)) return decide2("probe");
    if (!passed.has(command)) return decide2("not_passed_in_source");
    const declared = entries.filter((e) => e.match === command);
    if (declared.length === 0) return decide2("undeclared");
    if (declared.length > 1) return decide2("ambiguous_declaration");
    const touched = declared[0].inputs.some((glob) => changed.some((path) => matchesGlob(path, glob)));
    return decide2(touched ? "inputs_changed" : null);
  });
  return {
    source_run: source.id,
    source_sha: source.sha,
    carry: decisions.filter((d) => d.carried).map((d) => d.ordinal),
    refused: null,
    commands: decisions
  };
}
function planCarrySafe(req, env = process.env) {
  try {
    return planCarry(req, env);
  } catch {
    return refuse("error");
  }
}
function isMainModule() {
  const entry = process.argv[1];
  const self2 = fileURLToPath6(import.meta.url);
  if (entry === void 0 || basename7(self2) !== "verification-carry.js") return false;
  try {
    return realpathSync6(entry) === realpathSync6(self2);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const [db = "", taskId = "", worktree = "", head = "", commandsJson = ""] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(planCarrySafe({ db, taskId, worktree, head, commandsJson }))}
`);
}

// src/hooks/swe-brief-gate.ts
var GATE_NAME42 = "swe-brief-gate";
var BLOCKED_MUTATIONS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var TRAJECTORY_TOOL2 = /^mcp__[\s\S]*trajectory-server__/;
function briefSurface(toolName2) {
  if (toolName2.includes("task_brief")) return "task_brief";
  if (BLOCKED_MUTATIONS.has(toolName2)) return "mutation";
  if (TRAJECTORY_TOOL2.test(toolName2)) return "trajectory";
  return "other";
}
function rawOrEmpty(input, path) {
  return jqMap(
    input,
    (value) => {
      const v = path.reduce((acc, key2) => jqIndex(acc, key2), value);
      return v === null || v === void 0 || v === false ? null : jqRawText(v);
    },
    jqLiteralNumbers
  ).filter((line) => line !== null).join("\n");
}
function denyReason3(taskId, toolName2) {
  return `BLOCKED: SWE must call task_brief(agent='swe', task_id=${taskId}) before ${toolName2 || "this tool"}. task_brief delivers the spec, worktree path, and decision thread in one deterministic call. Recovery: task_brief(agent='swe', task_id=${taskId})`;
}
function resumeJson(taskId, agentId, observedAt) {
  return `{"task_id":${jqNumberLiteral(taskId)},"agent_id":${jqCompact(agentId)},"observed_at":${jqCompact(observedAt)},"consumed":0}`;
}
function bindRun(db, taskId, input, env) {
  const agentId = commandSubstitution(jqAlternatives(input, [["agent_id"]]));
  if (agentId === "") return;
  const safeAgentId = sqlQuote(agentId);
  const keyed = sqliteRo(
    db,
    `
SELECT COALESCE(MAX(completed_at IS NULL), -1) || '|' || (SELECT issue_id FROM tasks WHERE id = ${taskId})
  FROM agent_runs
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${safeAgentId}';`,
    env
  );
  if (keyed.startsWith("-1|")) {
    dbWrite(
      db,
      `
UPDATE agent_runs SET spawn_id = '${safeAgentId}'
 WHERE id = (SELECT id FROM agent_runs
              WHERE task_id = ${taskId} AND agent_type = 'swe' AND completed_at IS NULL
                AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
              ORDER BY id DESC LIMIT 1);`,
      { caller: GATE_NAME42, env }
    );
  } else if (keyed.startsWith("0|")) {
    auditAppend(
      db,
      {
        issueId: keyed.slice(keyed.indexOf("|") + 1),
        branchId: "",
        fromNode: `hook:${GATE_NAME42}`,
        eventType: "swe_resume_observed",
        summary: `swe ${agentId} resumed task ${taskId} and called task_brief`,
        contentJson: resumeJson(taskId, agentId, nowIso())
      },
      { caller: GATE_NAME42, env }
    );
  }
}
var sweBriefGate = (payload, env) => {
  const captured = commandSubstitution(payload);
  const input = `${captured}
`;
  const agentType = normalizeRole(
    commandSubstitution(jqAlternatives(input, [["agent_type"], ["subagent_type"], ["tool_input", "subagent_type"]]))
  );
  if (agentType !== "swe") return ALLOW;
  const toolName2 = commandSubstitution(jqAlternatives(input, [["tool_name"]]));
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null || !haveSqlite(env)) return ALLOW;
  let taskId = taskIdFromTranscript(agentTranscript(captured));
  if (taskId === "") taskId = sqlInt(commandSubstitution(rawOrEmpty(input, ["tool_input", "task_id"])));
  if (taskId === "") return ALLOW;
  const surface2 = briefSurface(toolName2);
  if (surface2 === "other") return ALLOW;
  if (surface2 === "task_brief") {
    bindRun(db, taskId, input, env);
    return ALLOW;
  }
  const sentinel = sqliteRo(
    db,
    `
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'swe_brief_fetched'
     AND json_extract(content_json, '$.task_id') = ${taskId}
  LIMIT 1;
`,
    env
  );
  if (Number(sentinel || "0") > 0) return ALLOW;
  return {
    stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason3(taskId, toolName2) } })}
`,
    code: 0
  };
};

// src/hooks/swe-verification-gate.ts
var GATE_NAME43 = "swe-verification-gate";
var VERIFICATION_DEFAULT_S = 900;
var VERIFICATION_MAX_S = 1800;
var RECORD_BUDGET_MS = 3e3;
var RECORD_POOL_MS = 9e3;
var FINISH_ATTEMPTS = 3;
var FINISH_BACKOFF_MS = 500;
var LOCK_POLL_MS = 500;
var TAIL_LINES = 20;
var FAILURE_LINES = 15;
var DEFAULT_TAIL_CHARS = 4e3;
var signals = osConstants.signals;
var DB_UNAVAILABLE_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable \u2014 the verification gate could not read the task row, so it refuses to fail open. Check the trajectory DB (sqlite3 error on read) and retry."}}\n';
var WAIVER_UNRECORDED_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: trajectory DB unavailable \u2014 the verification-gate waiver could not be recorded, so it cannot be honoured. Retry once the DB is writable."}}\n';
var NO_VERIFICATION_CONTEXT = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: task has no typed verification[] \u2014 verification gate skipped. Ask bro to set the task's verification[] field (Typed Rails #673) to enforce verification commands."}}
`;
var UNRECORDED_PASS_CONTEXT = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: verification[] passed (not recorded: worktree HEAD unresolvable)."}}\n';
var stderr = (text) => {
  process.stderr.write(text);
};
var sleep2 = (ms) => new Promise((done) => setTimeout(done, ms));
function beforeBar(s) {
  const i2 = s.indexOf("|");
  return i2 < 0 ? s : s.slice(0, i2);
}
function afterBar(s) {
  const i2 = s.indexOf("|");
  return i2 < 0 ? s : s.slice(i2 + 1);
}
function deny7(reason) {
  return `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}
`;
}
function context3(text) {
  return `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } })}
`;
}
function shellLength(s, env) {
  return ctypeUtf8(env) ? [...s].length : Buffer.byteLength(s);
}
function shellTail(s, n3, env) {
  if (ctypeUtf8(env)) return [...s].slice(-n3).join("");
  const bytes = Buffer.from(s);
  return bytes.subarray(Math.max(0, bytes.length - n3)).toString("utf8");
}
function msToS(ms) {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs % 1e3 === 250) return `${sign}${Math.floor(abs / 1e3)}.2`;
  return `${sign}${(abs / 1e3).toFixed(1)}`;
}
function parseBudget(raw) {
  let timeoutS = VERIFICATION_DEFAULT_S;
  if (raw !== "") {
    if (!/^[0-9]+$/.test(raw)) timeoutS = null;
    else if (raw.length > 9) timeoutS = VERIFICATION_MAX_S;
    else timeoutS = Number(raw) >= 1 ? Number(raw) : null;
  }
  let warning = "";
  if (timeoutS === null) {
    warning = `${GATE_NAME43}: verification_timeout_s '${raw.replaceAll("\n", " ")}' is not an integer from 1 to ${VERIFICATION_MAX_S}; using the default ${VERIFICATION_DEFAULT_S}s
`;
    timeoutS = VERIFICATION_DEFAULT_S;
  }
  return { timeoutS: Math.min(timeoutS, VERIFICATION_MAX_S), warning };
}
function executable(path) {
  if (path === "") return false;
  try {
    accessSync9(path, constants9.X_OK);
    return true;
  } catch {
    return false;
  }
}
function capture3(cmd, args2, dir, env) {
  const r = spawnSync10(cmd, args2, { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  return r.stdout ?? "";
}
function toolchainDirs(env, worktree) {
  const home = env.HOME ?? "";
  const out2 = [];
  const miseData = env.MISE_DATA_DIR || `${env.XDG_DATA_HOME || `${home}/.local/share`}/mise`;
  if (isDir(`${miseData}/shims`)) out2.push(`${miseData}/shims`);
  const mise = [env.MISE_INSTALL_PATH ?? "", "/opt/homebrew/bin/mise", "/usr/local/bin/mise", `${home}/.local/bin/mise`].find(executable);
  if (mise !== void 0) out2.push(...capture3(mise, ["bin-paths"], worktree, env).split("\n"));
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(executable);
  const brewPrefix = brew === void 0 ? "" : commandSubstitution(capture3(brew, ["--prefix"], worktree, env));
  const brewDirs = brewPrefix !== "" ? [`${brewPrefix}/bin`, `${brewPrefix}/sbin`] : ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  out2.push(...brewDirs.filter(isDir));
  if (home !== "" && isDir(`${home}/.local/bin`)) out2.push(`${home}/.local/bin`);
  if (home !== "") {
    for (const dir of [`${home}/Library/Application Support/reflex/bun/bin`, `${home}/.bun/bin`]) {
      if (isDir(dir) && executable(`${dir}/bun`)) out2.push(dir);
    }
  }
  return out2;
}
function joinToolchainPath(dirs, base2) {
  const seen = /* @__PURE__ */ new Set();
  for (const dir of [...dirs.filter((d) => d !== ""), ...base2.split(":")]) {
    if (dir !== "") seen.add(dir);
  }
  return [...seen].join(":");
}
function repoPathByName2(db, name3, env) {
  let file = false;
  try {
    file = statSync25(db).isFile();
  } catch {
  }
  if (!file || !haveSqlite(env) || name3 === "") return "";
  return firstLine(sqliteRo(db, `SELECT path FROM repos WHERE name = '${sqlQuote(name3)}' LIMIT 1;`, env));
}
function reviewFindingsActive(db, taskId, env) {
  const has = gateRead(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_findings';", env);
  if (has === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (has !== "1") return "[]";
  const out2 = gateRead(
    db,
    `SELECT COALESCE(json_group_array(json_object('id', id, 'status', status, 'probe_cmd', probe_cmd)), '[]')
     FROM (SELECT id, status, probe_cmd FROM review_findings
            WHERE task_id = ${taskId} AND status <> 'wontfix'
            ORDER BY CAST(substr(id, instr(id, '-') + 1) AS INTEGER));`,
    env
  );
  return out2 || "[]";
}
function parseFindings(json) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function probeCommand(f) {
  return `[probe ${typeof f.id === "string" ? f.id : ""}] ${typeof f.probe_cmd === "string" ? f.probe_cmd : ""}`;
}
function lastLines(text, n3) {
  return text.split("\n").slice(-n3).join("\n");
}
function failureLines(text) {
  return text.split("\n").filter((line) => /FAIL|failed|Error|❌/.test(line)).slice(0, FAILURE_LINES).join("\n");
}
function reusableRun(db, taskId, sha, commandsJson, env) {
  const cmds = sqlQuote(commandsJson);
  return sqliteRo(
    db,
    `SELECT r.id || '|' || r.finished_at FROM verification_runs r
     WHERE r.task_id = ${taskId} AND r.commit_sha = '${sqlQuote(sha)}'
       AND r.exit_code = 0 AND r.timed_out = 0 AND r.finished_at IS NOT NULL
       AND r.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3600 seconds')
       AND json_valid('${cmds}')
       AND (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) = json_array_length('${cmds}')
       AND NOT EXISTS (SELECT 1 FROM json_each('${cmds}') e
             LEFT JOIN verification_run_commands c ON c.run_id = r.id AND c.ordinal = e.key + 1
            WHERE c.command IS NOT e.value)
     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1;`,
    env
  );
}
var VerificationRun = class {
  constructor(c) {
    this.c = c;
  }
  c;
  runId = "";
  recordMs = 0;
  poolNoted = false;
  ordinal = 0;
  runStart = 0;
  carryRun = "";
  carrySha = "";
  carryOrdinals = /* @__PURE__ */ new Set();
  allowanceMs() {
    const left = RECORD_POOL_MS - this.recordMs;
    if (left <= 0) return null;
    return Math.min(left, RECORD_BUDGET_MS);
  }
  write(ms, sql) {
    const env = { ...this.c.env, TMB_DB_WRITE_TIMEOUT_MS: String(ms), TMB_DB_WRITE_RUN_BUDGET_MS: String(ms) };
    const r = dbWrite(this.c.db, sql, { caller: GATE_NAME43, env });
    if (!r.ok && r.error !== "") stderr(`${r.error}
`);
    return r;
  }
  invalid(message) {
    stderr(`tmb_verification_run: ${GATE_NAME43}: ${message}
`);
    return { ok: false, code: 2, stdout: "", error: "" };
  }
  start(ms) {
    const now = nowIso();
    const r = this.write(
      ms,
      `UPDATE verification_runs SET finished_at = '${now}', exit_code = 137, timed_out = 0
 WHERE finished_at IS NULL
   AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', '${now}', '-' || (budget_s + 60) || ' seconds');
INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (${this.c.taskId}, '${sqlQuote(this.c.wtSha)}', 'gate', '${now}', ${this.c.timeoutS});
SELECT last_insert_rowid();`
    );
    return r.ok ? commandSubstitution(r.stdout) : "";
  }
  commandWrite(ms, ordinal, command, rc, elapsed, output) {
    if (!/^[0-9]+$/.test(this.runId)) {
      this.invalid(`invalid run_id '${this.runId}'`);
      return;
    }
    const rawCap = this.c.env.TMB_VERIFICATION_TAIL_CHARS || String(DEFAULT_TAIL_CHARS);
    const cap = /^[0-9]+$/.test(rawCap) ? Number(rawCap) : DEFAULT_TAIL_CHARS;
    const tail = cap > 0 && shellLength(output, this.c.env) > cap ? shellTail(output, cap, this.c.env) : output;
    this.write(
      ms,
      `INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (${this.runId}, ${ordinal}, '${sqlQuote(command)}', ${rc}, ${elapsed}, '${sqlQuote(tail)}');`
    );
  }
  finishWrite(rc, timedOut) {
    if (!/^[0-9]+$/.test(this.runId)) return this.invalid(`invalid run_id '${this.runId}'`);
    return this.write(
      RECORD_BUDGET_MS,
      `UPDATE verification_runs SET finished_at = '${nowIso()}', exit_code = ${rc}, timed_out = ${timedOut} WHERE id = ${this.runId};`
    );
  }
  fixedWrite(ms, id) {
    if (!/^F[0-9]+-[0-9]+$/.test(id)) return this.invalid(`invalid finding id '${id}'`);
    return this.write(ms, `UPDATE review_findings SET status = 'fixed', resolved_at = '${nowIso()}' WHERE id = '${sqlQuote(id)}' AND status = 'open';`);
  }
  recordCommand(ordinal, command, rc, elapsed, output) {
    if (this.runId === "") return;
    const ms = this.allowanceMs();
    if (ms === null) {
      if (!this.poolNoted) {
        this.poolNoted = true;
        stderr(`${GATE_NAME43}: run-record write budget (${RECORD_POOL_MS}ms) spent; verification run #${this.runId} keeps no further command rows
`);
      }
      return;
    }
    const t0 = Date.now();
    this.commandWrite(ms, ordinal, command, rc, elapsed, output);
    this.recordMs += Date.now() - t0;
  }
  async recordFinish(rc, timedOut) {
    if (this.runId === "") return;
    for (let attempt = 1; ; attempt += 1) {
      if (this.finishWrite(rc, timedOut).ok) return;
      if (attempt >= FINISH_ATTEMPTS) break;
      await sleep2(attempt * FINISH_BACKOFF_MS);
    }
    stderr(
      `${GATE_NAME43}: verification run #${this.runId} record unfinished \u2014 its finish write failed ${FINISH_ATTEMPTS} times; the decision stands (trajectory_doctor reports it under no_unfinished_verification_runs after 2 h)
`
    );
  }
  recordNote() {
    if (this.runId !== "") return ` Recorded as verification run #${this.runId}.`;
    return this.c.wtSha === "" ? " (not recorded: worktree HEAD unresolvable)" : "";
  }
  activeMs() {
    return Date.now() - this.runStart - this.recordMs;
  }
  timeoutReason(ordinal, command, elapsed, cumulative) {
    const ran = elapsed !== "" ? ` after ${elapsed}s` : "";
    return commandSubstitution(
      `BLOCKED: verification timed out \u2014 the ${this.c.timeoutS}s budget ran out ${cumulative}s in, while running command ${ordinal}/${this.c.cmdTotal}${ran}:
${command}

Raise plugin_config.verification_timeout_s (config_set; capped at ${VERIFICATION_MAX_S}s) or speed up the command.${this.recordNote()}`
    );
  }
  planCarry() {
    const plan = planCarrySafe(
      { db: this.c.db, taskId: this.c.taskId, worktree: this.c.worktree, head: this.c.wtSha, commandsJson: this.c.gateCmdsJson },
      { ...this.c.env, PATH: this.c.toolchainPath }
    );
    if (typeof plan.source_run !== "number" || typeof plan.source_sha !== "string" || !Array.isArray(plan.carry)) return;
    const run5 = String(plan.source_run);
    const ords = plan.carry.map(String).join(" ");
    if (!/^[0-9]+$/.test(run5)) return;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(plan.source_sha)) return;
    if (!/^[0-9]+( [0-9]+)*$/.test(ords)) return;
    this.carryRun = run5;
    this.carrySha = plan.source_sha;
    this.carryOrdinals = new Set(plan.carry);
  }
  execute(command, seconds2, outPath) {
    return new Promise((done) => {
      const fd = openSync3(outPath, "w");
      let fired = false;
      let settled = false;
      const finish = (rc) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done({ rc, fired });
      };
      const child = spawn2("bash", ["-c", command], {
        cwd: this.c.worktree,
        env: { ...this.c.env, PATH: this.c.toolchainPath, PWD: this.c.worktree },
        stdio: ["ignore", fd, fd],
        detached: true
      });
      closeSync3(fd);
      const timer = setTimeout(() => {
        fired = true;
        try {
          if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      }, seconds2 * 1e3);
      child.on("error", () => finish(127));
      child.on("exit", (code, signal2) => {
        if (fired) finish(124);
        else finish(code ?? 128 + (signal2 !== null ? signals[signal2] ?? 0 : 0));
      });
    });
  }
  /** run_one: <runCmd> in the worktree within the remaining budget, recorded as <recordedCmd>; a deny string when the budget ran out. */
  async runOne(runCmd, recordedCmd) {
    this.ordinal += 1;
    const ordinal = this.ordinal;
    const remaining = this.c.timeoutS - Math.trunc(this.activeMs() / 1e3);
    if (remaining <= 0) {
      await this.recordFinish(124, 1);
      return deny7(this.timeoutReason(ordinal, recordedCmd, "", msToS(this.activeMs())));
    }
    const outPath = `${this.c.scratch}/out-${ordinal}`;
    const cmdStart = Date.now();
    const { rc, fired } = await this.execute(runCmd, remaining, outPath);
    const cmdMs = Date.now() - cmdStart;
    let out2 = "";
    try {
      out2 = commandSubstitution(readFileSync16(outPath, "utf8"));
      rmSync4(outPath, { force: true });
    } catch {
    }
    const elapsed = msToS(cmdMs);
    const total = msToS(this.activeMs());
    const tail = lastLines(out2, TAIL_LINES);
    this.recordCommand(ordinal, recordedCmd, rc, elapsed, tail);
    if (rc === 124 && fired) {
      await this.recordFinish(124, 1);
      return deny7(this.timeoutReason(ordinal, recordedCmd, elapsed, total));
    }
    return { rc, out: out2, elapsed, total, tail };
  }
  /** run_verification: the deny decision, the pass context, or "" when every command passed. */
  async run() {
    const c = this.c;
    this.runStart = Date.now();
    if (c.wtSha !== "") {
      const ms = this.allowanceMs();
      if (ms !== null) {
        this.runId = this.start(ms);
        this.recordMs = Date.now() - this.runStart;
      }
    }
    if (this.runId !== "") this.planCarry();
    const carried = [];
    for (const cmd of c.commands) {
      if (this.carryOrdinals.has(this.ordinal + 1)) {
        this.ordinal += 1;
        this.recordCommand(this.ordinal, cmd, 0, "0", `carried from run #${this.carryRun} at ${this.carrySha.slice(0, 12)}`);
        carried.push(cmd);
        continue;
      }
      const r = await this.runOne(cmd, cmd);
      if (typeof r === "string") return r;
      if (r.rc !== 0) {
        await this.recordFinish(r.rc, 0);
        const hits = failureLines(r.out);
        const hitsBlock = hits !== "" ? `

Failure lines (max ${FAILURE_LINES}):
${hits}` : "";
        return deny7(
          commandSubstitution(
            `BLOCKED: verification failed.
Failing command (${this.ordinal}/${c.cmdTotal}): ${cmd}
Exit ${r.rc} after ${r.elapsed}s; ${r.total}s cumulative.${this.recordNote()}${hitsBlock}

Output (last ${TAIL_LINES} lines):
${r.tail}`
          )
        );
      }
    }
    let probeFail = "";
    let probeRc = 0;
    for (const f of c.findings) {
      const fid = commandSubstitution(jqRawText(f.id));
      const fstatus = commandSubstitution(jqRawText(f.status));
      const pcmd = commandSubstitution(jqRawText(f.probe_cmd));
      const r = await this.runOne(pcmd, `[probe ${fid}] ${pcmd}`);
      if (typeof r === "string") return r;
      if (r.rc === 0) {
        if (fstatus === "open") {
          const ms = this.allowanceMs();
          if (ms !== null) {
            const t0 = Date.now();
            if (!this.fixedWrite(ms, fid).ok) stderr(`${GATE_NAME43}: review finding ${fid} probe passed but its fixed write failed; it stays open
`);
            this.recordMs += Date.now() - t0;
          } else {
            stderr(`${GATE_NAME43}: run-record write budget (${RECORD_POOL_MS}ms) spent; review finding ${fid} probe passed but it stays open
`);
          }
        }
        continue;
      }
      if (probeRc === 0) probeRc = r.rc;
      const regressed = fstatus === "fixed" ? " \u2014 REGRESSION: this finding was fixed and its probe fails again" : "";
      probeFail += commandSubstitution(
        `

Finding ${fid} (probe ${this.ordinal}/${c.cmdTotal})${regressed}: ${pcmd}
Exit ${r.rc} after ${r.elapsed}s.
Output (last ${TAIL_LINES} lines):
${r.tail}`
      );
    }
    if (probeFail !== "") {
      await this.recordFinish(probeRc, 0);
      return deny7(
        `BLOCKED: verification failed \u2014 review finding probe(s) failed; ${msToS(this.activeMs())}s cumulative.${this.recordNote()}${probeFail}

Fix each finding so its probe exits 0 (task_brief.open_findings lists the open ones).`
      );
    }
    await this.recordFinish(0, 0);
    if (c.wtSha === "") return UNRECORDED_PASS_CONTEXT;
    if (carried.length > 0) {
      return context3(
        `TMB: verification carried forward from run #${this.carryRun} at ${this.carrySha.slice(0, 12)} \u2014 this commit touched none of their declared inputs (.config/tmb/verification-inputs.json), so these commands were not run again; the rest of the ${c.cmdTotal} ran:
${carried.join("\n")}`
      );
    }
    return "";
  }
};
function nowS() {
  return Math.floor(Date.now() / 1e3);
}
function lockHeldSince(lock) {
  try {
    const since = commandSubstitution(readFileSync16(`${lock}/started`, "utf8"));
    if (/^[0-9]+$/.test(since)) return Number(since);
  } catch {
  }
  try {
    return Math.floor(statSync25(lock).mtimeMs / 1e3);
  } catch {
    return null;
  }
}
function tryMkdir(dir) {
  try {
    mkdirSync8(dir);
    return true;
  } catch {
    return false;
  }
}
function removeQuietly(path) {
  try {
    rmSync4(path, { recursive: true, force: true });
  } catch {
  }
}
async function acquireLock(lock, staleS) {
  while (!tryMkdir(lock)) {
    const held = lockHeldSince(lock) ?? nowS();
    if (nowS() - held > staleS) {
      removeQuietly(lock);
      continue;
    }
    while (isDir(lock)) {
      await sleep2(LOCK_POLL_MS);
      const since = lockHeldSince(lock);
      if (since === null) continue;
      if (nowS() - since > staleS) break;
    }
  }
}
function makeScratch(db) {
  try {
    return resolve3(mkdtempSync(`${posixDirname(db)}/verify-run.`));
  } catch {
    return mkdtempSync(`${tmpdir()}/verify-run.`);
  }
}
function waive(db, taskId, reason, field6, env) {
  const row = gateRead(
    db,
    `SELECT COALESCE(issue_id, -1) || '|' || COALESCE(branch_id, '') || '|' || COALESCE(commit_sha, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`,
    env
  );
  if (row === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(`${GATE_NAME43} (waiver)`, env)}
`, code: 0 };
  if (row === "") return ALLOW;
  const rest = afterBar(row);
  const sha = field6("commit_sha") || afterBar(rest);
  const r = auditAppend(
    db,
    {
      issueId: beforeBar(row),
      branchId: beforeBar(rest),
      fromNode: `hook:${GATE_NAME43}`,
      eventType: "verification_gate_waived",
      summary: `SWE waived verification gate for task_id=${taskId}`,
      contentJson: `{"task_id":${jqNumberLiteral(taskId)},"commit_sha":${jqCompact(sha)},"waiver_reason":${jqCompact(reason)}}`,
      dedupePaths: ["$.task_id", "$.commit_sha"]
    },
    { caller: GATE_NAME43, env }
  );
  if (r.ok) return { stdout: r.stdout, code: 0 };
  if (r.error !== "") stderr(`${r.error}
`);
  return { stdout: `${r.stdout}${WAIVER_UNRECORDED_DENY}`, code: 0 };
}
var sweVerificationGate = async (payload, env) => {
  const input = `${commandSubstitution(payload)}
`;
  const field6 = (key2) => commandSubstitution(rawOrEmpty(input, ["tool_input", key2]));
  if (normalizeRole(field6("agent")) !== "swe") return ALLOW;
  if (field6("status") !== "completed") return ALLOW;
  const taskId = field6("task_id");
  if (!/^[0-9]+$/.test(taskId)) return ALLOW;
  const db = dbPath(env, (line) => stderr(`${line}
`));
  if (db === null || !haveSqlite(env)) return ALLOW;
  const genv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: "5000", TMB_DB_WRITE_RUN_BUDGET_MS: "10200" };
  const waiver = field6("waive_verification_gate_reason");
  if (waiver !== "" && shellLength(waiver, genv) >= 10) return waive(db, taskId, waiver, field6, genv);
  const verificationJson = sqliteRo(db, `SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
  const branchId = gateRead(db, `SELECT COALESCE(branch_id, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
  if (branchId === GATE_READ_ERROR) return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
  const taskRepo = sqliteRo(db, `SELECT COALESCE(repo, '') FROM tasks WHERE id = ${taskId} LIMIT 1;`, genv);
  if (branchId === "") return ALLOW;
  const findingsJson = reviewFindingsActive(db, taskId, genv);
  if (findingsJson === GATE_READ_ERROR) return { stdout: DB_UNAVAILABLE_DENY, code: 0 };
  const findings = parseFindings(findingsJson);
  const block2 = commandSubstitution(jqRawElements(verificationJson));
  if (block2 === "" && findings.length === 0) return { stdout: NO_VERIFICATION_CONTEXT, code: 0 };
  const slug = branchSlug(branchId);
  const wsRoot = posixDirname(posixDirname(posixDirname(db)));
  const repoRoot = taskRepo !== "" ? repoPathByName2(db, taskRepo, genv) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, genv) || wsRoot;
  const worktree = `${repoRoot}/.claude/worktrees/${slug}`;
  if (repoRoot === "" || !isDir(worktree)) {
    const missingAt = `${repoRoot || wsRoot || "?"}/.claude/worktrees/${slug}`;
    return {
      stdout: deny7(
        `BLOCKED: verification gate could not locate the task worktree at ${missingAt} \u2014 refusing to fail open with non-empty verification[]. Ensure SWE ran in its registered worktree (ensure-swe-worktree creates it under <repoRoot>/.claude/worktrees/<slug>), verify the task's repo maps to the correct repos.path, or set waive_verification_gate_reason.`
      ),
      code: 0
    };
  }
  const toolchainPath = joinToolchainPath(toolchainDirs(genv, worktree), genv.PATH ?? "");
  const budget = parseBudget(
    genv.TMB_VERIFICATION_TIMEOUT_S || sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", genv)
  );
  if (budget.warning !== "") stderr(budget.warning);
  const head = gitRun(worktree, ["rev-parse", "--verify", "-q", "HEAD"], genv);
  const wtSha = head.code === 0 ? commandSubstitution(head.stdout) : "";
  const expectedSha = field6("commit_sha");
  const commands = block2.split("\n").filter((line) => line !== "");
  const gateCmdsJson = jqCompact([...commands, ...findings.map(probeCommand)]);
  const scratch = makeScratch(db);
  let lock = "";
  try {
    const ctx = {
      db,
      taskId,
      worktree,
      wtSha,
      timeoutS: budget.timeoutS,
      commands,
      findings,
      cmdTotal: commands.length + findings.length,
      gateCmdsJson,
      toolchainPath,
      scratch,
      env: genv
    };
    const reuse = () => {
      if (wtSha === "") return null;
      if (expectedSha !== "" && !wtSha.startsWith(expectedSha)) return null;
      const row = reusableRun(db, taskId, wtSha, gateCmdsJson, genv);
      if (row === "") return null;
      return context3(
        `TMB: verification reused run #${beforeBar(row)} (${afterBar(row)}) \u2014 verification[] passed on commit ${wtSha} within the last hour, so it was not run again.`
      );
    };
    const reused = reuse();
    if (reused !== null) return { stdout: reused, code: 0 };
    if (wtSha === "") return { stdout: await new VerificationRun(ctx).run(), code: 0 };
    const lockRoot = `${posixDirname(db)}/locks`;
    try {
      mkdirSync8(lockRoot, { recursive: true });
    } catch {
      return { stdout: await new VerificationRun(ctx).run(), code: 0 };
    }
    const lockDir = `${lockRoot}/verify-${taskId}-${wtSha}`;
    await acquireLock(lockDir, budget.timeoutS + 60);
    lock = lockDir;
    try {
      writeFileSync6(`${lock}/started`, `${nowS()}
`);
    } catch {
    }
    const reusedAfterWait = reuse();
    if (reusedAfterWait !== null) return { stdout: reusedAfterWait, code: 0 };
    return { stdout: await new VerificationRun(ctx).run(), code: 0 };
  } finally {
    if (lock !== "") removeQuietly(lock);
    removeQuietly(scratch);
  }
};

// src/hooks/swe-spawn-bind.ts
var GATE_NAME44 = "swe-spawn-bind";
var FIELD_SEPARATOR = "";
var FieldsError = class extends Error {
};
function jqToString(value) {
  return typeof value === "string" ? value : jqCompact(value);
}
function orEmpty(value, path) {
  let v = value;
  try {
    for (const key2 of path) v = jqIndex(v, key2);
  } catch {
    throw new FieldsError();
  }
  return v === null || v === void 0 || v === false ? "" : v;
}
function joinedFields(input, a, b) {
  if (!jsonStream(input).complete) return null;
  try {
    return jsonValues(input, jqLiteralNumbers).map((value) => `${jqToString(orEmpty(value, a))}${FIELD_SEPARATOR}${jqToString(orEmpty(value, b))}`).join("\n");
  } catch (e) {
    if (e instanceof FieldsError) return null;
    throw e;
  }
}
function readTwo(text, sep2) {
  const line = text.split("\n")[0];
  const at2 = line.indexOf(sep2);
  if (at2 < 0) return [line, ""];
  let rest = line.slice(at2 + 1);
  if (rest.endsWith(sep2) && !rest.slice(0, -1).includes(sep2)) rest = rest.slice(0, -1);
  return [line.slice(0, at2), rest];
}
function bindSql(toolUseId2, agentId) {
  const safeSpawnId = sqlQuote(`tool_use:${toolUseId2}`);
  const safeAgentId = sqlQuote(agentId);
  return `
UPDATE agent_runs SET spawn_id = '${safeAgentId}'
 WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}'
   AND NOT EXISTS (SELECT 1 FROM agent_runs b
                    WHERE b.task_id = agent_runs.task_id AND b.spawn_id = '${safeAgentId}');`;
}
var sweSpawnBind = (payload, env) => {
  try {
    const input = commandSubstitution(payload);
    if (normalizeRole(commandSubstitution(jqAlternatives(input, [["tool_input", "subagent_type"]]))) !== "swe") return ALLOW;
    const fields = joinedFields(input, ["tool_use_id"], ["tool_response", "agentId"]);
    if (fields === null) return ALLOW;
    const [toolUseId2, agentId] = readTwo(commandSubstitution(fields), FIELD_SEPARATOR);
    if (toolUseId2 === "" || agentId === "") return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    dbWrite(db, bindSql(toolUseId2, agentId), { caller: GATE_NAME44, env });
  } catch {
  }
  return ALLOW;
};

// src/hooks/swe-spawn-rollback.ts
var GATE_NAME45 = "swe-spawn-rollback";
var RUN_NO_USAGE_SQL = "COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0";
var RUN_UNMEASURED_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${RUN_NO_USAGE_SQL} THEN 'unmeasured' END)`;
function toolUseId(input) {
  if (!jsonStream(input).complete) return null;
  const lines2 = [];
  for (const value of jsonValues(input, jqLiteralNumbers)) {
    let v;
    try {
      v = jqIndex(value, "tool_use_id");
    } catch {
      return null;
    }
    if (v !== null && v !== void 0 && v !== false) lines2.push(jqRawText(v));
  }
  return commandSubstitution(lines2.join("\n"));
}
function rollbackSql(id, now) {
  const safeSpawnId = sqlQuote(`tool_use:${id}`);
  return `
UPDATE tasks SET status = 'pending', updated_at = '${now}'
 WHERE status = 'running'
   AND id = (SELECT task_id FROM agent_runs
              WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}' AND completed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_runs o
                    WHERE o.task_id = tasks.id AND o.agent_type = 'swe' AND o.completed_at IS NULL
                      AND o.spawn_id IS NOT '${safeSpawnId}');
UPDATE agent_runs
   SET completed_at = '${now}',
       exit_reason = 'swept_orphan',
       ${RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}' AND completed_at IS NULL;`;
}
var sweSpawnRollback = (payload, env) => {
  try {
    const input = commandSubstitution(payload);
    if (normalizeRole(commandSubstitution(jqAlternatives(input, [["tool_input", "subagent_type"]]))) !== "swe") return ALLOW;
    const id = toolUseId(input);
    if (id === null || id === "") return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    dbWrite(db, rollbackSql(id, nowIso()), { caller: GATE_NAME45, env });
  } catch {
  }
  return ALLOW;
};

// src/hooks/post-task-create-spawn-hint.ts
var GATE_NAME46 = "post-task-create-spawn-hint";
var BYPASS_ENV6 = "TMB_DISABLE_SPAWN_HINT";
var CREATE_BATCH_TOOL = /^mcp__[\s\S]*trajectory-server__task_create_batch$/;
var IndexError = class extends Error {
};
var isRawJson3 = (value) => JSON.isRawJSON?.(value) ?? false;
function at(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || isRawJson3(value)) throw new IndexError();
  if (typeof key2 === "number") {
    if (!Array.isArray(value)) throw new IndexError();
    return value[key2] ?? null;
  }
  if (Array.isArray(value)) throw new IndexError();
  const v = value[key2];
  return v === void 0 ? null : v;
}
function truthy3(value) {
  return value !== null && value !== void 0 && value !== false;
}
function rawOr(text, path, fallback) {
  const lines2 = jqMap(text, (value) => {
    let v = value;
    try {
      for (const key2 of path) v = at(v, key2);
    } catch {
      return null;
    }
    return truthy3(v) ? jqRawText(v) : fallback;
  }).filter((line) => line !== null);
  return commandSubstitution(lines2.join("\n"));
}
function interpolate(value) {
  return typeof value === "string" ? value : jqCompact(value);
}
function taskLine(task) {
  return [interpolate(at(task, "id")), interpolate(at(task, "branch_id"))];
}
function taskList(responseText) {
  const out2 = [];
  for (const value of jsonValues(`${responseText}
`, jqLiteralNumbers)) {
    if (!Array.isArray(value)) {
      out2.push("");
      continue;
    }
    try {
      out2.push(value.map((t) => taskLine(t)).map(([id, branch]) => `  - task_id=${id} branch_id=${branch}`).join("\n"));
    } catch (e) {
      if (!(e instanceof IndexError)) throw e;
    }
  }
  return commandSubstitution(out2.join("\n"));
}
function taskRows(responseText) {
  const out2 = [];
  for (const value of jsonValues(`${responseText}
`, jqLiteralNumbers)) {
    if (value === null || typeof value !== "object" || isRawJson3(value)) continue;
    const items = Array.isArray(value) ? value : Object.values(value);
    try {
      for (const item of items) out2.push(taskLine(item).join("	"));
    } catch (e) {
      if (!(e instanceof IndexError)) throw e;
    }
  }
  const text = out2.map((row) => `${row}
`).join("");
  const lines2 = text.split("\n");
  lines2.pop();
  return lines2;
}
function readTabFields(line) {
  const trimmed = line.replace(/^\t+/, "");
  const at2 = trimmed.indexOf("	");
  if (at2 < 0) return [trimmed, ""];
  return [trimmed.slice(0, at2), trimmed.slice(at2).replace(/^\t+/, "").replace(/\t+$/, "")];
}
function worktreeOf(db, id, env) {
  if (db === null) return "unresolved (no trajectory DB)";
  const loc = taskLocation(db, id, env);
  return loc.code === 0 ? loc.worktree : `unresolved (${loc.missing})`;
}
function hintReason(toolName2, tasks) {
  const tool = toolName2.slice(toolName2.lastIndexOf("__") + 2);
  return `\u{1F680} SWE-spawn hint: ${tool} created the following tasks. Per tmb_planning Step 4, the next step is to spawn every created task's SWE in one turn \u2014 one Agent call each, all in the same message, so independent tasks run concurrently. Production sessions where this step was skipped left tasks stuck at status='pending' forever.

Tasks created:
${tasks}

For each task, run the two-step proven flow:
1. Pre-create the worktree: \`printf '{"branch":"<branch_id>"}' | bash \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worktree-create.sh\` \u2014 capture the printed path.
2. Spawn SWE (all tasks' Agent calls together in one message): \`Agent(subagent_type='swe', prompt='task_id=<N> worktree=<absolute-worktree-path>')\` \u2014 no isolation= parameter.

If you intentionally want to halt before SWE (e.g. user requested review), surface that reason explicitly so future sessions don't see this as a stuck-task bug.`;
}
var postTaskCreateSpawnHint = (payload, env) => {
  try {
    if (env[BYPASS_ENV6] === "1") return ALLOW;
    const input = `${commandSubstitution(payload)}
`;
    const toolName2 = rawOr(input, ["tool_name"], "");
    if (!CREATE_BATCH_TOOL.test(toolName2)) return ALLOW;
    if (rawOr(input, ["tool_response", "is_error"], "false") === "true") return ALLOW;
    const responseText = rawOr(input, ["tool_response", "content", 0, "text"], "");
    if (responseText === "") return ALLOW;
    const list = taskList(responseText);
    if (list === "") return ALLOW;
    const db = dbPath(env);
    const withPaths = taskRows(responseText).map(readTabFields).map(([id, branch]) => `  - task_id=${id} branch_id=${branch} worktree=${worktreeOf(db, id, env)}`).join("\n");
    return {
      stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hintReason(toolName2, withPaths || list) } })}
`,
      code: 0
    };
  } catch {
    return ALLOW;
  }
};

// src/hooks/reviewer-identity-observe.ts
var GATE_NAME47 = "reviewer-identity-observe";
var VALIDATION_RECORD_TOOL = /^mcp__[\s\S]*trajectory-server__validation_record$/;
function denyUnavailable(env, stdout = "") {
  return { stdout: `${stdout}${denyDbUnavailable(GATE_NAME47, env)}
`, code: 0 };
}
var reviewerIdentityObserve = (payload, env) => {
  const input = jqInput(payload);
  if (!VALIDATION_RECORD_TOOL.test(jqCapture(input, ["tool_name"]))) return ALLOW;
  const agentId = jqCapture(input, ["agent_id"]);
  if (agentId === "") return ALLOW;
  if (normalizeRole(jqCapture(input, ["agent_type"])) !== CODE_REVIEWER_ROLE) return ALLOW;
  const taskId = sqlInt(jqCapture(input, ["tool_input", "task_id"]));
  const attemptN = sqlInt(jqCapture(input, ["tool_input", "attempt_n"]));
  if (taskId === "" || attemptN === "") return ALLOW;
  const sessionId = jqCapture(input, ["session_id"]);
  const toolUseId2 = jqCapture(input, ["tool_use_id"]);
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  const state = dbState(env);
  if (state === "unresolved" || db === null) return ALLOW;
  if (state === "error") return denyUnavailable(env);
  const issueId = gateRead(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env);
  if (issueId === GATE_READ_ERROR) return denyUnavailable(env);
  if (issueId === "") return ALLOW;
  const content = jqCompact({
    task_id: jqNumber2(taskId),
    attempt_n: jqNumber2(attemptN),
    session_id: sessionId,
    agent_id: agentId,
    tool_use_id: toolUseId2 === "" ? null : toolUseId2,
    observed_at: nowIso(),
    consumed: 0
  });
  const w = auditAppend(
    db,
    {
      issueId,
      branchId: "",
      fromNode: `hook:${GATE_NAME47}`,
      eventType: "reviewer_identity_observed",
      summary: `code-reviewer ${agentId} called validation_record for task ${taskId} attempt ${attemptN}`,
      contentJson: content
    },
    { env, caller: GATE_NAME47 }
  );
  if (w.ok) return { stdout: w.stdout, code: 0 };
  process.stderr.write(`${w.error}
`);
  return denyUnavailable(env, w.stdout);
};

// src/hooks/cheatcode-install-approval.ts
var GATE_NAME48 = "cheatcode-install-approval";
var NO_SOURCE_URL_REASON = "BLOCKED: cheatcode_install requires a candidate.source_url so the per-candidate approval can be verified. Recovery: call cheatcode_install with candidate={name,kind,source_url}.";
var UNVERIFIABLE_REASON = "BLOCKED: cheatcode_install approval cannot be verified (trajectory DB unavailable) \u2014 failing closed. Installs are human-approved, never silent.";
function notApprovedReason(name3, url) {
  return `BLOCKED: no human-approval record for cheatcode '${name3 || url}' (${url}). Installs are human-approved, never silent. Recovery: record approval via cheatcode_approve(agent='bro', candidate={name,kind,source_url}) after the Human confirms, then retry cheatcode_install.`;
}
function approvalSql(url) {
  return `
  SELECT COUNT(*) FROM audit
   WHERE event_type = 'cheatcode_approved'
     AND json_extract(content_json, '$.source_url') = '${sqlQuote(url)}'
  LIMIT 1;
`;
}
function deny8(reason) {
  return { stdout: denyJson(reason), code: 0 };
}
var cheatcodeInstallApproval = (payload, env) => {
  const input = jqInput(payload);
  if (!jqCapture(input, ["tool_name"], true).includes("cheatcode_install")) return ALLOW;
  const url = jqCapture(input, ["tool_input", "candidate", "source_url"], true);
  const name3 = jqCapture(input, ["tool_input", "candidate", "name"], true);
  if (url === "") return deny8(NO_SOURCE_URL_REASON);
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null || !haveSqlite(env)) return deny8(UNVERIFIABLE_REASON);
  const approved = sqliteRo(db, approvalSql(url), env);
  if (/^[0-9]+$/.test(approved) && Number(approved) > 0) return ALLOW;
  return deny8(notApprovedReason(name3, url));
};

// src/hooks/stay-on-base-guard.ts
import { statSync as statSync26 } from "node:fs";

// src/hooks/lib/statement-rows.ts
function readTabFields2(line, n3) {
  let s = line.replace(/^\t+/, "");
  const fields = [];
  for (let i2 = 0; i2 < n3 - 1; i2++) {
    const tab = s.indexOf("	");
    if (tab < 0) {
      fields.push(s);
      s = "";
      continue;
    }
    fields.push(s.slice(0, tab));
    s = s.slice(tab).replace(/^\t+/, "");
  }
  fields.push(s.replace(/\t+$/, ""));
  return fields;
}
function statementRows(statements2) {
  const text = stripTrailingNewlines(statements2.map(({ dir, stmt }) => `${dir}	${stmt}`).join("\n"));
  if (text === "") return [];
  return text.split("\n").map((line) => {
    const [dir, stmt] = readTabFields2(line, 2);
    return { dir, stmt };
  });
}
function payloadCwdOf(input, env = process.env) {
  return jqCapture(input, ["cwd"], true) || shellPwd(env);
}
function denyResult(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}

// src/hooks/stay-on-base-guard.ts
var GATE_NAME49 = "stay-on-base-guard";
var BRANCH_WORD = /^[a-zA-Z0-9_./:@^~-]+$/;
var CREATES_OR_RESTORES = [" -b ", " -B ", " -c ", " -C ", " --create ", " -- "];
function switchTarget(sub) {
  const rest = sub.slice(sub.indexOf(" ") + 1);
  let target = "";
  for (const w of (rest.split("\n")[0] ?? "").split(/[ \t]+/)) if (w !== "" && !w.startsWith("-")) target = w;
  return target;
}
function isFile12(path) {
  try {
    return statSync26(path).isFile();
  } catch {
    return false;
  }
}
var stayOnBaseGuard = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ["tool_name"]) !== "Bash") return ALLOW;
  const command = jqCapture(input, ["tool_input", "command"]);
  if (!command.includes("checkout") && !command.includes("switch")) return ALLOW;
  const listed2 = await cmdStatements(command, payloadCwdOf(input, env), env);
  if (!listed2.ok) return haveSqlite(env) && isFile12(dbPath(env) ?? "") ? denyResult(PARSE_REASON) : ALLOW;
  let lines2 = "";
  for (const { dir, stmt } of statementRows(listed2.statements)) {
    const sub = gitSubcommand(stmt);
    if (!sub.startsWith("checkout ") && !sub.startsWith("switch ")) continue;
    if (CREATES_OR_RESTORES.some((flag) => ` ${sub} `.includes(flag))) continue;
    const target = switchTarget(sub);
    if (target === "" || !BRANCH_WORD.test(target)) continue;
    lines2 += `${dir}	${target}	${stmt}
`;
  }
  if (lines2 === "") return ALLOW;
  if (!haveSqlite(env)) return ALLOW;
  const db = dbPath(env) ?? "";
  if (!isFile12(db)) return ALLOW;
  const switches = lines2.split("\n").map((line) => {
    const [dir, target, stmt] = readTabFields2(line, 3);
    return { dir, target, stmt };
  });
  for (const { dir, target, stmt } of switches) {
    if (target === "") continue;
    if (dir === "-" || dir.includes("/.claude/worktrees/")) continue;
    const openTask = gateRead(
      db,
      `
    SELECT id FROM tasks
     WHERE branch_id = '${sqlQuote(target)}'
       AND status IN ('pending','running','needs_validation')
     LIMIT 1;
  `,
      env
    );
    if (openTask === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME49, env)}
`, code: 0 };
    if (openTask === "" || !openTask.split("\n").some((l) => /^[0-9]+$/.test(l))) continue;
    if (dir === "?") return { stdout: denyAmbiguousGitTarget(stmt), code: 0 };
    const loc = taskLocation(db, openTask, env);
    const wt = loc.code === 0 ? loc.worktree : `${repoGitRoot(dir, env) || dir}/.claude/worktrees/${branchSlug(target)}`;
    return denyResult(
      `the main checkout stays on the base; SWE work lives in worktrees \u2014 use the worktree at ${wt}. Branch '${target}' belongs to open task #${openTask}. Switch to the worktree instead: cd ${wt}`
    );
  }
  return ALLOW;
};

// src/hooks/branch-up-to-date-with-remote.ts
var GATE_NAME50 = "branch-up-to-date-with-remote";
var CREATES_BRANCH = [" -b ", " -B ", " --create-branch "];
function behindCount(root, range, env) {
  const r = gitRun(root, ["rev-list", "--count", range], env);
  return stripTrailingNewlines(r.code === 0 ? r.stdout : `${r.stdout}?
`);
}
var branchUpToDateWithRemote = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ["tool_name"]) !== "Bash") return ALLOW;
  if ((env.TMB_ALLOW_STALE_BRANCH ?? "") === "1") return ALLOW;
  const command = jqCapture(input, ["tool_input", "command"]);
  if (command === "" || !command.includes("worktree")) return ALLOW;
  const cwd = payloadCwdOf(input, env);
  const listed2 = await cmdStatements(command, cwd, env);
  if (!listed2.ok) return dbPath(env) !== null && haveSqlite(env) ? denyResult(PARSE_REASON) : ALLOW;
  let wtDir = "";
  let wtSub = "";
  for (const { dir, stmt } of statementRows(listed2.statements)) {
    const sub = gitSubcommand(stmt);
    if (sub.startsWith("worktree add ")) {
      wtDir = dir;
      wtSub = sub;
      break;
    }
  }
  if (wtSub === "") return ALLOW;
  if (CREATES_BRANCH.some((flag) => ` ${wtSub} `.includes(flag))) return ALLOW;
  const branch = wtSub.slice(wtSub.lastIndexOf(" ") + 1);
  if (branch === "") return ALLOW;
  const root = stmtRepoRoot(wtDir, cwd, env);
  if (root === "") return ALLOW;
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return ALLOW;
  const repo = sqlQuote(repoNameForRoot(db, root, env));
  const row = gateRead(db, `SELECT 'repo|' || COALESCE(target_branch, '') FROM repos WHERE name = '${repo}' LIMIT 1;`, env);
  if (row === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME50, env)}
`, code: 0 };
  if (row === "") return ALLOW;
  const prTarget = (row.startsWith("repo|") ? row.slice(5) : row) || "main";
  if (!gitOk(root, ["rev-parse", "--verify", branch], env)) return ALLOW;
  if (gitOut(root, ["remote", "get-url", "origin"], env) === "") return ALLOW;
  gitRun(root, ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=5", "fetch", "origin", prTarget, "--quiet"], env);
  if (!gitOk(root, ["rev-parse", "--verify", `origin/${prTarget}`], env)) return ALLOW;
  if (gitOk(root, ["merge-base", "--is-ancestor", `origin/${prTarget}`, branch], env)) return ALLOW;
  const behind = behindCount(root, `${branch}..origin/${prTarget}`, env);
  return denyResult(
    `BLOCKED: branch '${branch}' is behind origin/${prTarget} by ${behind} commit(s). bro must rebase the task branch onto the latest origin/${prTarget} (or recreate it: \`git branch -D ${branch} && git fetch origin ${prTarget} && git branch ${branch} origin/${prTarget}\`) before SWE attaches a worktree. This catches stale-local-main bugs where the worktree starts from yesterday's commit and conflicts on push. Bypass: TMB_ALLOW_STALE_BRANCH=1 (e.g. offline work).`
  );
};

// src/hooks/no-worktree-branch-create.ts
var GATE_NAME51 = "no-worktree-branch-create";
var CREATES_BRANCH2 = [" -b ", " -B ", " --create-branch "];
var BRANCH_CREATE_REASON = "BLOCKED: `git worktree add` cannot create a branch (-b/-B/--create-branch). Branch authority belongs to bro: bro creates the branch first via `git branch <task.branch_id> HEAD`, then SWE attaches the worktree with `git worktree add <path> <branch>` (no -b/-B). Without this rule, SWE may invent a different branch name than the spec (`tasks.branch_id`), breaking the push-gate lookup. Bypass: TMB_ALLOW_WORKTREE_BRANCH_CREATE=1.";
var DETACH_REASON = "BLOCKED: `git worktree add --detach` strands SWE's commits on a detached HEAD instead of advancing the branch ref. Pushes then upload an empty branch and MRs open with no diff (#2869). Use a plain `git worktree add <path> <branch>` so commits advance the named branch naturally. Bypass: TMB_ALLOW_WORKTREE_DETACH=1.";
var REASONS = { "branch-create": BRANCH_CREATE_REASON, detach: DETACH_REASON, parse: PARSE_REASON };
function violationOf(statements2, env) {
  for (const { stmt } of statementRows(statements2)) {
    const sub = gitSubcommand(stmt);
    if (!sub.startsWith("worktree add ")) continue;
    const padded = ` ${sub} `;
    if (CREATES_BRANCH2.some((flag) => padded.includes(flag)) && (env.TMB_ALLOW_WORKTREE_BRANCH_CREATE ?? "0") !== "1") return "branch-create";
    if (padded.includes(" --detach ") && (env.TMB_ALLOW_WORKTREE_DETACH ?? "0") !== "1") return "detach";
  }
  return null;
}
var noWorktreeBranchCreate = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ["tool_name"]) !== "Bash") return ALLOW;
  const command = jqCapture(input, ["tool_input", "command"]);
  if (!command.includes("worktree")) return ALLOW;
  const listed2 = await cmdStatements(command, "/", env);
  const violation = listed2.ok ? violationOf(listed2.statements, env) : "parse";
  if (violation === null) return ALLOW;
  dbPath(env, (line) => process.stderr.write(`${line}
`));
  const state = dbState(env);
  if (state === "unresolved") return ALLOW;
  if (state === "error") return { stdout: `${denyDbUnavailable(GATE_NAME51, env)}
`, code: 0 };
  return denyResult(REASONS[violation]);
};

// src/hooks/no-remote-auth-guard.ts
var GATE_NAME52 = "no-remote-auth-guard";
var AUTH_LOGIN = [
  ["gh", "gh auth login"],
  ["glab", "glab auth login"]
];
function hasRemoteUrl(remotesJson) {
  const lines2 = [];
  for (const value of jqInput(remotesJson).values) {
    if (value === null || typeof value !== "object") break;
    let n3 = 0;
    try {
      for (const item of Object.values(value)) {
        const url = jqGet(item, "url");
        if (url !== null && url !== "") n3++;
      }
    } catch (e) {
      if (e instanceof JqUnindexable) break;
      throw e;
    }
    lines2.push(jqRaw2(n3 > 0));
  }
  return shellCapture2(lines2.join("\n"));
}
var noRemoteAuthGuard = async (payload, env) => {
  const input = jqInput(payload);
  const command = jqCapture(input, ["tool_input", "command"], true);
  if (command === "" || !command.includes("login")) return ALLOW;
  const cwd = payloadCwdOf(input, env);
  const listed2 = await cmdStatements(command, cwd, env);
  if (!listed2.ok) return dbPath(env) !== null && haveSqlite(env) ? denyResult(PARSE_REASON) : ALLOW;
  let tool = "";
  let matchedDir = "";
  for (const { dir, stmt } of statementRows(listed2.statements)) {
    const hit = AUTH_LOGIN.find(([, login]) => stmt === login || stmt.startsWith(`${login} `));
    if (hit) {
      [tool] = hit;
      matchedDir = dir;
      break;
    }
  }
  if (tool === "") return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return ALLOW;
  const remotes = repoRemotes(db, stmtRepoRoot(matchedDir, cwd, env), env);
  if (remotes === "") return ALLOW;
  if (hasRemoteUrl(remotes) !== "false") return ALLOW;
  return denyResult(
    `BLOCKED: No remote is configured (remotes have no URL) \u2014 TMB is operating locally. Interactive '${tool} auth login' will hang here (no TTY/network); remote/push ops are skipped. Work locally.`
  );
};

// src/hooks/swe-scope-fence.ts
var GATE_NAME53 = "swe-scope-fence";
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function jqFirst(input, paths, orEmpty2 = false) {
  const lines2 = [];
  for (const value of input.values) {
    let picked = null;
    try {
      for (const path of paths) {
        picked = jqAlt2(jqGet(value, ...path), null);
        if (picked !== null) break;
      }
      if (picked === null && !orEmpty2) picked = "";
    } catch (e) {
      if (e instanceof JqUnindexable) continue;
      throw e;
    }
    if (picked !== null) lines2.push(jqRaw2(picked));
  }
  return shellCapture2(lines2.join("\n"));
}
function worktreeRelative(path, worktree) {
  const prefix = `${worktree.endsWith("/") ? worktree.slice(0, -1) : worktree}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
function scopeNote(note2) {
  return `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `TMB: ${note2}` } })}
`;
}
var sweScopeFence = (payload, env) => {
  const captured = shellCapture2(payload);
  const input = jqInput(`${captured}
`);
  if (!EDIT_TOOLS2.has(jqFirst(input, [["tool_name"]]))) return ALLOW;
  const role = normalizeRole(jqFirst(input, [["agent_type"], ["subagent_type"], ["tool_input", "subagent_type"]], true));
  if (role !== "swe") return ALLOW;
  const target = jqFirst(input, [["tool_input", "file_path"], ["tool_input", "notebook_path"]]);
  if (target === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const ctx = agentContext(captured, db, env);
  if (ctx.code !== 0) return ALLOW;
  const fence = new ScopeFence(env);
  fence.load(db, ctx.taskId);
  if (fence.state !== "ok") return ALLOW;
  const cwd = jqFirst(input, [["cwd"]], true) || env.PWD || process.cwd();
  const abs = shellCapture2(pathCanonical2(target.startsWith("/") ? target : `${cwd}/${target}`));
  const rel = worktreeRelative(abs, shellCapture2(pathCanonical2(ctx.worktree)));
  if (rel === null || fence.allows(rel)) return ALLOW;
  const note2 = fence.note(ctx.taskId, rel);
  return note2 === "" ? ALLOW : { stdout: scopeNote(note2), code: 0 };
};

// src/hooks/orphan-scan.ts
import { spawnSync as spawnSync11 } from "node:child_process";
import { existsSync as existsSync12, lstatSync as lstatSync8, opendirSync, readFileSync as readFileSync17, rmSync as rmSync5, statSync as statSync27 } from "node:fs";
var GATE_NAME54 = "orphan-scan";
var DEADLINE_S = 4;
var ANCESTRY_GUARD2 = 40;
var INT64_MIN2 = -(2n ** 63n);
var INT64_MAX2 = 2n ** 63n - 1n;
var CC_WORD = /^(claude|claude\.exe|.*\/claude|.*\/claude\.exe|.*\/claude\/versions\/.*|.*\/claude-code\/cli\.js|.*\/claude-code\/cli\.mjs)$/s;
function signal(pid, sig) {
  if (!/^[0-9]+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), sig);
    return true;
  } catch {
    return false;
  }
}
var REAL_PROCESS_OPS = {
  alive: (pid) => signal(pid, 0),
  terminate: (pid) => signal(pid, "SIGTERM")
};
function bashInt(text) {
  const m = /^[ \t\n]*([+-]?[0-9]+)[ \t\n]*$/.exec(text);
  if (m === null) return null;
  const n3 = BigInt(m[1]);
  return n3 < INT64_MIN2 || n3 > INT64_MAX2 ? null : n3;
}
function projectSlug(dir) {
  return stripTrailingNewlines(
    dir.split("\n").map((line) => line.replace(/[^A-Za-z0-9]+/g, "-")).join("\n")
  );
}
function isCcCommand2(command) {
  return firstLine(command).split(/[ \t]+/).some((word) => word !== "" && CC_WORD.test(word));
}
function capture4(cmd, args2, env) {
  const r = spawnSync11(cmd, args2, { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  return r.error ? "" : r.stdout ?? "";
}
function procPpid2(pid, env) {
  return stripTrailingNewlines(capture4("ps", ["-o", "ppid=", "-p", pid], env).replaceAll(" ", ""));
}
function procCmd2(pid, env) {
  return stripTrailingNewlines(capture4("ps", ["-o", "command=", "-p", pid], env));
}
function aboveInit(pid) {
  const n3 = pid === "" ? null : bashInt(pid);
  return n3 !== null && n3 > 1n;
}
function nearestCcAncestor2(start2, env) {
  let pid = start2;
  for (let guard2 = 1; aboveInit(pid) && guard2 <= ANCESTRY_GUARD2; guard2 += 1) {
    if (isCcCommand2(procCmd2(pid, env))) return pid;
    pid = procPpid2(pid, env);
  }
  return "";
}
function chainContains2(start2, target, env) {
  if (target === "") return false;
  let pid = start2;
  for (let guard2 = 1; aboveInit(pid) && guard2 <= ANCESTRY_GUARD2; guard2 += 1) {
    if (pid === target) return true;
    pid = procPpid2(pid, env);
  }
  return false;
}
function isTrajectoryServer(pid, env) {
  return capture4("ps", ["-p", pid, "-o", "command="], env).includes("trajectory-server");
}
function holders(liveDb, env) {
  const override = env.TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE ?? "";
  if (override !== "") return override.replaceAll(" ", "\n").split("\n");
  if (!commandOnPath("lsof", env)) return [];
  const lines2 = stripTrailingNewlines(capture4("lsof", ["-t", "--", liveDb], env)).split("\n");
  return [...new Set(lines2)].sort(byteCompare);
}
function exists(path) {
  return existsSync12(path);
}
function nonEmpty(path) {
  try {
    return statSync27(path).size > 0;
  } catch {
    return false;
  }
}
function isFile13(path) {
  try {
    return statSync27(path).isFile();
  } catch {
    return false;
  }
}
function isDir7(path) {
  try {
    return statSync27(path).isDirectory();
  } catch {
    return false;
  }
}
var JqError6 = class extends Error {
};
function index5(value, key2) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError6(key2);
  const v = value[key2];
  return v === void 0 ? null : v;
}
function children(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value);
  return [];
}
function pinnedPaths(json) {
  let text;
  try {
    text = readFileSync17(json, "utf8");
  } catch {
    return [];
  }
  const out2 = [];
  for (const doc of jsonStream(text).values) {
    try {
      let plugins = index5(doc, "plugins");
      if (plugins === null || plugins === false) plugins = {};
      if (typeof plugins !== "object") throw new JqError6("has no keys");
      for (const value of children(plugins)) {
        for (const install of children(value)) {
          const path = index5(install, "installPath");
          if (path !== null && path !== false) out2.push(...jqRawText(path).split("\n"));
        }
      }
    } catch (e) {
      if (!(e instanceof JqError6)) throw e;
    }
  }
  return out2;
}
function globRegex2(glob) {
  let re = "";
  for (const c of glob) re += c === "*" ? ".*" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${re}$`, "s");
}
function cacheVersionDirs(root, plugin, within) {
  const match2 = globRegex2(`*/${plugin}/*`);
  const out2 = [];
  const walk = (dir, depth) => {
    let handle2;
    try {
      handle2 = opendirSync(dir);
    } catch {
      return;
    }
    try {
      for (let entry = handle2.readSync(); entry !== null; entry = handle2.readSync()) {
        if (!within()) return;
        const path = `${dir}/${entry.name}`;
        let directory;
        try {
          directory = lstatSync8(path).isDirectory();
        } catch {
          continue;
        }
        if (!directory) continue;
        if (depth === 3) {
          if (match2.test(path)) out2.push(path);
        } else {
          walk(path, depth + 1);
        }
      }
    } finally {
      handle2.closeSync();
    }
  };
  try {
    if (!lstatSync8(root).isDirectory()) return out2;
  } catch {
    return out2;
  }
  walk(root, 1);
  return out2;
}
function liveDbOf(env, warn) {
  const pinned = env.TMB_ORPHAN_SCAN_PROJECT_DIR ?? "";
  if (pinned !== "") {
    return { liveDb: dbPath({ ...env, CLAUDE_PROJECT_DIR: pinned }, warn) ?? "", projectDir: pinned };
  }
  const liveDb = dbPath(env, warn) ?? "";
  let projectDir = projectRoot(env);
  if (liveDb !== "" && (env.TRAJECTORY_DB_PATH ?? "") === "") projectDir = posixDirname(posixDirname(posixDirname(liveDb)));
  return { liveDb, projectDir };
}
function orphanScanRun(env, ops, stderr2) {
  const deadline = Math.floor(Date.now() / 1e3) + DEADLINE_S;
  const within = () => Math.floor(Date.now() / 1e3) < deadline;
  const clean2 = (env.TMB_ORPHAN_SCAN_CLEAN ?? "") === "1";
  const plugin = pluginName2(env);
  const scanHome = env.TMB_ORPHAN_SCAN_HOME || (env.HOME ?? "");
  const resolved = liveDbOf(env, (line) => stderr2(`${line}
`));
  const projectDir = resolved.projectDir;
  if (projectDir === "") return ALLOW;
  const liveDb = resolved.liveDb || dbLocation(projectDir, env);
  if (exists(liveDb) && gateRead(liveDb, "SELECT count(*) FROM sqlite_master;", env) === GATE_READ_ERROR) {
    stderr2(`orphan-scan: trajectory DB unavailable (${liveDb}) \u2014 scan continues without its schema version
`);
  }
  const historyDir = `${scanHome}/.claude/projects/${projectSlug(projectDir)}`;
  const schemaVersion = (db) => haveSqlite(env) ? sqliteRo(db, "SELECT schema_version FROM plugin_meta ORDER BY id DESC LIMIT 1;", env) : "";
  const liveSchema = nonEmpty(liveDb) ? schemaVersion(liveDb) : "";
  const report = [];
  const staleDbs = [];
  const considerStaleDb = (db) => {
    if (!exists(db) || db === liveDb) return;
    if (!nonEmpty(db)) {
      staleDbs.push(db);
      return;
    }
    const v = schemaVersion(db);
    if (v === "" || liveSchema === "") return;
    const a = bashInt(v);
    const b = bashInt(liveSchema);
    if (a !== null && b !== null && a < b) staleDbs.push(db);
  };
  considerStaleDb(`${historyDir}/${TMB_DB_FILENAME}`);
  considerStaleDb(`${historyDir}/memory/${TMB_DB_FILENAME}`);
  if (!nonEmpty(liveDb)) considerStaleDb(dbLocation(scanHome, env));
  for (const db of staleDbs) report.push(`stale trajectory DB (this project): ${db}`);
  const installedJson2 = `${scanHome}/.claude/plugins/installed_plugins.json`;
  const cacheRoot = `${scanHome}/.claude/plugins/cache`;
  const unusedCache = [];
  if (isFile13(installedJson2) && isDir7(cacheRoot) && within()) {
    const pinned = new Set(pinnedPaths(installedJson2));
    for (const vdir of cacheVersionDirs(cacheRoot, plugin, within)) {
      if (!isDir7(vdir)) continue;
      if (!within()) break;
      if (pinned.has(vdir)) continue;
      unusedCache.push(vdir);
    }
  }
  for (const vdir of unusedCache) report.push(`unused cache version (pinned by no project): ${vdir}`);
  const ownCc = nearestCcAncestor2(env.TMB_ORPHAN_SCAN_SELF_PID || String(process.pid), env);
  const staleProcs = [];
  if (nonEmpty(liveDb) && within()) {
    for (const pid of holders(liveDb, env)) {
      if (pid === "") continue;
      if (!isTrajectoryServer(pid, env)) continue;
      if (chainContains2(pid, ownCc, env)) continue;
      const owner = nearestCcAncestor2(pid, env);
      if (owner !== "" && ops.alive(owner)) continue;
      staleProcs.push(pid);
    }
  }
  for (const pid of staleProcs) report.push(`stale duplicate trajectory-server on this project's live DB: pid ${pid}`);
  const cleaned = [];
  if (clean2) {
    for (const db of staleDbs) {
      if (db === liveDb) continue;
      try {
        rmSync5(db, { force: true });
        cleaned.push(`removed stale DB: ${db}`);
      } catch {
      }
    }
    for (const vdir of unusedCache) {
      if (!vdir.startsWith(`${cacheRoot}/`)) continue;
      try {
        rmSync5(vdir, { recursive: true, force: true });
        cleaned.push(`removed unused cache version: ${vdir}`);
      } catch {
      }
    }
    for (const pid of staleProcs) {
      if (ops.alive(pid) && isTrajectoryServer(pid, env) && ops.terminate(pid)) {
        cleaned.push(`terminated stale duplicate trajectory-server: pid ${pid}`);
      }
    }
  }
  if (report.length === 0) return ALLOW;
  const mode = clean2 ? "cleanup enabled (TMB_ORPHAN_SCAN_CLEAN=1)" : "report-only (set TMB_ORPHAN_SCAN_CLEAN=1 to clean)";
  let ctx = `=== TMB orphan scan (project-scoped) ===
project: ${projectDir}
mode: ${mode}
${report.map((l) => `${l}
`).join("")}`;
  if (cleaned.length > 0) ctx += `--- cleaned ---
${cleaned.map((l) => `${l}
`).join("")}`;
  ctx += "========================================";
  return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } })}
`, code: 0 };
}
var orphanScan = (_payload, env) => {
  try {
    return orphanScanRun(env, REAL_PROCESS_OPS, (text) => process.stderr.write(text));
  } catch {
    return ALLOW;
  }
};

// src/hooks/session-start-prescan.ts
import { spawn as spawn3 } from "node:child_process";
import { readdirSync as readdirSync7, readFileSync as readFileSync18, statSync as statSync28 } from "node:fs";
import { fileURLToPath as fileURLToPath7 } from "node:url";
var GATE_NAME55 = "session-start-prescan";
var NO_JQ_LINE = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Tooling: jq not found \u2014 every TMB gate will deny until it is installed"}}\n';
var SUBDIR_STACKS_MAX = 3;
var TOPLEVEL_MAX = 10;
var WORLD_MODEL_STALE_SECS = 7n * 24n * 3600n;
var DOCTOR_BUDGET_DEFAULT = 1500n;
var DOCTOR_BUDGET_MAX = 3000n;
var NO_PROJECT = "(no project resolves)";
var SOURCE_EXCLUDED = /^(\.claude\/|node_modules\/|dist\/|build\/|\.git\/)/;
function isFile14(path) {
  try {
    return statSync28(path).isFile();
  } catch {
    return false;
  }
}
function isDir8(path) {
  if (path === "") return false;
  try {
    return statSync28(path).isDirectory();
  } catch {
    return false;
  }
}
function order(s, pos) {
  if (pos === s.length) return -1;
  const c = s.charCodeAt(pos);
  if (c >= 48 && c <= 57) return 0;
  if (c >= 65 && c <= 90 || c >= 97 && c <= 122) return c;
  if (c === 126) return -2;
  return c + 256;
}
function isDigit(s, pos) {
  const c = s.charCodeAt(pos);
  return c >= 48 && c <= 57;
}
function verrevcmp(a, alen, b, blen) {
  let i2 = 0;
  let j = 0;
  while (i2 < alen || j < blen) {
    let firstDiff = 0;
    while (i2 < alen && !isDigit(a, i2) || j < blen && !isDigit(b, j)) {
      const ac = order(a.slice(0, alen), i2);
      const bc = order(b.slice(0, blen), j);
      if (ac !== bc) return ac - bc;
      i2 += 1;
      j += 1;
    }
    while (i2 < alen && a[i2] === "0") i2 += 1;
    while (j < blen && b[j] === "0") j += 1;
    while (i2 < alen && j < blen && isDigit(a, i2) && isDigit(b, j)) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(i2) - b.charCodeAt(j);
      i2 += 1;
      j += 1;
    }
    if (i2 < alen && isDigit(a, i2)) return 1;
    if (j < blen && isDigit(b, j)) return -1;
    if (firstDiff !== 0) return firstDiff;
  }
  return 0;
}
function prefixLen(s) {
  let prefix = 0;
  let i2 = 0;
  const alnum = (c) => /[A-Za-z0-9~]/.test(c);
  while (i2 < s.length) {
    i2 += 1;
    prefix = i2;
    while (i2 + 1 < s.length && s[i2] === "." && /[A-Za-z~]/.test(s[i2 + 1])) {
      for (i2 += 2; i2 < s.length && alnum(s[i2]); i2 += 1) ;
    }
  }
  return prefix;
}
function filevercmp(a, b) {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  if (a[0] === ".") {
    if (b[0] !== ".") return -1;
    const adot = a.length === 1;
    const bdot = b.length === 1;
    if (adot || bdot) return Number(bdot) - Number(adot);
    const a2 = a[1] === "." && a.length === 2;
    const b2 = b[1] === "." && b.length === 2;
    if (a2 || b2) return Number(b2) - Number(a2);
  } else if (b[0] === ".") {
    return 1;
  }
  const ap = prefixLen(a);
  const bp = prefixLen(b);
  const onePass = ap === a.length && bp === b.length;
  const r = verrevcmp(a, ap, b, bp);
  return r !== 0 || onePass ? r : verrevcmp(a, a.length, b, b.length);
}
function sortVMax(a, b) {
  const r = filevercmp(a, b) || byteCompare(a, b);
  return r > 0 ? a : b;
}
function globNames(dir, env, suffix = "") {
  let names;
  try {
    names = readdirSync7(dir);
  } catch {
    return [];
  }
  const collator = localeCollates(env) ? new Intl.Collator("en") : null;
  const compare = (a, b) => {
    const x = a + suffix;
    const y = b + suffix;
    return (collator ? collator.compare(x, y) : 0) || byteCompare(x, y);
  };
  return names.filter((n3) => !n3.startsWith(".")).sort(compare);
}
function jqVersion(manifest) {
  let text;
  try {
    text = readFileSync18(manifest, "utf8");
  } catch {
    return "";
  }
  const out2 = [];
  for (const doc of jsonStream(text).values) {
    if (doc === null) continue;
    if (typeof doc !== "object" || Array.isArray(doc)) break;
    const v = doc.version;
    if (v !== void 0 && v !== null && v !== false) out2.push(jqRawText(v));
  }
  return stripTrailingNewlines(out2.join("\n"));
}
function versionSkew(env) {
  const root = env.CLAUDE_PLUGIN_ROOT ?? "";
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (root === "" || !isFile14(manifest)) return { running: "", newer: "" };
  const running = jqVersion(manifest);
  const versionsDir = posixDirname(root);
  if (running === "" || !isDir8(versionsDir)) return { running, newer: "" };
  let highest = "";
  let names = [];
  try {
    names = readdirSync7(versionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  for (const name3 of names) {
    if (!/^[0-9]/.test(name3)) continue;
    highest = highest === "" ? name3 : sortVMax(highest, name3);
  }
  const newer = highest !== "" && highest !== running && sortVMax(running, highest) === highest ? highest : "";
  return { running, newer };
}
function readPair(line) {
  const bar = line.indexOf("|");
  if (bar < 0) return { name: line, path: "" };
  const rest = line.slice(bar + 1);
  const path = rest.endsWith("|") && !rest.slice(0, -1).includes("|") ? rest.slice(0, -1) : rest;
  return { name: line.slice(0, bar), path };
}
function listRepos(db, root, env) {
  const rows = sqliteRo(db, "SELECT name || '|' || path FROM repos WHERE COALESCE(path, '') <> '' ORDER BY name;", env);
  if (rows === "") return root === "" ? [] : [readPair(`${posixBasename(root)}|${root}`)];
  return rows.split("\n").map((row) => {
    const { name: name3, path: raw } = readPair(row);
    const path = raw.startsWith("/") ? raw : realdir(`${posixDirname(db)}/${raw}`);
    return readPair(`${name3}|${path.endsWith("/") ? path.slice(0, -1) : path}`);
  });
}
function stacksIn(dir) {
  const has = (f) => isFile14(`${dir}/${f}`);
  const out2 = [];
  if (has("package.json")) out2.push("Node");
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) out2.push("Python");
  if (has("go.mod")) out2.push("Go");
  if (has("Cargo.toml")) out2.push("Rust");
  if (has("Gemfile")) out2.push("Ruby");
  if (has("composer.json")) out2.push("PHP");
  return out2;
}
function detectStacks(dir, env) {
  const root = stacksIn(dir);
  if (root.length > 0) return root.join(" ");
  const labels = [];
  let n3 = 0;
  for (const name3 of globNames(dir, env, "/")) {
    const sub = `${dir}/${name3}/`;
    if (!isDir8(sub)) continue;
    for (const stack of stacksIn(sub)) {
      n3 += 1;
      if (n3 <= SUBDIR_STACKS_MAX) labels.push(`${stack} (${name3}/)`);
    }
  }
  let s = labels.join(", ");
  if (n3 > SUBDIR_STACKS_MAX) s += `, +${n3 - SUBDIR_STACKS_MAX} more`;
  return s || "(none detected)";
}
function gitOr(dir, args2, fallback, env) {
  const r = gitRun(dir, args2, env);
  return stripTrailingNewlines(r.code === 0 ? r.stdout : `${r.stdout}${fallback}
`);
}
function lineCount2(text) {
  return text.split("\n").length - 1;
}
function records(text) {
  if (text === "") return [];
  const lines2 = text.split("\n");
  if (lines2[lines2.length - 1] === "") lines2.pop();
  return lines2;
}
function topLevel(root, env) {
  if (root === "" || !isDir8(root)) return NO_PROJECT;
  const names = globNames(root, env).filter((n3) => isDir8(`${root}/${n3}`));
  return names.join(" ").split(/[ \t\n]+/).filter((w) => w !== "").slice(0, TOPLEVEL_MAX).join(" ");
}
function relativeAge(raw) {
  const secs = raw < 0n ? 0n : raw;
  if (secs < 60n) return "just now";
  if (secs < 3600n) return `${secs / 60n}m ago`;
  if (secs < 86400n) return `${secs / 3600n}h ago`;
  return `${secs / 86400n}d ago`;
}
function worldModelLine(wmDirs, sourceFiles, scanRow) {
  const bar = scanRow.indexOf("|");
  const ageText = bar < 0 ? scanRow : scanRow.slice(0, bar);
  const scanned = bar < 0 ? scanRow : scanRow.slice(scanRow.lastIndexOf("|") + 1);
  if (wmDirs === "0") return `cold (no scan yet; ${sourceFiles} source files)`;
  if (!/^-?[0-9]+$/.test(ageText)) return "stale (last scan unknown) \u2014 run /scan";
  const age = BigInt(ageText);
  if (age < WORLD_MODEL_STALE_SECS) return `warm (${scanned} files, last scan ${relativeAge(age)})`;
  return `stale (last scan ${relativeAge(age)}) \u2014 run /scan`;
}
function decimalLiteral(text) {
  const [int, frac] = text.split(".");
  const whole = int.replace(/^0+(?=.)/, "");
  return frac === void 0 ? whole : `${whole}.${frac}`;
}
function paramValue(raw, fallback) {
  const v = raw ?? "";
  if (/^[0-9]+([.][0-9]+)?$/.test(v) && Number(v) > 0) return decimalLiteral(v);
  return jqRawText(fallback);
}
function contractScript(contracts, env) {
  const params = [
    ...new Set(contracts.flatMap((c) => (c.params ?? []).map((p) => `.parameter set :${p.name} ${paramValue(env[p.env], p.default)}`)))
  ].sort(byteCompare);
  return [
    "SELECT '__schema|' || COALESCE((SELECT schema_version FROM plugin_meta LIMIT 1), '');",
    ...params,
    ...contracts.map((c) => `SELECT '${c.id}|' || CASE WHEN (${c.sql}) ${c.expect.op} ${jqRawText(c.expect.value)} THEN 'ok' ELSE 'fail' END;`)
  ].join("\n");
}
function doctorBudget(raw) {
  const v = raw || String(DOCTOR_BUDGET_DEFAULT);
  if (!/^[0-9]+$/.test(v)) return String(DOCTOR_BUDGET_DEFAULT);
  return BigInt(v) > DOCTOR_BUDGET_MAX ? String(DOCTOR_BUDGET_MAX) : v;
}
function doctorState(root, db, env) {
  let doc;
  try {
    doc = JSON.parse(readFileSync18(`${root}/scripts/hooks/lib/data-contracts.json`, "utf8"));
  } catch {
    return "unchecked (no contract list)";
  }
  const contracts = Array.isArray(doc.contracts) ? doc.contracts : [];
  const ids = contracts.flatMap((c) => jqRawText(c.id ?? null).split("\n")).filter((id) => id !== "");
  if (ids.length === 0) return "unchecked (no contract list)";
  const requiredText = doc.schema_version === void 0 || doc.schema_version === null || doc.schema_version === false ? "0" : jqRawText(doc.schema_version);
  const required = /^[0-9]+$/.test(requiredText) ? BigInt(requiredText) : 0n;
  const r = dbReadBudget(db, doctorBudget(env.TMB_DOCTOR_BUDGET_MS), contractScript(contracts, env), env);
  if (r.code === 124) return "unchecked (timeout)";
  const lines2 = r.out.split("\n");
  const storedText = lines2.find((l) => l.startsWith("__schema|"))?.slice("__schema|".length) ?? "";
  const schemaNote = /^[0-9]+$/.test(storedText) && BigInt(storedText) < required ? `schema v${storedText} < v${required} \u2014 start the trajectory server to migrate` : "";
  const failed = [];
  let unchecked = 0;
  for (const id of ids) {
    const hit = lines2.find((l) => l === `${id}|ok` || l === `${id}|fail`);
    if (hit === `${id}|ok`) continue;
    if (hit === `${id}|fail`) failed.push(id);
    else unchecked += 1;
  }
  if (failed.length > 0) {
    let state = `${failed.length} contract violation(s) [${failed.join(", ")}] \u2014 run trajectory_doctor`;
    if (unchecked > 0) state += ` (${unchecked} unchecked${schemaNote ? `: ${schemaNote}` : ""})`;
    else if (schemaNote) state += ` (${schemaNote})`;
    return state;
  }
  if (unchecked > 0 || schemaNote) return `unchecked (${schemaNote || "read error"})`;
  return "healthy";
}
function startInitialScan(invoker, db, env) {
  const child = spawn3("node", ["--experimental-sqlite", invoker], {
    env: { ...env, TRAJECTORY_DB_PATH: db },
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => void 0);
  child.unref();
}
function coldNote(root, db, env) {
  const invoker = `${root}/scripts/hooks/../maintenance/run-scan-initial.mjs`;
  if ((env.TMB_SKIP_AUTO_PRESCAN ?? "0") !== "1" && isFile14(`${root}/scripts/scan.sh`) && isFile14(invoker) && commandOnPath("node", env)) {
    startInitialScan(invoker, db, env);
    return "world model was cold \u2014 a deterministic scan is running in the background; re-read world_model_get before planning";
  }
  return "world model is cold \u2014 run /scan before planning so world_model_get has a project map";
}
function pluginRoot2() {
  return installRoot(posixDirname(fileURLToPath7(import.meta.url))) ?? "";
}
function sessionStartPrescanRun(env, root, stderr2) {
  if (!commandOnPath("jq", env)) return { stdout: NO_JQ_LINE, code: 0 };
  const db = dbPathAdvisory(GATE_NAME55, env, (line) => stderr2(`${line}
`));
  if (db === null) return ALLOW;
  if (!haveSqlite(env) || !commandOnPath("git", env)) return ALLOW;
  const skew = versionSkew(env);
  const project = projectRoot(env);
  const repos = listRepos(db, project, env);
  const repoN = repos.length;
  const stacks = [];
  const branches = [];
  const last5 = [];
  for (const { name: name3, path } of repos) {
    if (name3 === "") continue;
    if (!isDir8(path)) {
      stacks.push(`${name3}: missing (${path})`);
      branches.push(`${name3}: missing (${path})`);
      continue;
    }
    stacks.push(`${name3}: ${detectStacks(path, env)}`);
    const branch = gitOr(path, ["rev-parse", "--abbrev-ref", "HEAD"], "unknown", env);
    const commits = gitOr(path, ["rev-list", "--count", "HEAD"], "0", env);
    const dirty = lineCount2(gitRun(path, ["status", "--porcelain"], env).stdout);
    branches.push(`${name3}: ${branch} (${commits} commits, ${dirty} dirty paths)`);
    const prefix = repoN > 1 ? `  [${name3}] ` : "  ";
    const log = records(gitRun(path, ["log", "--oneline", "-5"], env).stdout).map((l) => `${prefix}${l}`);
    if (log.length > 0) last5.push(log.join("\n"));
  }
  const counts = sqliteRo(
    db,
    "SELECT\n  (SELECT COUNT(*) FROM issues WHERE status='open'),\n  (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running'));",
    env
  ).split("\n")[0];
  const [openIssues = "", pendingTasks = ""] = counts.split("|");
  const wmRaw = sqliteRo(db, "SELECT COUNT(*) FROM wm_directories;", env);
  const wmDirs = /^[0-9]+$/.test(wmRaw) ? wmRaw : "0";
  let sourceFiles = 0;
  for (const { name: name3, path } of repos) {
    if (name3 === "" || !isDir8(path)) continue;
    sourceFiles += records(gitRun(path, ["ls-files"], env).stdout).filter((l) => !SOURCE_EXCLUDED.test(l)).length;
  }
  const scanRow = sqliteRo(
    db,
    "SELECT CAST(strftime('%s','now') - strftime('%s', MAX(last_scanned_at)) AS INTEGER), COALESCE(SUM(file_count), 0) FROM repos;",
    env
  );
  const worldModel = worldModelLine(wmDirs, sourceFiles, scanRow);
  const cold = wmDirs === "0" && sourceFiles !== 0 ? coldNote(root, db, env) : "";
  const doctor = doctorState(root, db, env);
  let suffix = cold === "" ? "" : `
${cold}`;
  if (skew.newer !== "") {
    suffix += `
newer plugin version ${skew.newer} is installed but ${skew.running} is still running \u2014 fully quit and relaunch Claude Code to apply`;
  }
  const dups = duplicateInstalls(projectRoot(env), env);
  if (dups.length > 0) {
    const marketplaces = dups.map((r) => r.marketplace).join(",").replaceAll(",", ", ");
    suffix += `
Plugin: duplicate ${installPluginName(env)} copies enabled (${marketplaces}) \u2014 hooks from one are dropped; keep one and disable the others from the project root (${duplicateDisableCmds(dups, env)}), then fully quit and relaunch Claude Code`;
  }
  const legacy = legacyUserHooks(projectRoot(env), env);
  if (legacy.hooks.length > 0) {
    const projects = legacyHookProjects(legacy.projects);
    suffix += `
Plugin: ${userSettingsJson(env)} holds ${legacy.hooks.length} pre-1.1.0 TMB hook(s) (${legacyHookEntries(legacy.hooks)}) \u2014 they run in every project and can deny what this version allows; the Human removes them by hand, see ${LEGACY_USER_HOOKS_DOC}${projects ? `; projects on TMB < 1.1.0 lose them too: ${projects}` : ""}`;
  }
  const inventory = stripTrailingNewlines(
    [
      "=== Project Inventory (auto, deterministic) ===",
      `Plugin version:    ${skew.running || "(unknown)"}`,
      `Top-level dirs:    ${topLevel(project, env)}`,
      `Stacks detected:   ${stacks.join("; ") || NO_PROJECT}`,
      `World model:       ${worldModel}`,
      `Trajectory DB:     ${doctor}`,
      `Git branch:        ${branches.join("; ") || NO_PROJECT}`,
      `Open issues:       ${openIssues || "0"}`,
      `Pending tasks:     ${pendingTasks || "0"}`,
      "Last 5 commits:",
      last5.join("\n"),
      `================================================${suffix}`
    ].join("\n")
  );
  return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: inventory } })}
`, code: 0 };
}
var sessionStartPrescan = (_payload, env) => {
  try {
    return sessionStartPrescanRun(env, pluginRoot2(), (text) => process.stderr.write(text));
  } catch {
    return ALLOW;
  }
};

// src/hooks/clean-merged-branch.ts
import { spawn as spawn4 } from "node:child_process";
import { statSync as statSync29 } from "node:fs";

// src/hooks/lib/merge.ts
function readMergePayload(payload) {
  const input = commandSubstitution(payload);
  const toolName2 = jqMap(input, (v) => jqRawText(jqOr(jqIndex(v, "tool_name"), "")));
  const command = jqMap(input, (v) => jqRawText(jqOr(jqIndex(jqIndex(v, "tool_input"), "command"), "")));
  const response = jqMap(
    input,
    (v) => {
      const r = jqIndex(v, "tool_response");
      return typeof r === "string" ? r : jqCompact(r);
    },
    jqLiteralNumbers
  );
  return {
    input,
    toolName: commandSubstitution(toolName2.join("\n")),
    command: commandSubstitution(command.join("\n")),
    response: commandSubstitution(response.join("\n"))
  };
}
var MERGE_FAILED = /(is_error|"error"|failed to merge|not mergeable|merge conflict|GraphQL: |pull request is not mergeable)/i;
function mergeFailed(response) {
  return MERGE_FAILED.test(response);
}

// src/hooks/clean-merged-branch.ts
var GATE_NAME56 = "clean-merged-branch";
var MERGE_CMD = /(^|[^A-Za-z0-9_-])(gh[ \t\v\f\r]+pr[ \t\v\f\r]+merge|glab[ \t\v\f\r]+mr[ \t\v\f\r]+merge)([^A-Za-z0-9_-]|$)/m;
var MERGE_PREFIX = /^.*(gh[ \t\v\f\r]+pr|glab[ \t\v\f\r]+mr)[ \t\v\f\r]+merge/;
function isFile15(path) {
  try {
    return statSync29(path).isFile();
  } catch {
    return false;
  }
}
function note(text) {
  process.stderr.write(`tmb: ${text}
`);
}
function localBranch(root, name3, env) {
  return gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name3}`], env);
}
function namesMerge(cmd) {
  return MERGE_CMD.test(cmd);
}
function branchFromCmd(cmd, root, env = process.env) {
  const args2 = cmd.split("\n").map((line) => line.replace(MERGE_PREFIX, "")).join("\n");
  for (const tok of args2.split(/[ \t\n]+/)) {
    if (tok === "" || tok.startsWith("-") || tok.includes("://")) continue;
    if (/^[0-9]+$/.test(tok)) continue;
    if (localBranch(root, tok, env)) return tok;
  }
  return "";
}
function repoRow(root, env) {
  const db = dbPath(env);
  return db !== null && isFile15(db) ? repoResolve(db, root, env) : "";
}
function cut(row, n3) {
  return row.includes("|") ? row.split("|")[n3 - 1] ?? "" : row;
}
function isProtected(root, branch, env = process.env) {
  const def = repoDefaultBranch(root, env);
  if (def !== "" && branch === def) return true;
  const protectedList = cut(repoRow(root, env), 3);
  return protectedList !== "" && protectedList.replace(/[\][",]/g, " ").split(/[ \t\n]+/).includes(branch);
}
function baseBranch(root, env = process.env) {
  const target = cut(repoRow(root, env), 1);
  return target !== "" ? target : repoDefaultBranch(root, env);
}
function integrated(root, tip, target, env = process.env) {
  if (gitOk(root, ["merge-base", "--is-ancestor", tip, target], env)) return true;
  const merged = gitRun(root, ["merge-tree", "--write-tree", target, tip], env);
  if (merged.code === 0) {
    const tree = gitRun(root, ["rev-parse", `${target}^{tree}`], env);
    const targetTree = tree.code === 0 ? tree.stdout.replace(/\n+$/, "") : "";
    if (targetTree !== "" && merged.stdout.replace(/\n+$/, "").split("\n")[0] === targetTree) return true;
  }
  const cherry = gitRun(root, ["cherry", target, tip], env);
  if (cherry.code !== 0) return false;
  return !cherry.stdout.split("\n").some((line) => line.startsWith("+"));
}
function worktreeForBranch(root, branch, env = process.env) {
  const want = `refs/heads/${branch}`;
  let wt = "";
  for (const line of gitRun(root, ["worktree", "list", "--porcelain"], env).stdout.split("\n")) {
    if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && line.slice("branch ".length) === want && wt !== root) return wt;
  }
  return "";
}
function fetchPrune(root, env) {
  try {
    const child = spawn4("git", ["-C", root, "fetch", "--prune", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env: { ...env, GIT_TERMINAL_PROMPT: "0" }
    });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function clean(payload, env) {
  const { input, toolName: toolName2, command: cmd, response } = readMergePayload(payload);
  if (toolName2 !== "Bash" || cmd === "") return;
  if (!namesMerge(cmd) || mergeFailed(response)) return;
  const cwd = cmdCwd(cmd, input, env);
  const root = repoGitRoot(cwd, env);
  if (root === "" || !isDir(root)) return;
  let branch = branchFromCmd(cmd, root, env);
  if (branch === "") branch = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  if (branch === "" || branch === "HEAD") return;
  if (!localBranch(root, branch, env)) return;
  if (isProtected(root, branch, env)) return;
  const base2 = baseBranch(root, env);
  if (base2 === "" || !localBranch(root, base2, env) || branch === base2) return;
  if (!integrated(root, `refs/heads/${branch}`, `refs/heads/${base2}`, env)) return;
  const wt = worktreeForBranch(root, branch, env);
  if (wt !== "" && isDir(wt)) {
    if (gitRun(wt, ["status", "--porcelain"], env).stdout !== "") {
      note(`branch ${branch} is merged but its worktree ${wt} has uncommitted/untracked changes \u2014 skipping cleanup (never force)`);
      return;
    }
    if (!gitOk(root, ["worktree", "remove", wt], env)) {
      note(`worktree remove failed for ${wt} \u2014 leaving branch ${branch} in place`);
      return;
    }
  }
  if (gitOk(root, ["branch", "-D", branch], env)) {
    gitOk(root, ["worktree", "prune"], env);
    note(`cleaned up merged branch ${branch}${wt !== "" ? ` (worktree ${wt})` : ""}`);
  } else {
    note(`branch delete failed for ${branch} \u2014 leaving in place`);
    gitOk(root, ["worktree", "prune"], env);
  }
  fetchPrune(root, env);
}
var cleanMergedBranch = (payload, env) => {
  if ((env.TMB_DISABLE_CLEAN_MERGED_BRANCH ?? "0") === "1") return ALLOW;
  try {
    clean(payload, env);
  } catch {
  }
  return ALLOW;
};

// src/hooks/close-issue-on-merge.ts
import { spawnSync as spawnSync12 } from "node:child_process";
import { statSync as statSync30 } from "node:fs";

// src/review-sql.ts
var HAS_PASS_SQL = `EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= (
    SELECT MIN(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '$.task_id') = t.id
        AND json_extract(a.content_json, '$.commit_sha') = t.commit_sha))`;
var reviewSkipAuthoredSql = (alias) => `((${alias}.event_type = 'review_gate_waived' AND ${alias}.from_node = 'bro')
      OR (${alias}.event_type = 'review_gate_bypassed' AND ${alias}.from_node IN ('bro', 'hook:close-issue-on-merge')))`;
var GATE_SKIP_RECORDED_SQL = `EXISTS (SELECT 1 FROM audit g
  WHERE ${reviewSkipAuthoredSql("g")}
    AND json_valid(g.content_json)
    AND json_extract(g.content_json, '$.task_id') = t.id
    AND COALESCE(json_extract(g.content_json, '$.commit_sha'), '') = COALESCE(t.commit_sha, ''))`;

// src/hooks/close-issue-on-merge.ts
var GATE_NAME57 = "close-issue-on-merge";
var FROM = "hook:close-issue-on-merge";
var LIVE = "'pending','running','needs_validation','completed'";
var GH_TIMEOUT_MS = 1e4;
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "env", "command", "nohup", "time"]);
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-t",
  "--subject",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-A",
  "--author-email",
  "--match-head-commit",
  "-m",
  "--message",
  "--sha",
  "-R",
  "--repo"
]);
var CLOSING_REF = /(close[sd]?|fix(e[sd])?|resolve[sd]?)[ \t\v\f\r]+(GH[ \t\v\f\r]+)?#[0-9]+/gi;
function isFile16(path) {
  try {
    return statSync30(path).isFile();
  } catch {
    return false;
  }
}
function gh(args2, repoDir, env) {
  const r = spawnSync12("gh", args2, {
    cwd: repoDir,
    encoding: "utf8",
    env,
    timeout: GH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return commandSubstitution(r.stdout ?? "");
}
function mergeArgs(cmd) {
  const stripped = commandSubstitution(stripLiterals(cmd));
  for (const line of stripped.split("\n")) {
    for (const stmt of line.split(/&&|\|\||[;|&()]/)) {
      const words2 = stmt.split(/[ \t\n]+/).filter((w) => w !== "");
      let i2 = 0;
      while (i2 < words2.length && (WRAPPERS.has(words2[i2]) || /^[A-Za-z_].*=/s.test(words2[i2]))) i2 += 1;
      if (words2.length - i2 < 3) continue;
      const tool = `${words2[i2]} ${words2[i2 + 1]}`;
      if ((tool === "gh pr" || tool === "glab mr") && words2[i2 + 2] === "merge") return words2.slice(i2 + 3);
    }
  }
  return null;
}
function refFromArgs(args2) {
  let skip2 = false;
  for (const tok of args2) {
    if (tok === "") continue;
    if (skip2) {
      skip2 = false;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      skip2 = true;
      continue;
    }
    if (tok.startsWith("-") || /[<>]/.test(tok)) continue;
    return tok;
  }
  return "";
}
function sortUniqueNumeric(values) {
  const seen = /* @__PURE__ */ new Set();
  const out2 = [];
  for (const v of values) {
    const key2 = BigInt(v).toString();
    if (seen.has(key2)) continue;
    seen.add(key2);
    out2.push(v);
  }
  return out2.sort((a, b) => {
    const d = BigInt(a) - BigInt(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });
}
function closingRefs(json) {
  if (json === "") return [];
  const refs = jqMap(
    json,
    (v) => {
      const out2 = [];
      const list = jqIndex(v, "closingIssuesReferences");
      const items = Array.isArray(list) ? list : list !== null && typeof list === "object" ? Object.values(list) : [];
      for (const item of items) {
        let n3;
        try {
          n3 = jqIndex(item, "number");
        } catch {
          break;
        }
        if (n3 !== null && n3 !== void 0 && n3 !== false) out2.push(jqRawText(n3));
      }
      return out2;
    },
    jqLiteralNumbers
  ).flat();
  const body2 = commandSubstitution(jqFieldOr(json, "body"));
  const bodyRefs = [];
  for (const line of body2.split("\n")) {
    for (const m of line.matchAll(CLOSING_REF)) bodyRefs.push(/#([0-9]+)/.exec(m[0])?.[1] ?? "");
  }
  const lines2 = [...commandSubstitution(refs.join("\n")).split("\n"), ...bodyRefs];
  return sortUniqueNumeric(lines2.filter((l) => /^[0-9]+$/.test(l)));
}
var Merge = class {
  constructor(db, head, syncOn2, repoDir, env) {
    this.db = db;
    this.head = head;
    this.syncOn = syncOn2;
    this.repoDir = repoDir;
    this.env = env;
  }
  db;
  head;
  syncOn;
  repoDir;
  env;
  sql = [];
  closedIds = [];
  read(sql) {
    return sqliteRo(this.db, sql, this.env);
  }
  audit(row) {
    const r = auditSql({ ...row, fromNode: FROM }, "", {
      caller: GATE_NAME57,
      env: this.env
    });
    if (r.code === 0) return r.sql;
    if (r.error !== "") process.stderr.write(`${r.error}
`);
    return null;
  }
  /** _cim_tasks_sql: a bypass row per unreviewed task of the branch, its open runs and live tasks closed. */
  tasksSql() {
    const branch = sqlQuote(this.head);
    const now = sqlQuote(nowIso());
    const out2 = [];
    const rows = this.read(`SELECT t.id || '|' || t.issue_id || '|' || COALESCE(t.commit_sha, '') FROM tasks t
     WHERE t.branch_id = '${branch}' AND t.status IN (${LIVE}, 'closed')
       AND NOT ${HAS_PASS_SQL} AND NOT ${GATE_SKIP_RECORDED_SQL} ORDER BY t.id;`);
    for (const row of rows.split("\n")) {
      if (row === "") continue;
      const [tidRaw, rest = ""] = splitOnce(row);
      const [issueRaw, sha = ""] = splitOnce(rest);
      const tid = sqlInt(tidRaw);
      const issue = sqlInt(issueRaw);
      const shaJson = sha === "" || /[^0-9a-f]/.test(sha) ? "null" : `"${sha}"`;
      if (tid === "" || issue === "") continue;
      const audit = this.audit({
        issueId: issue,
        branchId: this.head,
        eventType: "review_gate_bypassed",
        summary: `Task ${tid} merged without a passing review`,
        contentJson: `{"task_id":${tid},"commit_sha":${shaJson},"closed_by":"close-issue-on-merge"}`
      });
      if (audit !== null) out2.push(audit);
    }
    out2.push(`UPDATE agent_runs
       SET completed_at = '${now}',
           duration_ms = CASE WHEN duration_ms = 0
             THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)
             ELSE duration_ms END,
           exit_reason = 'completed',
           ${RUN_UNMEASURED_SQL}
     WHERE completed_at IS NULL
       AND task_id IN (SELECT id FROM tasks WHERE branch_id = '${branch}' AND status IN (${LIVE}, 'closed'));
    UPDATE tasks
       SET status = 'closed', completed_at = COALESCE(completed_at, '${now}'), updated_at = '${now}'
     WHERE branch_id = '${branch}' AND status IN (${LIVE});`);
    return out2.join("\n");
  }
  /** _cim_local_issue: the issues.id a closing ref names: by gh_iid first, else as an id. */
  localIssue(ref) {
    const n3 = sqlInt(ref);
    if (n3 === "") return "";
    const byGh = sqlInt(this.read(`SELECT id FROM issues WHERE gh_iid = ${n3};`));
    if (byGh !== "") return byGh;
    return sqlInt(this.read(`SELECT id FROM issues WHERE id = ${n3};`));
  }
  /** _cim_issue_sql: close an open issue, or defer it over live tasks off the merged branch. */
  issueSql(localId) {
    const id = sqlInt(localId);
    if (id === "") return "";
    const branch = sqlQuote(this.head);
    if (this.read(`SELECT status FROM issues WHERE id = ${id};`) !== "open") return "";
    const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
    const ghJson = ghIid === "" ? "null" : ghIid;
    const blocking = this.read(`SELECT id FROM tasks WHERE issue_id = ${id}
      AND status IN (${LIVE}) AND branch_id != '${branch}' ORDER BY id;`);
    if (blocking !== "") {
      const ids = blocking.split("\n").filter((l) => /^[0-9]+$/.test(l)).join(",");
      return this.audit({
        issueId: id,
        branchId: "",
        eventType: "issue_auto_close_deferred",
        summary: `Merge left issue ${id} open: tasks ${ids} still live`,
        contentJson: `{"blocking_task_ids":[${ids}],"gh_iid":${ghJson}}`
      }) ?? "";
    }
    const now = sqlQuote(nowIso());
    const out2 = [
      `UPDATE issues SET status = 'closed', closed_at = COALESCE(closed_at, '${now}'), updated_at = '${now}'
     WHERE id = ${id} AND status != 'closed';`
    ];
    const closed = this.audit({
      issueId: id,
      branchId: "",
      eventType: "issue_auto_closed_on_merge",
      summary: "Auto-closed on PR merge",
      contentJson: `{"gh_iid":${ghJson}}`
    });
    if (closed === null) return out2.join("\n");
    out2.push(closed);
    if (ghIid !== "" && !this.syncOn) {
      const skipped = this.audit({
        issueId: id,
        branchId: "",
        eventType: "issue_auto_close_remote_skipped",
        summary: `Remote close of gh #${ghIid} skipped: issue sync is off`,
        contentJson: `{"gh_iid":${ghIid},"reason":"sync_gate_off"}`
      });
      if (skipped !== null) out2.push(skipped);
    }
    return out2.join("\n");
  }
  build(prJson) {
    if (this.head !== "") this.sql.push(this.tasksSql());
    for (const ref of closingRefs(prJson)) {
      const localId = this.localIssue(ref);
      if (localId === "") continue;
      const issueSql = this.issueSql(localId);
      if (issueSql === "") continue;
      this.sql.push(issueSql);
      if (issueSql.includes("issue_auto_closed_on_merge")) this.closedIds.push(localId);
    }
    return this.sql.join("\n");
  }
  /** After the commit: each closed issue's note, then its remote close while the sync gate is on. */
  closeRemotes() {
    for (const raw of this.closedIds) {
      const id = sqlInt(raw);
      if (id === "") continue;
      process.stderr.write(`tmb: auto-closed issue ${id} on merge
`);
      if (!this.syncOn) continue;
      const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
      if (ghIid === "") continue;
      if (gh(["issue", "view", ghIid, "--json", "state", "-q", ".state"], this.repoDir, this.env) !== "CLOSED") {
        gh(["issue", "close", ghIid], this.repoDir, this.env);
      }
    }
  }
};
function splitOnce(text) {
  const bar = text.indexOf("|");
  return bar < 0 ? [text, text] : [text.slice(0, bar), text.slice(bar + 1)];
}
function syncOn(db, env = process.env) {
  if (!["", "0", "false", "FALSE", "False"].includes(env.TMB_DISABLE_REMOTE_SYNC ?? "")) return false;
  const mode = sqliteRo(
    db,
    `
    SELECT json_extract(value_json, '$')
      FROM plugin_config
     WHERE key = 'issue_sync';
  `,
    env
  );
  return mode !== "" && mode !== "off";
}
function close(payload, env) {
  const { input, toolName: toolName2, command: cmd, response } = readMergePayload(payload);
  if (toolName2 !== "Bash" || cmd === "") return;
  const args2 = mergeArgs(cmd);
  if (args2 === null || mergeFailed(response)) return;
  if (!commandOnPath("gh", env)) return;
  const db = dbPath(env);
  if (db === null || !isFile16(db) || !haveSqlite(env)) return;
  let ref = refFromArgs(commandSubstitution(args2.join("\n")).split("\n"));
  if (ref === "") ref = gitOut(forgeCommandDir(cmd, input, env), ["rev-parse", "--abbrev-ref", "HEAD"], env);
  if (ref === "" || ref === "HEAD") return;
  const repoDir = forgeRepoDir(cmd, input, env);
  const prJson = gh(["pr", "view", ref, "--json", "closingIssuesReferences,body,headRefName"], repoDir, env);
  let head = commandSubstitution(jqFieldOr(prJson, "headRefName"));
  if (head === "" && /[^0-9]/.test(ref) && !ref.includes("://")) head = ref;
  const merge = new Merge(db, head, syncOn(db, env), repoDir, env);
  const sql = merge.build(prJson);
  if (sql === "") return;
  const w = dbWrite(db, sql, { caller: GATE_NAME57, env });
  if (!w.ok) {
    process.stderr.write(`${w.error}
`);
    return;
  }
  merge.closeRemotes();
}
var closeIssueOnMerge = (payload, env) => {
  if ((env.TMB_DISABLE_CLOSE_ISSUE_ON_MERGE ?? "0") === "1") return ALLOW;
  try {
    close(payload, env);
  } catch {
  }
  return ALLOW;
};

// src/hooks/swe-atomic-close.ts
import { appendFileSync as appendFileSync4, mkdirSync as mkdirSync9, readFileSync as readFileSync19, realpathSync as realpathSync7, renameSync as renameSync4, statSync as statSync31 } from "node:fs";
var GATE_NAME58 = "swe-atomic-close";
var FROM_NODE2 = "hook:swe-atomic-close";
var LOG_ROTATE_BYTES2 = 1048576;
var NO_STATS = "0|0|0|0|0|0||";
var ISO2 = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z\n?$/;
var STAMP_PARTS = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$/;
var MODEL_STRIP2 = /[^A-Za-z0-9._:@/[\]-]/gu;
var DBL_MAX2 = Number.MAX_VALUE;
var RUN_NO_USAGE_SQL2 = "COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0";
var RUN_UNMEASURED_SQL2 = `usage_source = COALESCE(usage_source, CASE WHEN ${RUN_NO_USAGE_SQL2} THEN 'unmeasured' END)`;
var JqError7 = class extends Error {
};
var isRawJson4 = (value) => JSON.isRawJSON?.(value) ?? false;
function isFile17(path) {
  try {
    return statSync31(path).isFile();
  } catch {
    return false;
  }
}
function truthy4(v) {
  return v !== null && v !== void 0 && v !== false;
}
function index6(value, key2) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new JqError7(`Cannot index with ${key2}`);
  const v = value[key2];
  return v === void 0 ? null : v;
}
function isoStamp(v) {
  if (typeof v !== "string") return null;
  const m = ISO2.exec(v);
  return m === null ? null : `${m[1]}.${`${m[3] ?? ""}000`.slice(0, 3)}Z`;
}
function stampMs(stamp2) {
  const m = STAMP_PARTS.exec(stamp2);
  if (m === null) throw new JqError7("ms");
  const [year, month, day, hour, minute, second, frac] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60) throw new JqError7("strptime");
  if (year < 1900) throw new JqError7("invalid gmtime representation");
  const t = Date.UTC(year, month - 1, day, hour, minute, second) / 1e3;
  if (t === -1 || t === -2) throw new JqError7("mktime");
  return t * 1e3 + frac;
}
function clamp(v) {
  return v === Infinity ? DBL_MAX2 : v === -Infinity ? -DBL_MAX2 : v;
}
function n2(v) {
  return typeof v === "number" && clamp(v) >= 0 ? Math.floor(clamp(v)) : 0;
}
function model2(v) {
  return typeof v === "string" && !v.startsWith("<") ? v.replace(MODEL_STRIP2, "") : "";
}
function sum(values) {
  return values.length === 0 ? null : values.reduce((s, v) => s + v);
}
function stableSort(items, key2) {
  return items.map((item, i2) => ({ item, i: i2, k: key2(item) })).sort((a, b) => jqCompare(a.k, b.k) || a.i - b.i).map((e) => e.item);
}
function groupBy(items, key2) {
  const groups = [];
  for (const item of stableSort(items, key2)) {
    const g = groups.at(-1);
    if (g !== void 0 && jqCompare(key2(g[0]), key2(item)) === 0) g.push(item);
    else groups.push([item]);
  }
  return groups;
}
function reduceStats(all, since) {
  const values = since === "" ? all : all.filter((v) => {
    const t = isoStamp(index6(v, "timestamp"));
    return t !== null && byteCompare(t, since) >= 0;
  });
  const stamps = values.map((v) => isoStamp(index6(v, "timestamp"))).filter((s) => s !== null);
  const entries = [];
  values.forEach((v, i2) => {
    const usage = index6(index6(v, "message"), "usage");
    if (usage === null) return;
    const mid = index6(index6(v, "message"), "id");
    const uuid = index6(v, "uuid");
    const id = truthy4(mid) ? mid : truthy4(uuid) ? uuid : `line-${i2}`;
    entries.push({ id, u: usage, m: model2(index6(index6(v, "message"), "model")) });
  });
  const msgs = groupBy(entries, (e) => e.id).map((g) => ({ u: g[g.length - 1].u, m: g[g.length - 1].m }));
  let allToolUses = 0;
  for (const v of values) {
    const raw = index6(index6(v, "message"), "content");
    const content = truthy4(raw) ? raw : [];
    if (!Array.isArray(content)) continue;
    for (const block2 of content) if (index6(block2, "type") === "tool_use") allToolUses += 1;
  }
  const col = (key2) => sum(msgs.map((m) => n2(index6(m.u, key2)))) ?? 0;
  const ti = col("input_tokens");
  const to = col("output_tokens");
  const cr = col("cache_read_input_tokens");
  const cc = col("cache_creation_input_tokens");
  const ms = stamps.map(stampMs);
  const dm = ms.length < 2 ? 0 : ms.reduce((a, b) => Math.max(a, b)) - ms.reduce((a, b) => Math.min(a, b));
  const weighted = msgs.filter((m) => m.m !== "").map((m) => ({
    m: m.m,
    t: sum(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((k) => n2(index6(m.u, k))))
  }));
  const byModel = groupBy(weighted, (w) => w.m).map((g) => ({ m: g[0].m, t: sum(g.map((w) => w.t)) }));
  const ranked = stableSort(byModel, (w) => [-w.t, w.m]);
  const dominant = ranked.length === 0 ? "" : ranked[0].m;
  const first = stamps.length === 0 ? "" : [...stamps].sort(byteCompare)[0];
  return [jqIntText(ti), jqIntText(to), String(allToolUses), jqIntText(dm), jqIntText(cr), jqIntText(cc), first, dominant].join("|");
}
function transcriptStats(path, since = "") {
  if (path === "" || !isFile17(path)) return NO_STATS;
  let text;
  try {
    text = readFileSync19(path, "utf8");
  } catch {
    return NO_STATS;
  }
  return transcriptStatsOf(text, since);
}
function transcriptStatsOf(text, since = "") {
  const { values, complete } = jsonStream(text);
  if (!complete) return NO_STATS;
  try {
    return reduceStats(values, since);
  } catch (e) {
    if (e instanceof JqError7) return NO_STATS;
    throw e;
  }
}
function scalarPaths(value, path, out2) {
  if (value !== null && typeof value === "object" && !isRawJson4(value)) {
    const entries = Array.isArray(value) ? value.map((v, i2) => [String(i2), v]) : Object.entries(value);
    for (const [k, v] of entries) scalarPaths(v, [...path, k], out2);
    return;
  }
  if (path.length > 0 && truthy4(value)) out2.push(path.join("."));
}
function entryKeys(value) {
  const out2 = [];
  scalarPaths(value, [], out2);
  return jqCompact([...new Set(out2)].sort(byteCompare));
}
function entryKeysArg(input) {
  if (input.values.length === 0) return input.complete ? null : [];
  if (input.values.length > 1 || !input.complete) return null;
  return JSON.parse(entryKeys(input.values[0]));
}
function entryAgent(input) {
  const lines2 = [];
  for (const value of input.values) {
    try {
      for (const keys of [["agent_type"], ["subagent_type"], ["tool_input", "subagent_type"]]) {
        const v = jqGet(value, ...keys);
        if (truthy4(v)) {
          lines2.push(jqRaw2(v));
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof JqUnindexable)) throw e;
    }
  }
  return stripTrailingNewlines(lines2.join("\n"));
}
function cutField3(text, field6) {
  const lines2 = text.split("\n").map((line) => line.includes("|") ? line.split("|")[field6 - 1] ?? "" : line);
  return stripTrailingNewlines(lines2.join("\n"));
}
function secondsIso() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function physicalDir3(path, env) {
  const logical = cdPwd(path, shellPwd(env));
  try {
    return realpathSync7.native(logical !== "" && isDir(logical) ? logical : path);
  } catch {
    return "";
  }
}
var Log = class _Log {
  constructor(file) {
    this.file = file;
  }
  file;
  write(record) {
    if (this.file === null) return;
    try {
      appendFileSync4(this.file, `${jqCompact(record)}
`);
    } catch {
    }
  }
  static open(env) {
    const dir = stateDir(env);
    if (dir === null) return new _Log(null);
    try {
      mkdirSync9(`${dir}/logs`, { recursive: true });
    } catch {
      return new _Log(null);
    }
    const file = `${dir}/logs/mcp-health.log`;
    try {
      if (statSync31(file).isFile() && statSync31(file).size > LOG_ROTATE_BYTES2) renameSync4(file, `${file}.1`);
    } catch {
    }
    return new _Log(file);
  }
};
function write(db, sql, env, out2) {
  const r = dbWrite(db, sql, { caller: GATE_NAME58, env });
  out2.stdout += r.stdout;
  if (!r.ok) process.stderr.write(`${r.error}
`);
  return r.ok;
}
function runRecorder(recorder, payload, env) {
  try {
    recorder(payload, env);
  } catch {
  }
}
function skipUnbound(db, transcript, spawnId, taskId, env, out2) {
  const reason = taskId === "" ? "no task_id=<N> in the spawn transcript" : `spawn transcript names task_id=${taskId}, which has no task row`;
  const content = jqCompact({ reason, transcript, spawn_id: spawnId, task_id: taskId === "" ? null : jqNumber2(taskId) });
  const r = auditAppend(
    db,
    {
      issueId: "-1",
      branchId: "",
      fromNode: FROM_NODE2,
      eventType: "agent_runs_capture_skipped",
      summary: `SWE spawn not metered: ${reason}`,
      contentJson: content
    },
    { caller: GATE_NAME58, env }
  );
  out2.stdout += r.stdout;
  if (!r.ok) process.stderr.write(`${r.error}
`);
}
var sweAtomicClose = (payload, env) => {
  const inputText = commandSubstitution2(payload);
  const input = jqInput(payload);
  const log = Log.open(env);
  const keys = entryKeysArg(input);
  const entryAgentRaw = entryAgent(input);
  if (keys !== null) {
    log.write({ ts: secondsIso(), kind: "swe-atomic-close-entry", keys, agent_type_resolved: entryAgentRaw });
  }
  const agentType = normalizeRole(entryAgentRaw);
  if (agentType !== "swe" && agentType !== "code-reviewer") return { stdout: "", code: 0 };
  const db = dbPath(env) ?? "";
  if (db === "" || !haveSqlite(env)) return { stdout: "", code: 0 };
  const out2 = { stdout: "" };
  const transcriptPath = jqCapture(input, ["agent_transcript_path"]);
  const agentId = jqCapture(input, ["agent_id"]);
  const sessionId = jqCapture(input, ["session_id"]);
  const spawnId = agentId || transcriptPath;
  const transcriptTaskId = sqlInt(taskIdFromTranscript(transcriptPath));
  const row = transcriptTaskId === "" ? "" : sqliteRo(
    db,
    `SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, ''), issue_id FROM tasks
      WHERE id = ${transcriptTaskId} LIMIT 1;`,
    env
  );
  if (row === "") {
    if (agentType === "swe") skipUnbound(db, transcriptPath, spawnId, transcriptTaskId, env, out2);
    return { stdout: out2.stdout, code: 0 };
  }
  const taskId = sqlInt(cutField3(row, 1));
  if (taskId === "") return { stdout: out2.stdout, code: 0 };
  const taskStatus = cutField3(row, 2);
  const branch = cutField3(row, 3);
  const parentBranch = cutField3(row, 4);
  const issueId = cutField3(row, 6);
  const ts = secondsIso();
  const resumedSince = agentType === "swe" ? sqliteRo(
    db,
    `
SELECT CASE WHEN resumed_from IS NOT NULL THEN started_at END FROM agent_runs
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND spawn_id = '${sqlQuote(spawnId)}'
 ORDER BY id DESC LIMIT 1;`,
    env
  ) : "";
  const stats = transcriptStats(transcriptPath, resumedSince);
  const [tokensIn, tokensOut, toolUses2, durationMs, cacheRead, cacheCreation, firstTs, model3] = stats.split("|");
  log.write({ ts, kind: "agent-runs-stats-parsed", task_id: jqNumber2(taskId), stats, transcript: transcriptPath });
  const safeTaskId = taskId;
  const safeIssueId = sqlInt(issueId) || "NULL";
  const safeTokensIn = sqlInt(tokensIn) || "0";
  const safeTokensOut = sqlInt(tokensOut) || "0";
  const safeCacheRead = sqlInt(cacheRead) || "0";
  const safeCacheCreation = sqlInt(cacheCreation) || "0";
  const safeToolUses = sqlInt(toolUses2) || "0";
  const safeDurationMs = sqlInt(durationMs) || "0";
  const safeSpawnId = sqlQuote(spawnId);
  let safeNow = sqlQuote(nowIso());
  const safeFirstTs = sqlQuote(firstTs || nowIso());
  const sessionSql = sessionId !== "" ? `'${sqlQuote(sessionId)}'` : "NULL";
  const modelSql = model3 !== "" ? `'${sqlQuote(model3)}'` : "NULL";
  const version = pluginVersion(env);
  const versionSql = version !== "" ? `'${sqlQuote(version)}'` : "NULL";
  const measured = /[^0]/.test(`${safeTokensIn}${safeTokensOut}${safeCacheRead}${safeCacheCreation}`);
  const tokensSetSql = measured ? `tokens_in = ${safeTokensIn},
       tokens_out = ${safeTokensOut},
       cache_read_tokens = ${safeCacheRead},
       cache_creation_tokens = ${safeCacheCreation}` : `tokens_in = COALESCE(tokens_in, 0),
       tokens_out = COALESCE(tokens_out, 0),
       cache_read_tokens = COALESCE(cache_read_tokens, 0),
       cache_creation_tokens = COALESCE(cache_creation_tokens, 0)`;
  const usageSetSql = measured ? "usage_source = 'subagent_stop'" : RUN_UNMEASURED_SQL2;
  const usageInsertSql = measured ? "'subagent_stop'" : "'unmeasured'";
  if (agentType === "code-reviewer") {
    const defaults = effortDefaults(db, env);
    const reviewerEffort = defaults.includes("|") ? defaults.slice(defaults.indexOf("|") + 1) : defaults;
    const effortSql = ["low", "medium", "high"].includes(reviewerEffort) ? `'${reviewerEffort}'` : "NULL";
    const safeProjectRoot = sqlQuote(physicalDir3(`${posixDirname(db)}/../..`, env));
    const ok = write(
      db,
      `
UPDATE agent_runs
   SET ${tokensSetSql},
       tool_uses = ${safeToolUses},
       duration_ms = ${safeDurationMs},
       completed_at = '${safeNow}',
       session_id = COALESCE(${sessionSql}, session_id),
       ${usageSetSql},
       model = COALESCE(${modelSql}, model),
       effort = COALESCE(effort, ${effortSql})
 WHERE task_id = ${safeTaskId} AND agent_type = 'code-reviewer' AND spawn_id = '${safeSpawnId}';
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort,
                        plugin_version)
SELECT ${safeTaskId}, ${safeIssueId}, 'code-reviewer', ${safeTokensIn}, ${safeTokensOut}, ${safeCacheRead},
       ${safeCacheCreation}, ${safeToolUses}, ${safeDurationMs}, '${safeFirstTs}', '${safeNow}',
       (SELECT repo FROM tasks WHERE id = ${safeTaskId}), '${safeSpawnId}', ${sessionSql}, ${usageInsertSql},
       ${modelSql}, 'claude', '${safeProjectRoot}', 'completed', ${effortSql},
       ${versionSql}
 WHERE (SELECT changes()) = 0;`,
      env,
      out2
    );
    if (!ok) log.write({ ts, kind: "agent-runs-write-failed", task_id: jqNumber2(taskId), agent_type: "code-reviewer" });
    runRecorder(toolOutputSize, inputText, {
      ...env,
      TMB_STOP_AGENT_TYPE: "code-reviewer",
      TMB_STOP_TASK_ID: safeTaskId,
      TMB_STOP_SPAWN_ID: spawnId
    });
    return { stdout: out2.stdout, code: 0 };
  }
  const location = taskLocation(db, taskId, env);
  let repoRoot = location.code === 0 ? location.repoRoot : "";
  if (repoRoot === "") repoRoot = projectRoot(env);
  repoRoot = realdir(repoRoot);
  const wtPath = `${repoRoot}/.claude/worktrees/${branchSlug(branch)}`;
  const safeRootDir = sqlQuote(wtPath);
  let wtHead = gitOut(wtPath, ["rev-parse", "HEAD"], env);
  const headWithin = (head, ...tips) => tips.some((tip) => tip !== "" && gitOk(repoRoot, ["merge-base", "--is-ancestor", head, tip], env));
  const verify = (ref) => gitOut(repoRoot, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], env);
  let hasCommits = false;
  let parentTipLocal = "";
  let parentTipOrigin = "";
  if (parentBranch !== "") {
    parentTipLocal = verify(`refs/heads/${parentBranch}`);
    parentTipOrigin = verify(`refs/remotes/origin/${parentBranch}`);
  }
  if (wtHead !== "") {
    let headInParent = false;
    if (`${parentTipLocal}${parentTipOrigin}` !== "") {
      if (headWithin(wtHead, parentTipLocal, parentTipOrigin)) headInParent = true;
      else hasCommits = true;
    }
    if (!hasCommits && !headInParent) {
      const localFeature = verify(`refs/heads/${branch}`);
      if (localFeature !== "" && !headWithin(wtHead, localFeature)) hasCommits = true;
      if (!hasCommits && parentBranch === "" && localFeature !== "" && wtHead === localFeature) {
        let base2 = cutField3(repoResolve(db, repoRoot, env), 1);
        if (base2 === "") base2 = repoDefaultBranch(repoRoot, env);
        if (base2 !== "") {
          parentTipLocal = verify(`refs/heads/${base2}`);
          parentTipOrigin = verify(`refs/remotes/origin/${base2}`);
          let ahead = gitOut(wtPath, ["rev-list", "--count", `origin/${base2}..HEAD`], env);
          if (ahead === "") ahead = gitOut(wtPath, ["rev-list", "--count", `${base2}..HEAD`], env);
          if (!/^[0-9]+$/.test(ahead)) ahead = "0";
          if (Number(ahead) > 0 && !headWithin(wtHead, parentTipLocal, parentTipOrigin)) hasCommits = true;
        }
      }
    }
  } else {
    const rootBranch = gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], env);
    if (rootBranch === branch && `${parentTipLocal}${parentTipOrigin}` !== "") {
      const rootHead = gitOut(repoRoot, ["rev-parse", "HEAD"], env);
      if (rootHead !== "" && !headWithin(rootHead, parentTipLocal, parentTipOrigin)) {
        hasCommits = true;
        wtHead = rootHead;
      }
    }
  }
  let decision;
  let context4 = "";
  const checkpointed = taskStatus === "running" ? sqliteRo(
    db,
    `
SELECT 1 FROM tasks
 WHERE id = ${safeTaskId} AND json_valid(checkpoint)
   AND json_extract(checkpoint, '$.at') >= '${safeFirstTs}';`,
    env
  ) : "";
  if (checkpointed === "1") {
    decision = "checkpoint";
    context4 = `SWE for task #${taskId} handed back a checkpoint; the task stays running. Resume swe on it: a fresh spawn reads task_brief.checkpoint (done, left, files) and continues from there.`;
  } else if (taskStatus === "pending" || taskStatus === "running") {
    if (hasCommits) {
      decision = "auto-completed";
      const safeWtHead = sqlQuote(wtHead);
      safeNow = sqlQuote(nowIso());
      const closeJson = jqCompact({
        task_id: jqNumber2(safeTaskId),
        commit_sha: wtHead,
        parent_tip_local: parentTipLocal === "" ? null : parentTipLocal,
        parent_tip_origin: parentTipOrigin === "" ? null : parentTipOrigin
      });
      const audit = auditSql(
        {
          issueId: safeIssueId,
          branchId: branch,
          fromNode: FROM_NODE2,
          eventType: "swe_atomic_close_auto_completed",
          summary: `Task #${safeTaskId} auto-completed at ${wtHead} on SubagentStop`,
          contentJson: closeJson
        },
        "(SELECT changes()) > 0",
        { caller: GATE_NAME58, env }
      );
      if (audit.code !== 0) process.stderr.write(`${audit.error}
`);
      const closeAuditSql = audit.code === 0 ? audit.sql : "";
      const closed = write(
        db,
        `UPDATE tasks SET status='completed', commit_sha='${safeWtHead}', updated_at='${safeNow}', completed_at='${safeNow}', checkpoint=NULL WHERE id=${safeTaskId};
${closeAuditSql}`,
        env,
        out2
      );
      if (!closed) decision = "auto-complete-failed";
    } else {
      decision = "warn-no-commits";
      context4 = `SWE for task #${taskId} stopped without committing in worktree at ${wtPath}. Bro should send SWE back or mark the task failed.`;
    }
  } else {
    decision = "metrics-only";
  }
  const exitReason = decision === "auto-completed" || ["completed", "closed", "needs_validation"].includes(taskStatus) ? "completed" : taskStatus === "escalated" ? "escalated" : "failed";
  const runWritten = write(
    db,
    `
UPDATE agent_runs
   SET ${tokensSetSql},
       tool_uses = ${safeToolUses},
       duration_ms = ${safeDurationMs},
       started_at = COALESCE(started_at, '${safeFirstTs}'),
       completed_at = '${safeNow}',
       spawn_id = '${safeSpawnId}',
       session_id = COALESCE(${sessionSql}, session_id),
       ${usageSetSql},
       model = COALESCE(${modelSql}, model),
       host = COALESCE(host, 'claude'),
       root_dir = COALESCE(root_dir, '${safeRootDir}'),
       exit_reason = '${exitReason}',
       effort = COALESCE(effort, (SELECT effort FROM tasks WHERE id = ${safeTaskId}))
 WHERE id = (
   SELECT id FROM agent_runs
    WHERE task_id = ${safeTaskId}
      AND (spawn_id = '${safeSpawnId}'
           OR ((spawn_id IS NULL OR spawn_id GLOB 'tool_use:*') AND agent_type = 'swe'
               AND (completed_at IS NULL
                    OR started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${safeFirstTs}', '-2 seconds'))))
    ORDER BY (spawn_id IS '${safeSpawnId}') DESC, id DESC
    LIMIT 1);
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort,
                        plugin_version)
SELECT ${safeTaskId}, ${safeIssueId}, 'swe', ${safeTokensIn}, ${safeTokensOut}, ${safeCacheRead},
       ${safeCacheCreation}, ${safeToolUses}, ${safeDurationMs}, '${safeFirstTs}', '${safeNow}',
       (SELECT repo FROM tasks WHERE id = ${safeTaskId}), '${safeSpawnId}', ${sessionSql}, ${usageInsertSql},
       ${modelSql}, 'claude', '${safeRootDir}', '${exitReason}', (SELECT effort FROM tasks WHERE id = ${safeTaskId}),
       ${versionSql}
 WHERE (SELECT changes()) = 0;
UPDATE agent_runs
   SET usage_source = 'unmeasured',
       exit_reason = COALESCE(exit_reason, 'swept_orphan'),
       completed_at = COALESCE(completed_at, '${safeNow}')
 WHERE task_id = ${safeTaskId}
   AND agent_type = 'swe'
   AND ((spawn_id IS NULL
         AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${safeFirstTs}', '-2 seconds'))
        OR (spawn_id GLOB 'tool_use:*' AND completed_at IS NULL
            AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')))
   AND COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0
   AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0
   AND COALESCE(usage_source, '') <> 'subagent_stop';`,
    env,
    out2
  );
  if (!runWritten) log.write({ ts, kind: "agent-runs-write-failed", task_id: jqNumber2(taskId) });
  const stop2 = { TMB_STOP_TASK_ID: safeTaskId, TMB_STOP_SPAWN_ID: spawnId, TMB_STOP_SINCE: safeFirstTs };
  runRecorder(sweStopCause, inputText, { ...env, ...stop2 });
  runRecorder(toolOutputSize, inputText, { ...env, TMB_STOP_AGENT_TYPE: "swe", ...stop2 });
  const hookBlock = sqliteRo(
    db,
    `
SELECT CASE WHEN stop_cause = 'hook_block' THEN 'B' || COALESCE(substr(stop_detail, 1, 200), '') END
  FROM agent_runs
 WHERE task_id = ${safeTaskId} AND agent_type = 'swe' AND spawn_id = '${safeSpawnId}'
 ORDER BY id DESC LIMIT 1;`,
    env
  );
  if (hookBlock.startsWith("B")) {
    const detail = hookBlock.slice(1).replaceAll("\n", " ");
    const blockContext = `SWE for task #${taskId} ended on a hook block with no completion report ("${detail}"), which task_brief.last_stop carries; name the block in the rework spawn_note so the next swe applies the allowed form and continues.`;
    context4 = context4 === "" ? blockContext : `${context4} ${blockContext}`;
  }
  if (decision === "auto-completed" || decision === "auto-complete-failed") {
    log.write({ ts, kind: "swe-atomic-close", task_id: jqNumber2(taskId), branch, decision, commit_sha: wtHead });
  } else {
    log.write({ ts, kind: "swe-atomic-close", task_id: jqNumber2(taskId), branch, decision, worktree: wtPath });
  }
  if (context4 !== "") {
    out2.stdout += `${jqCompact({ hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: context4 } })}
`;
  }
  return { stdout: out2.stdout, code: 0 };
};

// src/hooks/post-task-close-rescan.ts
import { spawn as spawn5 } from "node:child_process";
import { statSync as statSync32 } from "node:fs";
import { fileURLToPath as fileURLToPath8 } from "node:url";
var GATE_NAME59 = "post-task-close-rescan";
var CLOSE_TOOL = /^mcp__[\s\S]*trajectory-server__bro_atomic_close$/;
function isFile18(path) {
  try {
    return statSync32(path).isFile();
  } catch {
    return false;
  }
}
function pluginRoot3() {
  return installRoot(posixDirname(fileURLToPath8(import.meta.url))) ?? "";
}
function launchDetached(spawner, invoker, db, env) {
  const child = spawner(process.execPath, ["--experimental-sqlite", invoker], {
    detached: true,
    stdio: "ignore",
    env: { ...env, TRAJECTORY_DB_PATH: db }
  });
  child.on("error", () => void 0);
  child.unref();
}
function rescan(payload, env, spawner = spawn5, root = pluginRoot3()) {
  const toolName2 = jqCapture(jqInput(payload), ["tool_name"]);
  if (!CLOSE_TOOL.test(toolName2)) return ALLOW;
  if ((env.TMB_SKIP_AUTO_RESCAN || "0") === "1") return ALLOW;
  const invoker = `${root}/scripts/maintenance/run-scan.mjs`;
  if (root === "" || !isFile18(invoker)) return ALLOW;
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null) return ALLOW;
  try {
    launchDetached(spawner, invoker, db, env);
  } catch {
  }
  return ALLOW;
}
function postTaskCloseRescan(payload, env) {
  return rescan(payload, env);
}

// src/hooks/post-atomic-close-readme.ts
import { statSync as statSync33 } from "node:fs";
var GATE_NAME60 = "post-atomic-close-readme";
var BYPASS_ENV7 = "TMB_DISABLE_README_STALENESS_HOOK";
var ATOMIC_CLOSE_TOOL = /^mcp__[\s\S]*trajectory-server__bro_atomic_close$/;
var ROOT_DIR = ".";
function isFile19(path) {
  try {
    return statSync33(path).isFile();
  } catch {
    return false;
  }
}
function cut2(text) {
  const bar = text.indexOf("|");
  return bar < 0 ? [text, text] : [text.slice(0, bar), text.slice(bar + 1)];
}
function parseTaskRow(row) {
  const [commitSha, rest1] = cut2(row);
  const [repo, rest2] = cut2(rest1);
  const [issueId, branchId] = cut2(rest2);
  return { commitSha, repo, issueId, branchId };
}
function touchedDirs(paths, env) {
  return sortUnique(
    paths.map((f) => {
      const slash = f.lastIndexOf("/");
      return slash < 0 ? ROOT_DIR : f.slice(0, slash);
    }),
    env
  );
}
function isDistDir(dir) {
  return dir.split("/").includes("dist");
}
function staleDirs(repoPath, sha, repo, paths, env) {
  const changed = new Set(paths);
  const out2 = [];
  for (const dir of touchedDirs(paths, env)) {
    if (isDistDir(dir)) continue;
    const readme = dir === ROOT_DIR ? "README.md" : `${dir}/README.md`;
    const label = dir === ROOT_DIR ? repo === "" ? "<repo root>" : `${repo}/` : dir;
    if (!gitOk(repoPath, ["cat-file", "-e", `${sha}:${readme}`], env)) out2.push(`${label} (no README.md)`);
    else if (!changed.has(readme)) out2.push(`${label} (README.md older than the commit)`);
  }
  return out2;
}
function nudgeReason(taskId, sha, stale) {
  return `\u{1F4DD} README-staleness check (task ${taskId}, commit ${sha.slice(0, 7)}): the world model derives each directory's summary from that dir's README.md, so a stale README degrades world_model_get / world_model_search for that dir.

The commit touched directories whose README.md is missing or older than the commit:
${stale}

For each, consider updating the directory's README.md so the next /scan picks up an accurate summary. This is a judgment call \u2014 skip it when the change doesn't alter what the README describes.`;
}
function resolveRepoPath(db, repo, env) {
  let path = repoResolvePath(db, repo, env);
  if (path === "" && repo === "") path = posixDirname(posixDirname(posixDirname(db)));
  if (path !== "" && !gitOk(path, ["rev-parse", "--git-dir"], env)) path = "";
  return path;
}
function surface(payload, env) {
  if (env[BYPASS_ENV7] === "1") return ALLOW;
  const input = jqInput(payload);
  if (!ATOMIC_CLOSE_TOOL.test(jqCapture(input, ["tool_name"]))) return ALLOW;
  if (jqCapture(input, ["tool_response", "is_error"]) === "true") return ALLOW;
  const taskId = sqlInt(jqCapture(input, ["tool_input", "task_id"]));
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || !isFile19(db) || !haveSqlite(env)) return ALLOW;
  const row = sqliteRo(
    db,
    `SELECT COALESCE(commit_sha,'') || '|' || COALESCE(repo,'') || '|' || COALESCE(issue_id,'') || '|' || COALESCE(branch_id,'') FROM tasks WHERE id = ${taskId};`,
    env
  );
  if (row === "") return ALLOW;
  const task = parseTaskRow(row);
  if (!/^[0-9a-fA-F]+$/.test(task.commitSha)) return ALLOW;
  const repoPath = resolveRepoPath(db, task.repo, env);
  if (repoPath === "") return ALLOW;
  if (!gitOk(repoPath, ["cat-file", "-e", `${task.commitSha}^{commit}`], env)) return ALLOW;
  const paths = gitOut(repoPath, ["show", "--name-only", "--pretty=format:", task.commitSha], env).split("\n").filter((line) => line !== "");
  if (paths.length === 0) return ALLOW;
  const stale = staleDirs(repoPath, task.commitSha, task.repo, paths, env);
  if (stale.length === 0) return ALLOW;
  const staleText = stale.join("\n");
  const staleLines = staleText.split("\n");
  const w = auditAppend(
    db,
    {
      issueId: sqlInt(task.issueId) || "-1",
      branchId: task.branchId,
      fromNode: `hook:${GATE_NAME60}`,
      eventType: "readme_staleness_surfaced",
      summary: `task ${taskId}: README may be stale in ${staleLines.filter((line) => line !== "").length} dir(s) after ${task.commitSha.slice(0, 7)}`,
      contentJson: jqCompact({ task_id: jqNumber2(taskId), commit_sha: task.commitSha, stale: staleLines })
    },
    { env, caller: GATE_NAME60 }
  );
  if (!w.ok) process.stderr.write(`${w.error}
`);
  const out2 = jqCompact({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: nudgeReason(taskId, task.commitSha, staleText) } });
  return { stdout: `${w.stdout}${out2}
`, code: 0 };
}
var postAtomicCloseReadme = (payload, env) => {
  try {
    return surface(payload, env);
  } catch {
    return ALLOW;
  }
};

// src/hooks/agent-spawn-dispatch.ts
var GATE_NAME61 = "agent-spawn-dispatch";
var CHAIN = [
  "require-task-spec",
  "require-spawn-effort",
  "require-feature-branch-active",
  "code-reviewer-no-worktree",
  "code-reviewer-spawn-prompt-shape",
  "code-reviewer-after-atomic-close",
  "code-reviewer-spawn-note",
  "code-reviewer-preflight",
  "rework-limit"
];
var PREPARE = ["ensure-swe-worktree", "record-swe-spawn"];
var CONTEXT_SEPARATOR = "\n\n---\n\n";
async function quietly(gate, input, env) {
  if (gate === void 0) return "";
  const write2 = process.stderr.write;
  process.stderr.write = (() => true);
  try {
    return (await gate(input, env)).stdout;
  } catch {
    return "";
  } finally {
    process.stderr.write = write2;
  }
}
async function agentSpawnDispatch(payload, env, find) {
  const input = commandSubstitution(payload);
  const parts2 = [];
  for (const name3 of CHAIN) {
    const out2 = commandSubstitution(await quietly(find(name3), input, env));
    if (out2 === "") continue;
    const reply = jqInput(out2);
    if (jqCapture(reply, ["hookSpecificOutput", "permissionDecision"]) === "deny") return { stdout: `${out2}
`, code: 0 };
    const ctx = jqCapture(reply, ["hookSpecificOutput", "additionalContext"]);
    if (ctx !== "") parts2.push(ctx);
  }
  for (const name3 of PREPARE) await quietly(find(name3), input, env);
  if (parts2.length === 0) return ALLOW;
  const merged = parts2.join(CONTEXT_SEPARATOR);
  return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: merged } })}
`, code: 0 };
}

// src/hooks/ensure-swe-worktree.ts
import { existsSync as existsSync13 } from "node:fs";
var GATE_NAME62 = "ensure-swe-worktree";
function cutField4(text, n3) {
  const lines2 = text.split("\n").map((line) => line.includes("|") ? line.split("|")[n3 - 1] ?? "" : line);
  return stripTrailingNewlines(lines2.join("\n"));
}
function sweSpawnTaskId(input) {
  if (normalizeRole(jqCapture(input, ["tool_input", "subagent_type"], true)) !== "swe") return "";
  return sqlInt(promptTaskId(jqCapture(input, ["tool_input", "prompt"], true)));
}
function prepareRepoRoot(db, repo, env) {
  const workspaceRoot = posixDirname(posixDirname(posixDirname(db)));
  if (repo !== "") return repoPathByName(db, repo, env) || `${workspaceRoot}/${repo}`;
  return repoSinglePath(db, env) || workspaceRoot;
}
function recordedWorktree(db, taskId, branch, env) {
  const loc = taskLocation(db, taskId, env);
  if (loc.code !== 0 || loc.worktree === `${loc.repoRoot}/.claude/worktrees/${branchSlug(branch)}`) return "";
  return existsSync13(loc.worktree) ? loc.worktree : "";
}
function registered(repoRoot, slug, env) {
  let pattern;
  try {
    pattern = new RegExp(`^worktree .*/\\.claude/worktrees/${slug}$`);
  } catch {
    return false;
  }
  return gitRun(repoRoot, ["worktree", "list", "--porcelain"], env).stdout.split("\n").some((line) => pattern.test(line));
}
function skip(line) {
  process.stderr.write(`ensure-swe-worktree: ${line}
`);
  return ALLOW;
}
var ensureSweWorktree = (payload, env) => {
  if (env.TMB_DISABLE_ENSURE_SWE_WORKTREE === "1") return ALLOW;
  const taskId = sweSpawnTaskId(jqInput(commandSubstitution(payload)));
  if (taskId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return skip("no trajectory DB or sqlite3 \u2014 skipping (non-isolated fallback)");
  const row = sqliteRo(db, `SELECT branch_id, repo FROM tasks WHERE id=${taskId};`, env);
  if (row === "") return skip(`no tasks row for task_id=${taskId} \u2014 skipping`);
  const branch = cutField4(row, 1);
  const repo = cutField4(row, 2);
  if (branch === "") return skip(`task_id=${taskId} has empty branch_id \u2014 skipping`);
  if (recordedWorktree(db, taskId, branch, env) !== "") return ALLOW;
  const slug = branchSlug(branch);
  const repoRoot = prepareRepoRoot(db, repo, env);
  if (!isDir(`${repoRoot}/.git`)) return skip(`repo root '${repoRoot}' is not a git repo \u2014 skipping`);
  const wtRel = `.claude/worktrees/${slug}`;
  const wtAbs = `${repoRoot}/${wtRel}`;
  if (registered(repoRoot, slug, env)) return ALLOW;
  if (existsSync13(wtAbs)) return skip(`'${wtAbs}' exists but is not a registered worktree \u2014 skipping`);
  if (gitOk(repoRoot, ["worktree", "add", wtRel, branch], env)) {
    return skip(`created worktree ${wtAbs} for branch ${branch}`);
  }
  return skip(`'git worktree add ${wtRel} ${branch}' failed \u2014 skipping (non-isolated fallback)`);
};

// src/hooks/record-swe-spawn.ts
var GATE_NAME63 = "record-swe-spawn";
var UNIT_SEPARATOR = "";
var SPAWN_FIELDS = [["session_id"], ["tool_use_id"], ["tool_input", "effort"], ["tool_input", "model"]];
function spawnFields(input) {
  if (!input.complete) return null;
  const lines2 = [];
  let lastFailed = false;
  for (const value of input.values) {
    try {
      lines2.push(SPAWN_FIELDS.map((keys) => jqTostring(jqAlt2(jqGet(value, ...keys), ""))).join(UNIT_SEPARATOR));
      lastFailed = false;
    } catch (e) {
      if (!(e instanceof JqUnindexable)) throw e;
      lastFailed = true;
    }
  }
  if (lastFailed) return null;
  const [sessionId, toolUseId2, effort, model3] = readFields2(commandSubstitution(lines2.join("\n")).split("\n")[0], 4);
  return { sessionId, toolUseId: toolUseId2, effort, model: model3 };
}
function readFields2(line, count) {
  let rest = line;
  const fields = [];
  for (let i2 = 0; i2 < count - 1; i2 += 1) {
    const at2 = rest.indexOf(UNIT_SEPARATOR);
    if (at2 < 0) {
      fields.push(rest);
      rest = "";
      continue;
    }
    fields.push(rest.slice(0, at2));
    rest = rest.slice(at2 + 1);
  }
  if (rest.endsWith(UNIT_SEPARATOR) && !rest.slice(0, -1).includes(UNIT_SEPARATOR)) rest = rest.slice(0, -1);
  fields.push(rest);
  return fields;
}
var quoted = (value) => value === "" ? "NULL" : `'${sqlQuote(value)}'`;
function spawnSql(row) {
  const { taskId, now } = row;
  const rootDirSql = row.rootDir === null ? "NULL" : `'${sqlQuote(row.rootDir)}'`;
  const effortSql = ["low", "medium", "high"].includes(row.fields.effort) ? `'${row.fields.effort}'` : "effort";
  return `
UPDATE agent_runs
   SET completed_at = '${now}',
       exit_reason = 'swept_orphan',
       ${RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE task_id = ${taskId} AND agent_type = 'swe' AND completed_at IS NULL
   AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
   AND started_at IS NOT NULL AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds');
UPDATE tasks SET status = 'running', updated_at = '${now}', completed_at = NULL
 WHERE id = ${taskId} AND status = 'pending';
INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host,
                        session_id, effort, model, spawn_id, plugin_version)
SELECT id, issue_id, 'swe', '${now}', repo, ${rootDirSql}, 'claude',
       ${quoted(row.fields.sessionId)}, ${effortSql}, ${quoted(row.fields.model)}, '${sqlQuote(row.spawnId)}', ${quoted(row.pluginVersion)}
  FROM tasks WHERE id = ${taskId};`;
}
var recordSweSpawn = (payload, env) => {
  try {
    const input = jqInput(commandSubstitution(payload));
    const taskId = sweSpawnTaskId(input);
    if (taskId === "") return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env)) return ALLOW;
    const row = sqliteRo(db, `SELECT branch_id, COALESCE(repo, '') FROM tasks WHERE id = ${taskId};`, env);
    if (row === "") return ALLOW;
    const branch = cutField4(row, 1);
    const fields = spawnFields(input);
    if (fields === null) return ALLOW;
    const spawnId = fields.toolUseId !== "" ? `tool_use:${fields.toolUseId}` : `tool_use:${fields.sessionId}:${Date.now()}`;
    let rootDir = null;
    if (branch !== "") {
      rootDir = recordedWorktree(db, taskId, branch, env) || `${prepareRepoRoot(db, cutField4(row, 2), env).replace(/\/$/, "")}/.claude/worktrees/${branchSlug(branch)}`;
    }
    const sql = spawnSql({ taskId, rootDir, fields, spawnId, pluginVersion: pluginVersion(env), now: nowIso() });
    dbWrite(db, sql, { caller: GATE_NAME63, env });
  } catch {
  }
  return ALLOW;
};

// src/hooks/cleanup-worktree-on-task-close.ts
import { statSync as statSync34 } from "node:fs";
var GATE_NAME64 = "cleanup-worktree-on-task-close";
var BYPASS_ENV8 = "TMB_KEEP_CLOSED_WORKTREES";
var KEEP_HEAD_ENV = "TMB_KEEP_HEAD_ON_CLOSE";
var TOOL = /^mcp__[\s\S]*trajectory-server__(?:task_update_status|validation_record)$/;
var DEFAULT_PR_TARGET = "dev";
var WORKTREE_LINE = "worktree ";
function isFile20(path) {
  try {
    return statSync34(path).isFile();
  } catch {
    return false;
  }
}
function slugMatcher(slug) {
  try {
    const re = new RegExp(`/\\.claude/worktrees/${slug}$`);
    return (path) => re.test(path);
  } catch {
    return () => false;
  }
}
function listedWorktree(repoRoot, matches, env) {
  for (const line of gitOut(repoRoot, ["worktree", "list", "--porcelain"], env).split("\n")) {
    if (!line.startsWith(WORKTREE_LINE)) continue;
    const wt = line.slice(WORKTREE_LINE.length);
    if (matches(wt)) return wt;
  }
  return "";
}
function taskRepoRoot(db, taskId, env) {
  const taskRepo = sqliteRo(db, `SELECT repo FROM tasks WHERE id=${taskId} LIMIT 1;`, env);
  const workspace = posixDirname(posixDirname(posixDirname(db)));
  if (taskRepo !== "") return repoPathByName(db, taskRepo, env) || `${workspace}/${taskRepo}`;
  return repoSinglePath(db, env) || workspace;
}
function resetHead(db, repoRoot, taskId, env, stderr2) {
  const target = repoResolve(db, repoRoot, env).split("|")[0] || DEFAULT_PR_TARGET;
  const current = gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  if (!gitOk(repoRoot, ["rev-parse", "--verify", target], env) || current === target) return;
  if (gitOk(repoRoot, ["checkout", target], env)) {
    stderr2(`tmb: checked out ${target} after task #${taskId} closed (was on ${current})
`);
  } else {
    stderr2(`tmb: post-close checkout of ${target} failed \u2014 leaving on ${current}
`);
  }
}
function cleanupWorktree(payload, env, stderr2) {
  const input = jqInput(payload);
  const tool = jqCapture(input, ["tool_name"]);
  if (!TOOL.test(tool)) return ALLOW;
  if ((env[BYPASS_ENV8] ?? "0") === "1") return ALLOW;
  const taskId = jqCapture(input, ["tool_input", "task_id"]);
  const isValidation = tool.endsWith("validation_record");
  if (isValidation) {
    if (jqCapture(input, ["tool_input", "verdict"]) !== "pass") return ALLOW;
  } else {
    if (jqCapture(input, ["tool_input", "agent"]) !== "bro") return ALLOW;
    if (jqCapture(input, ["tool_input", "status"]) !== "closed") return ALLOW;
  }
  const safeId = sqlInt(taskId);
  if (safeId === "") return ALLOW;
  const db = dbPath(env);
  if (db === null || db === "" || !isFile20(db) || !haveSqlite(env)) return ALLOW;
  if (isValidation) {
    const passed = sqliteRo(db, `SELECT 1 FROM tasks t WHERE t.id=${safeId} AND t.status='closed' AND ${HAS_PASS_SQL};`, env);
    if (passed !== "1") return ALLOW;
  }
  const branch = sqliteRo(db, `SELECT branch_id FROM tasks WHERE id=${safeId} LIMIT 1;`, env);
  if (branch === "") return ALLOW;
  if (sqliteRo(db, `SELECT worktree_adopted FROM tasks WHERE id=${safeId} LIMIT 1;`, env) === "1") {
    const kept = taskLocation(db, safeId, env);
    if (kept.code === 0) stderr2(`tmb: kept adopted worktree ${kept.worktree} after task #${taskId} closed (GH 2032)
`);
    return ALLOW;
  }
  const repoRoot = taskRepoRoot(db, safeId, env);
  if (!isDir(`${repoRoot}/.git`)) return ALLOW;
  const worktree = listedWorktree(repoRoot, slugMatcher(branchSlug(branch)), env);
  if (worktree === "" || worktree === repoRoot) return ALLOW;
  if (!gitOk(repoRoot, ["worktree", "remove", worktree, "--force"], env)) {
    stderr2(`tmb: worktree remove failed for ${worktree} \u2014 leaving in place
`);
    return ALLOW;
  }
  gitOk(repoRoot, ["worktree", "prune"], env);
  if (env[KEEP_HEAD_ENV] !== "1") resetHead(db, repoRoot, taskId, env, stderr2);
  stderr2(`tmb: cleaned up worktree ${worktree} after task #${taskId} closed
`);
  return ALLOW;
}
var cleanupWorktreeOnTaskClose = (payload, env) => cleanupWorktree(payload, env, (line) => process.stderr.write(line));

// src/hooks/worktree-create.ts
import { spawnSync as spawnSync13 } from "node:child_process";
import { existsSync as existsSync14, mkdirSync as mkdirSync10, readFileSync as readFileSync20, statSync as statSync35 } from "node:fs";
import { fileURLToPath as fileURLToPath9 } from "node:url";
var GATE_NAME65 = "worktree-create";
var MERGE_DRIVER_MARK = "merge=tmb-regen";
var MERGE_DRIVER_SCRIPT = "scripts/maintenance/install-merge-driver.sh";
var NO_BRANCH = "tmb worktree-create: WorktreeCreate input has no .branch field \u2014 cannot create an isolated worktree; SWE will run non-isolated in the main checkout (supported). If isolation is required, ensure the spawn passes the task's branch.\n";
var fail = (stderr2, line) => {
  stderr2(line);
  return { stdout: "", code: 1 };
};
function isFile21(path) {
  try {
    return statSync35(path).isFile();
  } catch {
    return false;
  }
}
function pluginRoot4() {
  return installRoot(posixDirname(fileURLToPath9(import.meta.url))) ?? "";
}
function installMergeDriver(dir, env, stderr2) {
  const top = gitRun(dir, ["rev-parse", "--show-toplevel"], env);
  if (top.code !== 0) return;
  const root = top.stdout.replace(/\n+$/, "");
  let attributes;
  try {
    attributes = readFileSync20(`${root}/.gitattributes`, "latin1");
  } catch {
    return;
  }
  if (!attributes.includes(MERGE_DRIVER_MARK)) return;
  const r = spawnSync13("bash", [`${pluginRoot4()}/${MERGE_DRIVER_SCRIPT}`, root], { env, stdio: "ignore" });
  if (r.error || r.status !== 0) stderr2(`tmb worktree-create: could not install the tmb-regen merge driver in ${root}
`);
}
function ensureWorktree(repo, worktree, branch, addFailed, created2, env, stderr2) {
  try {
    mkdirSync10(posixDirname(worktree), { recursive: true });
  } catch {
  }
  if (existsSync14(`${worktree}/.git`)) {
    stderr2(`tmb worktree-create: reusing existing worktree ${worktree} for branch ${branch}
`);
    installMergeDriver(repo, env, stderr2);
    return { stdout: `${worktree}
`, code: 0 };
  }
  if (!gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], env)) {
    if (!gitOk(repo, ["branch", branch, "HEAD"], env)) {
      return fail(stderr2, `tmb worktree-create: could not create branch ${branch} in ${repo}
`);
    }
    stderr2(`tmb worktree-create: auto-created branch ${branch} in ${repo}
`);
  }
  if (!gitOk(repo, ["worktree", "add", worktree, branch], env)) return fail(stderr2, addFailed);
  stderr2(created2);
  installMergeDriver(repo, env, stderr2);
  return { stdout: `${worktree}
`, code: 0 };
}
function branchRepo(db, branch, env) {
  const workspace = posixDirname(posixDirname(posixDirname(db)));
  const safe = sqlQuote(branch);
  const count = sqliteRo(db, `SELECT COUNT(*) FROM tasks WHERE branch_id='${safe}';`, env);
  if ((count || "0") === "0") return repoSinglePath(db, env) || workspace;
  const repo = sqliteRo(db, `SELECT COALESCE(repo,'') FROM tasks WHERE branch_id='${safe}' LIMIT 1;`, env);
  return repoResolvePath(db, repo, env) || workspace;
}
function worktreeCreateRun(payload, env, stderr2) {
  const branch = jqCapture(jqInput(payload), ["branch"]);
  if (branch === "") return fail(stderr2, NO_BRANCH);
  const slug = branchSlug(branch);
  const db = dbPath(env);
  if (db === null || db === "" || !isFile21(db)) {
    const cwd = shellPwd(env);
    const worktree2 = `${cwd}/.claude/worktrees/${slug}`;
    if (!gitOk(cwd, ["rev-parse", "--is-inside-work-tree"], env)) {
      return fail(stderr2, `tmb worktree-create: no trajectory DB and cwd ${cwd} is not a git repo
`);
    }
    return ensureWorktree(
      cwd,
      worktree2,
      branch,
      `tmb worktree-create: git worktree add failed for branch ${branch} in ${cwd}
`,
      `tmb worktree-create: created worktree ${worktree2} for branch ${branch} (no-DB path)
`,
      env,
      stderr2
    );
  }
  if (!haveSqlite(env)) return fail(stderr2, "tmb worktree-create: sqlite3 unavailable\n");
  const repo = branchRepo(db, branch, env);
  const worktree = `${repo}/.claude/worktrees/${slug}`;
  if (!gitOk(repo, ["rev-parse", "--is-inside-work-tree"], env)) {
    return fail(stderr2, `tmb worktree-create: resolved repo ${repo} is not a git work tree
`);
  }
  return ensureWorktree(
    repo,
    worktree,
    branch,
    `tmb worktree-create: git worktree add failed for branch ${branch} in repo ${repo}
`,
    `tmb worktree-create: created worktree ${worktree} for branch ${branch} in repo ${repo}
`,
    env,
    stderr2
  );
}
var worktreeCreate = (payload, env) => worktreeCreateRun(payload, env, (line) => process.stderr.write(line));

// src/hooks/remote-id-guard.ts
import { statSync as statSync36 } from "node:fs";
import { performance as performance5 } from "node:perf_hooks";
var GATE_NAME66 = "remote-id-guard";
var DEFAULT_DEADLINE_S = "3";
var WRITE_RUN_BUDGET_MS2 = "1000";
var REMOTE_WRITES = [
  ...["pr create", "pr edit", "issue create", "issue edit", "issue comment", "issue close"].map((s) => [`gh ${s}`, "gh"]),
  ...["mr create", "mr update", "issue create", "issue update", "issue note", "issue close"].map((s) => [`glab ${s}`, "glab"])
];
var TEXT_OPTION = /(--body|--title|--comment|--message|--description|--note)([ \t\n\v\f\r=]|$)/m;
var SHORT_TEXT_OPTION = /(^|[ \t\n\v\f\r])-[btm]([ \t\n\v\f\r]|$)/m;
var HEREDOC = /<<-?[ \t\v\f\r]*[A-Za-z_'"]/;
var REMOTE_MARKERS = [/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+/g, /[Gg][Hh]-[0-9]+/g, /[Gg][Ll]-[0-9]+/g, /[Rr][Ee][Mm][Oo][Tt][Ee]:[0-9]+/g];
var OVERRUN = /* @__PURE__ */ Symbol("overrun");
function deadlineSeconds(env) {
  const d = env.TMB_REMOTE_ID_GUARD_DEADLINE_S || DEFAULT_DEADLINE_S;
  return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(d) && /[1-9]/.test(d) ? d : DEFAULT_DEADLINE_S;
}
function providerOf(stmt) {
  for (const [prefix, provider] of REMOTE_WRITES) {
    if (stmt === prefix || stmt.startsWith(`${prefix} `)) return provider;
  }
  return null;
}
function carriesText(command) {
  return TEXT_OPTION.test(command) || SHORT_TEXT_OPTION.test(command) || HEREDOC.test(command);
}
function candidateTokens(command) {
  const scan3 = REMOTE_MARKERS.reduce((text, marker) => text.replace(marker, " "), command);
  const tokens = new Set([...scan3.matchAll(/#([0-9]+)/g)].map((m) => m[1]));
  return [...tokens].sort();
}
function cut3(row, from, rest) {
  const lines2 = row.split("\n").map((line) => {
    if (!line.includes("|")) return line;
    const fields = line.split("|");
    return rest ? fields.slice(from - 1).join("|") : fields[from - 1] ?? "";
  });
  return stripTrailingNewlines(lines2.join("\n"));
}
function unhex(hex) {
  const text = Buffer.from(hex, "hex").toString("utf8");
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}
function localRows(db, tokens, env) {
  const values = tokens.map((n3) => `('${n3}', ${n3})`).join(", ");
  const out2 = sqliteRo(
    db,
    `WITH t(n, k) AS (VALUES ${values}) SELECT t.n || '|' || hex(COALESCE(i.gh_iid, '')) || '|' || hex(COALESCE(i.gl_iid, '')) || '|' || hex(COALESCE(i.objective, '')) FROM t JOIN issues i ON i.id = t.k;`,
    env
  );
  const rows = /* @__PURE__ */ new Map();
  for (const line of out2.split("\n")) {
    const [n3, gh2, gl, objective] = line.split("|");
    if (objective === void 0) continue;
    rows.set(n3, stripTrailingNewlines(`${unhex(gh2)}|${unhex(gl)}|${unhex(objective)}`));
  }
  return rows;
}
var SIMPLE_ESCAPES = /* @__PURE__ */ new Map([
  ["a", 7],
  ["b", 8],
  ["e", 27],
  ["E", 27],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ["\\", 92]
]);
var isOctal = (b) => b !== void 0 && b >= 48 && b <= 55;
var hexValue = (b) => {
  if (b === void 0) return -1;
  const c = String.fromCharCode(b);
  return /[0-9A-Fa-f]/.test(c) ? parseInt(c, 16) : -1;
};
function printfB(text) {
  const src = Buffer.from(text, "utf8");
  const out2 = [];
  let i2 = 0;
  while (i2 < src.length) {
    const b = src[i2];
    if (b !== 92 || i2 + 1 >= src.length) {
      out2.push(b);
      i2 += 1;
      continue;
    }
    const c = String.fromCharCode(src[i2 + 1]);
    i2 += 2;
    const simple = SIMPLE_ESCAPES.get(c);
    if (simple !== void 0) {
      out2.push(simple);
    } else if (c === "c") {
      break;
    } else if (c >= "0" && c <= "7") {
      let value = c.charCodeAt(0) - 48;
      for (let left = c === "0" ? 3 : 2; left > 0 && isOctal(src[i2]); left -= 1, i2 += 1) value = value * 8 + (src[i2] - 48);
      out2.push(value & 255);
    } else if (c === "x" && hexValue(src[i2]) >= 0) {
      let value = hexValue(src[i2]);
      i2 += 1;
      if (hexValue(src[i2]) >= 0) {
        value = value * 16 + hexValue(src[i2]);
        i2 += 1;
      }
      out2.push(value);
    } else {
      out2.push(92, src[i2 - 1]);
    }
  }
  return stripTrailingNewlines(Buffer.from(out2.filter((b) => b !== 0)).toString("utf8"));
}
function deny9(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}
function offense(n3, row, provider) {
  const gh2 = cut3(row, 1, false);
  const gl = cut3(row, 2, false);
  const objective = cut3(row, 3, true);
  const [own, ownName, other, otherName] = provider === "glab" ? [gl, "GitLab", gh2, "GitHub"] : [gh2, "GitHub", gl, "GitLab"];
  const line = (iid, forge) => `#${n3} \u2192 #${iid} (${forge})  local #${n3}: "${objective}"\\n`;
  if (own !== "" && own !== n3) return line(own, ownName);
  if (own === "" && other !== "" && other !== n3) return line(other, otherName);
  return "";
}
async function analyze(payload, env, overran) {
  if (overran()) return OVERRUN;
  const command = stripTrailingNewlines(jqAlternatives(payload, [["tool_input", "command"]]).replace(/\0/g, ""));
  if (command === "" || !carriesText(command)) return ALLOW;
  const tokens = candidateTokens(command);
  if (tokens.length === 0) return ALLOW;
  const listed2 = await cmdStatements(command, "/", env);
  if (overran()) return OVERRUN;
  if (!listed2.ok) return ALLOW;
  let provider = null;
  for (const { stmt } of listed2.statements) {
    provider = providerOf(stmt);
    if (provider) break;
  }
  if (!provider) return ALLOW;
  const db = dbPath(env) ?? "";
  if (db === "" || !haveSqlite(env)) return ALLOW;
  const rows = localRows(db, tokens, env);
  if (overran()) return OVERRUN;
  const offenses = tokens.map((n3) => rows.has(n3) ? offense(n3, rows.get(n3) ?? "", provider) : "").join("");
  if (offenses === "") return ALLOW;
  return deny9(
    `BLOCKED: this remote-bound text cites LOCAL trajectory issue id(s) that resolve to a DIFFERENT issue on the remote. Re-issue with the remote iid:
${printfB(offenses)}
A bare #N in a PR body / gh issue comment resolves to remote issue N, not the local one. Use the remote id shown above. To cite a number that is already a remote id, write it as GH-<n>, remote:<n> or <owner>/<repo>#<n>. (Bypass: TMB_DISABLE_REMOTE_ID_GUARD=1.)`
  );
}
function isFile22(path) {
  try {
    return statSync36(path).isFile();
  } catch {
    return false;
  }
}
function auditOverrun(deadline, elapsed, env) {
  const db = dbPath(env) ?? "";
  if (db === "" || !isFile22(db) || !haveSqlite(env)) return;
  auditAppend(
    db,
    {
      issueId: "-1",
      branchId: "",
      fromNode: `hook:${GATE_NAME66}`,
      eventType: "remote_id_guard_overrun",
      summary: `${GATE_NAME66} allowed a Bash command: its analysis passed the ${deadline}s deadline`,
      contentJson: `{"deadline_s":${jqNumberLiteral(deadline)},"elapsed_s":${jqNumberLiteral(elapsed)}}`
    },
    { caller: GATE_NAME66, env }
  );
}
function seconds(ms) {
  const whole = Math.max(0, Math.round(ms));
  return `${Math.floor(whole / 1e3)}.${String(whole % 1e3).padStart(3, "0")}`;
}
var remoteIdGuard = async (payload, processEnv) => {
  if (processEnv.TMB_DISABLE_REMOTE_ID_GUARD === "1") return ALLOW;
  const env = { ...processEnv, TMB_DB_WRITE_RUN_BUDGET_MS: WRITE_RUN_BUDGET_MS2 };
  const deadline = deadlineSeconds(env);
  const budgetMs = Number(deadline) * 1e3;
  const start2 = performance5.now();
  const skew = env.TMB_REMOTE_ID_GUARD_TEST_OVERRUN === "1" ? budgetMs : 0;
  const elapsedMs2 = () => performance5.now() - start2 + skew;
  const overran = () => elapsedMs2() >= budgetMs;
  let timer;
  const expired = new Promise((resolve4) => {
    timer = setTimeout(() => resolve4(OVERRUN), budgetMs);
  });
  let result;
  try {
    result = await Promise.race([analyze(payload, env, overran).catch(() => ALLOW), expired]);
  } finally {
    clearTimeout(timer);
  }
  if (result !== OVERRUN && !overran()) return result;
  const elapsed = seconds(elapsedMs2());
  process.stderr.write(`${GATE_NAME66}: analysis passed its ${deadline}s deadline (TMB_REMOTE_ID_GUARD_DEADLINE_S) after ${elapsed}s; allowing
`);
  auditOverrun(deadline, elapsed, env);
  return ALLOW;
};

// src/hooks/no-source-edit-from-main.ts
import { readFileSync as readFileSync21, statSync as statSync37 } from "node:fs";
import { fileURLToPath as fileURLToPath10 } from "node:url";
var GATE_NAME67 = "no-source-edit-from-main";
var JUDGED_TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
var BASH_REASON = "BLOCKED: Bash write-forms targeting prompt-surface files (agents/*.md, skills/*/SKILL.md, commands/*.md, templates/*.md, CLAUDE.md, CODEX/CURSOR/GEMINI.md) are denied from the main checkout for every agent identity. Sanctioned route: spawn an SWE task (prompt_bearing=1) for intentional prompt edits. Reads (cat/grep/sed -n) are always allowed.";
var SURFACE_REASON = "BLOCKED: enforcement surfaces (scripts/hooks/ and hooks/hooks.json) of the plugin's own source repo are only editable through task worktrees \u2014 spawn an SWE task. Main-checkout edits to these paths are denied regardless of file type.";
function sourceReason(env) {
  return `BLOCKED: source edits from the main checkout are denied. Normal route: use tmb_planning \u2192 task_create_batch to spawn SWE in an isolated worktree. If the worktree-create step failed (e.g. WorktreeCreate input had no .branch field), SWE running with agent_type='swe' is auto-permitted to edit in-place (non-isolated mode). For a bro emergency hotfix, set TMB_ALLOW_SOURCE_EDIT=1 in the PROCESS environment at launch time \u2014 setting it in a shell rc file has no effect on an already-running session. Scratch scripts and notes belong in ${scratchDir(env)}/ (or /tmp/claude-<uid>), which are always writable.`;
}
function scratchDir(env) {
  return `${TMB_STATE_HOST_DIR}/${pluginName2(env)}/scratch`;
}
var ALLOWED_BASENAMES = /* @__PURE__ */ new Set([
  "LICENSE",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmignore",
  ".dockerignore",
  "CHANGELOG",
  "CHANGELOG.md",
  "README",
  "README.md"
]);
function capture5(text) {
  return stripTrailingNewlines(text.replace(/\0/g, ""));
}
function field5(input, ...paths) {
  return capture5(jqAlternatives(input, paths));
}
function deny10(reason) {
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}
`, code: 0 };
}
function dbDenied(env) {
  return { stdout: `${denyDbUnavailable(GATE_NAME67, env)}
`, code: 0 };
}
function hasDir(path, dir) {
  return path.includes(`/${dir}/`) || path.startsWith(`${dir}/`);
}
function inWorktreeDir(path) {
  return hasDir(path, ".claude/worktrees");
}
function scratchExcluded(path) {
  return path.includes("/../") || path.startsWith("../") || path.endsWith("/..") || hasDir(path, "scripts/hooks");
}
function under3(path, dir) {
  return dir !== "" && path.startsWith(`${dir.endsWith("/") ? dir.slice(0, -1) : dir}/`);
}
function inScratch(target, input, env) {
  if (scratchExcluded(target)) return false;
  const scratch = scratchDir(env);
  if (hasDir(target, scratch)) return true;
  const canonical3 = capture5(pathCanonical2(target.startsWith("/") ? target : `${payloadCwd(input, env)}/${target}`));
  if (scratchExcluded(canonical3)) return false;
  return hasDir(canonical3, scratch) || under3(canonical3, harnessTmp(process.getuid?.() ?? 0));
}
function isFile23(path) {
  try {
    return statSync37(path).isFile();
  } catch {
    return false;
  }
}
function manifestName2(manifest) {
  try {
    return field5(readFileSync21(manifest, "utf8"), ["name"]);
  } catch {
    return "";
  }
}
function targetIsPluginSourceRepo(target, input, env) {
  const pluginRoot5 = env.CLAUDE_PLUGIN_ROOT || installRoot(posixDirname(fileURLToPath10(import.meta.url))) || "";
  const running = `${pluginRoot5}/.claude-plugin/plugin.json`;
  let start2;
  if (target.startsWith("/")) {
    start2 = posixDirname(target);
    while (!isDir(start2) && start2 !== "/") start2 = posixDirname(start2);
  } else {
    start2 = posixDirname(`${payloadCwd(input, env)}/${target}`);
  }
  const root = repoGitRoot(start2, env);
  if (root === "") return false;
  const repoManifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile23(running) || !isFile23(repoManifest)) return false;
  const runningName = manifestName2(running);
  return runningName !== "" && runningName === manifestName2(repoManifest);
}
function allowlisted(target) {
  if (/\.(md|markdown|txt|rst)$/.test(target)) return true;
  if (hasDir(target, "docs") || hasDir(target, "templates")) return true;
  const base2 = posixBasename(target);
  if (ALLOWED_BASENAMES.has(base2) || base2.startsWith("LICENSE.")) return true;
  if (target.endsWith(".claude-plugin/plugin.json") || target.endsWith(".claude-plugin/marketplace.json")) return true;
  return target.includes(".github/");
}
function isEnforcementSurface(target) {
  return hasDir(target, "scripts/hooks") || target.endsWith("/hooks/hooks.json") || target === "hooks/hooks.json";
}
function projectRelative(p, roots) {
  for (const root of roots) {
    if (root !== "" && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p;
}
function judgedPath(word) {
  if (!word.startsWith("UNRESOLVED:")) return word;
  const rest = word.slice("UNRESOLVED:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return word;
  return Object.hasOwn(NEVER_JUDGED, rest.slice(0, colon)) ? null : rest.slice(colon + 1);
}
async function bashRule(input, env) {
  const command = field5(input, ["tool_input", "command"]);
  const proj = capture5(projectRoot(env));
  const roots = [proj, proj === "" ? "" : realdir(proj)];
  const lines2 = capture5((await writePaths(command, { cwd: payloadCwd(input, env), env })).join("\n")).split("\n");
  for (const line of lines2) {
    const path = judgedPath(line);
    if (path === null || path === "") continue;
    if (isPromptSurfacePath(path, "", env) && !inWorktreeDir(projectRelative(path, roots))) return deny10(BASH_REASON);
  }
  return ALLOW;
}
function editRule(input, env) {
  const db = dbPath(env, (line) => process.stderr.write(`${line}
`));
  if (db === null) return ALLOW;
  const target = field5(input, ["tool_input", "file_path"], ["tool_input", "notebook_path"]);
  if (target === "" || inWorktreeDir(target) || inScratch(target, input, env)) return ALLOW;
  if (dbState(env) === "error") return dbDenied(env);
  if (target.startsWith("/")) {
    const dir = posixDirname(target);
    if (haveSqlite(env) && isDir(dir)) {
      const root = repoGitRoot(dir, env);
      if (root === "") return ALLOW;
      if (gateRead(db, "SELECT COUNT(*) FROM repos;", env) === GATE_READ_ERROR) return dbDenied(env);
      if (repoNameForRoot(db, root, env) === "") return ALLOW;
    }
  }
  if (isEnforcementSurface(target) && targetIsPluginSourceRepo(target, input, env)) return deny10(SURFACE_REASON);
  if (allowlisted(target)) return ALLOW;
  if (agentRole(input) === "swe") return ALLOW;
  return deny10(sourceReason(env));
}
var noSourceEditFromMain = (payload, env) => {
  const toolName2 = field5(payload, ["tool_name"]);
  if (!JUDGED_TOOLS2.has(toolName2)) return ALLOW;
  if (toolName2 === "Bash") return bashRule(payload, env);
  if ((env.TMB_ALLOW_SOURCE_EDIT ?? "0") === "1") return ALLOW;
  return editRule(payload, env);
};

// src/hooks/router/budgets.json
var budgets_default = {
  rounds: 20,
  workers: 4,
  parse_allowance_ms: 2e3,
  groups: {
    "PreToolUse:Write|Edit|MultiEdit|NotebookEdit": {
      max_budget_ms: 8090,
      p99_sum_ms: 18264.7,
      group_budget_ms: 27398
    },
    "PreToolUse:Bash": {
      max_budget_ms: 16e3,
      p99_sum_ms: 21657.5,
      group_budget_ms: 32487
    },
    "PreToolUse:Agent": {
      max_budget_ms: 16e3,
      p99_sum_ms: 4343.4,
      group_budget_ms: 16e3
    },
    "PreToolUse:SendMessage": {
      max_budget_ms: 6e3,
      p99_sum_ms: 10.1,
      group_budget_ms: 6e3
    },
    "PreToolUse:mcp__.*trajectory-server__.*": {
      max_budget_ms: 183e4,
      p99_sum_ms: 5368.3,
      group_budget_ms: 183e4
    },
    "PreToolUse:AskUserQuestion": {
      max_budget_ms: 6e3,
      p99_sum_ms: 1420.8,
      group_budget_ms: 6e3
    },
    "PreToolUse:Read|Skill": {
      max_budget_ms: 7486,
      p99_sum_ms: 3643,
      group_budget_ms: 7486
    },
    "PostToolUse:mcp__.*trajectory-server__.*": {
      max_budget_ms: 11840,
      p99_sum_ms: 10495.7,
      group_budget_ms: 15744
    },
    "PostToolUse:Bash": {
      max_budget_ms: 23300,
      p99_sum_ms: 12992.6,
      group_budget_ms: 23300
    },
    "PostToolUse:Agent": {
      max_budget_ms: 6e3,
      p99_sum_ms: 35.5,
      group_budget_ms: 6e3
    },
    "PermissionDenied:Agent": {
      max_budget_ms: 6e3,
      p99_sum_ms: 37.1,
      group_budget_ms: 6e3
    },
    "Stop:": {
      max_budget_ms: 6e3,
      p99_sum_ms: 755,
      group_budget_ms: 6e3
    },
    "SubagentStop:": {
      max_budget_ms: 11350,
      p99_sum_ms: 5633.3,
      group_budget_ms: 11350
    }
  },
  gates: {
    "containment-guard": {
      kind: "enforcement",
      bench_p50: 3.5,
      bench_p95: 9,
      bench_p99: 22.5,
      bench_runs: 4320,
      bench_load_avg: 12.06,
      transcript_p99: 1173,
      transcript_samples: 1,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 5e3,
      budget_ms: 5e3,
      date: "2026-10-31"
    },
    "swe-brief-gate": {
      kind: "enforcement",
      bench_p50: 1.4,
      bench_p95: 4.4,
      bench_p99: 5.5,
      bench_runs: 2e3,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no swe-brief-gate PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "no-source-edit-from-main": {
      kind: "enforcement",
      bench_p50: 1.7,
      bench_p95: 274.1,
      bench_p99: 337.2,
      bench_runs: 3760,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no no-source-edit-from-main PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "swe-boundary": {
      kind: "enforcement",
      bench_p50: 20.3,
      bench_p95: 60.6,
      bench_p99: 102.9,
      bench_runs: 5120,
      bench_load_avg: 12.06,
      transcript_p99: 3945,
      transcript_samples: 215,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 8090,
      date: "2026-10-31"
    },
    "swe-scope-fence": {
      kind: "advisory",
      bench_p50: 3,
      bench_p95: 4.8,
      bench_p99: 6.8,
      bench_runs: 2080,
      bench_load_avg: 12.06,
      transcript_p99: 3374,
      transcript_samples: 111,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6948,
      date: "2026-10-31"
    },
    "naming-lint": {
      kind: "advisory",
      bench_p50: 0,
      bench_p95: 0,
      bench_p99: 0.1,
      bench_runs: 1440,
      bench_load_avg: 12.06,
      transcript_p99: 1851,
      transcript_samples: 5,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 4e3,
      budget_ms: 4e3,
      date: "2026-10-31"
    },
    "code-quality-lint": {
      kind: "advisory",
      bench_p50: 0,
      bench_p95: 0.1,
      bench_p99: 0.1,
      bench_runs: 1120,
      bench_load_avg: 12.06,
      transcript_p99: 3936,
      transcript_samples: 81,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 4e3,
      budget_ms: 8072,
      date: "2026-10-31"
    },
    "debug-trajectory": {
      kind: "advisory",
      bench_p50: 2.7,
      bench_p95: 6.3,
      bench_p99: 9,
      bench_runs: 880,
      bench_load_avg: 12.06,
      transcript_p99: 3643,
      transcript_samples: 8,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 4e3,
      budget_ms: 7486,
      date: "2026-10-31"
    },
    "git-guards": {
      kind: "enforcement",
      bench_p50: 116,
      bench_p95: 286.1,
      bench_p99: 396.3,
      bench_runs: 4800,
      bench_load_avg: 12.06,
      transcript_p99: 998,
      transcript_samples: 2,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 11e3,
      budget_ms: 11e3,
      date: "2026-10-31"
    },
    "git-push-guard": {
      kind: "enforcement",
      bench_p50: 41.3,
      bench_p95: 235.7,
      bench_p99: 328,
      bench_runs: 2960,
      bench_load_avg: 12.06,
      transcript_p99: 828,
      transcript_samples: 1,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "no-worktree-branch-create": {
      kind: "enforcement",
      bench_p50: 123.9,
      bench_p95: 155.5,
      bench_p99: 189.8,
      bench_runs: 1360,
      bench_load_avg: 12.06,
      transcript_p99: 1115,
      transcript_samples: 2,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "stay-on-base-guard": {
      kind: "enforcement",
      bench_p50: 249.6,
      bench_p95: 379.1,
      bench_p99: 433.7,
      bench_runs: 1680,
      bench_load_avg: 12.06,
      transcript_p99: 1049,
      transcript_samples: 3,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "branch-up-to-date-with-remote": {
      kind: "enforcement",
      bench_p50: 362.2,
      bench_p95: 1169,
      bench_p99: 1388.5,
      bench_runs: 1600,
      bench_load_avg: 12.06,
      transcript_p99: 1104,
      transcript_samples: 2,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 16e3,
      budget_ms: 16e3,
      date: "2026-10-31"
    },
    "commit-msg-lint": {
      kind: "advisory",
      bench_p50: 0.1,
      bench_p95: 0.2,
      bench_p99: 0.5,
      bench_runs: 1600,
      bench_load_avg: 12.06,
      transcript_p99: 3540,
      transcript_samples: 121,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 4e3,
      budget_ms: 7280,
      date: "2026-10-31"
    },
    "no-remote-auth-guard": {
      kind: "enforcement",
      bench_p50: 353.5,
      bench_p95: 443.9,
      bench_p99: 520.4,
      bench_runs: 1200,
      bench_load_avg: 12.06,
      transcript_p99: 1002,
      transcript_samples: 2,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "remote-id-guard": {
      kind: "enforcement",
      bench_p50: 18.3,
      bench_p95: 31.8,
      bench_p99: 45.7,
      bench_runs: 2480,
      bench_load_avg: 12.06,
      transcript_p99: 2976,
      transcript_samples: 51,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6152,
      date: "2026-10-31"
    },
    "agent-spawn-dispatch": {
      kind: "enforcement",
      bench_p50: 5.4,
      bench_p95: 544.9,
      bench_p99: 700.4,
      bench_runs: 1600,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no agent-spawn-dispatch PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 16e3,
      budget_ms: 16e3,
      date: "2026-10-31"
    },
    "swe-resume-gate": {
      kind: "enforcement",
      bench_p50: 2.4,
      bench_p95: 4.2,
      bench_p99: 10.1,
      bench_runs: 320,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no swe-resume-gate PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "agent-arg-matches-caller": {
      kind: "enforcement",
      bench_p50: 1.1,
      bench_p95: 7.3,
      bench_p99: 10.3,
      bench_runs: 1680,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no agent-arg-matches-caller PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "swe-verification-gate": {
      kind: "enforcement",
      bench_p50: 171.2,
      bench_p95: 1102.7,
      bench_p99: 5339.4,
      bench_runs: 1680,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no swe-verification-gate PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 183e4,
      budget_ms: 183e4,
      date: "2026-10-31"
    },
    "reviewer-identity-observe": {
      kind: "enforcement",
      bench_p50: 0.8,
      bench_p95: 7.1,
      bench_p99: 9.7,
      bench_runs: 1440,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no reviewer-identity-observe PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "cheatcode-install-approval": {
      kind: "enforcement",
      bench_p50: 1.3,
      bench_p95: 2.4,
      bench_p99: 3.4,
      bench_runs: 1360,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no cheatcode-install-approval PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "askuserquestion-length-lint": {
      kind: "advisory",
      bench_p50: 0,
      bench_p95: 0.1,
      bench_p99: 0.2,
      bench_runs: 1360,
      bench_load_avg: 12.06,
      transcript_p99: 1415,
      transcript_samples: 21,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "roundtable-auq-shape": {
      kind: "advisory",
      bench_p50: 1.4,
      bench_p95: 2.6,
      bench_p99: 5.8,
      bench_runs: 1520,
      bench_load_avg: 12.06,
      transcript_p99: null,
      reason: "no roundtable-auq-shape PreToolUse hook attachment in 991 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-10-31"
    },
    "cleanup-worktree-on-task-close": {
      kind: "advisory",
      bench_p50: 9.1,
      bench_p95: 2350.7,
      bench_p99: 3185.1,
      bench_runs: 2240,
      bench_load_avg: 46.55,
      transcript_p99: 5820,
      transcript_samples: 287,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 11e3,
      budget_ms: 11840,
      date: "2026-11-01"
    },
    "roundtable-cleanup-postcheck": {
      kind: "advisory",
      bench_p50: 1.3,
      bench_p95: 6.2,
      bench_p99: 28.4,
      bench_runs: 1440,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no roundtable-cleanup-postcheck PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "post-task-close-rescan": {
      kind: "advisory",
      bench_p50: 0.1,
      bench_p95: 1,
      bench_p99: 2.7,
      bench_runs: 720,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no post-task-close-rescan PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "post-atomic-close-readme": {
      kind: "advisory",
      bench_p50: 474.2,
      bench_p95: 1906.7,
      bench_p99: 2784.6,
      bench_runs: 1840,
      bench_load_avg: 46.55,
      transcript_p99: 2947,
      transcript_samples: 370,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6094,
      date: "2026-11-01"
    },
    "post-task-create-spawn-hint": {
      kind: "advisory",
      bench_p50: 0.5,
      bench_p95: 8.2,
      bench_p99: 36.6,
      bench_runs: 1280,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no post-task-create-spawn-hint PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 4e3,
      budget_ms: 4e3,
      date: "2026-11-01"
    },
    "task-overrun-alert": {
      kind: "advisory",
      bench_p50: 1.6,
      bench_p95: 10.6,
      bench_p99: 20.4,
      bench_runs: 320,
      bench_load_avg: 46.55,
      transcript_p99: 1646,
      transcript_samples: 31,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "liveness-alert": {
      kind: "advisory",
      bench_p50: 4.4,
      bench_p95: 9.8,
      bench_p99: 15,
      bench_runs: 320,
      bench_load_avg: 6.13,
      transcript_p99: null,
      reason: "no liveness-alert hook attachment yet: the gate is new in GH 2205",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "attribution-footer": {
      kind: "advisory",
      bench_p50: 7.7,
      bench_p95: 47.7,
      bench_p99: 140.2,
      bench_runs: 1280,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no attribution-footer PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 16e3,
      budget_ms: 16e3,
      date: "2026-11-01"
    },
    "clean-merged-branch": {
      kind: "advisory",
      bench_p50: 230.3,
      bench_p95: 944,
      bench_p99: 1302.4,
      bench_runs: 1280,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no clean-merged-branch PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 11e3,
      budget_ms: 11e3,
      date: "2026-11-01"
    },
    "close-issue-on-merge": {
      kind: "advisory",
      bench_p50: 221.5,
      bench_p95: 10017.4,
      bench_p99: 10086.1,
      bench_runs: 1600,
      bench_load_avg: 46.55,
      transcript_p99: 11550,
      transcript_samples: 60,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 16e3,
      budget_ms: 23300,
      date: "2026-11-01"
    },
    "swe-spawn-bind": {
      kind: "advisory",
      bench_p50: 1.3,
      bench_p95: 7,
      bench_p99: 35.5,
      bench_runs: 1280,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no swe-spawn-bind PostToolUse hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "swe-spawn-rollback": {
      kind: "advisory",
      bench_p50: 1.7,
      bench_p95: 9,
      bench_p99: 37.1,
      bench_runs: 1200,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no swe-spawn-rollback PermissionDenied hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "bro-turn-usage": {
      kind: "advisory",
      bench_p50: 0.5,
      bench_p95: 20.1,
      bench_p99: 61.7,
      bench_runs: 1120,
      bench_load_avg: 46.55,
      transcript_p99: 755,
      transcript_samples: 2,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    },
    "swe-atomic-close": {
      kind: "advisory",
      bench_p50: 697.4,
      bench_p95: 2485.8,
      bench_p99: 3417.3,
      bench_runs: 1760,
      bench_load_avg: 46.55,
      transcript_p99: 5575,
      transcript_samples: 133,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 11350,
      date: "2026-11-01"
    },
    "consultant-persistence-gate": {
      kind: "enforcement",
      bench_p50: 2.3,
      bench_p95: 16.8,
      bench_p99: 58.3,
      bench_runs: 1360,
      bench_load_avg: 46.55,
      transcript_p99: null,
      reason: "no consultant-persistence-gate SubagentStop hook attachment in 995 transcript files of the last 14 days",
      transcript_samples: 0,
      transcript_timed_out: 0,
      window_days: 14,
      floor_ms: 6e3,
      budget_ms: 6e3,
      date: "2026-11-01"
    }
  }
};

// src/hooks/registry.ts
var GATES = /* @__PURE__ */ new Map([
  ["askuserquestion-length-lint", askuserquestionLengthLint],
  [GATE_NAME3, broTurnUsage],
  [GATE_NAME4, attributionFooter],
  [GATE_NAME5, codeQualityLint],
  [GATE_NAME7, commitMsgLint],
  ["containment-guard", containmentGuard],
  [GATE_NAME8, deferredToolsDriftWarn],
  [GATE_NAME9, ensureGitignore],
  ["ensure-mcp-deps-installed", ensureMcpDepsInstalled],
  [GATE_NAME6, gitGuards],
  [GATE_NAME10, gitPushGuard],
  [GATE_NAME11, mcpHealthCheck],
  [GATE_NAME12, codeReviewerPreflight],
  [GATE_NAME13, codeReviewerSpawnNote],
  [GATE_NAME14, reworkLimit],
  [GATE_NAME15, requireFeatureBranchActive],
  [GATE_NAME17, requireSpawnEffort],
  [GATE_NAME16, requireTaskSpec],
  [GATE_NAME18, substratePreflight],
  [GATE_NAME19, namingLint],
  [GATE_NAME20, sweBoundary],
  [GATE_NAME21, sweResumeGate],
  [GATE_NAME22, sweStopCause],
  [GATE_NAME23, taskOverrunAlert],
  [GATE_NAME25, livenessAlert],
  [GATE_NAME26, livenessSentinel],
  [GATE_NAME27, activationRoutine],
  [GATE_NAME28, debugTrajectory],
  [GATE_NAME24, pluginHooksMarker],
  [GATE_NAME29, sessionLogCapture],
  [GATE_NAME30, sessionStartPersona],
  [GATE_NAME31, userPromptPersona],
  [GATE_NAME34, reworkWaiverCapture],
  [GATE_NAME35, consultantPersistenceGate],
  [GATE_NAME36, roundtableAuqShape],
  [GATE_NAME37, roundtableCleanupPostcheck],
  [GATE_NAME38, roundtableSlashDetect],
  [GATE_NAME2, toolOutputSize],
  [GATE_NAME39, codeReviewerNoWorktree],
  [GATE_NAME40, codeReviewerSpawnPromptShape],
  [GATE_NAME41, codeReviewerAfterAtomicClose],
  [GATE_NAME43, sweVerificationGate],
  [GATE_NAME42, sweBriefGate],
  [GATE_NAME44, sweSpawnBind],
  [GATE_NAME45, sweSpawnRollback],
  [GATE_NAME46, postTaskCreateSpawnHint],
  [GATE_NAME32, agentArgMatchesCaller],
  [GATE_NAME47, reviewerIdentityObserve],
  [GATE_NAME48, cheatcodeInstallApproval],
  [GATE_NAME49, stayOnBaseGuard],
  [GATE_NAME50, branchUpToDateWithRemote],
  [GATE_NAME51, noWorktreeBranchCreate],
  [GATE_NAME52, noRemoteAuthGuard],
  [GATE_NAME33, promptIntentHints],
  [GATE_NAME53, sweScopeFence],
  [GATE_NAME54, orphanScan],
  [GATE_NAME55, sessionStartPrescan],
  [GATE_NAME56, cleanMergedBranch],
  [GATE_NAME57, closeIssueOnMerge],
  [GATE_NAME58, sweAtomicClose],
  [GATE_NAME59, postTaskCloseRescan],
  [GATE_NAME60, postAtomicCloseReadme],
  [GATE_NAME61, (payload, env) => agentSpawnDispatch(payload, env, findGate)],
  [GATE_NAME62, ensureSweWorktree],
  [GATE_NAME63, recordSweSpawn],
  [GATE_NAME64, cleanupWorktreeOnTaskClose],
  [GATE_NAME65, worktreeCreate],
  [GATE_NAME66, remoteIdGuard],
  [GATE_NAME67, noSourceEditFromMain]
]);
function findGate(name3) {
  return GATES.get(name3);
}
function routerGate(name3, kind, toolSuffix) {
  const budgets = budgets_default.gates;
  return { name: name3, kind, budgetMs: budgets[name3].budget_ms, ...toolSuffix === void 0 ? {} : { toolSuffix } };
}
function routerGroupKey(group) {
  return `${group.event}:${group.matcher}`;
}
function eventGroup(event, matcher, gates, opts = {}) {
  const budgets = budgets_default.groups;
  return { event, matcher, gates, groupBudgetMs: budgets[routerGroupKey({ event, matcher })].group_budget_ms, ...opts };
}
function preToolUseGroup(matcher, gates, opts = {}) {
  return eventGroup("PreToolUse", matcher, gates, opts);
}
var ROUTER_GROUPS = [
  preToolUseGroup("Write|Edit|MultiEdit|NotebookEdit", [
    routerGate("containment-guard", "enforcement"),
    routerGate(GATE_NAME42, "enforcement"),
    routerGate(GATE_NAME67, "enforcement"),
    routerGate(GATE_NAME20, "enforcement"),
    routerGate(GATE_NAME53, "advisory"),
    routerGate(GATE_NAME19, "advisory"),
    routerGate(GATE_NAME5, "advisory"),
    routerGate(GATE_NAME28, "advisory")
  ]),
  preToolUseGroup("Bash", [
    routerGate("containment-guard", "enforcement"),
    routerGate(GATE_NAME6, "enforcement"),
    routerGate(GATE_NAME10, "enforcement"),
    routerGate(GATE_NAME20, "enforcement"),
    routerGate(GATE_NAME51, "enforcement"),
    routerGate(GATE_NAME49, "enforcement"),
    routerGate(GATE_NAME50, "enforcement"),
    routerGate(GATE_NAME7, "advisory"),
    routerGate(GATE_NAME52, "enforcement"),
    routerGate(GATE_NAME66, "enforcement"),
    routerGate(GATE_NAME28, "advisory")
  ]),
  preToolUseGroup("Agent", [routerGate(GATE_NAME61, "enforcement"), routerGate(GATE_NAME28, "advisory")]),
  preToolUseGroup("SendMessage", [routerGate(GATE_NAME21, "enforcement")]),
  preToolUseGroup(
    "mcp__.*trajectory-server__.*",
    [
      routerGate(GATE_NAME32, "enforcement"),
      routerGate(GATE_NAME42, "enforcement"),
      routerGate(GATE_NAME43, "enforcement", "task_update_status"),
      routerGate(GATE_NAME47, "enforcement", "validation_record"),
      routerGate(GATE_NAME48, "enforcement", "cheatcode_install")
    ],
    { stopAtFirstDeny: true }
  ),
  preToolUseGroup("AskUserQuestion", [routerGate("askuserquestion-length-lint", "advisory"), routerGate(GATE_NAME36, "advisory")]),
  preToolUseGroup("Read|Skill", [routerGate(GATE_NAME28, "advisory")]),
  eventGroup("PostToolUse", "mcp__.*trajectory-server__.*", [
    routerGate(GATE_NAME64, "advisory", "task_update_status"),
    routerGate(GATE_NAME64, "advisory", "validation_record"),
    routerGate(GATE_NAME37, "advisory", "roundtable_close"),
    routerGate(GATE_NAME59, "advisory", "bro_atomic_close"),
    routerGate(GATE_NAME60, "advisory", "bro_atomic_close"),
    routerGate(GATE_NAME46, "advisory", "task_create_batch"),
    routerGate(GATE_NAME23, "advisory"),
    routerGate(GATE_NAME25, "advisory")
  ]),
  eventGroup("PostToolUse", "Bash", [routerGate(GATE_NAME4, "advisory"), routerGate(GATE_NAME56, "advisory"), routerGate(GATE_NAME57, "advisory")]),
  eventGroup("PostToolUse", "Agent", [routerGate(GATE_NAME44, "advisory")]),
  eventGroup("PermissionDenied", "Agent", [routerGate(GATE_NAME45, "advisory")]),
  eventGroup("Stop", "", [routerGate(GATE_NAME3, "advisory")]),
  eventGroup("SubagentStop", "", [routerGate(GATE_NAME35, "enforcement"), routerGate(GATE_NAME58, "advisory")])
];
function routerEvents() {
  return new Set(ROUTER_GROUPS.map((g) => g.event));
}
function eventHoldsEnforcement(event, groups = ROUTER_GROUPS) {
  return groups.some((g) => g.event === event && g.gates.some((x) => x.kind === "enforcement"));
}
function matcherFits(matcher, tool) {
  return matcher === "" || new RegExp(`^(?:${matcher})$`).test(tool);
}
function routerGroup(event, tool, groups = ROUTER_GROUPS) {
  return groups.find((g) => g.event === event && matcherFits(g.matcher, tool));
}
function routerGates(event, tool, groups = ROUTER_GROUPS) {
  const gates = routerGroup(event, tool, groups)?.gates ?? [];
  return gates.filter((g) => g.toolSuffix === void 0 || tool.endsWith(`trajectory-server__${g.toolSuffix}`));
}
function routerTimeoutS(group) {
  return Math.ceil((budgets_default.parse_allowance_ms + group.groupBudgetMs) / 1e3) + 1;
}

// src/hooks/router/main.ts
import { spawnSync as spawnSync15 } from "node:child_process";
import { existsSync as existsSync17, mkdirSync as mkdirSync13, readFileSync as readFileSync23 } from "node:fs";
import { dirname as dirname3 } from "node:path";
import { fileURLToPath as fileURLToPath11 } from "node:url";

// src/hooks/router/sh-gate.ts
import { spawnSync as spawnSync14 } from "node:child_process";
import { existsSync as existsSync15 } from "node:fs";
function shGate(name3) {
  return (payload, env) => {
    const script = `${env.CLAUDE_PLUGIN_ROOT ?? ""}/scripts/hooks/${name3}.sh`;
    if (!existsSync15(script)) throw new Error(`no ${script} (TMB_HOOKS_IMPL=bash runs only .sh gates) \u2014 not run`);
    const limit = spawnLimit(void 0, "SIGKILL");
    const r = spawnSync14("bash", [script], {
      input: payload,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
      ...spawnOptions(limit)
    });
    const cut4 = noteSpawn(limit, r);
    if (r.error && !cut4) throw r.error;
    return { stdout: r.stdout ?? "", code: r.status ?? 1 };
  };
}

// src/hooks/router/decide.ts
var ROUTER_NAME = "router";
var DENY_PATTERN = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function trimNewlines(text) {
  return text.replace(/\n+$/, "");
}
function failClosedReason(gate, cause) {
  return `BLOCKED: TMB gate ${gate} ${cause} without a decision, so the action is denied (fail-closed). The hook's stderr names the cause; fix the gate, then retry.`;
}
function timeoutReason(gate, budgetMs) {
  return `BLOCKED: TMB gate ${gate} timed out after ${budgetMs} ms (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}
function groupBudgetReason(gate, groupBudgetMs, ran) {
  const what = ran ? `ran out of the router's ${groupBudgetMs} ms group budget` : `was not run: the gates before it spent the router's ${groupBudgetMs} ms group budget`;
  return `BLOCKED: TMB gate ${gate} ${what} (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}
function denyOutput(reason, event) {
  const output = event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } } : { decision: "block", reason };
  return `${JSON.stringify(output)}
`;
}
function denyReason4(stdout, fallback) {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line);
      if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
      const rec = o;
      const r = rec.hookSpecificOutput?.permissionDecisionReason ?? rec.reason;
      if (typeof r === "string" && r !== "") return r;
      if (r !== void 0 && r !== null && r !== false) return JSON.stringify(r);
    } catch {
    }
  }
  return fallback;
}
function parses(stdout) {
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}
var asRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
var DECISION_KEYS = /* @__PURE__ */ new Set(["permissionDecision", "permissionDecisionReason"]);
var SPECIFIC_KEY = /* @__PURE__ */ new Set(["hookSpecificOutput"]);
function firstWins(records2, into, skip2) {
  for (const record of records2) {
    for (const [key2, value] of Object.entries(record)) {
      if (!skip2.has(key2) && !(key2 in into)) into[key2] = value;
    }
  }
  return into;
}
function mergeContext(outputs, event) {
  if (outputs.length === 0) return "";
  if (outputs.length === 1) return `${outputs[0]}
`;
  const parsed = outputs.map((o) => asRecord(JSON.parse(o)));
  const specifics = parsed.map((p) => asRecord(p.hookSpecificOutput));
  const eventName2 = specifics.map((p) => p.hookEventName).find((e) => typeof e === "string" && e !== "") ?? event;
  const context4 = specifics.map((p) => p.additionalContext).filter((c) => c !== void 0 && c !== null && c !== false).map((c) => typeof c === "string" ? c : JSON.stringify(c)).join("\n\n");
  const specific = firstWins(specifics, { hookEventName: eventName2, additionalContext: context4 }, DECISION_KEYS);
  const decided = specifics.filter((p) => p.permissionDecision !== void 0);
  const winner = decided.find((p) => p.permissionDecision !== "allow") ?? decided[0];
  if (winner) {
    specific.permissionDecision = winner.permissionDecision;
    if (winner.permissionDecisionReason !== void 0) specific.permissionDecisionReason = winner.permissionDecisionReason;
  }
  return `${JSON.stringify({ ...firstWins(parsed, {}, SPECIFIC_KEY), hookSpecificOutput: specific })}
`;
}
function blockKeepingContext(event, deny11, contexts) {
  const out2 = trimNewlines(deny11.stdout);
  if (event === "PreToolUse" || deny11.code === 2 || contexts.length === 0 || !parses(out2)) return deny11.stdout;
  return mergeContext([out2, ...contexts], event);
}
var LATE = /* @__PURE__ */ Symbol("late");
async function settle(fn, payload, env, limit, now) {
  const start2 = now();
  armDeadline(start2 + limit, now);
  const s = await run4(fn, payload, env, limit, now, start2);
  return { s, cut: disarmDeadline() };
}
async function run4(fn, payload, env, limit, now, start2) {
  let out2;
  try {
    out2 = fn(payload, env);
  } catch (err2) {
    return { kind: "threw", error: err2 instanceof Error ? err2.message : String(err2), ms: now() - start2 };
  }
  if (!(out2 instanceof Promise)) return { kind: "result", result: out2, ms: now() - start2 };
  let timer;
  const late = new Promise((resolve4) => {
    timer = setTimeout(() => resolve4(LATE), Math.max(0, limit - (now() - start2)));
    timer.unref();
  });
  try {
    const r = await Promise.race([out2, late]);
    if (r === LATE) return { kind: "late", ms: now() - start2 };
    return { kind: "result", result: r, ms: now() - start2 };
  } catch (err2) {
    return { kind: "threw", error: err2 instanceof Error ? err2.message : String(err2), ms: now() - start2 };
  } finally {
    clearTimeout(timer);
  }
}
function overBudget(gate, b, ran) {
  const what = !ran ? `got no time: the ${b.groupBudgetMs} ms group budget was spent` : b.byGroup ? `ran out of the ${b.groupBudgetMs} ms group budget` : `ran past its ${b.budget} ms budget`;
  if (gate.kind !== "enforcement") return { outcome: "skipped_budget", stdout: "", code: 0, reason: "", stderr: `TMB router: advisory gate ${gate.name} ${what} \u2014 skipped, output dropped
` };
  const reason = b.byGroup || !ran ? groupBudgetReason(gate.name, b.groupBudgetMs, ran) : timeoutReason(gate.name, b.budget);
  return { outcome: "deny", stdout: denyOutput(reason, b.event), code: 0, reason, stderr: `TMB dispatch: gate ${gate.name} ${what} \u2014 failing closed
` };
}
function judge(gate, s, cut4, b) {
  const enforce = gate.kind === "enforcement";
  const closed = (cause, stderr2 = "") => enforce ? { outcome: "deny", stdout: denyOutput(failClosedReason(gate.name, cause), b.event), code: 0, reason: failClosedReason(gate.name, cause), stderr: `${stderr2}TMB dispatch: gate ${gate.name} ${cause} \u2014 failing closed
` } : { outcome: "error", stdout: "", code: 0, reason: "", stderr: `${stderr2}TMB router: advisory gate ${gate.name} ${cause} \u2014 output dropped
` };
  if (s.kind === "unrun") return overBudget(gate, b, false);
  if (cut4 || s.kind === "late") return overBudget(gate, b, true);
  if (s.kind === "threw") return closed("exited 1", `TMB hooks: gate '${oneLine(gate.name)}' failed: ${oneLine(s.error)}
`);
  if (s.ms > b.limit && !(s.result.code === 2 || DENY_PATTERN.test(s.result.stdout))) return overBudget(gate, b, true);
  const { code } = s.result;
  const out2 = trimNewlines(s.result.stdout);
  const denies = DENY_PATTERN.test(out2);
  if (code === 2 || denies) {
    if (code === 0 || code === 2 || enforce) {
      return { outcome: "deny", stdout: out2 === "" ? "" : `${out2}
`, code: code === 2 ? 2 : 0, reason: denyReason4(out2, `exit ${code}`), stderr: "" };
    }
  }
  if (code !== 0) return closed(`exited ${code}`);
  if (out2 !== "" && !parses(out2)) return closed("printed unparseable output");
  return { outcome: "allow", stdout: out2, code: 0, reason: "", stderr: "" };
}
function payloadTool(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const tool = parsed.tool_name;
  return typeof tool === "string" ? tool : "";
}
async function decide(event, payload, env, deps = {}) {
  const now = deps.now ?? (() => performance.now());
  const tool = payloadTool(payload);
  const groups = deps.groups ?? ROUTER_GROUPS;
  if (tool === null) {
    if (!eventHoldsEnforcement(event, groups)) {
      return { stdout: "", stderr: `TMB router: ${event} got an unparseable payload \u2014 no gate run
`, code: 0, tool: "", gates: [], denied: null };
    }
    const reason = failClosedReason(ROUTER_NAME, "got an unparseable payload");
    return {
      stdout: denyOutput(reason, event),
      stderr: `TMB dispatch: gate ${ROUTER_NAME} got an unparseable payload \u2014 failing closed
`,
      code: 0,
      tool: "",
      gates: [],
      denied: { gate: ROUTER_NAME, reason }
    };
  }
  const bashImpl = env.TMB_HOOKS_IMPL === "bash";
  const find = deps.findGate ?? (bashImpl ? shGate : findGate);
  const group = routerGroup(event, tool, groups);
  const gates = routerGates(event, tool, groups);
  if (event === "PreToolUse" && tool === "Bash" && gates.length > 0 && !bashImpl) await bashParser().catch(() => void 0);
  const groupBudgetMs = deps.groupBudgetMs ?? group?.groupBudgetMs ?? 0;
  const groupStart = now();
  const done = [];
  let spent = false;
  for (const gate of gates) {
    const budget = deps.budgetMs?.(gate) ?? gate.budgetMs;
    const left = groupBudgetMs - (now() - groupStart);
    const b = { event, limit: Math.min(budget, left), budget, groupBudgetMs, byGroup: left < budget };
    const fn = find(gate.name);
    if (!fn) {
      done.push({ gate, s: { kind: "threw", error: `unknown gate '${oneLine(gate.name)}' \u2014 not run`, ms: 0 }, j: judgeUnknown(gate, event) });
      continue;
    }
    if (spent || left <= 0) {
      const s2 = { kind: "unrun", ms: 0 };
      done.push({ gate, s: s2, j: judge(gate, s2, false, b) });
      continue;
    }
    const { s, cut: cut4 } = await settle(fn, payload, env, b.limit, now);
    spent = b.byGroup && (cut4 || s.kind === "late" || s.ms >= b.limit);
    const j = judge(gate, s, cut4, b);
    done.push({ gate, s, j });
    if (group?.stopAtFirstDeny && j.outcome === "deny") break;
  }
  const outcomes = done.map(({ gate, s, j }) => ({ gate: gate.name, ms: Math.round(s.ms * 1e3) / 1e3, outcome: j.outcome }));
  const stderr2 = done.map(({ j }) => j.stderr).join("");
  const deny11 = done.find(({ j }) => j.outcome === "deny");
  const context4 = done.filter(({ j }) => j.outcome === "allow" && j.stdout !== "").map(({ j }) => j.stdout);
  if (deny11) {
    return { stdout: blockKeepingContext(event, deny11.j, context4), stderr: stderr2, code: deny11.j.code, tool, gates: outcomes, denied: { gate: deny11.gate.name, reason: deny11.j.reason } };
  }
  return { stdout: mergeContext(context4, event), stderr: stderr2, code: 0, tool, gates: outcomes, denied: null };
}
function judgeUnknown(gate, event) {
  const note2 = `TMB hooks: unknown gate '${oneLine(gate.name)}' \u2014 not run
`;
  if (gate.kind !== "enforcement") return { outcome: "error", stdout: "", code: 0, reason: "", stderr: `${note2}TMB router: advisory gate ${gate.name} exited 1 \u2014 output dropped
` };
  const reason = failClosedReason(gate.name, "exited 1");
  return { outcome: "deny", stdout: denyOutput(reason, event), code: 0, reason, stderr: `${note2}TMB dispatch: gate ${gate.name} exited 1 \u2014 failing closed
` };
}

// src/hooks/router/dedupe.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync16, mkdirSync as mkdirSync11, readdirSync as readdirSync8, readFileSync as readFileSync22, renameSync as renameSync5, rmSync as rmSync6, statSync as statSync38, writeFileSync as writeFileSync7 } from "node:fs";
import { setTimeout as sleep3 } from "node:timers/promises";
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function dedupeKey(payload) {
  let o;
  try {
    o = JSON.parse(payload);
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const p = o;
  const material = canonicalJson("tool_name" in p ? [p.hook_event_name ?? "", p.session_id ?? "", p.tool_name, p.tool_input ?? null, p.tool_use_id ?? ""] : p);
  return createHash2("sha256").update(material).digest("hex");
}
function intEnv(env, name3, fallback) {
  const v = env[name3] ?? "";
  return /^[0-9]+$/.test(v) ? Number(v) : fallback;
}
function nowS2() {
  return Math.floor(Date.now() / 1e3);
}
function stamp(file) {
  try {
    const line = readFileSync22(file, "utf8").split("\n")[0];
    return /^[0-9]+$/.test(line) ? Number(line) : null;
  } catch {
    return null;
  }
}
function ageS(path) {
  try {
    return nowS2() - Math.floor(statSync38(path).mtimeMs / 1e3);
  } catch {
    return null;
  }
}
var Dedupe = class {
  constructor(base2, timeoutS, env) {
    this.timeoutS = timeoutS;
    this.base = base2;
    this.ttlMin = intEnv(env, "TMB_DISPATCH_TTL_MIN", 10);
    this.windowS = intEnv(env, "TMB_DISPATCH_WINDOW_S", 5);
    this.sweepS = intEnv(env, "TMB_DISPATCH_SWEEP_S", 60);
  }
  timeoutS;
  base;
  ttlMin;
  windowS;
  sweepS;
  expired(lock) {
    const done = existsSync16(`${lock}/rc`);
    if (!done) {
      const deadline = stamp(`${lock}/deadline`);
      if (deadline !== null) return nowS2() > deadline;
    }
    const age = ageS(lock);
    if (age === null) return false;
    return done ? age > this.windowS : age > this.timeoutS;
  }
  sweep() {
    const stampFile = `${this.base}.sweep`;
    const now = nowS2();
    const last = stamp(stampFile);
    if (last !== null && last <= now && now - last < this.sweepS) return;
    try {
      writeFileSync7(stampFile, `${now}
`);
    } catch {
    }
    let names;
    try {
      names = readdirSync8(this.base);
    } catch {
      return;
    }
    for (const name3 of names) {
      const d = `${this.base}/${name3}`;
      let st;
      try {
        st = statSync38(d);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const ageMin = (Date.now() - st.mtimeMs) / 6e4;
      const done = existsSync16(`${d}/rc`);
      const deadline = done ? null : stamp(`${d}/deadline`);
      const gone = done && ageMin > this.ttlMin || !done && deadline === null && ageMin > this.ttlMin * 3 || !done && deadline !== null && now > deadline;
      if (gone) rmSync6(d, { recursive: true, force: true });
    }
  }
  take(lock) {
    try {
      mkdirSync11(lock);
    } catch {
      return false;
    }
    try {
      writeFileSync7(`${lock}/deadline`, `${nowS2() + this.timeoutS + 5}
`);
    } catch {
    }
    return true;
  }
  replay(lock) {
    let rc;
    try {
      const text = readFileSync22(`${lock}/rc`, "utf8").trim();
      if (!/^[0-9]+$/.test(text)) return null;
      rc = Number(text);
    } catch {
      return null;
    }
    const read = (f) => {
      try {
        return readFileSync22(`${lock}/${f}`, "utf8");
      } catch {
        return "";
      }
    };
    const result = read("result");
    if (rc === 2) return { stdout: result, stderr: read("stderr"), code: 2 };
    const denies = result.split("\n").some((line) => {
      try {
        return JSON.parse(line).hookSpecificOutput?.permissionDecision === "deny";
      } catch {
        return false;
      }
    });
    return denies ? { stdout: result, stderr: "", code: rc } : { stdout: "", stderr: "", code: 0 };
  }
  reclaim(lock) {
    const mutex = `${lock}.reclaim`;
    try {
      mkdirSync11(mutex);
    } catch {
      const age = ageS(mutex);
      if (age !== null && age > 30) rmSync6(mutex, { recursive: true, force: true });
      return false;
    }
    try {
      if (!existsSync16(lock) || this.expired(lock)) {
        rmSync6(lock, { recursive: true, force: true });
        return this.take(lock);
      }
      return false;
    } finally {
      rmSync6(mutex, { recursive: true, force: true });
    }
  }
  /** hold: this call decides and stores; replay: a duplicate's answer; none: a duplicate that gave up. */
  async claim(key2) {
    this.sweep();
    const lock = `${this.base}/${key2}`;
    const giveUp = nowS2() + Math.max(1, this.timeoutS - 1);
    for (; ; ) {
      if (this.take(lock)) return { kind: "hold", lock };
      if (existsSync16(`${lock}/rc`) && !this.expired(lock)) {
        const out2 = this.replay(lock);
        return out2 === null ? { kind: "none" } : { kind: "replay", out: out2 };
      }
      if (this.expired(lock) && this.reclaim(lock)) return { kind: "hold", lock };
      if (nowS2() >= giveUp) return { kind: "none" };
      await sleep3(100);
    }
  }
  static store(lock, out2) {
    try {
      writeFileSync7(`${lock}/result`, out2.stdout);
      writeFileSync7(`${lock}/stderr`, out2.stderr);
      writeFileSync7(`${lock}/rc.tmp`, `${out2.code}
`);
      renameSync5(`${lock}/rc.tmp`, `${lock}/rc`);
    } catch {
    }
  }
};

// src/hooks/router/records.ts
import { mkdirSync as mkdirSync12, readdirSync as readdirSync9, rmdirSync as rmdirSync2, statSync as statSync39, unlinkSync as unlinkSync2, writeFileSync as writeFileSync8 } from "node:fs";
var CALLER = "router";
function parse(payload) {
  try {
    const o = JSON.parse(payload);
    return o !== null && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
function str(v) {
  return typeof v === "string" ? v : null;
}
function taskAndIssue(payload, p, db, env) {
  const run5 = callerRun(payload, db, env);
  let taskId = sqlInt(run5.split("|")[0]);
  if (taskId === "") {
    const t = p.tool_input?.task_id;
    taskId = sqlInt(typeof t === "number" || typeof t === "string" ? String(t) : "");
  }
  if (taskId === "") return { taskId, issue: "-1" };
  const issue = sqlInt(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env).trim());
  return { taskId, issue: issue === "" ? "-1" : issue };
}
function auditCall(event, payload, d, env) {
  const writeEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: "300", TMB_DB_WRITE_RUN_BUDGET_MS: "600" };
  const db = dbPath(writeEnv);
  if (db === null) return;
  const p = parse(payload);
  const { taskId, issue } = taskAndIssue(payload, p, db, writeEnv);
  const tool = str(p.tool_name);
  const decision = d.denied ? "deny" : "allow";
  auditAppend(
    db,
    {
      issueId: issue,
      branchId: "",
      fromNode: "hook:router",
      eventType: "hook_call",
      summary: `${event}${tool ? ` ${tool}` : ""}: ${decision}${d.denied ? ` by ${d.denied.gate}` : ""}`,
      contentJson: JSON.stringify({
        event,
        tool,
        decision,
        denied_gate: d.denied?.gate ?? null,
        task_id: taskId === "" ? null : Number(taskId),
        gates: d.gates
      })
    },
    { caller: CALLER, env: writeEnv }
  );
  if (!d.denied) return;
  auditAppend(
    db,
    {
      issueId: issue,
      branchId: "",
      fromNode: "hook:dispatch",
      eventType: "hook_denied",
      summary: `${d.denied.gate} denied${tool ? ` ${tool}` : ""}`,
      contentJson: JSON.stringify({
        hook: d.denied.gate,
        rule: d.denied.reason.slice(0, 200),
        tool,
        agent_type: p.agent_type ?? null,
        task_id: taskId === "" ? null : Number(taskId),
        cwd: p.cwd ?? null
      })
    },
    { caller: CALLER, env: writeEnv }
  );
}
function unjudgedDeny(reason) {
  const head = 'BLOCKED: write target "';
  const sep2 = `" ${UNJUDGED_PHRASE} `;
  if (!reason.startsWith(head)) return false;
  const at2 = reason.lastIndexOf(sep2);
  if (at2 < head.length) return false;
  return !reason.slice(at2 + sep2.length).includes('"');
}
function prune(dir, cutoffMs) {
  let names;
  try {
    names = readdirSync9(dir);
  } catch {
    return false;
  }
  let empty = true;
  for (const name3 of names) {
    const path = `${dir}/${name3}`;
    try {
      const st = statSync39(path);
      if (st.isDirectory()) {
        if (prune(path, cutoffMs)) rmdirSync2(path);
        else empty = false;
      } else if (st.mtimeMs < cutoffMs) unlinkSync2(path);
      else empty = false;
    } catch {
      empty = false;
    }
  }
  return empty;
}
async function recordBashDeny(base2, payload, d, env) {
  if (!d.denied || d.tool !== "Bash" || unjudgedDeny(d.denied.reason)) return;
  const p = parse(payload);
  const session = str(p.session_id) ?? "";
  if (session === "" || session.includes("/") || session.startsWith(".")) return;
  const cmd = str(p.tool_input?.command) ?? "";
  if (cmd === "") return;
  const w = env.TMB_BYPASS_WINDOW_MIN ?? "";
  const window2 = /^[0-9]+$/.test(w) && Number(w) > 0 ? Number(w) : 10;
  try {
    prune(base2, Date.now() - window2 * 6e4);
    const dir = `${base2}/${session}`;
    mkdirSync12(dir, { recursive: true });
    const paths = await writePaths(cmd, { cwd: payloadCwd(payload, env), raw: false, root: projectRoot(env), env });
    const epoch = Math.floor(Date.now() / 1e3);
    for (const path of paths) {
      if (path.startsWith("/")) writeFileSync8(`${dir}/${pathDigest(path)}`, `${d.denied.gate}
${epoch}
`);
    }
  } catch {
  }
}

// src/hooks/router/table.ts
var EMPTY_MATCHER_COLUMN = "-";
function matcherOfColumn(column) {
  return column === EMPTY_MATCHER_COLUMN ? "" : column;
}

// src/hooks/router/main.ts
var ROUTER_MANIFEST = "mcp/trajectory-server/dist/hooks-router.txt";
var BUNDLE = "mcp/trajectory-server/dist/hooks.js";
var HOP_ENV = "TMB_ROUTER_HOP";
function ownRoot(env) {
  return installRoot(dirname3(fileURLToPath11(import.meta.url))) ?? env.CLAUDE_PLUGIN_ROOT ?? "";
}
function hopTo(root, event, payload, env) {
  const r = spawnSync15(process.execPath, [`${root}/${BUNDLE}`, event], {
    input: payload,
    env: { ...env, CLAUDE_PLUGIN_ROOT: root, [HOP_ENV]: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status === null) {
    const cause = `could not run in ${root}`;
    if (!eventHoldsEnforcement(event)) return { stdout: "", stderr: `TMB router: ${event} ${cause} \u2014 no gate run
`, code: 0 };
    return { stdout: denyOutput(failClosedReason(ROUTER_NAME, cause), event), stderr: `TMB dispatch: gate ${ROUTER_NAME} ${cause} \u2014 failing closed
`, code: 0 };
  }
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}
function servesCall(root, event, tool) {
  if (tool === null) return true;
  let table;
  try {
    table = readFileSync23(`${root}/${ROUTER_MANIFEST}`, "utf8");
  } catch {
    return false;
  }
  return table.split("\n").some((line) => {
    const f = line.split(" ");
    return f[3] === event && matcherOfColumn(f[4] ?? "").split(",").some((m) => matcherFits(m, tool));
  });
}
function lockBase(env) {
  if (!haveSqlite(env)) return null;
  const state = stateDir(env);
  return state === null ? null : `${canonicalDir(state)}/locks`;
}
async function routerMain(event, env, io, opts = {}) {
  const payload = io.readStdin();
  const tool = payloadTool(payload);
  const self2 = opts.selfRoot ?? ownRoot(env);
  if (opts.hop !== false && env[HOP_ENV] !== "1") {
    const root = activeInstall(env, io.writeStderr);
    if (root !== "" && self2 !== "" && canonicalDir(root) !== canonicalDir(self2)) {
      if (existsSync17(`${root}/${ROUTER_MANIFEST}`) && existsSync17(`${root}/${BUNDLE}`) && servesCall(root, event, tool)) {
        const out2 = hopTo(root, event, payload, env);
        io.writeStderr(out2.stderr);
        await io.writeStdout(out2.stdout);
        return out2.code;
      }
      io.writeStderr(`TMB router: no router in ${root} \u2014 using ${self2}
`);
    }
  }
  const gateEnv = self2 === "" ? env : { ...env, CLAUDE_PLUGIN_ROOT: self2 };
  const locks = opts.dedupe === false ? null : lockBase(gateEnv);
  const key2 = locks === null ? null : dedupeKey(payload);
  let dedupe = null;
  let lock = null;
  const groupBudget = opts.groupBudgetMs ?? routerGroup(event, tool ?? "", opts.groups)?.groupBudgetMs;
  if (locks !== null && key2 !== null && groupBudget !== void 0) {
    dedupe = new Dedupe(`${locks}/events`, routerTimeoutS({ groupBudgetMs: groupBudget }), gateEnv);
    try {
      mkdirSync13(dedupe.base, { recursive: true });
      const claim2 = await dedupe.claim(key2);
      if (claim2.kind === "replay") {
        io.writeStderr(claim2.out.stderr);
        await io.writeStdout(claim2.out.stdout);
        return claim2.out.code;
      }
      if (claim2.kind === "none") return 0;
      lock = claim2.lock;
    } catch {
      lock = null;
    }
  }
  const d = await decide(event, payload, gateEnv, opts);
  if (lock !== null) Dedupe.store(lock, d);
  io.writeStderr(d.stderr);
  await io.writeStdout(d.stdout);
  if (opts.record !== false) {
    try {
      auditCall(event, payload, d, gateEnv);
    } catch {
    }
    if (locks !== null && lock !== null) await recordBashDeny(`${locks}/boundary-denies`, payload, d, gateEnv);
  }
  return d.code;
}

// src/hooks/run.ts
function oneLine2(text) {
  return text.replace(/\s+/g, " ").trim();
}
async function runHook(name3, findGate2, env, io) {
  try {
    const gate = findGate2(name3);
    if (!gate) {
      io.writeStderr(`TMB hooks: unknown gate '${oneLine2(name3)}' \u2014 not run
`);
      return 1;
    }
    const result = await gate(io.readStdin(), env);
    io.writeStdout(result.stdout);
    if (result.stderr) io.writeStderr(result.stderr);
    return result.code;
  } catch (err2) {
    const detail = err2 instanceof Error ? err2.message : String(err2);
    io.writeStderr(`TMB hooks: gate '${oneLine2(name3)}' failed: ${oneLine2(detail)}
`);
    return 1;
  }
}

// src/hooks/index.ts
var name2 = process.argv[2] ?? "";
if (routerEvents().has(name2)) {
  const code = await routerMain(name2, process.env, {
    readStdin: () => readFileSync24(0, "utf8"),
    writeStdout: (text) => new Promise((resolve4) => text === "" ? resolve4() : process.stdout.write(text, () => resolve4())),
    writeStderr: (text) => {
      if (text !== "") process.stderr.write(text);
    }
  });
  await new Promise((resolve4) => process.stderr.write("", () => resolve4()));
  process.exit(code);
}
var installWorker = name2 === GATE_NAME && process.argv[3] === INSTALL_FLAG;
var worker = (_payload, env) => ({ stdout: "", code: runInstallWorker(env) });
process.exitCode = await runHook(name2, installWorker ? () => worker : findGate, process.env, {
  readStdin: () => installWorker ? "" : readFileSync24(0, "utf8"),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text)
});
//# sourceMappingURL=hooks.js.map
