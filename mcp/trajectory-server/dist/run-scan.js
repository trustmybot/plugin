var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err3) => function __init() {
  if (err3) throw err3[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err3 = [e], e;
  }
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
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
  let result2 = tree.textCallback(startIndex, startPosition);
  if (result2) {
    startIndex += result2.length;
    while (startIndex < endIndex) {
      const string = tree.textCallback(startIndex, startPosition);
      if (string && string.length > 0) {
        startIndex += string.length;
        result2 += string;
      } else {
        break;
      }
    }
    if (startIndex > endIndex) {
      result2 = result2.slice(0, length);
    }
  }
  return result2 ?? "";
}
function unmarshalCaptures(query, tree, address, patternIndex, result2) {
  for (let i2 = 0, n = result2.length; i2 < n; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result2[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
function marshalNode(node, index = 0) {
  let address = TRANSFER_BUFFER + index * SIZE_OF_NODE;
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
  const index = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result2 = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index,
    startPosition: { row, column },
    other
  });
  return result2;
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
  const result2 = {
    row: C.getValue(address, "i32") >>> 0,
    column: C.getValue(address + SIZE_OF_INT, "i32") >>> 0
  };
  return result2;
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
  const result2 = {};
  result2.startPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result2.endPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result2.startIndex = C.getValue(address, "i32") >>> 0;
  address += SIZE_OF_INT;
  result2.endIndex = C.getValue(address, "i32") >>> 0;
  return result2;
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
function parseAnyPredicate(steps, index, operator, textPredicates) {
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
    textPredicates[index].push((captures) => {
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
    textPredicates[index].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName) nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
function parseMatchPredicate(steps, index, operator, textPredicates) {
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
  textPredicates[index].push((captures) => {
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
function parseAnyOfPredicate(steps, index, operator, textPredicates) {
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
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    if (nodes.length === 0) return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
function parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties) {
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
  if (!properties[index]) properties[index] = {};
  properties[index][steps[1].value] = steps[2]?.value ?? null;
}
function parseSetDirective(steps, index, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index]) setProperties[index] = {};
  setProperties[index][steps[1].value] = steps[2]?.value ?? null;
}
function parsePattern(index, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
  if (stepType === PREDICATE_STEP_TYPE_CAPTURE) {
    const name2 = captureNames[stepValueId];
    steps.push({ type: "capture", name: name2 });
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
        parseAnyPredicate(steps, index, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index, setProperties);
        break;
      default:
        predicates[index].push({ operator, operands: steps.slice(1) });
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
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result2;
      }
      /** Get the included ranges that were used to parse the syntax tree. */
      getIncludedRanges() {
        C._ts_tree_included_ranges_wasm(this[0]);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result2;
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
        const result2 = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
        const result2 = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
        unmarshalTreeCursor(this);
        return result2 === 1;
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
      child(index) {
        marshalNode(this);
        C._ts_node_child_wasm(this.tree[0], index);
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
      namedChild(index) {
        marshalNode(this);
        C._ts_node_named_child_wasm(this.tree[0], index);
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
      fieldNameForChild(index) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index);
        if (!address) return null;
        return C.AsciiToString(address);
      }
      /** Get the field name of this node's named child at the given index. */
      fieldNameForNamedChild(index) {
        marshalNode(this);
        const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index);
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
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
          C._free(buffer);
        }
        return result2;
      }
      /** Get the node's first child that contains or starts after the given byte offset. */
      firstChildForIndex(index) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index, "i32");
        C._ts_node_first_child_for_byte_wasm(this.tree[0]);
        return unmarshalNode(this.tree);
      }
      /** Get the node's first named child that contains or starts after the given byte offset. */
      firstNamedChildForIndex(index) {
        marshalNode(this);
        const address = TRANSFER_BUFFER + SIZE_OF_NODE;
        C.setValue(address, index, "i32");
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
        const result2 = new Array(descendantCount);
        if (descendantCount > 0) {
          let address = descendantAddress;
          for (let i2 = 0; i2 < descendantCount; i2++) {
            result2[i2] = unmarshalNode(this.tree, address);
            address += SIZE_OF_NODE;
          }
        }
        C._free(descendantAddress);
        C._free(symbolsAddress);
        return result2;
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
        const result2 = C.AsciiToString(address);
        C._free(address);
        return result2;
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
      constructor(kind, info2, index, length) {
        super(_QueryError.formatMessage(kind, info2));
        this.kind = kind;
        this.info = info2;
        this.index = index;
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
        const result2 = new Array(rawCount);
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
            result2[filteredCount] = { pattern: patternIndex, patternIndex, captures };
            const setProperties = this.setProperties[patternIndex];
            result2[filteredCount].setProperties = setProperties;
            const assertedProperties = this.assertedProperties[patternIndex];
            result2[filteredCount].assertedProperties = assertedProperties;
            const refutedProperties = this.refutedProperties[patternIndex];
            result2[filteredCount].refutedProperties = refutedProperties;
            filteredCount++;
          }
        }
        result2.length = filteredCount;
        C._free(startAddress);
        C.currentQueryProgressCallback = null;
        return result2;
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
        const result2 = new Array();
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
            const capture = captures[captureIndex];
            const setProperties = this.setProperties[patternIndex];
            capture.setProperties = setProperties;
            const assertedProperties = this.assertedProperties[patternIndex];
            capture.assertedProperties = assertedProperties;
            const refutedProperties = this.refutedProperties[patternIndex];
            capture.refutedProperties = refutedProperties;
            result2.push(capture);
          }
        }
        C._free(startAddress);
        C.currentQueryProgressCallback = null;
        return result2;
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
        const result2 = this.fields.indexOf(fieldName);
        return result2 !== -1 ? result2 : null;
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
      idForNodeType(type, named2) {
        const typeLength = C.lengthBytesUTF8(type);
        const typeAddress = C._malloc(typeLength + 1);
        C.stringToUTF8(type, typeAddress, typeLength + 1);
        const result2 = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named2 ? 1 : 0);
        C._free(typeAddress);
        return result2 || null;
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
        const name2 = C._ts_language_symbol_name(this[0], typeId);
        return name2 ? C.UTF8ToString(name2) : null;
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
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = C.getValue(address, "i16");
            address += SIZE_OF_SHORT;
          }
        }
        return result2;
      }
      /**
       * Get the subtype ids for a given supertype node id.
       */
      subtypes(supertype) {
        C._ts_language_subtypes_wasm(this[0], supertype);
        const count = C.getValue(TRANSFER_BUFFER, "i32");
        const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = C.getValue(address, "i16");
            address += SIZE_OF_SHORT;
          }
        }
        return result2;
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
        const functionName = symbolNames.find((key) => LANGUAGE_FUNCTION_REGEX.test(key) && !key.includes("external_scanner_"));
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
          const { createRequire } = await import("module");
          var require = createRequire(import.meta.url);
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
          function receiveInstantiationResult(result22) {
            return receiveInstance(result22["instance"], result22["module"]);
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
            var result2 = await instantiateAsync(wasmBinary, wasmBinaryFile, info2);
            var exports = receiveInstantiationResult(result2);
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
          function failIf(condition, message2) {
            if (condition) throw new Error(message2);
          }
          __name(failIf, "failIf");
          var name2 = "dylink.0";
          if (binary2 instanceof WebAssembly.Module) {
            var dylinkSection = WebAssembly.Module.customSections(binary2, name2);
            if (dylinkSection.length === 0) {
              name2 = "dylink";
              dylinkSection = WebAssembly.Module.customSections(binary2, name2);
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
            name2 = getString();
          }
          var customSection = {
            neededDynlibs: [],
            tlsExports: /* @__PURE__ */ new Set(),
            weakImports: /* @__PURE__ */ new Set()
          };
          if (name2 == "dylink") {
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
            failIf(name2 !== "dylink.0");
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
        var newDSO = /* @__PURE__ */ __name((name2, handle2, syms) => {
          var dso = {
            refcount: Infinity,
            name: name2,
            exports: syms,
            global: true
          };
          LDSO.loadedLibsByName[name2] = dso;
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
          } catch (err22) {
            if (!(err22 instanceof RangeError)) {
              throw err22;
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
          } catch (err22) {
            if (!(err22 instanceof TypeError)) {
              throw err22;
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
              return WebAssembly.instantiate(binary, info).then((result2) => postInstantiation(result2.module, result2.instance));
            }
            var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
            var instance = new WebAssembly.Instance(module, info);
            return postInstantiation(module, instance);
          }
          __name(loadModule, "loadModule");
          if (flags.loadAsync) {
            return metadata.neededDynlibs.reduce((chain, dynNeeded) => chain.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
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
          dynamicLibraries.reduce((chain, lib) => chain.then(() => loadDynamicLibrary(lib, {
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
          var now2;
          if (clk_id === 0) {
            now2 = _emscripten_date_now();
          } else if (nowIsMonotonic) {
            now2 = _emscripten_get_now();
          } else {
            return 52;
          }
          var nsec = Math.round(now2 * 1e3 * 1e3);
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
            const message2 = UTF8ToString(messageAddress);
            Module.currentLogCallback(message2, isLexMessage !== 0);
          }
        }
        __name(_tree_sitter_log_callback, "_tree_sitter_log_callback");
        function _tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress) {
          const INPUT_BUFFER_SIZE = 10 * 1024;
          const string = Module.currentParseCallback(index, {
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
          C.currentParseCallback = (index) => callback.slice(index);
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
        const result2 = new Tree(INTERNAL, treeAddress, this.language, C.currentParseCallback);
        C.currentParseCallback = null;
        C.currentLogCallback = null;
        C.currentProgressCallback = null;
        return result2;
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
        const result2 = new Array(count);
        if (count > 0) {
          let address = buffer;
          for (let i2 = 0; i2 < count; i2++) {
            result2[i2] = unmarshalRange(address);
            address += SIZE_OF_RANGE;
          }
          C._free(buffer);
        }
        return result2;
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

// src/db.ts
import { readFileSync as readFileSync2, readdirSync as readdirSync2 } from "node:fs";
import { basename as basename2, join as join3, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as performance2 } from "node:perf_hooks";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/logger.ts
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync as lstatSync2,
  mkdirSync,
  openSync
} from "node:fs";
import { join as join2 } from "node:path";

// src/platform.ts
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep
} from "node:path";
var UnsafeProjectWritePathError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "UnsafeProjectWritePathError";
  }
};
function readClaudePluginMetadata(env = process.env) {
  const root = env["CLAUDE_PLUGIN_ROOT"] ?? null;
  if (!root) {
    return freezePlugin({ root: null, name: "tmb", version: null });
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")
    );
    const name2 = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : "tmb";
    const version = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : null;
    return freezePlugin({ root, name: name2, version });
  } catch {
    return freezePlugin({ root, name: "tmb", version: null });
  }
}
function resolveClaudePluginName(env = process.env) {
  return readClaudePluginMetadata(env).name;
}
function resolveClaudePluginVersion(env = process.env) {
  return readClaudePluginMetadata(env).version;
}
function resolveClaudeProjectRoot(env = process.env) {
  const root = env["CLAUDE_PROJECT_DIR"];
  return root && root.trim().length > 0 ? root : null;
}
function resolveClaudeDbPathForPlugin(pluginName, opts) {
  const { env, cwd, home } = opts;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) return override;
  const projectRoot = resolveClaudeProjectRoot(env);
  const found = findExistingClaudeDbUp(cwd, pluginName, { home, env, projectRoot });
  if (found) return found;
  return claudeDbLocation(projectRoot ?? cwd, pluginName);
}
var CLAUDE_STATE_HOST_DIR = ".claude";
function claudeDbLocation(root, pluginName) {
  return join(root, CLAUDE_STATE_HOST_DIR, pluginName, "trajectory.db");
}
function claudeLogDirFor(trajectoryDb, pluginName) {
  if (trajectoryDb === ":memory:") return join(tmpdir(), `${pluginName}-memory-logs`);
  return join(dirname(trajectoryDb), "logs");
}
function resolveClaudeLogDir(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const pluginName = resolveClaudePluginName(env);
  return claudeLogDirFor(resolveClaudeDbPathForPlugin(pluginName, { env, cwd, home }), pluginName);
}
function assertSafeProjectWritePath(projectRoot, path, label = "Codex writable path", expectedKind = "either") {
  if (!isAbsolute(projectRoot)) {
    throw new UnsafeProjectWritePathError(
      `${label} project root must be an absolute path`
    );
  }
  if (!isAbsolute(path)) {
    throw new UnsafeProjectWritePathError(`${label} must be an absolute path`);
  }
  let rootStat;
  try {
    rootStat = lstatSync(projectRoot);
  } catch {
    throw new UnsafeProjectWritePathError(
      `${label} project root must remain an existing directory`
    );
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new UnsafeProjectWritePathError(
      `${label} project root must remain a real directory`
    );
  }
  const canonicalRoot = realpathSync(projectRoot);
  if (canonicalRoot !== projectRoot) {
    throw new UnsafeProjectWritePathError(
      `${label} project root changed after canonicalization`
    );
  }
  assertPathContained(canonicalRoot, path, label);
  assertExistingAncestorContained(
    canonicalRoot,
    path,
    label,
    expectedKind
  );
}
function probeClaudeDb(path) {
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all();
    return cols.some((c) => c.name === "prompt_bearing") ? "current" : "stale";
  } catch {
    return "error";
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
var CLAUDE_STANDALONE_MARKER = "standalone";
function isStandaloneClaudeDb(dbPath) {
  return existsSync(join(dirname(dbPath), CLAUDE_STANDALONE_MARKER));
}
function walkClaudeDbs(start2, pluginName, opts) {
  const home = opts?.home ?? homedir();
  const probe = opts?.probe ?? probeClaudeDb;
  const found = [];
  for (let dir = start2; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir === home && start2 !== home) break;
    const candidate = claudeDbLocation(dir, pluginName);
    if (!existsSync(candidate) || probe(candidate) === "stale") continue;
    found.push(candidate);
    if (isStandaloneClaudeDb(candidate)) break;
  }
  return { resolved: found.length === 0 ? null : found[found.length - 1], candidates: found };
}
function findExistingClaudeDbUp(startDir, pluginName, opts) {
  const env = opts?.env ?? process.env;
  const override = env["TRAJECTORY_DB_PATH"];
  if (override && override.trim().length > 0) {
    return existsSync(override) ? override : null;
  }
  const projectRoot = opts?.projectRoot !== void 0 ? opts.projectRoot : resolveClaudeProjectRoot(env);
  return walkClaudeDbs(projectRoot ?? startDir, pluginName, opts).resolved;
}
function assertPathContained(root, path, label) {
  const rel = relative(root, path);
  if (rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
    return;
  }
  throw new UnsafeProjectWritePathError(
    `${label} escapes the trusted project root`
  );
}
function assertExistingAncestorContained(root, path, label, expectedKind) {
  const rel = relative(root, path);
  const parts2 = rel === "" ? [] : rel.split(sep);
  let current = root;
  for (let index = 0; index < parts2.length; index += 1) {
    current = join(current, parts2[index]);
    let currentStat;
    try {
      currentStat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (currentStat.isSymbolicLink()) {
      throw new UnsafeProjectWritePathError(
        `${label} contains a symbolic link in writable state`
      );
    }
    if (index === parts2.length - 1) {
      if (expectedKind === "file" && !currentStat.isFile()) {
        throw new UnsafeProjectWritePathError(
          `${label} must be a regular file`
        );
      }
      if (expectedKind === "directory" && !currentStat.isDirectory()) {
        throw new UnsafeProjectWritePathError(
          `${label} must be a directory`
        );
      }
      if (currentStat.isFile() && currentStat.nlink !== 1) {
        throw new UnsafeProjectWritePathError(
          `${label} must not be a multiply linked writable file`
        );
      }
    }
    if (index < parts2.length - 1 && !currentStat.isDirectory()) {
      throw new UnsafeProjectWritePathError(
        `${label} has a non-directory ancestor`
      );
    }
  }
  if (parts2.length > 0) {
    assertPathContained(root, realpathSync(path), label);
  }
}
function freezePlugin(plugin) {
  return Object.freeze(plugin);
}

// src/logger.ts
function createLogger(opts, ensureLogDir, appendLine) {
  let logDirState = "pending";
  const logDirReady = () => {
    if (logDirState === "pending") {
      try {
        ensureLogDir();
        logDirState = "ready";
      } catch {
        logDirState = "failed";
      }
    }
    return logDirState === "ready";
  };
  const serverLogPath = join2(opts.logDir, "mcp-server.log");
  const sqlLogPath = join2(opts.logDir, "sql.log");
  const serverLog2 = (entry) => {
    if (!logDirReady()) return;
    try {
      const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
      appendLine(serverLogPath, line);
    } catch {
    }
  };
  const sqlLog2 = opts.sqlEnabled === true ? (entry) => {
    if (!logDirReady()) return;
    try {
      const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
      appendLine(sqlLogPath, line);
    } catch {
    }
  } : () => {
  };
  return Object.freeze({
    logDir: opts.logDir,
    serverLog: serverLog2,
    serverLogSync: serverLog2,
    sqlLog: sqlLog2
  });
}
var defaultLogger = null;
function getDefaultLogger() {
  if (defaultLogger === null) {
    const logDir = resolveClaudeLogDir();
    defaultLogger = createLogger(
      { logDir, sqlEnabled: process.env["TMB_DEBUG_SQL"] === "1" },
      () => mkdirSync(logDir, { recursive: true }),
      appendFileSync
    );
  }
  return defaultLogger;
}
function serverLog(entry) {
  getDefaultLogger().serverLog(entry);
}
function sqlLog(entry) {
  getDefaultLogger().sqlLog(entry);
}

// src/audit-events.ts
var AUDIT_EVENT_TYPES = [
  { type: "agent_arg_mismatch", writers: ["hook"], description: "`agent-arg-matches-caller` denied a trajectory-server call whose `agent` argument named another role than the caller (the payload's `agent_type`, or bro for the main session); one row per denial on the task's issue when `tool_input` carries a `task_id`, else the system issue `-1`, from_node `hook:agent-arg-matches-caller`; `content_json` carries `tool`, `given`, `actual`, `task_id`. `audit_append` refuses this event" },
  { type: "agent_runs_capture_skipped", writers: ["hook"], description: "`swe-atomic-close` could not bind a SWE spawn to a task (no `task_id=<N>` in the spawn transcript, or no such task) and wrote no `agent_runs` row; filed under the system issue `-1`; `content_json` carries `reason`, `transcript`, `spawn_id`, `task_id`" },
  { type: "agent_runs_backfilled", writers: ["bro"], description: "`agent_runs_backfill` (dry_run false) recovered `agent_runs` rows from archived Claude Code transcripts; one row per run on the system issue `-1`, from_node `bro`; `content_json` is the report: `transcripts_dir`, `transcripts_seen`, `sessions_seen`, `bound`, `unbound` (`count`, `first` \u2014 up to 20 `{path, reason}`), `rows_inserted`, `rows_updated`, `rows_skipped_measured`, `tokens_total_added`" },
  { type: "agent_runs_claimed", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `bro-turn-usage` claimed per-task bro `agent_runs` rows opened without a `session_id` for its session; bro is now metered per session, so nothing writes it and `audit_append` refuses it; `content_json` carries `run_ids`, `session_id`", reserved: true },
  { type: "branch_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_branch_gate`; `content_json` carries the waiver reason" },
  { type: "branch_id_proposed", writers: ["bro"], description: "`intent_start` proposed the issue's feature branch; `content_json` carries `branch_id`, `objective`; the scope and branch gates read it" },
  { type: "bro_verification_fail", writers: ["bro"], description: "Bro task-gate found a V1/V2/V3 check that failed" },
  { type: "bro_verification_pass", writers: ["bro"], description: "Bro task-gate V1/V2/V3 all passed; `content_json` carries `task_id`, `commit_sha`, and from `bro_atomic_close` a `scope` record (`extras_accepted`, `base_moved`, `recorded_base`, `merge_base`) that `task_brief` reads" },
  { type: "cheatcode_activate", writers: ["bro"], description: "`cheatcode_activate` confirmed or failed a cheatcode's load; `content_json` carries the resulting status" },
  { type: "cheatcode_approved", writers: ["bro"], description: "`cheatcode_approve` recorded the Human's install approval; the `cheatcode-install-approval` hook reads it" },
  { type: "cheatcode_healthcheck", writers: ["bro", "server"], description: "`cheatcode_reconcile` (bro) or the server startup reconcile (server) moved a cheatcode's status (e.g. `active` \u2192 `broken`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `from`, `to`" },
  { type: "cheatcode_install", writers: ["bro"], description: "`cheatcode_install` ran the install script; `content_json` carries `method` and the script outcome" },
  { type: "cheatcode_installed", writers: ["bro"], description: "`cheatcode_install` registered the installed cheatcode row; `content_json` carries `cheatcode_id`" },
  { type: "cheatcode_search", writers: ["bro"], description: "`cheatcode_search` finished; `content_json` carries `query`, `kind`, `candidate_count`, and `top` ranked candidates" },
  { type: "cheatcode_uninstalled", writers: ["bro"], description: "`cheatcode_uninstall` removed a cheatcode" },
  { type: "cheatcode_vet", writers: ["bro"], description: "`cheatcode_vet` classified a candidate; `content_json` carries `trust_tier` and the vet signals" },
  { type: "concept_proposal_applied", writers: ["bro"], description: "`scan_run` upserted an L2 concept a closed task proposed in its completion report (`report.concepts`), the task having a passing code-reviewer verdict for its current commit; `verified_by` is `swe`; one row per (task, concept name), on the task's issue, from_node `bro`; `content_json` carries `task_id`, `concept_id`, `name`" },
  { type: "concept_proposal_rejected", writers: ["bro"], description: "`scan_run` gave up on a reviewed task's concept proposal that still failed to upsert (an anchor not in the index, a failing claim) 14 days after the task closed; before that a failing proposal stays pending with no row; one row per (task, concept name), on the task's issue, from_node `bro`; `content_json` carries `task_id`, `name`, `error`" },
  { type: "config_changed", writers: ["bro"], description: "An agent changed a `plugin_config` key through `/onboard`; written by bro via `audit_append`", reserved: true },
  { type: "consultant_spawn_nudged", writers: ["hook"], description: "`prompt-intent-hints` emitted the consultant-spawn nudge; filed under the system issue `-1`" },
  { type: "containment_denied", writers: ["hook"], description: "`containment-guard` denied a write outside the run's root (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `root`, `task_id`" },
  { type: "decision_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_decision_gate`; `content_json` carries the waiver reason" },
  { type: "deep_scan_completed", writers: ["bro"], description: "`scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs`" },
  { type: "effort_ab_enrolled", writers: ["bro"], description: "`task_provision` or `task_create_batch` enrolled a new task in the opt-in swe effort A/B (`plugin_config.swe_effort_ab`, GH 1745): its computed effort was the default or an explicit `medium` and fewer than `target` tasks carried the label, so its effort became the arm of its id's parity (even `high`, odd `medium`) with `effort_reason` `ab_arm`; one row per task on its issue, in the insert's transaction; `content_json` carries `label`, `arm`, `task_id`" },
  { type: "effort_inputs_recorded", writers: ["bro"], description: "`task_provision` or `task_create_batch` recorded, in shadow mode (GH 1904), what the world model knows about the code a new task's spec names in backticks and the effort tier those inputs suggest; the task's effort is unchanged; one row per task on its issue, in the insert's transaction, after any `effort_ab_enrolled` row; `content_json` carries `task_id`, `inputs` (`files_in_scope`, `symbols_named`, `symbols_resolved`, `direct_callers`, `caller_files_outside_scope`, `tables_written`, `outside_table_readers`, `tests_reached`, `enforcement`, `prompt_bearing`, `rework`, `wm_available` \u2014 false with zero world-model counts when the repo has no world model or a lookup failed), `suggested_tier` (`low`, `medium`, `high`), `reason`, `effort` (the effort the task runs at)" },
  { type: "embeddings_degraded", writers: ["server"], description: "The embedding model entered the degraded state \u2014 it could not load, or `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive embed calls failed \u2014 so semantic search falls back to FTS until a timed re-attempt (1 min, 5 min, then every 10 min) succeeds; one row per degraded episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `reason`, `consecutive_failures`" },
  { type: "embeddings_recovered", writers: ["server"], description: "A re-attempt brought the degraded embedding model back, or a process loaded the model healthy while an earlier process left a degraded episode open (`reason` `process_start`, `retries` 0); one row per episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `degraded_since`, `reason`, `retries`" },
  { type: "hook_block_bypassed", writers: ["hook"], description: "`swe-boundary` saw an Edit/Write to a path that a PreToolUse Bash gate had judged as a literal write target and denied in the same session within `TMB_BYPASS_WINDOW_MIN` minutes (default 10); a deny that could not judge its target records no path, so the literal-path write it prescribes is never counted (GH 1750); the write is still allowed (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `denied_gate`, `denied_at`, `session_id`, `task_id`" },
  { type: "hook_denied", writers: ["hook"], description: "`dispatch.sh` returned a deny: a gate's exit 2, `permissionDecision: \"deny\"` or `decision: \"block\"`, or the dispatcher's own fail-closed decision; one row per deny (a replayed duplicate writes none), from_node `hook:dispatch`, on the task's issue else the system issue `-1`; `content_json` carries `hook` (the gate), `rule` (the first 200 characters of the deny reason), `tool`, `agent_type`, `task_id` (the calling swe's run, else `tool_input.task_id`; null when unknown), `cwd` (the payload's). `audit_append` refuses this event" },
  { type: "intent_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_intent_gate`; `content_json` carries the waiver reason" },
  { type: "issue_adopted", writers: ["bro"], description: "`issue_create`, `issue_adopt_remote` or `issue_sync_retry` adopted an existing remote issue as the local issue's twin (`issue_sync_retry`: the issue an earlier lost create made, found by its body marker); `content_json` carries `issue_id`, `backend`, `remote_iid`, plus `via: 'issue_sync_retry'` from that tool" },
  { type: "issue_auto_close_deferred", writers: ["hook"], description: "`close-issue-on-merge` left an issue named by a merged PR's closing-ref open because other tasks of it are still live; `content_json` carries `blocking_task_ids`, `gh_iid`" },
  { type: "issue_auto_close_remote_skipped", writers: ["hook"], description: "`close-issue-on-merge` closed an issue locally but not its GitHub twin because issue sync is off (`plugin_config.issue_sync` unset or `off`, or `TMB_DISABLE_REMOTE_SYNC` set); `content_json` carries `gh_iid`, `reason`" },
  { type: "issue_auto_closed_on_merge", writers: ["hook"], description: "`close-issue-on-merge` closed a local issue named by a merged PR's closing-ref; `content_json` carries `gh_iid`" },
  { type: "issue_close_remote_skipped", writers: ["server"], description: "`issue_close`, `bro_atomic_close` or `task_recover` closed an issue locally but no linked remote because the remote-sync gate is off: `reason` is `issue_sync_off` (`plugin_config.issue_sync` unset or `off`), `env_disabled` (`TMB_DISABLE_REMOTE_SYNC` set) or `no_backend` (no usable gh/glab for the issue repo's remotes); `content_json` carries `reason`, `remotes`" },
  { type: "issue_linked", writers: ["bro"], description: "`issue_link` bound a local issue to a remote issue; `content_json` carries `issue_id`, `backend`, `iid`, `forced`" },
  { type: "issue_updated", writers: ["bro"], description: "bro changed an issue's milestone, labels or objective after creation; the dashboard also writes one per Human write (an edit, a comment or a close), from_node `dashboard`, `content_json` carrying `actor: human`, `source: dashboard`, `tool` (the trajectory-server handler it called) and `fields`" },
  { type: "legacy_event", writers: ["server"], description: "A migration re-typed a legacy audit row: v38 one whose `event_type` was outside the closed set (written by v1.0.x, before the set closed), v39 a swe-written `verification_gate_waived` row without a `commit_sha` that repeated an earlier one for its task; `content_json` keeps the original content and carries `legacy_event_type` (the old type), plus `legacy_content` when the old content was not valid JSON. Filed under the row's original issue; `audit_append` refuses this event" },
  { type: "mcp_unavailable_fallback_invoked", writers: ["bro", "swe", "code-reviewer", "consultant"], description: "The sqlite3 fallback (`scripts/lib/sqlite3-fallback.sh`) wrote in place of an unavailable MCP server; filed under the system issue `-1`" },
  { type: "milestone_closed", writers: ["bro"], description: "`milestone_close` closed a milestone; `content_json` carries `name`, `repo`, `forced`, `open_issues`, `remote_closed`, `remote_results`" },
  { type: "milestone_reconcile_failed", writers: ["bro"], description: "`scan_run` could not read a repo's remote milestones; `content_json` carries `repo`, `backend`, `reason` (the scan still succeeds)" },
  { type: "milestone_seed_skipped", writers: ["bro"], description: "`scan_run` found no milestones and could not seed one; `content_json` carries `repo`, `reason` (`no_version_source` or `reconcile_failed`)" },
  { type: "milestone_seeded", writers: ["bro"], description: "`scan_run` seeded `v<next-patch>` for a repo with no milestones; `content_json` carries `name`, `repo`, `source`, `remote_created`" },
  { type: "milestones_reconciled", writers: ["bro"], description: "`scan_run` imported a repo's remote milestones; `content_json` carries `imported`, `closed`, `repo`" },
  { type: "persona_block_written", writers: ["server"], description: "Legacy type kept for historical rows: in v1.1.0-rc.1 `onboard_apply` copied bro's persona block into the project's `CLAUDE.md`; nothing writes it now and `audit_append` refuses it; `content_json` carries `action` (`appended`, `replaced`), `version`", reserved: true },
  { type: "planning_complete", writers: ["bro"], description: "Bro finished planning: batched `task_create_batch` + SWE spawn" },
  { type: "project_made_standalone", writers: ["bro"], description: "`onboard_apply(standalone=true)` made the session directory, nested below the workspace, its own TMB project: it wrote the `standalone` marker and a fresh trajectory DB in `<session_dir>/.claude/<plugin>/`, which the DB walk-up then picks over the workspace DB; filed under the system issue `-1` in the workspace DB; `content_json` carries `session_dir`, `db_path`, `marker`" },
  { type: "readme_staleness_surfaced", writers: ["hook"], description: "`post-atomic-close-readme` surfaced READMEs a closed task may have left stale" },
  { type: "registry_gate_waived", writers: ["bro"], description: "`task_create_batch` ran with `waive_registry_gate`; `content_json` carries the waiver reason" },
  { type: "remote_id_guard_overrun", writers: ["hook"], description: "`remote-id-guard` killed its analysis at `TMB_REMOTE_ID_GUARD_DEADLINE_S` (default 3 s, inside the 6 s hooks.json timeout) and allowed the Bash command (GH 1821); one row per overrun on the system issue `-1`, from_node `hook:remote-id-guard`; `content_json` carries `deadline_s`, `elapsed_s`" },
  { type: "repo_remotes_migration_skipped", writers: ["server"], description: "The v35 migration could not move a repo's `repos.remotes` JSON into `repo_remotes` \u2014 the value did not parse as an array or a name \u2192 url map, or some entries carried no url or a duplicate name (the rest moved); one row per repo on the system issue `-1`, written by `system`; `content_json` carries `repo`, `reason`, `raw`" },
  { type: "repo_rename_detected", writers: ["bro"], description: "`scan_run` found a discovered repo whose canonical path or primary remote URL matches an existing row under another name; no second row is inserted and the old row is kept until `repo_rename`; filed under the system issue `-1` by `bro`; `content_json` carries `old`, `new`, `by` (`path` or `remote`)" },
  { type: "repo_renamed", writers: ["bro"], description: "`repo_rename` moved a repo to a new name: the `repos` row, its FK children, `pr_review_runs` host slugs and the world-model nodes; filed under the system issue `-1` by `bro` with `repo` = the new name; `content_json` carries `old`, `new`, `reason`, `rows_by_table`, `graph` (`rekeyed`, or `deferred` when the world model was unavailable or the re-key failed \u2014 the next `scan_run` rebuilds), `graph_nodes`, and `graph_error` when the re-key failed" },
  { type: "review_finding_wontfix", writers: ["bro"], description: "`task_reopen(wontfix)` set an open review finding of the task to `wontfix` (the Human accepted it), so the close gate no longer probes it; one row per finding on the task's issue; `content_json` carries `task_id`, `finding_id`, `reason`" },
  { type: "review_findings_carried", writers: ["bro"], description: "`task_retry` copied the failed task's open review findings onto the retry task as `F<new_task_id>-<n>`; one row per retry that carried at least one; `content_json` carries `from_task_id`, `to_task_id`, `findings` (`from`, `id`)" },
  { type: "review_gate_bypassed", writers: ["bro", "hook"], description: "A task reached `closed` by a path other than `bro_atomic_close` (`close-issue-on-merge`, `task_recover`, `task_update_status`) with no passing code-reviewer verdict for its current commit; the task still closes. At most one row per task and commit (none when a `review_gate_waived` row already names them); `content_json` carries `task_id`, `commit_sha`, `closed_by`. A verdict counts as passing when `verdict = 'pass'` and its `created_at` is at or after the earliest `bro_verification_pass` row naming the task and its current `commit_sha`" },
  { type: "review_gate_waived", writers: ["bro"], description: "`issue_close(waive_review: true)` closed an issue over a closed task with no passing code-reviewer verdict for its current commit; one row per such task; `content_json` carries `skill`, `task_id`, `commit_sha`, `waive_review_reason`" },
  { type: "reviewer_identity_observed", writers: ["hook"], description: "`reviewer-identity-observe` saw a code-reviewer subagent call `validation_record` (the payload carried `agent_id` and an `agent_type` that normalises to `code-reviewer`); one row per call on the task's issue, from_node `hook:reviewer-identity-observe`; `content_json` carries `task_id`, `attempt_n`, `session_id`, `agent_id`, `tool_use_id` (null when the payload has none), `observed_at`, `consumed` (0 until `validation_record` stamps `subagent_session_id` and `reviewer_agent_id` from it and sets 1; a row observed more than 600 s before the call is never consumed), and `superseded`, `superseded_by`, `superseded_at` (set when `validation_record` consumes a newer row for the same `(task_id, attempt_n)`: every older unconsumed row gets `superseded` 1, the audit id of the consumed row and the time; a superseded row is never consumed). `audit_append` refuses this event" },
  { type: "roundtable_slash_invoked", writers: ["hook"], description: "`roundtable-slash-detect` saw the Human type `/roundtable`; `roundtable_create` consumes the row" },
  { type: "roundtable_summary", writers: ["bro"], description: "Bro recorded a roundtable's outcome summary via `audit_append`; `roundtable-cleanup-postcheck` requires it", reserved: true },
  { type: "scan_discovered", writers: ["server", "hook"], description: "A scan registered a newly discovered cheatcode (`scan_run`, or `scan.sh` as `hook:scan`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `origin`, `source`" },
  { type: "scan_discovered_repair", writers: ["server"], description: "The v32 migration deleted `scan_discovered` rows whose `(name, kind)` has no `cheatcodes` row; filed under the system issue `-1` by `system`; `content_json` carries `deleted`" },
  { type: "scan_skipped", writers: ["hook"], description: "`scan.sh` left a git repo below the session dir out of the scan; one row per path and reason (a re-scan that skips it again writes none), filed under the system issue `-1` as `hook:scan`; `content_json` carries `path`, `reason` (`dot_dir`: a dot-prefixed path segment below the session dir; `git_ignored`: an enclosing repo ignores it; `no_commits`: it has no commit)" },
  { type: "scope_gate_waived", writers: ["bro"], description: "`bro_atomic_close(waive_scope_gate: true)` accepted the task's changed paths outside its `files[]` with a `scope_waiver_reason`; `content_json` carries `skill`, `task_id`, `commit_sha`, `accepted_paths`, `reason`, `base_moved`, `recorded_base`, `merge_base`. `task_create_batch(waive_scope_gate: true)` writes one when it skips its question gate, `content_json` carrying `waive_scope_gate_reason`, `tasks_created`" },
  { type: "skill_creator_blocked", writers: ["bro"], description: "`tmb_skill-creator` halted before writing the skill (no Human approval); written by bro via `audit_append`", reserved: true },
  { type: "spec_shape_gate_waived", writers: ["bro"], description: "A task's spec-shape waiver, one row per task on its issue with from_node `bro`; `task_create_batch` and `task_provision` called with `waive_spec_shape` write one for every task they create, and bro records one for an existing task through `audit_append`; `content_json` carries `task_id`, `gate` (`spec_shape`), `reason`, `waived_by` (`bro`), `source` (`task_create_batch`, `task_provision`, or absent for `audit_append`); `require-task-spec` reads it as the spawn waiver" },
  { type: "stray_db_removed", writers: ["bro"], description: "`onboard_apply(remove_stray_dbs)` deleted an empty trajectory DB (0 issues, 0 tasks) below the project root, with its `-wal`/`-shm` files and its state dir, on the Human's yes; one row per DB on the system issue `-1`; `content_json` carries `path`, `state_dir`, `project_root`" },
  { type: "swe_atomic_close_auto_completed", writers: ["hook"], description: "`swe-atomic-close` auto-completed a `pending`/`running` task on SubagentStop because its worktree HEAD is neither equal to nor an ancestor of any parent tip (local or origin); one row per auto-complete on the task's issue, written in the same transaction as the status change; `content_json` carries `task_id`, `commit_sha`, `parent_tip_local`, `parent_tip_origin` (null when that ref is absent)" },
  { type: "swe_brief_fetched", writers: ["swe"], description: "`task_brief` recorded that a SWE fetched its brief (one row per task); swe-brief-gate reads it" },
  { type: "swe_resume_observed", writers: ["hook"], description: "`swe-brief-gate` saw a swe call `task_brief` with an `agent_id` whose `agent_runs` rows for the task are all closed: a swe resumed through SendMessage (GH 1742); one row per such call on the task's issue, from_node `hook:swe-brief-gate`; `content_json` carries `task_id`, `agent_id`, `observed_at`, `consumed` (0 until `task_brief`'s `openSweRun` opens the resumed run's row from it, with `resumed_from` its previous row, and sets 1; a row observed more than 600 s before the call is never consumed). `audit_append` refuses this event" },
  { type: "sync_skipped", writers: ["bro"], description: "Issue sync skipped a remote write because `issue_sync` is off; `content_json` carries `issue_id`, `reason`" },
  { type: "task_effort_raised", writers: ["bro"], description: "`task_reopen` or `task_retry` called with an `effort` above the task's (for `task_retry`, the failed task's) raised the effort swe runs it at, as does either call made with no `effort` (rework computes `high`); one row per raise on the task's issue; `content_json` carries `task_id`, `from`, `to`, and `failed_task_id` from `task_retry`" },
  { type: "task_escalated_by_issue_close", writers: ["bro"], description: "`issue_close(cascade: true)` escalated a live task (`pending`/`running`/`needs_validation`/`completed`) of the issue it closed and closed its open `agent_runs` rows as `issue_closed`; one row per task; `content_json` carries `task_id`, `from_status`, `reason`" },
  { type: "task_escalated_repair", writers: ["server"], description: "The v33 migration escalated a task still `pending`/`running`/`needs_validation`/`completed` whose issue was already `closed` and closed its open `agent_runs` rows as `issue_closed`; written by `system`; `content_json` carries `task_id`, `issue_id`, `from_status`" },
  { type: "task_overrun_alerted", writers: ["hook"], description: "`task-overrun-alert` told bro that a `running` task passed `TMB_TASK_OVERRUN_MIN` minutes (default 60) since its `created_at`; one row per task, ever (the once-marker), on the task's issue, from_node `hook:task-overrun-alert`; `content_json` carries `task_id`, `minutes`, `attempts` (swe spawns), `blocker` (the first line of the latest FAIL feedback, else the status)" },
  { type: "task_recovered", writers: ["bro"], description: "`task_recover` closed a task stuck in `running`/`completed` at its commit; `content_json` carries `task_id`, `commit_sha`, `prior_status`" },
  { type: "task_reopened", writers: ["bro"], description: "`task_reopen` moved a `pending` / `closed` / `failed` / `escalated` / `running` task back to `running` for rework; `content_json` carries `task_id`, `from_status`, `reason`, `files_add`, `verification_add`" },
  { type: "task_retry_attempted", writers: ["bro"], description: "`task_retry` created a retry task for a failed one; `content_json` carries `failed_task_id`, `new_task_id`, `new_branch_id`" },
  { type: "task_spec_amended", writers: ["bro"], description: "`task_update_spec` replaced a live task's `files` / `verification` / `spec_body`; `content_json` carries `task_id`, `status`, `reason`, `changes`" },
  { type: "task_stale_swept", writers: ["bro"], description: "`task_recover` moved a `running` task with no open swe `agent_runs` row and no update for `TMB_STALE_RUNNING_HOURS` (default 6) to `failed` and closed its open runs as `swept_stale`; `content_json` carries `task_id`, `from_status`, `last_updated_at`, `stale_after_hours`" },
  { type: "tmb_agent_created", writers: ["server", "bro"], description: "`agent_register` registered a project-local consultant; `content_json` carries `name`, `mode`, `agent_id`" },
  { type: "tmb_branch_autocreated", writers: ["bro"], description: "`task_create_batch` created the task's feature branch ref" },
  { type: "tmb_skill_created", writers: ["bro"], description: "`tmb_skill-creator` landed a new skill; written by bro via `audit_append`", reserved: true },
  { type: "trajectory_doctor_run", writers: ["bro"], description: "`trajectory_doctor(record: true)` checked the trajectory DB against its data contracts (`mcp/trajectory-server/src/data-contracts.ts`); filed under the system issue `-1` by `bro`; `content_json` is the report: `healthy`, `checked_at`, `schema` (`stored`, `required`, `current`), `violations` (`id`, `severity`, `description`, `actual`, `expected`, `sample`), `skipped` (`id`, `reason`), `embeddings` (the server's `embeddingStatus()`: `state`, `since`, `reason`, `consecutive_failures`, `next_retry_at`)" },
  { type: "validation_session_unverified", writers: ["server"], description: "`validation_record` recorded an honor-system verdict (`mcp_available: false`) with no `reviewer_identity_observed` row, so `subagent_session_id` is the caller's unverified value and `reviewer_agent_id` is NULL; on the task's issue, from_node `trajectory-server`; `content_json` carries `task_id`, `attempt_n`, `subagent_session_id`" },
  { type: "verification_gate_waived", writers: ["hook"], description: "`swe-verification-gate` honoured a SWE's `waive_verification_gate_reason`; at most one row per task and commit; `content_json` carries `task_id`, `commit_sha`, `waiver_reason`" },
  { type: "wm_tool_called", writers: ["server"], description: "A world-model tool (`world_model_get`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get`, `world_model_concept_upsert`) answered a call, error results included; one row per call, from_node the `agent` argument, on the task's issue when exactly one open `agent_runs` row has the caller's role as `agent_type`, else the system issue `-1`; `content_json` carries `tool`, `agent`, `task_id`, `args` (only the present `query`, `path`, `id`, `qualified_name`, `name`, `mode`, `depth`, `repo`, `k`), `result_count`, `empty`, `error`, `warning`, `match`, `derived`, `latency_ms`. `audit_append` refuses this event" }
];
var KNOWN = new Set(AUDIT_EVENT_TYPES.map((e) => e.type));
var WRITERS = new Map(AUDIT_EVENT_TYPES.map((e) => [e.type, e.writers]));
function isAuditEventType(value) {
  return typeof value === "string" && KNOWN.has(value);
}
function auditEventWriters(type) {
  return WRITERS.get(type) ?? [];
}
function isAuditEventWritableBy(type, writer) {
  return auditEventWriters(type).includes(writer);
}
function assertAuditEventType(value) {
  if (isAuditEventType(value)) return value;
  throw new Error(
    `unknown audit event_type '${String(value)}'. Allowed: ${AUDIT_EVENT_TYPES.map((e) => e.type).join(", ")}`
  );
}

// src/utils/classify-url.ts
function extractHost(url) {
  const scpMatch = url.match(/^[^@]+@([^:/]+)[:/]/);
  if (scpMatch) return scpMatch[1].toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return parsed.hostname.toLowerCase();
  } catch {
  }
  return null;
}
function classifyHost(host) {
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || /(?:^|\.)gitlab\./i.test(host)) return "gitlab";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "bitbucket";
  if (host === "codeberg.org" || host.endsWith(".codeberg.org")) return "codeberg";
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) return "azuredev";
  return "other";
}
function classifyUrl(url) {
  const host = extractHost(url);
  if (!host) return "other";
  return classifyHost(host);
}

// src/repos/remotes.ts
function remoteProvider(url, declared) {
  const fromHost = classifyUrl(url);
  if (fromHost === "github" || fromHost === "gitlab") return fromHost;
  if (declared === "github" || declared === "gitlab") return declared;
  return "other";
}
function primaryIndex(remotes) {
  if (remotes.length === 0) return -1;
  const origin = remotes.findIndex((r) => r.name === "origin");
  return origin >= 0 ? origin : 0;
}
function parseLegacyRemotes(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e.message}` };
  }
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed.map(
      (e) => e !== null && typeof e === "object" ? {
        name: e["name"],
        url: e["url"],
        provider: e["provider"]
      } : { name: void 0, url: void 0, provider: void 0 }
    );
  } else if (parsed !== null && typeof parsed === "object") {
    entries = Object.entries(parsed).map(([name2, url]) => ({ name: name2, url, provider: void 0 }));
  } else {
    return { ok: false, reason: `expected an array or an object, got ${parsed === null ? "null" : typeof parsed}` };
  }
  const remotes = [];
  const seen = /* @__PURE__ */ new Set();
  let dropped = 0;
  entries.forEach((e, i2) => {
    if (typeof e.url !== "string") {
      dropped++;
      return;
    }
    const name2 = typeof e.name === "string" && e.name.trim() !== "" ? e.name.trim() : i2 === 0 ? "origin" : `remote-${i2}`;
    if (seen.has(name2)) {
      dropped++;
      return;
    }
    seen.add(name2);
    remotes.push({ name: name2, url: e.url.trim(), provider: typeof e.provider === "string" ? e.provider : null });
  });
  return { ok: true, entries: remotes, dropped };
}
function toRemote(r) {
  return { name: r.name, provider: r.provider, url: r.url, is_primary: r.is_primary === 1, sync: r.sync === 1 };
}
function repoRemotes(db, repo) {
  return db.all(
    `SELECT name, provider, url, is_primary, sync FROM repo_remotes WHERE repo = ? ORDER BY is_primary DESC, rowid`,
    [repo]
  ).map(toRemote);
}
function syncRemotes(db, repo) {
  return db.all(
    `SELECT name, provider, url, is_primary, sync FROM repo_remotes WHERE repo = ? AND sync = 1 ORDER BY is_primary DESC, rowid`,
    [repo]
  ).map(toRemote);
}
function upsertRepoRemotes(db, repo, remotes) {
  const unique = [];
  const seen = /* @__PURE__ */ new Set();
  for (const r of remotes) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    unique.push(r);
  }
  const primary = primaryIndex(unique);
  const names = JSON.stringify(unique.map((r) => r.name));
  const existing = new Set(
    db.all(`SELECT name FROM repo_remotes WHERE repo = ?`, [repo]).map((r) => r.name)
  );
  const dropped = db.all(
    `SELECT url, sync FROM repo_remotes WHERE repo = ? AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
    [repo, names]
  );
  db.run(`DELETE FROM repo_remotes WHERE repo = ? AND name NOT IN (SELECT value FROM json_each(?))`, [repo, names]);
  unique.forEach((r, i2) => {
    const isPrimary = i2 === primary ? 1 : 0;
    let sync = isPrimary;
    if (!existing.has(r.name)) {
      const renamedFrom = dropped.findIndex((d) => d.url === r.url);
      if (renamedFrom >= 0) {
        sync = dropped[renamedFrom].sync;
        dropped.splice(renamedFrom, 1);
      }
    }
    db.run(
      `INSERT INTO repo_remotes (repo, name, provider, url, is_primary, sync) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, name) DO UPDATE SET provider = excluded.provider, url = excluded.url, is_primary = excluded.is_primary`,
      [repo, r.name, remoteProvider(r.url, r.provider), r.url, isPrimary, sync]
    );
  });
}

// src/db.ts
var TARGET_SCHEMA_VERSION = 51;
var BUSY_TIMEOUT_MS = 5e3;
function resolvePluginName(env = process.env) {
  return resolveClaudePluginName(env);
}
function resolvePluginVersion(env = process.env) {
  return resolveClaudePluginVersion(env);
}
var TrajectoryDB = class {
  db;
  pluginVersion;
  serverLog;
  sqlLog;
  migrate;
  dbPath;
  /**
   * True when the DB opened with user tables present but NO plugin_meta table
   * (a pre-stamp legacy shape that predates schema versioning). Such a DB is
   * adopted forward (its tables are kept; the schema is reapplied) rather than
   * treated as a clean fresh install — but the ambiguity is surfaced as a
   * degraded signal so the upgrade is not silent. Non-fatal.
   */
  legacyNoPluginMeta = false;
  constructor(dbPath, dependencies, options = {}) {
    const resolvedDependencies = resolveDependencies(dependencies);
    this.dbPath = dbPath;
    this.pluginVersion = resolvedDependencies.pluginVersion;
    this.serverLog = resolvedDependencies.serverLog;
    this.sqlLog = resolvedDependencies.sqlLog;
    this.migrate = options.migrate === true;
    if (dbPath !== ":memory:" && resolvedDependencies.trustedProjectRoot !== void 0) {
      assertSafeProjectWritePath(
        resolvedDependencies.trustedProjectRoot,
        dbPath,
        "Trajectory database",
        "file"
      );
    }
    this.db = new DatabaseSync2(dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (!this.migrate) this.refuseUnsupportedVersionBeforeWrite();
      execRetryingLockUpgrade(this.db, "PRAGMA journal_mode = WAL");
      this.legacyNoPluginMeta = this.applySchema();
    } catch (error) {
      try {
        this.db.close();
      } catch {
      }
      throw error;
    }
  }
  /**
   * A non-migrating opener refuses an older or newer schema before anything
   * writes: the WAL switch rewrites the header of a rollback-journal DB, so
   * the version is read first and the refusal leaves the file byte-identical.
   * applySchemaLocked repeats the check under the write lock.
   */
  refuseUnsupportedVersionBeforeWrite() {
    const pluginMetaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'").get();
    if (pluginMetaExists === void 0) return;
    const versionRow = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
    if (versionRow !== void 0) assertOpenableVersion(versionRow.schema_version, false);
  }
  /**
   * Applies schema.sql, migrating first when the stored version is behind, and
   * stamps the plugin version — all under one BEGIN IMMEDIATE so concurrent
   * cold starts serialise: the first process migrates, the rest re-read the
   * version inside the lock and find it current. Table-rebuild migrations need
   * foreign_keys OFF, and the pragma is a no-op inside a transaction, so it is
   * switched off around the lock (the Django SQLite schema-editor pattern);
   * each rebuild still runs its own foreign_key_check before it is released.
   */
  applySchema() {
    const schemaDir = dirname2(fileURLToPath(import.meta.url));
    const sql = readFileSync2(join3(schemaDir, "schema.sql"), "utf8");
    this.db.exec("PRAGMA foreign_keys = OFF");
    let outcome;
    try {
      outcome = withImmediateTransaction(this.db, () => {
        const applied = this.applySchemaLocked(sql, schemaDir);
        this.syncPluginVersion();
        this.syncBuiltinVersions();
        return applied;
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    if (outcome.migratedFrom !== null) {
      this.serverLog({
        kind: "schema_migrated",
        level: "info",
        db_path: this.dbPath,
        from_version: outcome.migratedFrom,
        to_version: TARGET_SCHEMA_VERSION
      });
    }
    return outcome.isLegacy;
  }
  applySchemaLocked(sql, schemaDir) {
    const applyEvalIfNeeded = () => {
      if (process.env["TMB_EVAL_MODE"] === "1") {
        const evalSql = readFileSync2(join3(schemaDir, "schema-eval.sql"), "utf8");
        this.db.exec(evalSql);
      }
    };
    const verifySeed = () => {
      const row = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
      if (row === void 0) {
        throw new Error(
          "TrajectoryDB: schema applied but plugin_meta has no rows \u2014 verify schema.sql seeds it."
        );
      }
    };
    const pluginMetaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'").get();
    if (pluginMetaExists === void 0) {
      const userTableCount = this.db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).get();
      const isLegacy = userTableCount.n > 0;
      if (isLegacy) {
        this.serverLog({
          kind: "legacy_db_no_plugin_meta",
          level: "warn",
          db_path: this.dbPath,
          existing_tables: userTableCount.n,
          message: "TrajectoryDB: opened a DB with tables but no plugin_meta row (pre-stamp legacy shape). Adopting it forward and stamping schema_version \u2014 verify the upgrade and back up if unsure."
        });
      }
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy, migratedFrom: null };
    }
    const versionRow = this.db.prepare("SELECT schema_version FROM plugin_meta LIMIT 1").get();
    if (versionRow === void 0) {
      this.db.exec(sql);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy: false, migratedFrom: null };
    }
    const storedVersion = versionRow.schema_version;
    assertOpenableVersion(storedVersion, this.migrate);
    if (storedVersion < TARGET_SCHEMA_VERSION) {
      backupDbBeforeMigration(this.dbPath, TARGET_SCHEMA_VERSION);
      runMigrations(this.db, storedVersion, TARGET_SCHEMA_VERSION);
      this.db.exec(sql);
      this.db.prepare("UPDATE plugin_meta SET schema_version = ? WHERE id = 1").run(TARGET_SCHEMA_VERSION);
      applyEvalIfNeeded();
      verifySeed();
      return { isLegacy: false, migratedFrom: storedVersion };
    }
    this.db.exec(sql);
    applyEvalIfNeeded();
    verifySeed();
    return { isLegacy: false, migratedFrom: null };
  }
  /**
   * Runs inside applySchema's BEGIN IMMEDIATE, so the write lock is already
   * held (acquired under busy_timeout) and the UPDATE cannot hit SQLITE_BUSY.
   * Any failure is logged and fails the open rather than passing as success.
   */
  syncPluginVersion() {
    if (!this.pluginVersion) return;
    this.runVersionSync("plugin_meta", `UPDATE plugin_meta SET plugin_version = ? WHERE id = 1`);
  }
  /**
   * Backfill the builtin cheatcodes' `version` to the plugin version (#111).
   * The schema-seed (schema.sql) and the v19→v20 migration both insert builtin
   * skill rows with version NULL — the SKILL.md body is the source of truth, but
   * the registry row should still record which plugin version shipped it so
   * cheatcode_list surfaces a version for every row. Runs every startup against
   * the resolved plugin version; a no-op when the version is unresolvable.
   */
  syncBuiltinVersions() {
    if (!this.pluginVersion) return;
    this.runVersionSync("cheatcodes", `UPDATE cheatcodes SET version = ? WHERE origin = 'builtin'`);
  }
  runVersionSync(target, sql) {
    try {
      this.db.prepare(sql).run(this.pluginVersion);
    } catch (err3) {
      this.serverLog({
        kind: "plugin_version_sync_failed",
        level: "error",
        db_path: this.dbPath,
        target,
        plugin_version: this.pluginVersion,
        message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  run(sql, params) {
    const start2 = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const result2 = stmt.run(...params ?? []);
      const out2 = { changes: Number(result2.changes), lastInsertRowid: result2.lastInsertRowid };
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        rows_affected: out2.changes,
        ok: true
      });
      return out2;
    } catch (err3) {
      this.sqlLog({
        kind: "run",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  get(sql, params) {
    const start2 = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params ?? []);
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        row_count: row === void 0 ? 0 : 1,
        ok: true
      });
      return row;
    } catch (err3) {
      this.sqlLog({
        kind: "get",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  all(sql, params) {
    const start2 = performance2.now();
    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params ?? []);
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        row_count: rows.length,
        ok: true
      });
      return rows;
    } catch (err3) {
      this.sqlLog({
        kind: "all",
        sql,
        params: params ?? [],
        duration_ms: Math.round(performance2.now() - start2),
        ok: false,
        error_message: err3 instanceof Error ? err3.message : String(err3)
      });
      throw err3;
    }
  }
  /**
   * Wraps `fn` in a BEGIN IMMEDIATE transaction (a SAVEPOINT when nested).
   * node:sqlite has no `db.transaction(fn)` helper, so BEGIN/COMMIT/ROLLBACK
   * are issued explicitly.
   */
  transaction(fn) {
    return withImmediateTransaction(this.db, fn);
  }
  get isOpen() {
    return this.db.isOpen;
  }
  close() {
    this.db.close();
  }
};
function resolveDependencies(dependencies) {
  if (dependencies === void 0) {
    return {
      pluginVersion: resolvePluginVersion(process.env),
      serverLog: noThrowTrajectoryLog(serverLog),
      sqlLog: noThrowTrajectoryLog(sqlLog)
    };
  }
  if (dependencies.pluginVersion !== null && (typeof dependencies.pluginVersion !== "string" || dependencies.pluginVersion.trim().length === 0)) {
    throw new TypeError(
      "TrajectoryDB dependencies.pluginVersion must be a non-empty string or null"
    );
  }
  if (typeof dependencies.serverLog !== "function") {
    throw new TypeError("TrajectoryDB dependencies.serverLog must be a function");
  }
  if (typeof dependencies.sqlLog !== "function") {
    throw new TypeError("TrajectoryDB dependencies.sqlLog must be a function");
  }
  return {
    pluginVersion: dependencies.pluginVersion,
    serverLog: noThrowTrajectoryLog(dependencies.serverLog),
    sqlLog: noThrowTrajectoryLog(dependencies.sqlLog),
    trustedProjectRoot: dependencies.trustedProjectRoot
  };
}
function noThrowTrajectoryLog(log) {
  return (entry) => {
    try {
      log(entry);
    } catch {
    }
  };
}
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var transactionDepth = /* @__PURE__ */ new WeakMap();
var SQLITE_BUSY = 5;
var backoffCell = new Int32Array(new SharedArrayBuffer(4));
function isBusyError(err3) {
  if (!(err3 instanceof Error)) return false;
  const errcode = err3.errcode;
  return typeof errcode === "number" && (errcode & 255) === SQLITE_BUSY || err3.message.includes("database is locked");
}
function assertOpenableVersion(storedVersion, migrate) {
  if (storedVersion > TARGET_SCHEMA_VERSION) {
    throw new Error(
      `TrajectoryDB: stored schema_version ${storedVersion} is newer than code's max ${TARGET_SCHEMA_VERSION}; downgrade not supported. Use a newer plugin version, or restore the .bak file from before the upgrade.`
    );
  }
  if (storedVersion < TARGET_SCHEMA_VERSION && !migrate) {
    throw new Error(
      `TrajectoryDB: schema v${storedVersion} is older than this code's v${TARGET_SCHEMA_VERSION}; only the trajectory-server migrates the DB. Open a Claude Code session to upgrade it, or point TRAJECTORY_DB_PATH at a copy.`
    );
  }
}
function execRetryingLockUpgrade(db, sql) {
  const deadline = performance2.now() + BUSY_TIMEOUT_MS;
  for (; ; ) {
    try {
      db.exec(sql);
      return;
    } catch (err3) {
      if (!isBusyError(err3) || performance2.now() >= deadline) throw err3;
      Atomics.wait(backoffCell, 0, 0, 5 + Math.random() * 45);
    }
  }
}
function beginImmediate(db) {
  const depth = transactionDepth.get(db) ?? 0;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT tmb_tx_${depth}`);
  transactionDepth.set(db, depth + 1);
}
function commitTransaction(db) {
  const depth = (transactionDepth.get(db) ?? 1) - 1;
  db.exec(depth === 0 ? "COMMIT" : `RELEASE tmb_tx_${depth}`);
  transactionDepth.set(db, depth);
}
function rollbackTransaction(db) {
  const depth = (transactionDepth.get(db) ?? 1) - 1;
  transactionDepth.set(db, depth);
  db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO tmb_tx_${depth}; RELEASE tmb_tx_${depth}`);
}
function withImmediateTransaction(db, fn) {
  beginImmediate(db);
  try {
    const result2 = fn();
    commitTransaction(db);
    return result2;
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function backupDbBeforeMigration(dbPath, targetVersion) {
  if (!dbPath || dbPath === ":memory:") return;
  const dir = dirname2(dbPath);
  const base = basename2(dbPath);
  const prefix = `${base}.pre-v${targetVersion}.`;
  try {
    const existing = readdirSync2(dir).some(
      (f) => f.startsWith(prefix) && f.endsWith(".bak")
    );
    if (existing) return;
  } catch {
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-v${targetVersion}.${timestamp}.bak`;
  const snapshot = new DatabaseSync2(dbPath);
  try {
    snapshot.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    snapshot.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    snapshot.close();
  }
}
function runMigrations(db, fromVersion, toVersion) {
  if (fromVersion < 2 && toVersion >= 2) {
    migrateV1toV2(db);
  }
  if (fromVersion < 3 && toVersion >= 3) {
    migrateV2toV3(db);
  }
  if (fromVersion < 4 && toVersion >= 4) {
    migrateV3toV4(db);
  }
  if (fromVersion < 5 && toVersion >= 5) {
    migrateV4toV5(db);
  }
  if (fromVersion < 6 && toVersion >= 6) {
    migrateV5toV6(db);
  }
  if (fromVersion < 7 && toVersion >= 7) {
    migrateV6toV7(db);
  }
  if (fromVersion < 8 && toVersion >= 8) {
    migrateV7toV8(db);
  }
  if (fromVersion < 9 && toVersion >= 9) {
    migrateV8toV9(db);
  }
  if (fromVersion < 10 && toVersion >= 10) {
    migrateV9toV10(db);
  }
  if (fromVersion < 11 && toVersion >= 11) {
    migrateV10toV11(db);
  }
  if (fromVersion < 12 && toVersion >= 12) {
    migrateV11toV12(db);
  }
  if (fromVersion < 13 && toVersion >= 13) {
    migrateV12toV13(db);
  }
  if (fromVersion < 14 && toVersion >= 14) {
    migrateV13toV14(db);
  }
  if (fromVersion < 15 && toVersion >= 15) {
    migrateV14toV15(db);
  }
  if (fromVersion < 16 && toVersion >= 16) {
    migrateV15toV16(db);
  }
  if (fromVersion < 17 && toVersion >= 17) {
    migrateV16toV17(db);
  }
  if (fromVersion < 18 && toVersion >= 18) {
    migrateV17toV18(db);
  }
  if (fromVersion < 19 && toVersion >= 19) {
    migrateV18toV19(db);
  }
  if (fromVersion < 20 && toVersion >= 20) {
    migrateV19toV20(db);
  }
  if (fromVersion < 21 && toVersion >= 21) {
    migrateV20toV21(db);
  }
  if (fromVersion < 22 && toVersion >= 22) {
    migrateV21toV22(db);
  }
  if (fromVersion < 23 && toVersion >= 23) {
    migrateV22toV23(db);
  }
  if (fromVersion < 24 && toVersion >= 24) {
    migrateV23toV24(db);
  }
  if (fromVersion < 25 && toVersion >= 25) {
    migrateV24toV25(db);
  }
  if (fromVersion < 26 && toVersion >= 26) {
    migrateV25toV26(db);
  }
  if (fromVersion < 27 && toVersion >= 27) {
    migrateV26toV27(db);
  }
  if (fromVersion < 28 && toVersion >= 28) {
    migrateV27toV28(db);
  }
  if (fromVersion < 29 && toVersion >= 29) {
    migrateV28toV29(db);
  }
  if (fromVersion < 30 && toVersion >= 30) {
    migrateV29toV30(db);
  }
  if (fromVersion < 31 && toVersion >= 31) {
    migrateV30toV31(db);
  }
  if (fromVersion < 32 && toVersion >= 32) {
    migrateV31toV32(db);
  }
  if (fromVersion < 33 && toVersion >= 33) {
    migrateV32toV33(db);
  }
  if (fromVersion < 34 && toVersion >= 34) {
    migrateV33toV34(db);
  }
  if (fromVersion < 35 && toVersion >= 35) {
    migrateV34toV35(db);
  }
  if (fromVersion < 36 && toVersion >= 36) {
    migrateV35toV36(db);
  }
  if (fromVersion < 37 && toVersion >= 37) {
    migrateV36toV37(db);
  }
  if (fromVersion < 38 && toVersion >= 38) {
    migrateV37toV38(db);
  }
  if (fromVersion < 39 && toVersion >= 39) {
    migrateV38toV39(db);
  }
  if (fromVersion < 40 && toVersion >= 40) {
    migrateV39toV40(db);
  }
  if (fromVersion < 41 && toVersion >= 41) {
    migrateV40toV41(db);
  }
  if (fromVersion < 42 && toVersion >= 42) {
    migrateV41toV42(db);
  }
  if (fromVersion < 43 && toVersion >= 43) {
    migrateV42toV43(db);
  }
  if (fromVersion < 44 && toVersion >= 44) {
    migrateV43toV44(db);
  }
  if (fromVersion < 45 && toVersion >= 45) {
    migrateV44toV45(db);
  }
  if (fromVersion < 46 && toVersion >= 46) {
    migrateV45toV46(db);
  }
  if (fromVersion < 47 && toVersion >= 47) {
    migrateV46toV47(db);
  }
  if (fromVersion < 48 && toVersion >= 48) {
    migrateV47toV48(db);
  }
  if (fromVersion < 49 && toVersion >= 49) {
    migrateV48toV49(db);
  }
  if (fromVersion < 50 && toVersion >= 50) {
    migrateV49toV50(db);
  }
  if (fromVersion < 51 && toVersion >= 51) {
    migrateV50toV51(db);
  }
}
function deleteBuiltinCheatcodeAttachments(db, name2) {
  if (!tableExists(db, "cheatcode_attachments")) return;
  db.prepare(
    // LINT-ALLOW: mirrors the ON DELETE CASCADE that foreign_keys OFF suppresses during migration (GH 1624).
    `DELETE FROM cheatcode_attachments
      WHERE cheatcode_id IN (SELECT id FROM cheatcodes WHERE name = ? AND origin = 'builtin')`
  ).run(name2);
}
function hasColumn(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}
function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== void 0;
}
function readTableSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row?.sql ?? "";
}
function rebuildTable(db, table, createBody, columns) {
  const scratch = `${table}_new`;
  const select = columns.map(([name2, fallback]) => hasColumn(db, table, name2) ? name2 : `${fallback} AS ${name2}`).join(", ");
  const seqRow = tableExists(db, "sqlite_sequence") ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) : void 0;
  db.exec(`DROP TABLE IF EXISTS ${scratch}`);
  db.exec(`CREATE TABLE ${scratch} (${createBody})`);
  db.exec(
    `INSERT INTO ${scratch} (${columns.map(([name2]) => name2).join(", ")}) SELECT ${select} FROM ${table}`
  );
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO ${table}`);
  if (seqRow !== void 0) {
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(seqRow.seq, table);
  }
}
function migrateV8toV9(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "cache_read_tokens")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(db, "agent_runs", "cache_creation_tokens")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
      }
    }
    if (tableExists(db, "pr_review_runs")) {
      if (!hasColumn(db, "pr_review_runs", "task_id")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
      }
      if (!hasColumn(db, "pr_review_runs", "verdict")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN verdict TEXT");
      }
      if (!hasColumn(db, "pr_review_runs", "attempt_n")) {
        db.exec("ALTER TABLE pr_review_runs ADD COLUMN attempt_n INTEGER");
      }
      db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_pr");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo) WHERE pr_number > 0"
      );
      const taskIdxExists = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pr_review_runs_task'").get();
      if (!taskIdxExists) {
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)"
        );
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV9toV10(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      if (!hasColumn(db, "tasks", "prompt_bearing")) {
        db.exec("ALTER TABLE tasks ADD COLUMN prompt_bearing INTEGER NOT NULL DEFAULT 0");
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV10toV11(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      if (!hasColumn(db, "repos", "target_branch")) {
        db.exec("ALTER TABLE repos ADD COLUMN target_branch TEXT");
      }
      if (!hasColumn(db, "repos", "branching_model")) {
        db.exec("ALTER TABLE repos ADD COLUMN branching_model TEXT");
      }
      if (!hasColumn(db, "repos", "protected_branches")) {
        db.exec("ALTER TABLE repos ADD COLUMN protected_branches TEXT");
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV11toV12(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "usage_baseline_json")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN usage_baseline_json TEXT");
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV12toV13(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks")) {
      if (!hasColumn(db, "tasks", "files")) {
        db.exec("ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
      }
      if (!hasColumn(db, "tasks", "verification")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification TEXT NOT NULL DEFAULT '[]'");
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV13toV14(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcodes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          source_url   TEXT    NOT NULL,
          version      TEXT,
          trust_tier   TEXT,
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          UNIQUE(name, source_url)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cheatcode_attachments (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
          target       TEXT    NOT NULL,
          artifact     TEXT    NOT NULL,
          created_at   TEXT    NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_cheatcode_attachments_cheatcode ON cheatcode_attachments(cheatcode_id)"
    );
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV14toV15(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "cheatcodes") && !hasColumn(db, "cheatcodes", "scope")) {
      db.exec("ALTER TABLE cheatcodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV15toV16(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS rule_invocations");
    db.exec("DROP TABLE IF EXISTS rules");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV16toV17(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS commands");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV17toV18(db) {
  if (!tableExists(db, "skills") || !(hasColumn(db, "skills", "uses") || hasColumn(db, "skills", "successes") || hasColumn(db, "skills", "effectiveness"))) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS skills_new");
    db.exec(`
      CREATE TABLE skills_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL UNIQUE,
          description     TEXT    NOT NULL,
          file_path       TEXT    NOT NULL,
          scope           TEXT    NOT NULL DEFAULT 'global'
                            CHECK (scope IN ('global','template','project-local')),
          trust_tier      TEXT    NOT NULL DEFAULT 'curated',
          status          TEXT    NOT NULL DEFAULT 'active',
          created_at      TEXT    NOT NULL,
          updated_at      TEXT    NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO skills_new (id, name, description, file_path, scope, trust_tier, status, created_at, updated_at)
      SELECT id, name, description, file_path, scope, trust_tier, status, created_at, updated_at FROM skills
    `);
    db.exec("DROP TABLE skills");
    db.exec("ALTER TABLE skills_new RENAME TO skills");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV17toV18: foreign_key_check found ${violations.length} dangling reference(s) after skills rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV18toV19(db) {
  const skillsPresent = tableExists(db, "skills");
  const cheatcodesUnified = tableExists(db, "cheatcodes") && hasColumn(db, "cheatcodes", "origin");
  if (cheatcodesUnified && !skillsPresent) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!cheatcodesUnified) {
      db.exec("DROP TABLE IF EXISTS cheatcodes_new");
      db.exec(`
        CREATE TABLE cheatcodes_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL UNIQUE,
            kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
            origin       TEXT    NOT NULL DEFAULT 'installed' CHECK (origin IN ('builtin','installed')),
            description  TEXT    NOT NULL DEFAULT '',
            source_url   TEXT,
            file_path    TEXT,
            version      TEXT,
            trust_tier   TEXT,
            scope        TEXT    NOT NULL DEFAULT 'project-local'
                           CHECK (scope IN ('global','template','project-local')),
            status       TEXT    NOT NULL DEFAULT 'installed',
            installed_at TEXT    NOT NULL,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            CHECK (kind != 'skill' OR file_path IS NOT NULL),
            CHECK (origin != 'installed' OR source_url IS NOT NULL),
            CHECK (origin != 'builtin' OR source_url IS NULL)
        )
      `);
      if (tableExists(db, "cheatcodes")) {
        db.exec(`
          INSERT INTO cheatcodes_new
            (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
          SELECT
            id, name, kind, 'installed', '', source_url, NULL, version, trust_tier,
            CASE scope WHEN 'local' THEN 'project-local' WHEN 'global' THEN 'global' ELSE 'project-local' END,
            status, installed_at, installed_at, installed_at
          FROM cheatcodes
        `);
        db.exec("DROP TABLE cheatcodes");
      }
      db.exec("ALTER TABLE cheatcodes_new RENAME TO cheatcodes");
    }
    if (tableExists(db, "skills")) {
      db.exec(`
        INSERT OR IGNORE INTO cheatcodes
          (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
        SELECT
          name, 'skill', 'builtin', description, NULL, file_path, NULL, trust_tier, scope, status, created_at, created_at, updated_at
        FROM skills
      `);
    }
    if (tableExists(db, "skill_invocations")) {
      const agentRunFk = tableExists(db, "agent_runs") ? " REFERENCES agent_runs(id)" : "";
      const taskFk = tableExists(db, "tasks") ? " REFERENCES tasks(id)" : "";
      db.exec("DROP TABLE IF EXISTS skill_invocations_new");
      db.exec(`
        CREATE TABLE skill_invocations_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_name    TEXT    NOT NULL REFERENCES cheatcodes(name),
            agent_name    TEXT    NOT NULL,
            agent_run_id  INTEGER${agentRunFk},
            task_id       INTEGER${taskFk},
            invoked_at    TEXT    NOT NULL,
            outcome       TEXT    NOT NULL DEFAULT 'completed'
                            CHECK (outcome IN ('completed','failed','partial'))
        )
      `);
      db.exec(`
        INSERT INTO skill_invocations_new (id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome)
        SELECT id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome FROM skill_invocations
      `);
      db.exec("DROP TABLE skill_invocations");
      db.exec("ALTER TABLE skill_invocations_new RENAME TO skill_invocations");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON skill_invocations(skill_name)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_task  ON skill_invocations(task_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent_run ON skill_invocations(agent_run_id)");
    }
    db.exec("DROP TABLE IF EXISTS skills");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV18toV19: foreign_key_check found ${violations.length} dangling reference(s) after the skills\u2192cheatcodes unification`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV19toV20(db) {
  if (!tableExists(db, "cheatcodes")) {
    return;
  }
  beginImmediate(db);
  try {
    deleteBuiltinCheatcodeAttachments(db, "tmb_agent-creator");
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_agent-creator' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_cheatcode', 'skill', 'builtin',
         'When bro hits a wall \u2014 a task leans on a capability the project lacks and a published skill / MCP toolkit / plugin would close the gap \u2014 name the gap, cheatcode_search for ranked candidates, judge the best fit, and recommend it for Human approval.',
         NULL, 'skills/tmb_cheatcode/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV19toV20: foreign_key_check found ${violations.length} dangling reference(s) after the builtin-skill seed correction`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV20toV21(db) {
  db.exec("DROP TABLE IF EXISTS skill_invocations");
}
function migrateV21toV22(db) {
  if (tableExists(db, "issues") && !hasColumn(db, "issues", "milestone")) {
    db.exec("ALTER TABLE issues ADD COLUMN milestone TEXT");
  }
}
function migrateV27toV28(db) {
  if (tableExists(db, "issues") && !hasColumn(db, "issues", "labels")) {
    db.exec("ALTER TABLE issues ADD COLUMN labels TEXT");
  }
}
function migrateV28toV29(db) {
  const tableSql = (table) => readTableSql(db, table);
  const needsRebuild = (table, checkMarker, droppedColumn) => tableExists(db, table) && (droppedColumn !== void 0 && hasColumn(db, table, droppedColumn) || !tableSql(table).includes(checkMarker));
  const rebuild = (table, createBody, columns) => rebuildTable(db, table, createBody, columns);
  const TASK_STATUSES = "'pending','running','needs_validation','completed','closed','failed','escalated'";
  const OPEN_CLOSED = "'open','closed'";
  const VERDICTS = "'pass','fail','escalate'";
  const DISCUSSION_KINDS = "'intent','question','answer','decision','note','analysis'";
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "pr_review_runs")) {
      db.exec("DELETE FROM pr_review_runs WHERE pr_number = 0");
    }
    const probes = [
      ["tasks", "status", `status NOT IN (${TASK_STATUSES})`],
      ["issues", "status", `status NOT IN (${OPEN_CLOSED})`],
      ["validation_attempts", "verdict", `verdict NOT IN (${VERDICTS})`],
      ["validation_attempts", "mcp_available", "mcp_available IS NULL"],
      ["discussions", "kind", `kind NOT IN (${DISCUSSION_KINDS})`],
      ["milestones", "state", `state NOT IN (${OPEN_CLOSED})`],
      ["pr_review_runs", "pr_number", "pr_number IS NULL OR pr_number <= 0"],
      ["pr_review_runs", "repo", "repo IS NULL OR repo = ''"]
    ];
    const violations = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`).all();
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV28toV29: rows violate the new v29 constraints \u2014 fix or delete them, then reopen: ${violations.join("; ")}`
      );
    }
    if (needsRebuild("tasks", "CHECK (status IN", "attempts")) {
      rebuild(
        "tasks",
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id          INTEGER NOT NULL REFERENCES issues(id),
          branch_id         TEXT    NOT NULL,
          parent_branch_id  TEXT,
          title             TEXT    NOT NULL DEFAULT '',
          description       TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN (${TASK_STATUSES})),
          spec_body         TEXT    NOT NULL DEFAULT '',
          commit_sha        TEXT,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          prompt_bearing    INTEGER NOT NULL DEFAULT 0,
          files             TEXT    NOT NULL DEFAULT '[]',
          verification      TEXT    NOT NULL DEFAULT '[]',
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          completed_at      TEXT
        `,
        [
          ["id", "NULL"],
          ["issue_id", "NULL"],
          ["branch_id", "NULL"],
          ["parent_branch_id", "NULL"],
          ["title", "''"],
          ["description", "''"],
          ["status", "'pending'"],
          ["spec_body", "''"],
          ["commit_sha", "NULL"],
          ["repo", "NULL"],
          ["prompt_bearing", "0"],
          ["files", "'[]'"],
          ["verification", "'[]'"],
          ["created_at", "NULL"],
          ["updated_at", "NULL"],
          ["completed_at", "NULL"]
        ]
      );
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)");
    }
    if (needsRebuild("issues", "CHECK (status IN", "remote_iid")) {
      if (hasColumn(db, "issues", "remote_iid")) {
        db.exec(
          "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL"
        );
        db.exec(
          "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL"
        );
      }
      rebuild(
        "issues",
        `
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          objective         TEXT    NOT NULL,
          description       TEXT    NOT NULL DEFAULT '',
          status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (${OPEN_CLOSED})),
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          closed_at         TEXT,
          remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
          gh_iid            INTEGER,
          gl_iid            INTEGER,
          repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          milestone         TEXT,
          labels            TEXT,
          FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        `,
        [
          ["id", "NULL"],
          ["objective", "''"],
          ["description", "''"],
          ["status", "'open'"],
          ["created_at", "NULL"],
          ["updated_at", "NULL"],
          ["closed_at", "NULL"],
          ["remote_kind", "NULL"],
          ["gh_iid", "NULL"],
          ["gl_iid", "NULL"],
          ["repo", "NULL"],
          ["milestone", "NULL"],
          ["labels", "NULL"]
        ]
      );
    }
    if (needsRebuild("validation_attempts", "CHECK (verdict IN")) {
      rebuild(
        "validation_attempts",
        `
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL CHECK (verdict IN (${VERDICTS})),
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["attempt_n", "NULL"],
          ["agent", "''"],
          ["verdict", "NULL"],
          ["feedback", "''"],
          ["mcp_available", "1"],
          ["subagent_session_id", "NULL"],
          ["repo", "NULL"],
          ["created_at", "NULL"]
        ]
      );
    }
    if (needsRebuild("discussions", "CHECK (kind IN")) {
      const embeddingsCount = () => tableExists(db, "discussions_embeddings") ? db.prepare("SELECT COUNT(*) AS n FROM discussions_embeddings").get().n : 0;
      const embeddingsBefore = embeddingsCount();
      rebuild(
        "discussions",
        `
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id       INTEGER NOT NULL REFERENCES issues(id),
          author         TEXT    NOT NULL,
          kind           TEXT    NOT NULL DEFAULT 'note'
                           CHECK (kind IN (${DISCUSSION_KINDS})),
          body           TEXT    NOT NULL,
          repo           TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at     TEXT    NOT NULL
        `,
        [
          ["id", "NULL"],
          ["issue_id", "NULL"],
          ["author", "''"],
          ["kind", "'note'"],
          ["body", "''"],
          ["repo", "NULL"],
          ["created_at", "NULL"]
        ]
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_discussions_issue_created ON discussions(issue_id, created_at)"
      );
      if (tableExists(db, "discussions_fts")) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          END;
          CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
            INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
            INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
          END;
        `);
        db.exec("INSERT INTO discussions_fts(discussions_fts) VALUES('rebuild')");
      }
      const embeddingsAfter = embeddingsCount();
      if (embeddingsAfter !== embeddingsBefore) {
        throw new Error(
          `migrateV28toV29: discussions_embeddings changed from ${embeddingsBefore} to ${embeddingsAfter} rows across the discussions rebuild`
        );
      }
    }
    if (needsRebuild("milestones", "CHECK (state IN")) {
      rebuild(
        "milestones",
        `
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open' CHECK (state IN (${OPEN_CLOSED})),
          PRIMARY KEY (name, repo)
        `,
        [["name", "NULL"], ["repo", "NULL"], ["state", "'open'"]]
      );
    }
    if (tableExists(db, "agents") && hasColumn(db, "agents", "status")) {
      db.exec("ALTER TABLE agents DROP COLUMN status");
    }
    if (needsRebuild("pr_review_runs", "CHECK (pr_number > 0)", "verdict")) {
      rebuild(
        "pr_review_runs",
        `
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pr_number       INTEGER NOT NULL CHECK (pr_number > 0),
          repo            TEXT    NOT NULL CHECK (repo <> ''),
          last_fetched_at DATETIME NOT NULL,
          last_comment_id TEXT,
          task_id         INTEGER REFERENCES tasks(id),
          UNIQUE (pr_number, repo)
        `,
        [
          ["id", "NULL"],
          ["pr_number", "NULL"],
          ["repo", "NULL"],
          ["last_fetched_at", "NULL"],
          ["last_comment_id", "NULL"],
          ["task_id", "NULL"]
        ]
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id)");
    }
    db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_pr");
    db.exec("DROP INDEX IF EXISTS idx_pr_review_runs_audit");
    if (tableExists(db, "plugin_config")) {
      db.exec("DELETE FROM plugin_config WHERE key = 'tmb_default_repo'");
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV28toV29: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v29 rebuilds`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var ISO_NOW_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
var TIMESTAMP_COLUMNS = [
  ["audit", "created_at"],
  ["tasks", "created_at"],
  ["tasks", "updated_at"],
  ["tasks", "completed_at"],
  ["issues", "created_at"],
  ["issues", "updated_at"],
  ["issues", "closed_at"],
  ["discussions", "created_at"],
  ["validation_attempts", "created_at"],
  ["agent_runs", "started_at"],
  ["agent_runs", "completed_at"],
  ["roundtables", "created_at"],
  ["roundtables", "closed_at"],
  ["roundtable_votes", "created_at"],
  ["agents", "created_at"],
  ["agents", "updated_at"],
  ["cheatcodes", "installed_at"],
  ["cheatcodes", "created_at"],
  ["cheatcodes", "updated_at"],
  ["cheatcode_attachments", "created_at"],
  ["repos", "last_scanned_at"],
  ["pr_review_runs", "last_fetched_at"],
  ["discussions_embeddings", "embedded_at"],
  ["audit_embeddings", "embedded_at"]
];
function migrateV29toV30(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    const probes = [
      ["agents", "kind", "kind NOT IN ('backbone','consultant')"],
      ["agents", "scope", "scope NOT IN ('global','template','project-local')"],
      ["cheatcodes", "kind", "kind NOT IN ('skill','mcp','plugin')"],
      ["cheatcodes", "origin", "origin NOT IN ('builtin','marketplace','external')"],
      ["cheatcodes", "scope", "scope NOT IN ('global','template','project-local')"],
      ["cheatcodes", "name", "kind = 'skill' AND file_path IS NULL"],
      ["cheatcodes", "name", "origin <> 'builtin' AND source_url IS NULL"],
      ["cheatcodes", "name", "origin = 'builtin' AND source_url IS NOT NULL"]
    ];
    const violations = [];
    for (const [table, column, predicate] of probes) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      const bad = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${predicate} LIMIT 20`).all();
      if (bad.length > 0) {
        violations.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")} (${predicate})`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `migrateV29toV30: rows violate the rebuilt v30 constraints \u2014 fix or delete them, then reopen: ${violations.join("; ")}`
      );
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "usage_source")) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          tokens_total          INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          usage_baseline_json   TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["tokens_total", "0"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["usage_baseline_json", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"]
        ]
      );
      db.exec(`
        UPDATE agent_runs
           SET tokens_in = NULL, tokens_out = NULL, cache_read_tokens = NULL, cache_creation_tokens = NULL,
               usage_source = 'unmeasured'
         WHERE completed_at IS NOT NULL
           AND tokens_in = 0 AND tokens_out = 0 AND cache_read_tokens = 0 AND cache_creation_tokens = 0
      `);
      db.exec(`
        UPDATE agent_runs
           SET usage_source = CASE agent_type WHEN 'bro' THEN 'transcript' ELSE 'subagent_stop' END
         WHERE completed_at IS NOT NULL AND usage_source IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    if (tableExists(db, "discussions") && !hasColumn(db, "discussions", "remote_comment_id")) {
      db.exec("ALTER TABLE discussions ADD COLUMN remote_comment_id TEXT");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_remote_comment ON discussions(remote_comment_id) WHERE remote_comment_id IS NOT NULL"
      );
    }
    const needsIsoDefault = (table) => tableExists(db, table) && !readTableSql(db, table).includes("strftime(");
    if (needsIsoDefault("agents")) {
      rebuildTable(
        db,
        "agents",
        `
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL UNIQUE,
          kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
          scope       TEXT    NOT NULL CHECK (scope IN ('global','template','project-local')),
          file_path   TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["scope", "NULL"],
          ["file_path", "''"],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    if (needsIsoDefault("cheatcodes")) {
      rebuildTable(
        db,
        "cheatcodes",
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["origin", "'external'"],
          ["description", "''"],
          ["source_url", "NULL"],
          ["file_path", "NULL"],
          ["version", "NULL"],
          ["trust_tier", "NULL"],
          ["scope", "'project-local'"],
          ["status", "'installed'"],
          ["installed_at", ISO_NOW_DEFAULT],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    if (needsIsoDefault("repos")) {
      rebuildTable(
        db,
        "repos",
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT,
          remotes            TEXT
        `,
        [
          ["name", "NULL"],
          ["path", "''"],
          ["file_count", "0"],
          ["last_scanned_at", ISO_NOW_DEFAULT],
          ["target_branch", "NULL"],
          ["branching_model", "NULL"],
          ["protected_branches", "NULL"],
          ["remotes", "NULL"]
        ]
      );
    }
    const presentTimestampColumns = TIMESTAMP_COLUMNS.filter(
      ([table, column]) => tableExists(db, table) && hasColumn(db, table, column)
    );
    for (const [table, column] of presentTimestampColumns) {
      db.exec(
        `UPDATE ${table} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
          WHERE ${column} IS NOT NULL AND length(${column}) <> 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL`
      );
    }
    const malformed = [];
    for (const [table, column] of presentTimestampColumns) {
      const bad = db.prepare(
        `SELECT DISTINCT ${column} AS v FROM ${table}
            WHERE ${column} IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NULL LIMIT 5`
      ).all();
      if (bad.length > 0) {
        malformed.push(`${table}.${column} = ${bad.map((r) => JSON.stringify(r.v)).join(", ")}`);
      }
    }
    if (malformed.length > 0) {
      throw new Error(
        `migrateV29toV30: timestamps that cannot be parsed into YYYY-MM-DDTHH:MM:SS.sssZ \u2014 fix them, then reopen: ${malformed.join("; ")}`
      );
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV29toV30: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v30 rebuilds`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV30toV31(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs") && (hasColumn(db, "agent_runs", "tokens_total") || hasColumn(db, "agent_runs", "usage_baseline_json"))) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"]
        ]
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV30toV31: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v31 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var OWN_MCP_SERVER_NAME = "trajectory-server";
function migrateV31toV32(db) {
  if (!tableExists(db, "cheatcodes")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!/UNIQUE\s*\(\s*name\s*,\s*kind\s*\)/.test(readTableSql(db, "cheatcodes"))) {
      rebuildTable(
        db,
        "cheatcodes",
        `
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          updated_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL),
          UNIQUE (name, kind)
        `,
        [
          ["id", "NULL"],
          ["name", "NULL"],
          ["kind", "NULL"],
          ["origin", "'external'"],
          ["description", "''"],
          ["source_url", "NULL"],
          ["file_path", "NULL"],
          ["version", "NULL"],
          ["trust_tier", "NULL"],
          ["scope", "'project-local'"],
          ["status", "'installed'"],
          ["installed_at", ISO_NOW_DEFAULT],
          ["created_at", ISO_NOW_DEFAULT],
          ["updated_at", ISO_NOW_DEFAULT]
        ]
      );
    }
    const pluginRow = db.prepare("SELECT 1 FROM cheatcodes WHERE kind = 'plugin' AND name = ? LIMIT 1");
    const ownPlugin = resolvePluginName();
    const legacyServers = db.prepare("SELECT id, name FROM cheatcodes WHERE kind = 'mcp' AND source_url = 'mcp:' || name").all();
    for (const server of legacyServers) {
      let parent = null;
      if (pluginRow.get(server.name) !== void 0) {
        parent = server.name;
      } else if (server.name === OWN_MCP_SERVER_NAME && pluginRow.get(ownPlugin) !== void 0) {
        parent = ownPlugin;
      }
      if (parent === null) continue;
      db.prepare("UPDATE cheatcodes SET source_url = ? WHERE id = ?").run(`mcp:${parent}/${server.name}`, server.id);
    }
    let phantoms = 0;
    if (tableExists(db, "audit")) {
      const phantomIds = db.prepare(
        `SELECT a.id FROM audit a
            WHERE a.event_type = 'scan_discovered'
              AND json_valid(a.content_json)
              AND NOT EXISTS (
                SELECT 1 FROM cheatcodes c
                 WHERE c.name = json_extract(a.content_json, '$.name')
                   AND c.kind = json_extract(a.content_json, '$.kind'))`
      ).all();
      phantoms = phantomIds.length;
      if (phantoms > 0) {
        const ids = JSON.stringify(phantomIds.map((r) => r.id));
        if (tableExists(db, "audit_embeddings")) {
          db.prepare(
            // LINT-ALLOW: v31→v32 removes the embeddings of phantom scan_discovered audit rows (GH 1200).
            "DELETE FROM audit_embeddings WHERE audit_id IN (SELECT value FROM json_each(?))"
          ).run(ids);
        }
        db.prepare("DELETE FROM audit WHERE id IN (SELECT value FROM json_each(?))").run(ids);
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           SELECT -1, NULL, 'system', 'scan_discovered_repair', ?, ?, (SELECT repo FROM issues WHERE id = -1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE EXISTS (SELECT 1 FROM issues WHERE id = -1)`
        ).run(
          `deleted ${phantoms} phantom scan_discovered audit row(s)`,
          JSON.stringify({ deleted: phantoms })
        );
      }
    }
    db.exec(`
      UPDATE cheatcodes
         SET status = 'installed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE kind = 'mcp' AND source_url LIKE 'mcp:%' AND status = 'broken'
    `);
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV31toV32: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v32 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
var ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function migrateV32toV33(db) {
  if (!tableExists(db, "agent_runs")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "exit_reason") || !/'backfill'/.test(readTableSql(db, "agent_runs"))) {
      rebuildTable(
        db,
        "agent_runs",
        `
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id               INTEGER REFERENCES tasks(id),
          issue_id              INTEGER REFERENCES issues(id),
          agent_type            TEXT    NOT NULL,
          tokens_in             INTEGER,
          tokens_out            INTEGER,
          cache_read_tokens     INTEGER,
          cache_creation_tokens INTEGER,
          tool_uses             INTEGER NOT NULL DEFAULT 0,
          duration_ms           INTEGER NOT NULL DEFAULT 0,
          started_at            TEXT,
          completed_at          TEXT,
          repo                  TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          spawn_id              TEXT,
          session_id            TEXT,
          usage_source          TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured','backfill')),
          root_dir              TEXT,
          model                 TEXT,
          host                  TEXT CHECK (host IN ('claude','codex')),
          exit_reason           TEXT CHECK (exit_reason IN ('completed','failed','escalated','swept_orphan','swept_stale','issue_closed'))
        `,
        [
          ["id", "NULL"],
          ["task_id", "NULL"],
          ["issue_id", "NULL"],
          ["agent_type", "''"],
          ["tokens_in", "NULL"],
          ["tokens_out", "NULL"],
          ["cache_read_tokens", "NULL"],
          ["cache_creation_tokens", "NULL"],
          ["tool_uses", "0"],
          ["duration_ms", "0"],
          ["started_at", "NULL"],
          ["completed_at", "NULL"],
          ["repo", "NULL"],
          ["spawn_id", "NULL"],
          ["session_id", "NULL"],
          ["usage_source", "NULL"],
          ["root_dir", "NULL"],
          ["model", "NULL"],
          ["host", "NULL"],
          ["exit_reason", "NULL"]
        ]
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;
      `);
    }
    db.exec("UPDATE agent_runs SET host = 'claude' WHERE host IS NULL");
    if (tableExists(db, "tasks")) db.exec(`
      UPDATE agent_runs
         SET exit_reason = CASE
               WHEN usage_source = 'unmeasured' THEN 'swept_orphan'
               ELSE (SELECT CASE t.status
                              WHEN 'closed' THEN 'completed'
                              WHEN 'completed' THEN 'completed'
                              WHEN 'failed' THEN 'failed'
                              WHEN 'escalated' THEN 'escalated'
                            END
                       FROM tasks t WHERE t.id = agent_runs.task_id)
             END
       WHERE completed_at IS NOT NULL AND exit_reason IS NULL
    `);
    if (tableExists(db, "tasks") && tableExists(db, "issues")) {
      const leaked = db.prepare(
        `SELECT t.id, t.issue_id, t.branch_id, t.status FROM tasks t JOIN issues i ON i.id = t.issue_id
            WHERE i.status = 'closed' AND t.status IN ('pending','running','needs_validation','completed')
            ORDER BY t.id`
      ).all();
      const insertRepairAudit = tableExists(db, "audit") ? db.prepare(
        `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
             VALUES (?, ?, 'system', 'task_escalated_repair', ?, ?, (SELECT repo FROM issues WHERE id = ?), ${ISO_NOW_SQL})`
      ) : null;
      const escalate = db.prepare(
        `UPDATE tasks SET status = 'escalated', completed_at = NULL, updated_at = ${ISO_NOW_SQL} WHERE id = ?`
      );
      const closeRuns = db.prepare(
        `UPDATE agent_runs
            SET completed_at = ${ISO_NOW_SQL},
                duration_ms = CASE WHEN duration_ms = 0
                                   THEN COALESCE(MAX(0, CAST(ROUND((julianday('now') - julianday(started_at)) * 86400000) AS INTEGER)), 0)
                                   ELSE duration_ms END,
                exit_reason = 'issue_closed'
          WHERE task_id = ? AND completed_at IS NULL`
      );
      for (const task of leaked) {
        insertRepairAudit?.run(
          task.issue_id,
          task.branch_id,
          `task ${task.id} escalated: its issue ${task.issue_id} is closed (was ${task.status})`,
          JSON.stringify({ task_id: task.id, issue_id: task.issue_id, from_status: task.status }),
          task.issue_id
        );
        escalate.run(task.id);
        closeRuns.run(task.id);
      }
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV32toV33: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v33 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV33toV34(db) {
  if (!tableExists(db, "agents")) return;
  if (!hasColumn(db, "agents", "scope") && /file_path\s+LIKE\s+'plugin:%'/.test(readTableSql(db, "agents"))) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    const root = hasColumn(db, "agents", "scope") ? "CASE WHEN scope = 'project-local' THEN 'project:' ELSE 'plugin:' END" : "'plugin:'";
    db.exec(`
      UPDATE agents
         SET file_path = ${root} || file_path
       WHERE file_path NOT LIKE 'plugin:%' AND file_path NOT LIKE 'project:%'
    `);
    rebuildTable(
      db,
      "agents",
      `
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
        file_path   TEXT    NOT NULL CHECK (file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        updated_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
      `,
      [
        ["id", "NULL"],
        ["name", "NULL"],
        ["kind", "NULL"],
        ["file_path", "''"],
        ["created_at", ISO_NOW_DEFAULT],
        ["updated_at", ISO_NOW_DEFAULT]
      ]
    );
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV33toV34: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v34 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV34toV35(db) {
  if (!tableExists(db, "repos")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_remotes (
        repo        TEXT    NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
        name        TEXT    NOT NULL,
        provider    TEXT    NOT NULL CHECK (provider IN ('github','gitlab','other')),
        url         TEXT    NOT NULL,
        is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        created_at  TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
        PRIMARY KEY (repo, name)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_remotes_primary ON repo_remotes(repo, is_primary);
    `);
    if (hasColumn(db, "repos", "remotes")) {
      const rows = db.prepare(`SELECT name, remotes AS legacy FROM repos WHERE remotes IS NOT NULL AND trim(remotes) <> '' ORDER BY name`).all();
      const insertRemote = db.prepare(
        `INSERT OR IGNORE INTO repo_remotes (repo, name, provider, url, is_primary) VALUES (?, ?, ?, ?, ?)`
      );
      const canAudit = tableExists(db, "audit") && tableExists(db, "issues");
      const skipped2 = (repo, raw, reason) => {
        if (!canAudit) return;
        db.exec(
          `INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
           VALUES (-1, 'system', 'parent issue for recovery / system-level audit and discussion events', 'open', ${ISO_NOW_SQL}, ${ISO_NOW_SQL})`
        );
        db.prepare(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
           VALUES (-1, NULL, 'system', 'repo_remotes_migration_skipped', ?, ?, ?, ${ISO_NOW_SQL})`
        ).run(`v35 migration skipped remotes of repo ${repo}: ${reason}`, JSON.stringify({ repo, reason, raw }), repo);
      };
      for (const row of rows) {
        const parsed = parseLegacyRemotes(row.legacy);
        if (!parsed.ok) {
          skipped2(row.name, row.legacy, parsed.reason);
          continue;
        }
        const primary = primaryIndex(parsed.entries);
        parsed.entries.forEach((r, i2) => {
          insertRemote.run(row.name, r.name, remoteProvider(r.url, r.provider), r.url, i2 === primary ? 1 : 0);
        });
        if (parsed.dropped > 0) {
          skipped2(row.name, row.legacy, `${parsed.dropped} remote entr${parsed.dropped === 1 ? "y" : "ies"} without a url or with a duplicate name`);
        }
      }
      rebuildTable(
        db,
        "repos",
        `
          name               TEXT PRIMARY KEY,
          path               TEXT    NOT NULL,
          file_count         INTEGER NOT NULL DEFAULT 0,
          last_scanned_at    TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT},
          target_branch      TEXT,
          branching_model    TEXT,
          protected_branches TEXT
        `,
        [
          ["name", "NULL"],
          ["path", "''"],
          ["file_count", "0"],
          ["last_scanned_at", ISO_NOW_DEFAULT],
          ["target_branch", "NULL"],
          ["branching_model", "NULL"],
          ["protected_branches", "NULL"]
        ]
      );
    }
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "reviewer_agent_id")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN reviewer_agent_id TEXT");
    }
    if (tableExists(db, "audit")) {
      db.exec(`UPDATE audit SET branch_id = NULL WHERE branch_id = ''`);
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV34toV35: foreign_key_check found ${fkViolations.length} dangling reference(s) after the v35 rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV35toV36(db) {
  if (!tableExists(db, "tasks")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_runs (
      id           INTEGER PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      commit_sha   TEXT    NOT NULL,
      source       TEXT    NOT NULL CHECK (source IN ('gate','manual')),
      started_at   TEXT    NOT NULL,
      finished_at  TEXT,
      exit_code    INTEGER,
      budget_s     INTEGER NOT NULL,
      timed_out    INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
      created_at   TEXT    NOT NULL DEFAULT ${ISO_NOW_DEFAULT}
    );
    CREATE INDEX IF NOT EXISTS idx_verification_runs_task_commit
      ON verification_runs(task_id, commit_sha, finished_at);
    CREATE TABLE IF NOT EXISTS verification_run_commands (
      run_id       INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
      ordinal      INTEGER NOT NULL,
      command      TEXT    NOT NULL,
      exit_code    INTEGER,
      elapsed_s    REAL,
      output_tail  TEXT,
      PRIMARY KEY (run_id, ordinal)
    );
  `);
}
function migrateV36toV37(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "tasks") && !hasColumn(db, "tasks", "effort")) {
      db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high'))");
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "effort")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN effort TEXT CHECK (effort IN ('low','medium','high'))");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV37toV38(db) {
  if (!tableExists(db, "audit")) return;
  const documented = AUDIT_EVENT_TYPES.map((e) => e.type);
  const placeholders2 = documented.map(() => "?").join(", ");
  beginImmediate(db);
  try {
    db.prepare(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE event_type NOT IN (${placeholders2})`
    ).run(...documented);
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV38toV39(db) {
  if (!tableExists(db, "audit")) return;
  const legacyWaiver = (alias) => `${alias}.event_type = 'verification_gate_waived' AND ${alias}.from_node = 'swe'
          AND (CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.commit_sha') END) IS NULL`;
  const taskId = (alias) => `CASE WHEN json_valid(${alias}.content_json) THEN json_extract(${alias}.content_json, '$.task_id') END`;
  beginImmediate(db);
  try {
    db.exec(
      `UPDATE audit
          SET content_json = json_set(
                CASE WHEN json_valid(content_json) THEN content_json ELSE json_object('legacy_content', content_json) END,
                '$.legacy_event_type', event_type),
              event_type = 'legacy_event'
        WHERE ${legacyWaiver("audit")}
          AND EXISTS (SELECT 1 FROM audit k
                       WHERE ${legacyWaiver("k")}
                         AND ${taskId("k")} IS ${taskId("audit")}
                         AND k.id < audit.id)`
    );
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV39toV40(db) {
  if (!tableExists(db, "repos") || hasColumn(db, "repos", "onboard_scan")) return;
  db.exec("ALTER TABLE repos ADD COLUMN onboard_scan TEXT");
}
function migrateV40toV41(db) {
  if (!tableExists(db, "repo_remotes") || hasColumn(db, "repo_remotes", "sync")) return;
  beginImmediate(db);
  try {
    db.exec("ALTER TABLE repo_remotes ADD COLUMN sync INTEGER NOT NULL DEFAULT 0 CHECK (sync IN (0,1))");
    db.exec("UPDATE repo_remotes SET sync = 1 WHERE is_primary = 1");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV41toV42(db) {
  beginImmediate(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wm_directories (
          id                 INTEGER PRIMARY KEY,
          repo               TEXT    NOT NULL,
          path               TEXT    NOT NULL,
          parent_path        TEXT,
          summary            TEXT,
          summary_source     TEXT    NOT NULL,
          summary_updated_at TEXT,
          file_count         INTEGER NOT NULL DEFAULT 0,
          UNIQUE (repo, path)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS wm_files (
          id              INTEGER PRIMARY KEY,
          repo            TEXT    NOT NULL,
          path            TEXT    NOT NULL,
          dir             TEXT    NOT NULL,
          purpose         TEXT    NOT NULL DEFAULT '',
          purpose_source  TEXT    NOT NULL DEFAULT 'none',
          content_md5     TEXT    NOT NULL DEFAULT '',
          size_bytes      INTEGER NOT NULL DEFAULT 0,
          last_commit_sha TEXT    NOT NULL DEFAULT '',
          updated_at      TEXT    NOT NULL,
          UNIQUE (repo, path)
      )
    `);
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV42toV43(db) {
  if (!tableExists(db, "wm_directories")) return;
  beginImmediate(db);
  try {
    for (const [column, type] of [
      ["summary_sha", "TEXT"],
      ["commits_behind", "INTEGER"],
      ["dead_refs", "TEXT"]
    ]) {
      if (!hasColumn(db, "wm_directories", column)) {
        db.exec(`ALTER TABLE wm_directories ADD COLUMN ${column} ${type}`);
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV43toV44(db) {
  if (!tableExists(db, "wm_files")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "wm_files", "symbols_md5")) {
      db.exec("ALTER TABLE wm_files ADD COLUMN symbols_md5 TEXT");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV44toV45(db) {
  if (!tableExists(db, "wm_symbols")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "wm_edges") && !hasColumn(db, "wm_edges", "hint")) {
      db.exec("ALTER TABLE wm_edges ADD COLUMN hint TEXT");
    }
    if (tableExists(db, "wm_files") && hasColumn(db, "wm_files", "symbols_md5")) {
      db.exec("UPDATE wm_files SET symbols_md5 = NULL");
    }
    if (!hasColumn(db, "wm_symbols", "run_order") || !readTableSql(db, "wm_symbols").includes("'hook'")) {
      rebuildTable(
        db,
        "wm_symbols",
        `
          id              INTEGER PRIMARY KEY,
          repo            TEXT    NOT NULL,
          path            TEXT    NOT NULL,
          kind            TEXT    NOT NULL CHECK (kind IN ('function','method','class','interface','type','const','sh_function','sql_table','sql_index','sql_trigger','module','hook')),
          qualified_name  TEXT    NOT NULL,
          signature       TEXT    NOT NULL DEFAULT '',
          doc             TEXT    NOT NULL DEFAULT '',
          start_line      INTEGER,
          end_line        INTEGER,
          body_hash       TEXT    NOT NULL,
          exported        INTEGER NOT NULL DEFAULT 0,
          terms           TEXT    NOT NULL DEFAULT '',
          run_order       INTEGER,
          UNIQUE (repo, path, kind, qualified_name)
        `,
        [
          ["id", "NULL"],
          ["repo", "''"],
          ["path", "''"],
          ["kind", "'module'"],
          ["qualified_name", "''"],
          ["signature", "''"],
          ["doc", "''"],
          ["start_line", "NULL"],
          ["end_line", "NULL"],
          ["body_hash", "''"],
          ["exported", "0"],
          ["terms", "''"],
          ["run_order", "NULL"]
        ]
      );
    }
    const fkViolations = db.prepare("PRAGMA foreign_key_check(wm_edges)").all();
    if (fkViolations.length > 0) {
      throw new Error(
        `migrateV44toV45: foreign_key_check found ${fkViolations.length} dangling reference(s) after the wm_symbols rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV45toV46(db) {
  if (!tableExists(db, "discussions")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "discussions", "task_id")) {
      db.exec("ALTER TABLE discussions ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
    }
    if (!hasColumn(db, "discussions", "supersedes")) {
      db.exec("ALTER TABLE discussions ADD COLUMN supersedes INTEGER REFERENCES discussions(id)");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV46toV47(db) {
  if (!tableExists(db, "tasks")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id           TEXT    PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_n    INTEGER NOT NULL,
      criterion_id TEXT,
      probe_cmd    TEXT    NOT NULL,
      expected     TEXT    NOT NULL,
      observed     TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
      created_at   TEXT    NOT NULL,
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_task_status
      ON review_findings(task_id, status);
  `);
}
function migrateV47toV48(db) {
  if (!tableExists(db, "tasks")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "tasks", "completion_report")) {
      db.exec("ALTER TABLE tasks ADD COLUMN completion_report TEXT");
    }
    if (!hasColumn(db, "tasks", "spawn_note")) {
      db.exec("ALTER TABLE tasks ADD COLUMN spawn_note TEXT");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV48toV49(db) {
  if (!tableExists(db, "agent_runs")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "resumed_from")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN resumed_from INTEGER REFERENCES agent_runs(id)");
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_agent_runs_spawn;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL AND resumed_from IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_resumed ON agent_runs(resumed_from) WHERE resumed_from IS NOT NULL;
    `);
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV49toV50(db) {
  if (!tableExists(db, "agent_runs")) return;
  beginImmediate(db);
  try {
    if (!hasColumn(db, "agent_runs", "plugin_version")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN plugin_version TEXT");
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
var OLD_REVIEWER = "pr-reviewer";
var OLD_REVIEWER_TITLE = "PR-reviewer";
var REVIEWER = "code-reviewer";
var REVIEWER_JSON_RENAMES = {
  [OLD_REVIEWER]: REVIEWER,
  [`tmb:${OLD_REVIEWER}`]: `tmb:${REVIEWER}`
};
function renameReviewerInAuditJson(db) {
  const hits = db.prepare(
    `SELECT a.id AS id, j.fullkey AS path, j.atom AS value
         FROM audit a, json_tree(a.content_json) j
        WHERE instr(a.content_json, ?) > 0
          AND json_valid(a.content_json)
          AND j.type = 'text'
          AND j.atom IN (?, ?)
        ORDER BY a.id`
  ).all(OLD_REVIEWER, OLD_REVIEWER, `tmb:${OLD_REVIEWER}`);
  const update = db.prepare("UPDATE audit SET content_json = json_set(content_json, ?, ?) WHERE id = ?");
  for (const hit of hits) {
    update.run(hit.path, REVIEWER_JSON_RENAMES[hit.value], hit.id);
  }
}
function migrateV50toV51(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "agent_runs")) {
      db.prepare("UPDATE agent_runs SET agent_type = ? WHERE agent_type = ?").run(REVIEWER, OLD_REVIEWER);
    }
    if (tableExists(db, "validation_attempts")) {
      db.prepare("UPDATE validation_attempts SET agent = ? WHERE agent = ?").run(REVIEWER, OLD_REVIEWER);
    }
    if (tableExists(db, "agents")) {
      db.prepare(`DELETE FROM agents WHERE name = ? AND EXISTS (SELECT 1 FROM agents WHERE name = ?)`).run(
        OLD_REVIEWER,
        REVIEWER
      );
      db.prepare(
        `UPDATE agents
            SET name = ?,
                file_path = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE name = ?`
      ).run(REVIEWER, `plugin:agents/${REVIEWER}.md`, OLD_REVIEWER);
    }
    if (tableExists(db, "audit")) {
      renameReviewerInAuditJson(db);
    }
    if (tableExists(db, "cheatcodes")) {
      db.prepare(
        `UPDATE cheatcodes
            SET description = replace(replace(description, ?, ?), ?, ?)
          WHERE (origin = 'builtin' OR (kind = 'plugin' AND name = 'tmb'))
            AND (instr(description, ?) > 0 OR instr(description, ?) > 0)`
      ).run(OLD_REVIEWER, REVIEWER, OLD_REVIEWER_TITLE, "Code-reviewer", OLD_REVIEWER, OLD_REVIEWER_TITLE);
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV22toV23(db) {
  const soleRepo = () => {
    if (!tableExists(db, "repos")) return null;
    const rows = db.prepare("SELECT name FROM repos").all();
    return rows.length === 1 ? rows[0].name : null;
  };
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      if (!hasColumn(db, "repos", "remotes")) {
        db.exec("ALTER TABLE repos ADD COLUMN remotes TEXT");
      }
    }
    const sole = soleRepo();
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
          name   TEXT NOT NULL,
          repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
          state  TEXT NOT NULL DEFAULT 'open',
          PRIMARY KEY (name, repo)
      )
    `);
    if (tableExists(db, "issues") && hasColumn(db, "issues", "milestone")) {
      const issuesHasRepo = hasColumn(db, "issues", "repo");
      if (!issuesHasRepo) {
        db.exec("ALTER TABLE issues ADD COLUMN repo TEXT");
      }
      if (sole !== null) {
        db.prepare("UPDATE issues SET repo = ? WHERE repo IS NULL AND id <> -1").run(sole);
      }
      db.exec(`
        INSERT OR IGNORE INTO milestones (name, repo, state)
        SELECT DISTINCT milestone, repo, 'open'
          FROM issues
         WHERE milestone IS NOT NULL AND repo IS NOT NULL
      `);
      db.exec("DROP TABLE IF EXISTS issues_new");
      db.exec(`
        CREATE TABLE issues_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            objective         TEXT    NOT NULL,
            description       TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT 'open',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            closed_at         TEXT,
            remote_iid        INTEGER,
            remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
            gh_iid            INTEGER,
            gl_iid            INTEGER,
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            milestone         TEXT,
            FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
        )
      `);
      const issueCol = (name2, expr = name2) => hasColumn(db, "issues", name2) ? expr : `NULL AS ${name2}`;
      db.exec(`
        INSERT INTO issues_new
          (id, objective, description, status, created_at, updated_at, closed_at,
           remote_iid, remote_kind, gh_iid, gl_iid, repo, milestone)
        SELECT
           id, objective, description, status, created_at, updated_at,
           ${issueCol("closed_at")},
           ${issueCol("remote_iid")}, ${issueCol("remote_kind")},
           ${issueCol("gh_iid")}, ${issueCol("gl_iid")},
           repo, milestone
          FROM issues
      `);
      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");
    }
    if (tableExists(db, "tasks") && hasColumn(db, "tasks", "repo")) {
      db.exec("DROP TABLE IF EXISTS tasks_new");
      db.exec(`
        CREATE TABLE tasks_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id          INTEGER NOT NULL REFERENCES issues(id),
            branch_id         TEXT    NOT NULL,
            parent_branch_id  TEXT,
            title             TEXT    NOT NULL DEFAULT '',
            description       TEXT    NOT NULL,
            status            TEXT    NOT NULL DEFAULT 'pending',
            attempts          INTEGER NOT NULL DEFAULT 0,
            spec_body         TEXT    NOT NULL DEFAULT '',
            commit_sha        TEXT,
            repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
            prompt_bearing    INTEGER NOT NULL DEFAULT 0,
            files             TEXT    NOT NULL DEFAULT '[]',
            verification      TEXT    NOT NULL DEFAULT '[]',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      const taskCol = (name2, fallback) => hasColumn(db, "tasks", name2) ? name2 : `${fallback} AS ${name2}`;
      db.exec(`
        INSERT INTO tasks_new
          (id, issue_id, branch_id, parent_branch_id, title, description, status,
           attempts, spec_body, commit_sha, repo, prompt_bearing, files,
           verification, created_at, updated_at, completed_at)
        SELECT
           id, issue_id, branch_id,
           ${taskCol("parent_branch_id", "NULL")},
           ${taskCol("title", "''")},
           description, status, attempts,
           ${taskCol("spec_body", "''")},
           ${taskCol("commit_sha", "NULL")},
           repo,
           ${taskCol("prompt_bearing", "0")},
           ${taskCol("files", "'[]'")},
           ${taskCol("verification", "'[]'")},
           created_at, updated_at,
           ${taskCol("completed_at", "NULL")}
          FROM tasks
      `);
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)"
      );
    }
    if (tableExists(db, "discussions") && !hasColumn(db, "discussions", "repo")) {
      db.exec("ALTER TABLE discussions ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE discussions
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = discussions.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, "audit") && !hasColumn(db, "audit", "repo")) {
      db.exec("ALTER TABLE audit ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE audit
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = audit.issue_id)
           WHERE repo IS NULL
        `);
      }
    }
    if (tableExists(db, "agent_runs") && !hasColumn(db, "agent_runs", "repo")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "tasks")) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = agent_runs.task_id)
           WHERE repo IS NULL AND task_id IS NOT NULL
        `);
      }
      if (tableExists(db, "issues")) {
        db.exec(`
          UPDATE agent_runs
             SET repo = (SELECT i.repo FROM issues i WHERE i.id = agent_runs.issue_id)
           WHERE repo IS NULL AND issue_id IS NOT NULL
        `);
      }
    }
    if (tableExists(db, "validation_attempts") && !hasColumn(db, "validation_attempts", "repo")) {
      db.exec("ALTER TABLE validation_attempts ADD COLUMN repo TEXT REFERENCES repos(name) ON DELETE RESTRICT");
      if (tableExists(db, "tasks")) {
        db.exec(`
          UPDATE validation_attempts
             SET repo = (SELECT t.repo FROM tasks t WHERE t.id = validation_attempts.task_id)
           WHERE repo IS NULL
        `);
      }
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV22toV23: foreign_key_check found ${violations.length} dangling reference(s) after the repos-centric migration`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV23toV24(db) {
  if (!tableExists(db, "cheatcodes")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec(`
      -- LINT-ALLOW: v23\u2192v24 WHERE-scoped cleanup of leaked scan-ingest rows (#150).
      DELETE FROM cheatcodes
       WHERE source_url = 'scan_discovered'
         AND (
           name GLOB '*[^A-Za-z0-9._-]*'
           OR name IN ('Installed','Version','Scope','Status','Location','Name','Source','Enabled')
         )
    `);
    db.exec("DROP TABLE IF EXISTS cheatcodes_new");
    db.exec(`
      CREATE TABLE cheatcodes_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT    NOT NULL UNIQUE,
          kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
          origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
          description  TEXT    NOT NULL DEFAULT '',
          source_url   TEXT,
          file_path    TEXT,
          version      TEXT,
          trust_tier   TEXT,
          scope        TEXT    NOT NULL DEFAULT 'project-local'
                         CHECK (scope IN ('global','template','project-local')),
          status       TEXT    NOT NULL DEFAULT 'installed',
          installed_at TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (kind != 'skill' OR file_path IS NOT NULL),
          CHECK (origin = 'builtin' OR source_url IS NOT NULL),
          CHECK (origin != 'builtin' OR source_url IS NULL)
      )
    `);
    db.exec(`
      INSERT INTO cheatcodes_new
        (id, name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      SELECT
        id, name, kind,
        CASE
          WHEN origin = 'builtin' THEN 'builtin'
          WHEN name IN ('typescript-lsp','mcp-server-dev','plugin-dev') THEN 'marketplace'
          WHEN name = 'superpowers' THEN 'external'
          WHEN source_url LIKE '%@%' AND source_url NOT LIKE '%://%' AND source_url NOT LIKE '%@%:%' THEN 'marketplace'
          WHEN source_url LIKE './%' THEN 'marketplace'
          ELSE 'external'
        END,
        description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at
      FROM cheatcodes
    `);
    db.exec("DROP TABLE cheatcodes");
    db.exec("ALTER TABLE cheatcodes_new RENAME TO cheatcodes");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV23toV24: foreign_key_check found ${violations.length} dangling reference(s) after the cheatcodes rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV24toV25(db) {
  if (!tableExists(db, "cheatcodes")) {
    return;
  }
  beginImmediate(db);
  try {
    deleteBuiltinCheatcodeAttachments(db, "tmb_push-triage");
    db.exec("DELETE FROM cheatcodes WHERE name = 'tmb_push-triage' AND origin = 'builtin'");
    db.exec(`
      INSERT OR IGNORE INTO cheatcodes
        (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at, created_at, updated_at)
      VALUES
        ('tmb_push-gate', 'skill', 'builtin',
         'Bro''s push-gate orchestration \u2014 reaping unsigned commits, spawning pr-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.',
         NULL, 'skills/tmb_push-gate/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now')),
        ('tmb_comment-triage', 'skill', 'builtin',
         'Bro''s PR/MR comment triage \u2014 resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.',
         NULL, 'skills/tmb_comment-triage/SKILL.md', NULL, 'curated', 'global', 'active',
         datetime('now'), datetime('now'), datetime('now'))
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV24toV25: foreign_key_check found ${violations.length} dangling reference(s) after the push-triage skill split`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV25toV26(db) {
  if (!tableExists(db, "validation_attempts")) return;
  if (hasColumn(db, "validation_attempts", "mcp_available")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  beginImmediate(db);
  try {
    db.exec("DROP TABLE IF EXISTS validation_attempts_new");
    db.exec(`
      CREATE TABLE validation_attempts_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id             INTEGER NOT NULL REFERENCES tasks(id),
          attempt_n           INTEGER NOT NULL,
          agent               TEXT    NOT NULL DEFAULT '',
          verdict             TEXT    NOT NULL,
          feedback            TEXT    NOT NULL DEFAULT '',
          mcp_available       INTEGER NOT NULL DEFAULT 1,
          subagent_session_id TEXT,
          repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
          created_at          TEXT    NOT NULL,
          UNIQUE(task_id, attempt_n)
      )
    `);
    db.exec(`
      INSERT INTO validation_attempts_new
        (id, task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, repo, created_at)
      SELECT
        id, task_id, attempt_n, agent, verdict, feedback,
        CASE WHEN feedback LIKE 'MCP available: no%' THEN 0 ELSE 1 END,
        subagent_session_id, repo, created_at
      FROM validation_attempts
    `);
    db.exec("DROP TABLE validation_attempts");
    db.exec("ALTER TABLE validation_attempts_new RENAME TO validation_attempts");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migrateV25toV26: foreign_key_check found ${violations.length} dangling reference(s) after the validation_attempts rebuild`
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
function migrateV26toV27(db) {
  if (!tableExists(db, "plugin_config")) return;
  beginImmediate(db);
  try {
    if (tableExists(db, "repos")) {
      const scalarFromConfig = (key) => {
        const row = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        if (!row?.value_json) return null;
        try {
          const v = JSON.parse(row.value_json);
          return typeof v === "string" && v.length > 0 ? v : null;
        } catch {
          return null;
        }
      };
      const rawFromConfig = (key) => {
        const row = db.prepare("SELECT value_json FROM plugin_config WHERE key = ?").get(key);
        return row?.value_json ?? null;
      };
      const prTarget = scalarFromConfig("pr_target");
      const branchingModel = scalarFromConfig("branching_model");
      const protectedBranches = rawFromConfig("protected_branches");
      const remotes = rawFromConfig("remotes");
      if (hasColumn(db, "repos", "target_branch") && prTarget !== null) {
        db.prepare("UPDATE repos SET target_branch = ? WHERE target_branch IS NULL").run(prTarget);
      }
      if (hasColumn(db, "repos", "branching_model") && branchingModel !== null) {
        db.prepare("UPDATE repos SET branching_model = ? WHERE branching_model IS NULL").run(
          branchingModel
        );
      }
      if (hasColumn(db, "repos", "protected_branches") && protectedBranches !== null) {
        db.prepare("UPDATE repos SET protected_branches = ? WHERE protected_branches IS NULL").run(
          protectedBranches
        );
      }
      if (hasColumn(db, "repos", "remotes") && remotes !== null) {
        db.prepare("UPDATE repos SET remotes = ? WHERE remotes IS NULL").run(remotes);
      }
    }
    db.prepare(
      // LINT-ALLOW: v27 migration intentionally removes the drained global policy keys (#980).
      "DELETE FROM plugin_config WHERE key IN ('pr_target', 'branching_model', 'protected_branches', 'remotes')"
    ).run();
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV7toV8(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TRIGGER IF EXISTS directories_au_new");
    db.exec("DROP TRIGGER IF EXISTS directories_au");
    db.exec("DROP TRIGGER IF EXISTS directories_ad");
    db.exec("DROP TRIGGER IF EXISTS directories_ai");
    db.exec("DROP INDEX IF EXISTS idx_directories_embeddings_model");
    db.exec("DROP INDEX IF EXISTS idx_directories_parent");
    db.exec("DROP TABLE IF EXISTS directories_embeddings");
    db.exec("DROP TABLE IF EXISTS directories_fts");
    db.exec("DROP TABLE IF EXISTS directories");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV6toV7(db) {
  beginImmediate(db);
  try {
    db.exec("DROP TRIGGER IF EXISTS file_registry_au_new");
    db.exec("DROP TRIGGER IF EXISTS file_registry_au");
    db.exec("DROP TRIGGER IF EXISTS file_registry_ad");
    db.exec("DROP TRIGGER IF EXISTS file_registry_ai");
    db.exec("DROP INDEX IF EXISTS idx_file_registry_embeddings_model");
    db.exec("DROP TABLE IF EXISTS file_registry_embeddings");
    db.exec("DROP TABLE IF EXISTS file_registry_fts");
    db.exec("DROP TABLE IF EXISTS file_registry");
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV5toV6(db) {
  beginImmediate(db);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS directories (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, parent_path TEXT, summary TEXT, summary_source TEXT CHECK (summary_source IN ('readme','llm','manual')) DEFAULT 'llm', summary_updated_at TEXT, file_count INTEGER NOT NULL DEFAULT 0, UNIQUE(repo, path))"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_directories_parent ON directories(repo, parent_path)"
    );
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS directories_fts USING fts5(summary, path, content='directories', tokenize='porter unicode61')"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ai AFTER INSERT ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_ad AFTER DELETE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au AFTER UPDATE ON directories WHEN old.summary IS NOT NULL BEGIN INSERT INTO directories_fts(directories_fts, rowid, summary, path) VALUES ('delete', old.id, old.summary, old.path); END"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS directories_au_new AFTER UPDATE ON directories WHEN new.summary IS NOT NULL BEGIN INSERT INTO directories_fts(rowid, summary, path) VALUES (new.id, new.summary, new.path); END"
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS directories_embeddings (directory_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model_id TEXT NOT NULL, embedded_at TEXT NOT NULL)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_directories_embeddings_model ON directories_embeddings(model_id)"
    );
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV4toV5(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "issues")) {
      if (!hasColumn(db, "issues", "gh_iid")) {
        db.exec("ALTER TABLE issues ADD COLUMN gh_iid INTEGER");
      }
      if (!hasColumn(db, "issues", "gl_iid")) {
        db.exec("ALTER TABLE issues ADD COLUMN gl_iid INTEGER");
      }
      db.exec(
        "UPDATE issues SET gh_iid = remote_iid WHERE remote_kind = 'github' AND remote_iid IS NOT NULL AND gh_iid IS NULL"
      );
      db.exec(
        "UPDATE issues SET gl_iid = remote_iid WHERE remote_kind = 'gitlab' AND remote_iid IS NOT NULL AND gl_iid IS NULL"
      );
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV3toV4(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "discussions")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discussions_embeddings (
          discussion_id INTEGER PRIMARY KEY REFERENCES discussions(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model
        ON discussions_embeddings(model_id)
      `);
    }
    if (tableExists(db, "audit")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_embeddings (
          audit_id INTEGER PRIMARY KEY REFERENCES audit(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model
        ON audit_embeddings(model_id)
      `);
    }
    if (tableExists(db, "file_registry")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_registry_embeddings (
          file_registry_id INTEGER PRIMARY KEY,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          embedded_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_registry_embeddings_model
        ON file_registry_embeddings(model_id)
      `);
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV2toV3(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "discussions")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5(
          body,
          content='discussions',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
          INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
          INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
        END
      `);
      db.exec(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
    }
    if (tableExists(db, "audit")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
          summary,
          content_json,
          content='audit',
          content_rowid='id',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ai AFTER INSERT ON audit BEGIN
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_ad AFTER DELETE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_au AFTER UPDATE ON audit BEGIN
          INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
          INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
        END
      `);
      db.exec(`INSERT INTO audit_fts(rowid, summary, content_json) SELECT id, summary, content_json FROM audit`);
    }
    if (tableExists(db, "file_registry")) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS file_registry_fts USING fts5(
          summary,
          path,
          content='file_registry',
          tokenize='porter unicode61'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ai AFTER INSERT ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_ad AFTER DELETE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au AFTER UPDATE ON file_registry
        WHEN old.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS file_registry_au_new AFTER UPDATE ON file_registry
        WHEN new.summary IS NOT NULL BEGIN
          INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
        END
      `);
      db.exec(`INSERT INTO file_registry_fts(rowid, summary, path) SELECT rowid, summary, path FROM file_registry WHERE summary IS NOT NULL`);
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}
function migrateV1toV2(db) {
  beginImmediate(db);
  try {
    if (tableExists(db, "identity") && tableExists(db, "plugin_config")) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM identity").get();
      if (row && row.n > 0) {
        db.exec(
          "INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')"
        );
      }
    }
    db.exec("DROP TABLE IF EXISTS identity");
    db.exec("DROP TABLE IF EXISTS regen_state");
    db.exec("DROP TABLE IF EXISTS project_metadata");
    if (tableExists(db, "skills") && !hasColumn(db, "skills", "scope")) {
      db.exec(
        "ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','template','project-local'))"
      );
    }
    if (tableExists(db, "tasks") && hasColumn(db, "tasks", "success_criteria")) {
      db.exec("DROP TABLE IF EXISTS tasks_new");
      db.exec(`
        CREATE TABLE tasks_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id          INTEGER NOT NULL REFERENCES issues(id),
            branch_id         TEXT    NOT NULL,
            parent_branch_id  TEXT,
            title             TEXT    NOT NULL DEFAULT '',
            description       TEXT    NOT NULL,
            status            TEXT    NOT NULL DEFAULT 'pending',
            attempts          INTEGER NOT NULL DEFAULT 0,
            spec_body         TEXT    NOT NULL DEFAULT '',
            commit_sha        TEXT,
            repo              TEXT,
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL,
            completed_at      TEXT
        )
      `);
      db.exec(`
        INSERT INTO tasks_new (id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at)
        SELECT id, issue_id, branch_id, parent_branch_id, title, description, status, attempts, spec_body, commit_sha, repo, created_at, updated_at, completed_at FROM tasks
      `);
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id)"
      );
    }
    if (tableExists(db, "roundtables") && hasColumn(db, "roundtables", "agent")) {
      db.exec("DROP TABLE IF EXISTS roundtables_new");
      db.exec(`
        CREATE TABLE roundtables_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id                INTEGER NOT NULL REFERENCES issues(id),
            topic                   TEXT    NOT NULL,
            outcome                 TEXT    NOT NULL DEFAULT '',
            created_at              TEXT    NOT NULL,
            closed_at               TEXT,
            state                   TEXT    NOT NULL DEFAULT 'collecting'
                                      CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
            expected_participants   INTEGER
        )
      `);
      const hasState = hasColumn(db, "roundtables", "state");
      const hasExpected = hasColumn(db, "roundtables", "expected_participants");
      const stateExpr = hasState ? "state" : "'collecting' AS state";
      const expectedExpr = hasExpected ? "expected_participants" : "NULL AS expected_participants";
      db.exec(`
        INSERT INTO roundtables_new (id, issue_id, topic, outcome, created_at, closed_at, state, expected_participants)
        SELECT id, issue_id, topic, outcome, created_at, closed_at, ${stateExpr}, ${expectedExpr} FROM roundtables
      `);
      db.exec("DROP TABLE roundtables");
      db.exec("ALTER TABLE roundtables_new RENAME TO roundtables");
    }
    if (tableExists(db, "roundtable_votes") && hasColumn(db, "roundtable_votes", "agent")) {
      db.exec("DROP TABLE IF EXISTS roundtable_votes_new");
      db.exec(`
        CREATE TABLE roundtable_votes_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
            participant    TEXT    NOT NULL,
            vote           TEXT    NOT NULL,
            rationale      TEXT    NOT NULL DEFAULT '',
            created_at     TEXT    NOT NULL
        )
      `);
      const hasParticipant = hasColumn(db, "roundtable_votes", "participant");
      const participantExpr = hasParticipant ? "participant" : "agent AS participant";
      db.exec(`
        INSERT INTO roundtable_votes_new (id, roundtable_id, participant, vote, rationale, created_at)
        SELECT id, roundtable_id, ${participantExpr}, vote, rationale, created_at FROM roundtable_votes
      `);
      db.exec("DROP TABLE roundtable_votes");
      db.exec("ALTER TABLE roundtable_votes_new RENAME TO roundtable_votes");
    }
    if (tableExists(db, "file_registry")) {
      const stale = [
        "size_bytes",
        "last_commit_sha",
        "language",
        "last_change_type",
        "last_change_at",
        "imports_json",
        "exports_json",
        "metadata_json"
      ];
      const hasStale = stale.some((c) => hasColumn(db, "file_registry", c));
      if (hasStale) {
        db.exec("DROP TABLE IF EXISTS file_registry_new");
        db.exec(`
          CREATE TABLE file_registry_new (
              repo                TEXT NOT NULL DEFAULT '',
              path                TEXT NOT NULL,
              type                TEXT NOT NULL DEFAULT 'unknown',
              content_md5         TEXT,
              summary             TEXT,
              summary_updated_at  TEXT,
              PRIMARY KEY (repo, path)
          )
        `);
        const hasRepo = hasColumn(db, "file_registry", "repo");
        const hasType = hasColumn(db, "file_registry", "type");
        const hasContentMd5 = hasColumn(db, "file_registry", "content_md5");
        const hasSummary = hasColumn(db, "file_registry", "summary");
        const hasSummaryUpdated = hasColumn(db, "file_registry", "summary_updated_at");
        const repoExpr = hasRepo ? "repo" : "'' AS repo";
        const typeExpr = hasType ? "type" : "'unknown' AS type";
        const md5Expr = hasContentMd5 ? "content_md5" : "NULL AS content_md5";
        const summaryExpr = hasSummary ? "summary" : "NULL AS summary";
        const summaryUpdatedExpr = hasSummaryUpdated ? "summary_updated_at" : "NULL AS summary_updated_at";
        db.exec(`
          INSERT OR IGNORE INTO file_registry_new (repo, path, type, content_md5, summary, summary_updated_at)
          SELECT ${repoExpr}, path, ${typeExpr}, ${md5Expr}, ${summaryExpr}, ${summaryUpdatedExpr} FROM file_registry
        `);
        db.exec("DROP TABLE file_registry");
        db.exec("ALTER TABLE file_registry_new RENAME TO file_registry");
      }
    }
    if (tableExists(db, "agent_runs")) {
      if (!hasColumn(db, "agent_runs", "started_at")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN started_at TEXT");
      }
      const cols = db.prepare("PRAGMA table_info(agent_runs)").all();
      const completedCol = cols.find((c) => c.name === "completed_at");
      if (completedCol && completedCol.notnull === 1) {
        db.exec("DROP TABLE IF EXISTS agent_runs_new");
        db.exec(`
          CREATE TABLE agent_runs_new (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id      INTEGER REFERENCES tasks(id),
              issue_id     INTEGER REFERENCES issues(id),
              agent_type   TEXT    NOT NULL,
              tokens_in    INTEGER NOT NULL DEFAULT 0,
              tokens_out   INTEGER NOT NULL DEFAULT 0,
              tokens_total INTEGER NOT NULL DEFAULT 0,
              tool_uses    INTEGER NOT NULL DEFAULT 0,
              duration_ms  INTEGER NOT NULL DEFAULT 0,
              started_at   TEXT,
              completed_at TEXT
          )
        `);
        db.exec(`
          INSERT INTO agent_runs_new (id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at)
          SELECT id, task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, started_at, completed_at FROM agent_runs
        `);
        db.exec("DROP TABLE agent_runs");
        db.exec("ALTER TABLE agent_runs_new RENAME TO agent_runs");
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)"
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id)"
        );
      }
    }
    commitTransaction(db);
  } catch (err3) {
    try {
      rollbackTransaction(db);
    } catch {
    }
    throw err3;
  }
}

// src/fts-query.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your"
]);
function queryTokens(raw) {
  return Array.from(raw.matchAll(/"([^"]*)"|\S+/g), (m) => (m[1] ?? m[0].replace(/^"+|"+$/g, "")).trim()).filter(
    (token) => token.length > 0
  );
}
function quoted(token) {
  return `"${token.replace(/"/g, '""')}"`;
}
function toFtsQuery(raw) {
  const tokens = queryTokens(raw).map(quoted);
  return tokens.length > 0 ? tokens.join(" ") : '""';
}
function toFtsOrQuery(raw) {
  const tokens = queryTokens(raw).filter((token) => {
    const word = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    return word.length > 0 && !STOPWORDS.has(word);
  });
  return tokens.length > 0 ? tokens.map(quoted).join(" OR ") : null;
}
function withFtsGuard(run2) {
  try {
    return run2();
  } catch (e) {
    const message2 = e instanceof Error ? e.message : String(e);
    if (/fts5|no such column/i.test(message2)) {
      throw new Error(`fts_query_invalid: ${message2}`);
    }
    throw e;
  }
}

// src/graph.ts
var SUBTREE_MAX_DEPTH = 256;
var DIR_COLUMNS = "d.id, d.repo, d.path, d.parent_path, d.summary, d.summary_source, d.summary_updated_at, d.file_count, d.summary_sha, d.commits_behind, d.dead_refs";
var FILE_COLUMNS = "f.id, f.repo, f.path, f.dir, f.purpose, f.purpose_source, f.content_md5, f.size_bytes, f.last_commit_sha, f.updated_at";
function toDirectoryNode(r) {
  return {
    key: WorldModelGraph.dirKey(r.repo, r.path),
    repo: r.repo,
    path: r.path,
    parent_path: r.parent_path,
    summary: r.summary || null,
    summary_source: r.summary_source,
    summary_updated_at: r.summary_updated_at || null,
    file_count: Number(r.file_count),
    summary_sha: r.summary_sha ?? null,
    commits_behind: r.commits_behind === null || r.commits_behind === void 0 ? null : Number(r.commits_behind),
    dead_refs: parseDeadRefs(r.dead_refs)
  };
}
function parseDeadRefs(raw) {
  if (raw === null || raw === void 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : null;
  } catch {
    return null;
  }
}
function toFileNode(r) {
  return {
    path: WorldModelGraph.fileKey(r.repo, r.path),
    repo: r.repo,
    dir: r.dir,
    purpose: r.purpose,
    purpose_source: r.purpose_source,
    content_md5: r.content_md5,
    size_bytes: Number(r.size_bytes),
    last_commit_sha: r.last_commit_sha,
    updated_at: r.updated_at
  };
}
function rankWithFallback(query, search) {
  const allTerms = toFtsQuery(query);
  const all = withFtsGuard(() => search(allTerms));
  if (all.length > 0) return { rows: all, match: "all_terms" };
  const any = toFtsOrQuery(query);
  if (any === null || any === allTerms) return { rows: all, match: "all_terms" };
  return { rows: withFtsGuard(() => search(any)), match: "any_term" };
}
function placeholders(n) {
  return Array.from({ length: n }, () => "?").join(", ");
}
var WorldModelGraph = class _WorldModelGraph {
  constructor(db) {
    this.db = db;
  }
  db;
  transaction(fn) {
    return this.db.transaction(fn);
  }
  tableNames() {
    return this.db.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wm\\_%' ESCAPE '\\' ORDER BY name`
    ).map((r) => r.name);
  }
  // File keys are '<repo>/<repo-relative path>'; repo names are directory
  // basenames, so the first '/' always separates the two.
  static fileKey(repo, relPath) {
    return `${repo}/${relPath}`;
  }
  static relativeFilePath(node) {
    return node.path.startsWith(`${node.repo}/`) ? node.path.slice(node.repo.length + 1) : node.path;
  }
  // JSON tuple so a ':' (or any delimiter) in repo/path can't collide. (#282)
  static dirKey(repo, path) {
    return JSON.stringify([repo, path]);
  }
  upsertFile(node) {
    this.db.run(
      `INSERT INTO wm_files (repo, path, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         dir = excluded.dir,
         purpose = excluded.purpose,
         purpose_source = excluded.purpose_source,
         content_md5 = excluded.content_md5,
         size_bytes = excluded.size_bytes,
         last_commit_sha = excluded.last_commit_sha,
         updated_at = excluded.updated_at`,
      [
        node.repo,
        _WorldModelGraph.relativeFilePath(node),
        node.dir,
        node.purpose,
        node.purpose_source,
        node.content_md5,
        node.size_bytes,
        node.last_commit_sha,
        node.updated_at
      ]
    );
  }
  upsertHasFile(repo, dir, filePath) {
    this.db.run(`UPDATE wm_files SET dir = ? WHERE repo = ? AND path = ? AND dir IS NOT ?`, [
      dir,
      repo,
      _WorldModelGraph.relativeFilePath({ repo, path: filePath }),
      dir
    ]);
  }
  allFilesForRepo(repo) {
    return this.db.all(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? ORDER BY f.path`, [repo]).map(toFileNode);
  }
  filesForDirectory(repo, dir) {
    return this.db.all(`SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.repo = ? AND f.dir = ? ORDER BY f.path`, [
      repo,
      dir
    ]).map(toFileNode);
  }
  filePathsWithDirectory(repo) {
    const rows = this.db.all(
      `SELECT f.path FROM wm_files f
         JOIN wm_directories d ON d.repo = f.repo AND d.path = f.dir
        WHERE f.repo = ?`,
      [repo]
    );
    return new Set(rows.map((r) => _WorldModelGraph.fileKey(repo, r.path)));
  }
  pruneFiles(repo, keepPaths) {
    const stale = this.db.all(`SELECT id, path FROM wm_files WHERE repo = ?`, [repo]).filter((f) => !keepPaths.has(_WorldModelGraph.fileKey(repo, f.path)));
    for (const f of stale) {
      this.db.run(`DELETE FROM wm_symbols WHERE repo = ? AND path = ?`, [repo, f.path]);
      this.db.run(`DELETE FROM wm_files WHERE id = ?`, [f.id]);
    }
    if (stale.length > 0) {
      this.db.run(`UPDATE wm_edges SET resolution = 'unresolved' WHERE dst_id IS NULL AND resolution <> 'unresolved'`);
    }
    return stale.length;
  }
  fileCoverage(repo) {
    const rows = this.db.all(
      `SELECT purpose_source AS source, COUNT(*) AS n, SUM(CASE WHEN purpose <> '' THEN 1 ELSE 0 END) AS with_purpose
         FROM wm_files WHERE repo = ? GROUP BY purpose_source`,
      [repo]
    );
    const coverage = { files: 0, with_purpose: 0, by_source: {} };
    for (const r of rows) {
      const n = Number(r.n);
      coverage.files += n;
      coverage.with_purpose += Number(r.with_purpose ?? 0);
      coverage.by_source[r.source] = n;
    }
    return coverage;
  }
  // FTS5 hits over path + purpose ranked by bm25 (score = -bm25, higher is
  // better; any-term fallback per rankWithFallback), then case-insensitive
  // path/purpose substring hits at score 0. CROSS JOIN keeps the FTS match as
  // the outer loop; a plain JOIN lets the planner walk every repo row instead.
  keywordSearchFiles(repo, query, k) {
    const { rows: ranked, match } = rankWithFallback(
      query,
      (fts) => this.db.all(
        `SELECT ${FILE_COLUMNS}, bm25(wm_files_fts) AS rank
           FROM wm_files_fts CROSS JOIN wm_files f ON f.id = wm_files_fts.rowid
          WHERE wm_files_fts MATCH ? AND f.repo = ?
          ORDER BY rank, f.path
          LIMIT ?`,
        [fts, repo, k]
      )
    );
    const hits = ranked.map((r) => ({ ...toFileNode(r), score: -r.rank }));
    if (hits.length >= k) return { hits, match };
    const seen = new Set(ranked.map((r) => r.id));
    const needle = query.toLowerCase();
    const substring = this.db.all(
      `SELECT ${FILE_COLUMNS} FROM wm_files f
          WHERE f.repo = ? AND (instr(lower(f.path), ?) > 0 OR instr(lower(f.purpose), ?) > 0)
          ORDER BY f.path
          LIMIT ?`,
      [repo, needle, needle, k + seen.size]
    ).filter((r) => !seen.has(r.id));
    return { hits: [...hits, ...substring.map((r) => ({ ...toFileNode(r), score: 0 }))].slice(0, k), match };
  }
  filesByIds(ids) {
    if (ids.length === 0) return /* @__PURE__ */ new Map();
    const rows = this.db.all(
      `SELECT ${FILE_COLUMNS} FROM wm_files f WHERE f.id IN (${placeholders(ids.length)})`,
      ids
    );
    return new Map(rows.map((r) => [r.id, toFileNode(r)]));
  }
  upsertDirectory(node) {
    this.db.run(
      `INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count, summary_sha, commits_behind, dead_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         parent_path = excluded.parent_path,
         summary = excluded.summary,
         summary_source = excluded.summary_source,
         summary_updated_at = excluded.summary_updated_at,
         file_count = excluded.file_count,
         summary_sha = excluded.summary_sha,
         commits_behind = excluded.commits_behind,
         dead_refs = excluded.dead_refs`,
      [
        node.repo,
        node.path,
        node.parent_path,
        node.summary,
        node.summary_source,
        node.summary_updated_at,
        node.file_count,
        node.summary_sha ?? null,
        node.commits_behind ?? null,
        node.dead_refs ? JSON.stringify(node.dead_refs) : null
      ]
    );
  }
  upsertContains(parent, child) {
    if (parent.repo !== child.repo) return;
    this.db.run(
      `UPDATE wm_directories SET parent_path = ?
        WHERE repo = ? AND path = ? AND parent_path IS NOT ?
          AND EXISTS (SELECT 1 FROM wm_directories p WHERE p.repo = ? AND p.path = ?)`,
      [parent.path, child.repo, child.path, parent.path, parent.repo, parent.path]
    );
  }
  pruneDirectories(repo, keepKeys) {
    const stale = this.db.all(`SELECT id, path FROM wm_directories WHERE repo = ?`, [repo]).filter((d) => !keepKeys.has(_WorldModelGraph.dirKey(repo, d.path)));
    for (const d of stale) this.db.run(`DELETE FROM wm_directories WHERE id = ?`, [d.id]);
    return stale.length;
  }
  // Move every directory, file, symbol and concept row of oldRepo under newRepo in one
  // transaction, replacing any leftover rows already filed under newRepo.
  // Row ids survive, so FTS, embedding and edge rows stay attached. Returns
  // the number of directories moved.
  renameRepo(oldRepo, newRepo) {
    return this.db.transaction(() => {
      const moved = this.directoryCount(oldRepo);
      if (moved === 0) return 0;
      this.db.run(`DELETE FROM wm_directories WHERE repo = ?`, [newRepo]);
      this.db.run(`DELETE FROM wm_files WHERE repo = ?`, [newRepo]);
      this.db.run(`DELETE FROM wm_symbols WHERE repo = ?`, [newRepo]);
      this.db.run(`DELETE FROM wm_concepts WHERE repo = ?`, [newRepo]);
      this.db.run(`UPDATE wm_directories SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_files SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_symbols SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_concepts SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_concept_steps SET repo = ? WHERE repo = ?`, [newRepo, oldRepo]);
      this.db.run(`UPDATE wm_edges SET resolution = 'unresolved' WHERE dst_id IS NULL AND resolution <> 'unresolved'`);
      return moved;
    });
  }
  allDirectoriesForRepo(repo) {
    return this.db.all(`SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.repo = ? ORDER BY d.path`, [repo]).map(toDirectoryNode);
  }
  // The directory at `path` plus its descendants down to `depth` levels below
  // it (null = the whole subtree), via a recursive CTE over parent_path.
  subtree(repo, path, depth) {
    const cap = depth === null ? SUBTREE_MAX_DEPTH : Math.max(0, Math.min(depth, SUBTREE_MAX_DEPTH));
    return this.db.all(
      `WITH RECURSIVE sub(id, path, lvl) AS (
           SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT c.id, c.path, s.lvl + 1
             FROM wm_directories c JOIN sub s ON c.parent_path = s.path
            WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
         )
         SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.id IN (SELECT id FROM sub)
          ORDER BY d.path`,
      [repo, path, repo, cap]
    ).map(toDirectoryNode);
  }
  // The directory at `path` and each of its ancestors, root first.
  ancestors(repo, path) {
    return this.db.all(
      `WITH RECURSIVE up(id, parent_path, lvl) AS (
           SELECT id, parent_path, 0 FROM wm_directories WHERE repo = ? AND path = ?
           UNION
           SELECT p.id, p.parent_path, u.lvl + 1
             FROM wm_directories p JOIN up u ON p.path = u.parent_path
            WHERE p.repo = ? AND u.lvl < ?
         )
         SELECT ${DIR_COLUMNS}, up.lvl FROM up JOIN wm_directories d ON d.id = up.id
          ORDER BY up.lvl DESC`,
      [repo, path, repo, SUBTREE_MAX_DEPTH]
    ).map(toDirectoryNode);
  }
  // FTS5 hits over path + summary ranked by bm25 (score = -bm25, higher is
  // better; any-term fallback per rankWithFallback), then case-insensitive
  // path/summary substring hits at score 0.
  keywordSearchDirectories(repo, query, k) {
    const { rows: ranked, match } = rankWithFallback(
      query,
      (fts) => this.db.all(
        `SELECT ${DIR_COLUMNS}, bm25(wm_directories_fts) AS rank
           FROM wm_directories_fts CROSS JOIN wm_directories d ON d.id = wm_directories_fts.rowid
          WHERE wm_directories_fts MATCH ? AND d.repo = ?
          ORDER BY rank, d.path
          LIMIT ?`,
        [fts, repo, k]
      )
    );
    const hits = ranked.map((r) => ({ ...toDirectoryNode(r), score: -r.rank }));
    if (hits.length >= k) return { hits, match };
    const seen = new Set(ranked.map((r) => r.id));
    const needle = query.toLowerCase();
    const substring = this.db.all(
      `SELECT ${DIR_COLUMNS} FROM wm_directories d
          WHERE d.repo = ? AND (instr(lower(d.path), ?) > 0 OR instr(lower(coalesce(d.summary, '')), ?) > 0)
          ORDER BY d.path
          LIMIT ?`,
      [repo, needle, needle, k + seen.size]
    ).filter((r) => !seen.has(r.id));
    return { hits: [...hits, ...substring.map((r) => ({ ...toDirectoryNode(r), score: 0 }))].slice(0, k), match };
  }
  directoriesByIds(ids) {
    if (ids.length === 0) return /* @__PURE__ */ new Map();
    const rows = this.db.all(
      `SELECT ${DIR_COLUMNS} FROM wm_directories d WHERE d.id IN (${placeholders(ids.length)})`,
      ids
    );
    return new Map(rows.map((r) => [r.id, toDirectoryNode(r)]));
  }
  directoryCount(repo) {
    const row = repo === void 0 ? this.db.get(`SELECT COUNT(*) AS n FROM wm_directories`) : this.db.get(`SELECT COUNT(*) AS n FROM wm_directories WHERE repo = ?`, [repo]);
    return Number(row?.n ?? 0);
  }
  // The graph borrows the trajectory DB handle; its owner closes it.
  close() {
  }
};
var GraphHolder = class _GraphHolder {
  constructor(graph, openError = null) {
    this.graph = graph;
    this.openError = openError;
  }
  graph;
  openError;
  static fixed(graph, openError = null) {
    return new _GraphHolder(graph, openError);
  }
  ensureGraph() {
    return this.graph;
  }
};

// src/graph-db.ts
var WorldModelGraph2 = class extends WorldModelGraph {
  openError = null;
  owned;
  constructor(db) {
    const owned = typeof db === "string" ? new TrajectoryDB(db) : null;
    super(owned ?? db);
    this.owned = owned;
  }
  ensureGraph() {
    return this;
  }
  close() {
    if (this.owned?.isOpen) this.owned.close();
  }
};

// src/tools/scan.ts
import { spawn, spawnSync as spawnSync6 } from "node:child_process";
import { existsSync as existsSync6, readFileSync as readFileSync6, realpathSync as realpathSync2, writeFileSync, unlinkSync } from "node:fs";
import { dirname as dirname5, join as join13 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/middleware/agent-scope.ts
var FIRST_CLASS_ROLES = /* @__PURE__ */ new Set(["bro", "swe", "code-reviewer"]);
function normalizeAgent(name2) {
  if (typeof name2 !== "string") return "unknown";
  const lower = name2.toLowerCase().replace(/^tmb:/, "");
  if (!lower) return "unknown";
  if (FIRST_CLASS_ROLES.has(lower)) return lower;
  if (/^[a-z][a-z0-9_-]*$/.test(lower)) return "consultant";
  return "unknown";
}
var VALID_AGENTS = ["bro", "swe", "code-reviewer", "consultant slug matching ^[a-z][a-z0-9_-]*$"];
function missingAgentDiagnostics(toolName, allowedRoles, received) {
  const agentReceived = received === void 0 ? null : received;
  return {
    reason: "agent_missing_or_invalid",
    agent_received: agentReceived,
    valid_agents: VALID_AGENTS,
    message: `\`agent\` was missing or invalid (received: ${JSON.stringify(agentReceived)}). This is a missing-argument error, not a role restriction \u2014 retry with agent set to your role: 'bro', 'swe', 'code-reviewer', or a consultant slug matching ^[a-z][a-z0-9_-]*$. ${toolName} accepts: ${allowedRoles.join(", ")}.`
  };
}
function forbidden(toolName, agent, allowedRoles, received) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "forbidden",
          tool: toolName,
          caller_role: agent,
          allowed_roles: [...allowedRoles],
          ...agent === "unknown" ? missingAgentDiagnostics(toolName, allowedRoles, received) : {}
        })
      }
    ]
  };
}
var gatedRoles = /* @__PURE__ */ new WeakMap();
function requireRoles(toolName, allowedRoles, handler) {
  const allowed = new Set(allowedRoles);
  const gated = async (args2) => {
    const agent = normalizeAgent(args2["agent"]);
    if (!allowed.has(agent)) return forbidden(toolName, agent, allowedRoles, args2["agent"]);
    return handler(args2);
  };
  gatedRoles.set(gated, [...allowedRoles]);
  return gated;
}

// src/embeddings/model.ts
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";
import { pathToFileURL } from "node:url";

// src/runtime-deps.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
import { join as join4, resolve } from "node:path";
var TRANSFORMERS_VERSION = "3.8.1";
var TRANSFORMERS_PACKAGE = "@huggingface/transformers";
function runtimeDepsKey(platform = process.platform, arch = process.arch, version = TRANSFORMERS_VERSION) {
  return `${version}-${platform}-${arch}`;
}
function runtimeDepsRoot(dataDir = process.env.CLAUDE_PLUGIN_DATA, key = runtimeDepsKey()) {
  return dataDir ? join4(dataDir, "deps", key) : void 0;
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readPackageJson(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync3(join4(pkgDir, "package.json"), "utf8"));
    return isObject(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
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
  return join4(root, "node_modules", TRANSFORMERS_PACKAGE);
}
function transformersEsmEntry(root) {
  const pkgDir = transformersPackageDir(root);
  const target = nodeImportDefault(rootExport(readPackageJson(pkgDir)?.["exports"]));
  if (!target) return void 0;
  const entry = resolve(pkgDir, target);
  return existsSync2(entry) ? entry : void 0;
}

// src/embeddings/model.ts
var TMB_MODEL_CACHE_DIR = process.env["TMB_MODEL_CACHE_DIR"] ?? process.env["HF_HOME"] ?? join5(homedir2(), ".cache", "huggingface");
var MODEL_REPO = "Xenova/bge-small-en-v1.5";
var MODEL_DTYPE = "q8";
var MODEL_ID = `${MODEL_REPO}@${MODEL_DTYPE}`;
var EMBED_RETRY_SCHEDULE_MS = [6e4, 3e5, 6e5];
var EMBED_FAIL_THRESHOLD_DEFAULT = 5;
function transformersSources(dataDir = process.env["CLAUDE_PLUGIN_DATA"]) {
  const root = runtimeDepsRoot(dataDir);
  if (!root) return { specifiers: [TRANSFORMERS_PACKAGE], misses: ["CLAUDE_PLUGIN_DATA is unset"] };
  const entry = transformersEsmEntry(root);
  if (!entry) return { specifiers: [TRANSFORMERS_PACKAGE], misses: [`no ${TRANSFORMERS_PACKAGE} at ${transformersPackageDir(root)}`] };
  return { specifiers: [pathToFileURL(entry).href, TRANSFORMERS_PACKAGE], misses: [] };
}
async function importTransformers(sources = transformersSources(), importer = (s) => import(s)) {
  const failures = [...sources.misses];
  for (const specifier of sources.specifiers) {
    try {
      return await importer(specifier);
    } catch (e) {
      failures.push(`${specifier}: ${message(e)}`);
    }
  }
  throw new Error(`${TRANSFORMERS_PACKAGE} did not load (${failures.join("; ")})`);
}
async function defaultLoader() {
  const { pipeline, env } = await importTransformers();
  env.cacheDir = TMB_MODEL_CACHE_DIR;
  return await pipeline("feature-extraction", MODEL_REPO, { dtype: MODEL_DTYPE });
}
var now = Date.now;
var loader = defaultLoader;
var pipePromise = null;
var loadingSince = null;
var readySince = null;
var consecutiveFailures = 0;
var degraded = null;
var retrying = false;
var listeners = /* @__PURE__ */ new Set();
function embedRetryDelayMs(retries, env = process.env) {
  const raw = env["TMB_EMBED_RETRY_MS"];
  const override = raw === void 0 || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(override) && override >= 0) return override;
  return EMBED_RETRY_SCHEDULE_MS[Math.min(retries, EMBED_RETRY_SCHEDULE_MS.length - 1)];
}
function embedFailThreshold(env = process.env) {
  const raw = Number(env["TMB_EMBED_FAIL_THRESHOLD"]);
  return Number.isInteger(raw) && raw > 0 ? raw : EMBED_FAIL_THRESHOLD_DEFAULT;
}
function emit(t) {
  for (const l of listeners) {
    try {
      l(t);
    } catch (e) {
      console.error("[embeddings] transition listener failed:", e);
    }
  }
}
function message(e) {
  return e instanceof Error ? e.message : String(e);
}
function loadPipe() {
  if (!pipePromise) {
    loadingSince = new Date(now()).toISOString();
    readySince = null;
    const p = loader();
    pipePromise = p;
    p.then(
      () => {
        if (pipePromise !== p) return;
        readySince = new Date(now()).toISOString();
        if (!degraded) emit({ kind: "ready" });
      },
      () => {
        if (pipePromise === p) pipePromise = null;
      }
    );
  }
  return pipePromise;
}
function enterDegraded(reason) {
  if (degraded) return;
  degraded = { since: new Date(now()).toISOString(), reason, retries: 0, nextRetryAt: now() + embedRetryDelayMs(0) };
  emit({ kind: "degraded", reason, consecutive_failures: consecutiveFailures });
}
async function retry(text) {
  const d = degraded;
  retrying = true;
  pipePromise = null;
  try {
    const pipe = await loadPipe();
    const result2 = await pipe(text, { pooling: "mean", normalize: true });
    consecutiveFailures = 0;
    degraded = null;
    emit({ kind: "recovered", degraded_since: d.since, reason: d.reason, retries: d.retries + 1 });
    return new Float32Array(result2.data);
  } catch (e) {
    console.error("[embeddings] re-attempt failed:", e);
    consecutiveFailures++;
    d.retries++;
    d.reason = `re-attempt failed: ${message(e)}`;
    d.nextRetryAt = now() + embedRetryDelayMs(d.retries);
    return null;
  } finally {
    retrying = false;
  }
}
async function embed(text) {
  if (degraded) {
    if (retrying || now() < degraded.nextRetryAt) return null;
    return retry(text);
  }
  let pipe;
  try {
    pipe = await loadPipe();
  } catch (e) {
    if (degraded) return null;
    console.error("[embeddings] model load failed:", e);
    consecutiveFailures++;
    enterDegraded(`model load failed: ${message(e)}`);
    return null;
  }
  try {
    const result2 = await pipe(text, { pooling: "mean", normalize: true });
    consecutiveFailures = 0;
    return new Float32Array(result2.data);
  } catch (e) {
    console.error("[embeddings] embed failed:", e);
    if (degraded) return null;
    consecutiveFailures++;
    if (consecutiveFailures >= embedFailThreshold()) {
      enterDegraded(`${consecutiveFailures} consecutive embed failures: ${message(e)}`);
    }
    return null;
  }
}

// src/embeddings/store.ts
function packEmbedding(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
var INSERT_SQL = {
  discussions: "INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  audit: "INSERT OR REPLACE INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  wm_directories: "INSERT OR REPLACE INTO wm_directories_embeddings (dir_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)",
  wm_files: "INSERT OR REPLACE INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)"
};
function auditEmbedText(summary, contentJson) {
  return contentJson && contentJson !== "{}" ? `${summary} ${contentJson}` : summary;
}
async function embedAndStore(db, table, rowid, text) {
  const v = await embed(text);
  if (v === null || !db.isOpen) return;
  const sql = INSERT_SQL[table];
  db.run(sql, [rowid, packEmbedding(v), MODEL_ID, (/* @__PURE__ */ new Date()).toISOString()]);
}

// src/embeddings/backfill.ts
var MISSING_WHERE = {
  discussions: "id NOT IN (SELECT discussion_id FROM discussions_embeddings WHERE model_id = ?)",
  audit: "id NOT IN (SELECT audit_id FROM audit_embeddings WHERE model_id = ?)",
  wm_directories: "id NOT IN (SELECT dir_id FROM wm_directories_embeddings WHERE model_id = ?)",
  wm_files: "purpose <> '' AND id NOT IN (SELECT file_id FROM wm_files_embeddings WHERE model_id = ?)"
};
var MISSING_SQL = {
  discussions: `SELECT id, body AS text FROM discussions WHERE ${MISSING_WHERE.discussions} ORDER BY id DESC LIMIT ?`,
  audit: `SELECT id, summary AS text, content_json FROM audit WHERE ${MISSING_WHERE.audit} ORDER BY id DESC LIMIT ?`,
  wm_directories: `SELECT id, CASE WHEN path = '' THEN repo ELSE path END AS text, summary AS body FROM wm_directories WHERE ${MISSING_WHERE.wm_directories} ORDER BY id DESC LIMIT ?`,
  wm_files: `SELECT id, path AS text, purpose AS body FROM wm_files WHERE ${MISSING_WHERE.wm_files} ORDER BY id DESC LIMIT ?`
};

// src/tools/audit.ts
function resolveIssueRepo(db, issueId) {
  return db.get("SELECT repo FROM issues WHERE id = ?", [issueId])?.repo ?? null;
}
var AuditWriterError = class extends Error {
  constructor(eventType, writer) {
    super(
      `audit_event_not_writable_by_role: '${writer}' may not write '${eventType}' (writers: ${auditEventWriters(eventType).join(", ")})`
    );
    this.eventType = eventType;
    this.writer = writer;
  }
  eventType;
  writer;
};
function insertAudit(db, entry) {
  assertAuditEventType(entry.event_type);
  if (entry.writer !== void 0 && !isAuditEventWritableBy(entry.event_type, entry.writer)) {
    throw new AuditWriterError(entry.event_type, entry.writer);
  }
  const contentJson = entry.content_json ?? "{}";
  const repo = entry.repo ?? resolveIssueRepo(db, entry.issue_id);
  const res = db.run(
    `INSERT INTO audit
       (issue_id, branch_id, from_node, event_type, summary, content_json, created_at, repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.issue_id,
      entry.branch_id ?? null,
      entry.from_node,
      entry.event_type,
      entry.summary,
      contentJson,
      entry.created_at ?? nowISO(),
      repo
    ]
  );
  const id = Number(res.lastInsertRowid);
  void embedAndStore(db, "audit", id, auditEmbedText(entry.summary, contentJson)).catch(
    (e) => console.error("[embeddings] insertAudit embed failed:", e)
  );
  return id;
}

// src/file-purpose.ts
var PURPOSE_HEAD_BYTES = 4096;
var PURPOSE_MAX_CHARS = 200;
var NONE = { purpose: "", source: "none" };
var MANIFESTS = /* @__PURE__ */ new Set(["package.json", "plugin.json", "marketplace.json"]);
var COMMENT_STYLES = {
  ts: { line: ["//"], block: true },
  tsx: { line: ["//"], block: true },
  js: { line: ["//"], block: true },
  mjs: { line: ["//"], block: true },
  sh: { line: ["#"], block: false },
  pl: { line: ["#"], block: false },
  sql: { line: ["--"], block: true }
};
var JSDOC_EXTS = /* @__PURE__ */ new Set(["ts", "tsx", "js", "mjs"]);
var STRUCTURAL_EXTS = /* @__PURE__ */ new Set(["json", "yml", "yaml", "txt"]);
var DIRECTIVE_LINE = /^(spdx-license-identifier|copyright|\(c\)|©|licensed under|all rights reserved|shellcheck |eslint|prettier-ignore|@ts-|-\*-|vim:|jshint|global )/i;
function baseName(path) {
  const i2 = path.lastIndexOf("/");
  return i2 >= 0 ? path.slice(i2 + 1) : path;
}
function extension(path) {
  const name2 = baseName(path);
  const i2 = name2.lastIndexOf(".");
  return i2 > 0 ? name2.slice(i2 + 1).toLowerCase() : "";
}
function inChangelogDir(path) {
  return /(^|\/)changelog\.d\//.test(path);
}
function isPurposeCandidate(path) {
  const ext = extension(path);
  return MANIFESTS.has(baseName(path)) || ext === "py" || ext === "md" || ext in COMMENT_STYLES || STRUCTURAL_EXTS.has(ext) || inChangelogDir(path);
}
function capChars(text, max) {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}\u2026`;
}
function normalizePurpose(raw) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const end = /[.!?](?=\s+[A-Z0-9`'"(\[]|\s*$)/.exec(text);
  return capChars(end ? text.slice(0, end.index + 1) : text, PURPOSE_MAX_CHARS);
}
function result(raw, source) {
  const purpose = normalizePurpose(raw);
  return purpose ? { purpose, source } : null;
}
function built(raw, source) {
  const purpose = capChars(raw.replace(/\s+/g, " ").trim(), PURPOSE_MAX_CHARS);
  return purpose ? { purpose, source } : null;
}
function fitList(label, items, budget, sep3 = ", ") {
  let out2 = `${label}: `;
  let n = 0;
  for (const item of items) {
    const rest = items.length - n - 1;
    const more = rest > 0 ? `${sep3}+${rest} more` : "";
    if (n > 0 && out2.length + sep3.length + item.length + more.length > budget) break;
    out2 += (n > 0 ? sep3 : "") + item;
    n++;
  }
  return n < items.length ? `${out2}${sep3}+${items.length - n} more` : out2;
}
function firstParagraph(lines2) {
  const out2 = [];
  for (const l of lines2) {
    if (l.trim() === "") {
      if (out2.length > 0) break;
      continue;
    }
    out2.push(l.trim());
  }
  return out2.join(" ");
}
function stripBlockComment(body2) {
  return body2.split("\n").map((l) => l.replace(/^\s*\*+\s?/, "").replace(/\s*\*+$/, ""));
}
function fromJsdoc(head) {
  const blocks = head.matchAll(/\/\*\*([\s\S]*?)\*\//g);
  for (const m of blocks) {
    const lines2 = stripBlockComment(m[1] ?? "");
    const tagIdx = lines2.findIndex((l) => /@(file|fileoverview)\b/.test(l));
    if (tagIdx < 0) continue;
    const tagged = lines2[tagIdx].replace(/^.*@(file|fileoverview)\b/, "").trim();
    const rest = lines2.slice(tagIdx + 1);
    const nextTag = rest.findIndex((l) => l.trim().startsWith("@"));
    const text = tagged ? [tagged, ...nextTag < 0 ? rest : rest.slice(0, nextTag)] : lines2.filter((l) => !l.trim().startsWith("@"));
    const r = result(firstParagraph(text), "jsdoc");
    if (r) return r;
  }
  return null;
}
function isDirective(text) {
  return DIRECTIVE_LINE.test(text.trim());
}
function proseLine(l) {
  return /[A-Za-z0-9]/.test(l) ? l : "";
}
function fromCommentBlock(head, style) {
  const lines2 = head.split("\n");
  const offsets = [];
  let acc = 0;
  for (const l of lines2) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  let i2 = 0;
  if (lines2[0]?.startsWith("#!")) i2 = 1;
  while (i2 < lines2.length) {
    const line = lines2[i2].trim();
    if (line === "") {
      i2++;
      continue;
    }
    const marker = style.line.find((m) => line.startsWith(m));
    if (marker) {
      const block = [];
      while (i2 < lines2.length) {
        const l = lines2[i2].trim();
        const m = style.line.find((mk) => l.startsWith(mk));
        if (!m) break;
        block.push(proseLine(l.slice(m.length).replace(/^[#/-]+/, "").trim()));
        i2++;
      }
      const content = block.filter((l) => !isDirective(l));
      const r = result(firstParagraph(content), "comment");
      if (r) return r;
      continue;
    }
    if (style.block && line.startsWith("/*")) {
      const start2 = offsets[i2] + lines2[i2].indexOf("/*");
      const close = head.indexOf("*/", start2 + 2);
      const body2 = head.slice(start2 + 2, close < 0 ? head.length : close).replace(/^\*+/, "");
      const content = stripBlockComment(body2).map(proseLine).filter((l) => !isDirective(l));
      const r = result(firstParagraph(content), "comment");
      if (r) return r;
      if (close < 0) return null;
      i2 = head.slice(0, close + 2).split("\n").length;
      continue;
    }
    return null;
  }
  return null;
}
function fromPythonDocstring(head) {
  const lines2 = head.split("\n");
  let i2 = 0;
  while (i2 < lines2.length && (lines2[i2].trim() === "" || lines2[i2].trim().startsWith("#"))) i2++;
  const rest = lines2.slice(i2).join("\n");
  const m = /^[rRuU]?("""|''')([\s\S]*?)(?:\1|$)/.exec(rest) ?? /^[rRuU]?(["'])((?:\\.|(?!\1).)*)\1/.exec(rest);
  if (!m) return null;
  return result(firstParagraph((m[2] ?? "").split("\n")), "docstring");
}
function unquoteYaml(v) {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}
function splitFrontmatter(head) {
  const lines2 = head.split("\n");
  if (lines2[0]?.trim() !== "---") return { frontmatter: null, body: lines2 };
  const close = lines2.findIndex((l, idx) => idx > 0 && l.trim() === "---");
  if (close < 0) return { frontmatter: lines2.slice(1), body: [] };
  return { frontmatter: lines2.slice(1, close), body: lines2.slice(close + 1) };
}
function fromFrontmatter(fm) {
  const idx = fm.findIndex((l) => /^description\s*:/.test(l));
  if (idx < 0) return null;
  const value = fm[idx].replace(/^description\s*:/, "").trim();
  if (value && !/^[>|][+-]?$/.test(value)) return result(unquoteYaml(value), "frontmatter");
  const continuation = [];
  for (const l of fm.slice(idx + 1)) {
    if (!/^\s+\S/.test(l)) break;
    continuation.push(l.trim());
  }
  return result(continuation.join(" "), "frontmatter");
}
function stripInlineMarkdown(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.*?)\1/g, "$2").trim();
}
function fromHeading(body2) {
  const h1 = body2.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 < 0) return null;
  const title = stripInlineMarkdown(body2[h1].replace(/^#\s+/, "").replace(/\s+#+\s*$/, ""));
  const para = [];
  for (const raw of body2.slice(h1 + 1)) {
    const l = raw.trim();
    if (l === "") {
      if (para.length > 0) break;
      continue;
    }
    if (para.length === 0 && (/^\[?!\[/.test(l) || l.startsWith("<"))) continue;
    if (/^(#|```|~~~|\||[-*+]\s|\d+\.\s|>)/.test(l)) break;
    para.push(stripInlineMarkdown(l));
  }
  const sentence = normalizePurpose(para.join(" "));
  return result(sentence ? `${title} \u2014 ${sentence}` : title, "heading");
}
function fromMarkdown(head) {
  const { frontmatter, body: body2 } = splitFrontmatter(head);
  return frontmatter && fromFrontmatter(frontmatter) || fromHeading(body2);
}
function fromManifest(head) {
  try {
    const parsed = JSON.parse(head);
    return typeof parsed.description === "string" ? result(parsed.description, "manifest") : null;
  } catch {
    const m = /"description"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
    if (!m) return null;
    try {
      return result(JSON.parse(m[1]), "manifest");
    } catch {
      return null;
    }
  }
}
function stem(path) {
  return baseName(path).replace(/\.[^.]+$/, "");
}
function readJsonString(text, start2) {
  let j = start2 + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  if (j >= text.length) return null;
  try {
    return { value: JSON.parse(text.slice(start2, j + 1)), end: j + 1 };
  } catch {
    return { value: text.slice(start2 + 1, j), end: j + 1 };
  }
}
function jsonShape(text) {
  const start2 = text.search(/\S/);
  const array = text[start2] === "[";
  if (!array && text[start2] !== "{") return null;
  const keyDepth = array ? 2 : 1;
  const shape = { array, keys: [], items: [], strings: /* @__PURE__ */ new Map() };
  let depth = 0;
  let element = 0;
  let i2 = start2;
  while (i2 < text.length) {
    const c = text[i2];
    if (c === '"') {
      const key = readJsonString(text, i2);
      if (!key) break;
      i2 = key.end;
      if (array && depth === 1) {
        shape.items.push(key.value);
        continue;
      }
      if (depth !== keyDepth || element > 0) continue;
      const colon = /^\s*:\s*/.exec(text.slice(i2, i2 + 64));
      if (!colon) continue;
      if (!shape.keys.includes(key.value)) shape.keys.push(key.value);
      i2 += colon[0].length;
      if (text[i2] === '"') {
        const value = readJsonString(text, i2);
        if (!value) break;
        if (!shape.strings.has(key.value)) shape.strings.set(key.value, value.value);
        i2 = value.end;
      }
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) break;
    } else if (c === "," && array && depth === 1) element++;
    i2++;
  }
  return shape;
}
var YAML_KEY = /^("[^"]*"|'[^']*'|[A-Za-z_$][\w$.-]*)\s*:(?:\s+(.*))?$/;
function yamlShape(text) {
  const shape = { array: false, keys: [], items: [], strings: /* @__PURE__ */ new Map() };
  for (const line of text.split("\n")) {
    const schema = /^#\s*yaml-language-server:\s*\$schema=(\S+)/.exec(line);
    if (schema) shape.strings.set("$schema", schema[1]);
    const m = YAML_KEY.exec(line.trimEnd());
    if (!m) continue;
    const key = unquoteYaml(m[1]);
    if (shape.keys.includes(key)) continue;
    shape.keys.push(key);
    const value = (m[2] ?? "").replace(/\s+#.*$/, "").trim();
    if (value && !/^[|>&*{[!]/.test(value)) shape.strings.set(key, unquoteYaml(value));
  }
  return shape;
}
function shortSchema(url) {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/#$/, "");
}
function fromShape(shape) {
  if (!shape) return null;
  const name2 = shape.array ? void 0 : shape.strings.get("name");
  const description = shape.array ? void 0 : shape.strings.get("description");
  const schema = shape.array ? void 0 : shape.strings.get("$schema");
  if (description) return result(name2 ? `${name2}: ${description}` : description, "structural");
  if (name2) return built(schema ? `${name2} (schema ${shortSchema(schema)})` : name2, "structural");
  if (schema) return built(`schema ${shortSchema(schema)}`, "structural");
  if (shape.keys.length === 0) return shape.items.length > 0 ? built(fitList("items", shape.items, PURPOSE_MAX_CHARS), "structural") : null;
  return built(fitList(shape.array ? "items with keys" : "keys", shape.keys, PURPOSE_MAX_CHARS), "structural");
}
function dirRole(path) {
  if (inChangelogDir(path)) return "changelog fragment";
  const dirs = path.split("/").slice(0, -1);
  const parent = dirs[dirs.length - 1];
  if (!parent) return "text";
  if (dirs.includes("fixtures") || dirs.includes("__fixtures__")) {
    const owner = parent === "fixtures" || parent === "__fixtures__" ? dirs[dirs.length - 2] : parent;
    return owner ? `${owner} fixture` : "fixture";
  }
  return `${parent} text`;
}
function stripTags(s) {
  let prev;
  let out2 = s;
  do {
    prev = out2;
    out2 = out2.replace(/<[^<>]*>/g, "");
  } while (out2 !== prev);
  return out2.replace(/<+(?=[A-Za-z/!?])/g, "");
}
function plainMarkdown(s) {
  return stripTags(
    stripInlineMarkdown(s).replace(/`([^`]*)`/g, "$1").replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
  ).trim();
}
function backtickRunEnd(line, at) {
  let end = at;
  while (line[end] === "`") end++;
  return end;
}
function codeSpanEnd(line, open, openEnd) {
  const length = openEnd - open;
  let j = line.indexOf("`", openEnd);
  while (j >= 0) {
    const runEnd = backtickRunEnd(line, j);
    if (runEnd - j === length) return runEnd;
    j = line.indexOf("`", runEnd);
  }
  return -1;
}
function withoutComments(line, inComment) {
  let rest = "";
  let i2 = 0;
  for (; ; ) {
    if (inComment) {
      const end = line.indexOf("-->", i2);
      if (end < 0) return { rest, inComment: true };
      i2 = end + 3;
      inComment = false;
    }
    const start2 = line.indexOf("<!--", i2);
    const tick = line.indexOf("`", i2);
    if (tick >= 0 && (start2 < 0 || tick < start2)) {
      const runEnd = backtickRunEnd(line, tick);
      const spanEnd = codeSpanEnd(line, tick, runEnd);
      const next = spanEnd < 0 ? runEnd : spanEnd;
      rest += line.slice(i2, next);
      i2 = next;
      continue;
    }
    if (start2 < 0) return { rest: rest + line.slice(i2), inComment: false };
    rest += line.slice(i2, start2);
    i2 = start2 + 2;
    inComment = true;
  }
}
function fromFirstLine(body2) {
  let fenced = false;
  let inComment = false;
  for (const raw of body2) {
    let l = raw.trim();
    if (!fenced) {
      const scan = withoutComments(l, inComment);
      inComment = scan.inComment;
      l = scan.rest.trim();
    }
    if (/^(```|~~~)/.test(l)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || l === "" || l.startsWith("|") || /^-{3,}$/.test(l)) continue;
    const text = plainMarkdown(l.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, ""));
    if (/[A-Za-z0-9]/.test(text)) return result(text, "structural");
  }
  return null;
}
function fromStructure(path, ext, text) {
  if (inChangelogDir(path) || ext === "txt") return built(`${dirRole(path)}: ${stem(path)}`, "structural");
  if (ext === "json") return fromShape(jsonShape(text));
  if (ext === "yml" || ext === "yaml") return fromShape(yamlShape(text));
  if (ext === "md") return fromFirstLine(splitFrontmatter(text).body);
  return null;
}
function extractPurpose(path, head) {
  if (!head || head.includes("\0") || head.trim() === "") return NONE;
  const text = head.slice(0, PURPOSE_HEAD_BYTES).replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const ext = extension(path);
  let found = null;
  if (MANIFESTS.has(baseName(path))) found = fromManifest(text);
  else if (ext === "py") found = fromPythonDocstring(text);
  else if (ext === "md") found = fromMarkdown(text);
  else if (ext in COMMENT_STYLES) {
    found = (JSDOC_EXTS.has(ext) ? fromJsdoc(text) : null) ?? fromCommentBlock(text, COMMENT_STYLES[ext]);
  }
  return found ?? fromStructure(path, ext, text) ?? NONE;
}
var KIND_LABEL = {
  sh_function: "function",
  sql_table: "table",
  sql_index: "index",
  sql_trigger: "trigger"
};
var CODE_EXT = /\.[cm]?[jt]sx?$/;
function isTestFile(path) {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\./.test(baseName(path));
}
function needsHeadForSymbols(path) {
  return isTestFile(path) && CODE_EXT.test(path);
}
function testTitles(head) {
  const titles = [];
  const re = /\b(?:describe|suite|test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  for (const m of head.matchAll(re)) {
    const title = m[2].replace(/\\(.)/g, "$1").trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}
function fromTestTitles(path, head) {
  const titles = testTitles(head);
  if (titles.length === 0) return null;
  const subject = baseName(path).replace(/\.(test|spec)\.[^.]+$/, "").replace(/\.[^.]+$/, "");
  return built(fitList(`tests for ${subject}`, titles, PURPOSE_MAX_CHARS, "; "), "symbols");
}
function contains(outer, inner) {
  if (outer.start_line === null || outer.end_line === null || inner.start_line === null || inner.end_line === null) {
    return false;
  }
  return outer.start_line <= inner.start_line && outer.end_line >= inner.end_line && (outer.start_line < inner.start_line || outer.end_line > inner.end_line);
}
function docSentence(doc) {
  const text = normalizePurpose(doc);
  return text && !isDirective(text) && /[A-Za-z]{3}/.test(text) ? text : "";
}
function squash(name2) {
  return name2.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function withDoc(label, items, doc) {
  const docBudget = doc ? Math.min(doc.length + 3, PURPOSE_MAX_CHARS / 2) : 0;
  const list = fitList(label, items, PURPOSE_MAX_CHARS - docBudget);
  const room = PURPOSE_MAX_CHARS - list.length - 3;
  return doc && room >= 20 ? `${list} \u2014 ${capChars(doc, room)}` : list;
}
function purposeFromSymbols(path, symbols, head = "") {
  if (needsHeadForSymbols(path)) {
    const tests = fromTestTitles(path, head);
    if (tests) return tests;
  }
  const defs = symbols.filter((s) => s.kind !== "module" && s.kind !== "hook" && s.kind !== "method");
  const top = defs.filter((d) => !defs.some((o) => o !== d && contains(o, d)));
  if (top.length === 0) return null;
  const moduleDoc2 = docSentence(symbols.find((s) => s.kind === "module")?.doc ?? "");
  const shell = top.every((s) => s.kind === "sh_function");
  if (shell) return built(withDoc("functions", [...new Set(top.map((s) => s.qualified_name))], moduleDoc2), "symbols");
  const exports = top.filter((s) => s.exported === 1);
  const listed = exports.length > 0 ? exports : top;
  const items = [...new Set(listed.map((s) => `${s.qualified_name} (${KIND_LABEL[s.kind] ?? s.kind})`))];
  let doc = moduleDoc2;
  if (!doc && exports.length > 0) {
    const fileStem = squash(baseName(path).replace(/\..*$/, ""));
    const main = exports.find((s) => squash(s.qualified_name) === fileStem && docSentence(s.doc)) ?? exports.find((s) => docSentence(s.doc));
    doc = main ? docSentence(main.doc) : "";
  }
  return built(withDoc(exports.length > 0 ? "exports" : "defines", items, doc), "symbols");
}

// src/symbol-purpose.ts
import { closeSync as closeSync2, openSync as openSync2, readSync } from "node:fs";
import { join as join6 } from "node:path";
function readFileHead(absPath) {
  let fd = null;
  try {
    fd = openSync2(absPath, "r");
    const buf = Buffer.alloc(PURPOSE_HEAD_BYTES);
    const n = readSync(fd, buf, 0, PURPOSE_HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync2(fd);
  }
}
function refreshSymbolPurposes(db, repo) {
  const files = db.all(
    `SELECT id, path, purpose, purpose_source FROM wm_files
      WHERE repo = ? AND purpose_source IN ('none', 'symbols') ORDER BY path`,
    [repo]
  );
  if (files.length === 0) return { updated: 0 };
  const repoPath = db.get(`SELECT path FROM repos WHERE name = ?`, [repo])?.path ?? null;
  const byPath = /* @__PURE__ */ new Map();
  const rows = db.all(
    `SELECT path, kind, qualified_name, doc, exported, start_line, end_line FROM wm_symbols
      WHERE repo = ? AND path IN (SELECT value FROM json_each(?))
      ORDER BY path, start_line, id`,
    [repo, JSON.stringify(files.map((f) => f.path))]
  );
  for (const r of rows) {
    const symbol = {
      kind: r.kind,
      qualified_name: r.qualified_name,
      doc: r.doc,
      exported: Number(r.exported),
      start_line: r.start_line === null ? null : Number(r.start_line),
      end_line: r.end_line === null ? null : Number(r.end_line)
    };
    const list = byPath.get(r.path);
    if (list) list.push(symbol);
    else byPath.set(r.path, [symbol]);
  }
  const now2 = nowISO();
  let updated = 0;
  db.transaction(() => {
    for (const f of files) {
      const head = repoPath !== null && needsHeadForSymbols(f.path) ? readFileHead(join6(repoPath, f.path)) : "";
      const next = purposeFromSymbols(f.path, byPath.get(f.path) ?? [], head);
      const purpose = next?.purpose ?? "";
      const source = next ? "symbols" : "none";
      if (purpose === f.purpose && source === f.purpose_source) continue;
      db.run(`UPDATE wm_files SET purpose = ?, purpose_source = ?, updated_at = ? WHERE id = ?`, [purpose, source, now2, f.id]);
      updated++;
    }
  });
  return { updated };
}

// src/readme-drift.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { join as join7, posix } from "node:path";

// src/utils/timeouts.ts
var SUBPROCESS_TIMEOUT_MS = 5e3;

// src/readme-drift.ts
var HISTORY_TIMEOUT_MS = 3e4;
var HISTORY_MAX_BUFFER = 64 * 1024 * 1024;
function git(root, args2, timeout = SUBPROCESS_TIMEOUT_MS) {
  try {
    const r = spawnSync("git", ["-C", root, ...args2], { encoding: "utf8", timeout, maxBuffer: HISTORY_MAX_BUFFER });
    return r.status === 0 && !r.error ? r.stdout : null;
  } catch {
    return null;
  }
}
function basename3(p) {
  const i2 = p.lastIndexOf("/");
  return i2 >= 0 ? p.slice(i2 + 1) : p;
}
function lines(out2) {
  return out2.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
function readRepoHistory(root, trackedDirs) {
  const out2 = git(root, ["log", "--diff-filter=DR", "--name-status", "--format="], HISTORY_TIMEOUT_MS);
  if (out2 === null) return null;
  const tracked = git(root, ["-c", "core.quotePath=false", "ls-files"], HISTORY_TIMEOUT_MS);
  if (tracked === null) return null;
  const deleted = /* @__PURE__ */ new Set();
  const renamedAway = /* @__PURE__ */ new Set();
  for (const [status, path] of lines(out2).map((l) => l.split("	"))) {
    if (!path) continue;
    if (status === "D") deleted.add(path);
    else if (status?.startsWith("R")) renamedAway.add(path);
  }
  const trackedFiles = new Set(lines(tracked));
  const trackedBasenames = new Set([...trackedFiles].map(basename3));
  const deletedByBasename = /* @__PURE__ */ new Map();
  for (const p of [...deleted].sort()) {
    const name2 = basename3(p);
    const list = deletedByBasename.get(name2);
    if (list) list.push(p);
    else deletedByBasename.set(name2, [p]);
  }
  return { root, deleted, deletedByBasename, renamedAway, trackedBasenames, trackedDirs, trackedFiles };
}
function stripUntrustedFraming(text) {
  return text.replace(/<\/?untrusted-content\b[^>]*>/g, "");
}
var LINK_TARGET = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
var BACKTICK_SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;
var PATH_SHAPE = /^[A-Za-z0-9_.\-/@+]+$/;
var FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
var URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
function skipped(ref2) {
  return ref2.length === 0 || ref2.startsWith("..") || /(^|\/)dist\//.test(ref2) || ref2.includes("${") || ref2.includes("<") || ref2.includes("*");
}
function linkCandidate(target) {
  if (URL_SCHEME.test(target) || target.startsWith("#")) return null;
  const path = target.replace(/[?#].*$/, "").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return path.length > 0 ? path : null;
}
function backtickCandidate(span, dir, trackedDirs) {
  const ref2 = span.trim().replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!PATH_SHAPE.test(ref2) || ref2.startsWith("/") || ref2.includes("://")) return null;
  const slash = ref2.indexOf("/");
  if (slash < 0) return FILE_EXTENSION.test(ref2) ? ref2 : null;
  const first = ref2.slice(0, slash);
  const tracked = trackedDirs.has(first) || dir !== "" && trackedDirs.has(`${dir}/${first}`);
  return tracked ? ref2 : null;
}
function readmeCandidates(readme, dir, trackedDirs) {
  const text = stripUntrustedFraming(readme);
  const seen = /* @__PURE__ */ new Map();
  for (const m of text.matchAll(LINK_TARGET)) {
    const ref2 = linkCandidate(m[1]);
    if (ref2 && !skipped(ref2)) seen.set(ref2, { ref: ref2, link: true });
  }
  for (const m of text.matchAll(BACKTICK_SPAN)) {
    const ref2 = backtickCandidate(m[1], dir, trackedDirs);
    if (ref2 && !skipped(ref2) && !seen.has(ref2)) seen.set(ref2, { ref: ref2, link: false });
  }
  return [...seen.values()];
}
function relativeToDir(dir, ref2) {
  return dir === "" ? posix.normalize(ref2) : posix.normalize(`${dir}/${ref2}`);
}
function deletedBareName(ref2, history) {
  if (ref2.includes("/") || history.trackedBasenames.has(ref2)) return void 0;
  return history.deletedByBasename.get(ref2)?.[0];
}
function deadRefs(readme, dir, history) {
  const dead = /* @__PURE__ */ new Set();
  for (const { ref: ref2, link } of readmeCandidates(readme, dir, history.trackedDirs)) {
    const fromDir = relativeToDir(dir, ref2);
    if (existsSync3(join7(history.root, fromDir)) || existsSync3(join7(history.root, ref2))) continue;
    const deletedHit = history.deleted.has(fromDir) ? fromDir : history.deleted.has(ref2) ? ref2 : deletedBareName(ref2, history);
    if (deletedHit) dead.add(deletedHit);
    else if (link) dead.add(fromDir);
  }
  return [...dead].sort();
}
var MAX_REFERENCED_PATHSPECS = 200;
function referencedFiles(readme, dir, readmePath, history) {
  const isFile = (p) => history.trackedFiles.has(p) || history.deleted.has(p) || history.renamedAway.has(p);
  const files = /* @__PURE__ */ new Set();
  for (const { ref: ref2 } of readmeCandidates(readme, dir, history.trackedDirs)) {
    const fromDir = relativeToDir(dir, ref2);
    const fromRoot = posix.normalize(ref2);
    const hit = isFile(fromDir) ? fromDir : isFile(fromRoot) ? fromRoot : void 0;
    if (hit && hit !== readmePath) files.add(hit);
  }
  return [...files].sort();
}
function readmeDrift(history, dir, readmeName, readme) {
  const readmePath = dir === "" ? readmeName : `${dir}/${readmeName}`;
  const sha = git(history.root, ["log", "-1", "--format=%H", "--", `:(literal)${readmePath}`])?.trim();
  if (!sha) return null;
  const range = `${sha}..HEAD`;
  const refs = referencedFiles(readme, dir, readmePath, history).slice(0, MAX_REFERENCED_PATHSPECS);
  const pathspecs = refs.map((r) => `:(literal)${r}`);
  const touched = refs.length === 0 ? "" : git(history.root, ["log", "--diff-filter=a", "--format=%H", range, "--", ...pathspecs]);
  if (touched === null) return null;
  const commits_behind = new Set(lines(touched)).size;
  return { summary_sha: sha, commits_behind, dead_refs: deadRefs(readme, dir, history) };
}

// src/readme-summary.ts
var README_CLEAN_MAX_CHARS = 16 * 1024;
var LINKED_IMAGE = /\[!\[[^[\]]*\]\([^()]*\)\]\([^()]*\)/g;
var IMAGE = /!\[[^[\]]*\]\([^()]*\)/g;
var LINK = /\[([^[\]]*)\]\([^()]*\)/g;
function untilStable(s, step) {
  let prev;
  let out2 = s;
  do {
    prev = out2;
    out2 = step(out2);
  } while (out2 !== prev);
  return out2;
}
var COMMENT = /<!--[\s\S]*?-->/g;
var TAG = /<[A-Za-z/!?](?:[^<>\n]|\n(?![ \t]*\n))*>/g;
var STRAY_TAG_OPEN = /<(?=[A-Za-z/!?])/g;
var newlinesOf = (m) => m.replace(/[^\n]/g, "");
function stripMarkup(s) {
  const noComments = untilStable(s, (t) => t.replace(COMMENT, newlinesOf));
  const noImages = untilStable(noComments, (t) => t.replace(LINKED_IMAGE, newlinesOf).replace(IMAGE, newlinesOf));
  const noTags = untilStable(noImages, (t) => t.replace(TAG, newlinesOf));
  return untilStable(noTags, (t) => t.replace(STRAY_TAG_OPEN, ""));
}
function hasProse(block) {
  return block.some((l) => new RegExp("\\p{L}", "u").test(l.replace(LINK, "")));
}
function isHeading(block) {
  return block.length === 1 && /^\s*#{1,6}\s/.test(block[0]);
}
function cleanReadme(raw) {
  const text = raw.length > README_CLEAN_MAX_CHARS ? raw.slice(0, README_CLEAN_MAX_CHARS) : raw;
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines2 = normalized.split("\n");
  const stripped = stripMarkup(normalized).split("\n");
  let changed = stripped.some((l, i2) => l !== lines2[i2]);
  const kept = [];
  let block = [];
  let proseSeen = false;
  const flush = () => {
    if (block.length === 0) return;
    if (proseSeen || hasProse(block)) {
      if (kept.length > 0) kept.push("");
      kept.push(...block);
      if (!isHeading(block)) proseSeen = true;
    } else {
      changed = true;
    }
    block = [];
  };
  stripped.forEach((line, i2) => {
    if (line.trim() !== "") block.push(line);
    else if (lines2[i2].trim() === "") flush();
  });
  flush();
  return changed ? `${kept.join("\n")}
` : text;
}

// src/utils/untrusted.ts
var UNTRUSTED_CLOSE = "</untrusted-content>";
function frameUntrusted(source, content) {
  const neutralized = content.replace(/<\s*\/\s*untrusted-content\s*>/gi, "</ untrusted-content>").replace(/<\s*untrusted-content(?=[\s>])[^>]*>/gi, "< untrusted-content>");
  return `<untrusted-content source="${source}">
${neutralized}
${UNTRUSTED_CLOSE}`;
}

// src/symbol-index.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { basename as basename5, join as join10, posix as posix2 } from "node:path";

// src/utils/repo-paths.ts
import { dirname as dirname3, isAbsolute as isAbsolute3, resolve as resolve2 } from "node:path";

// src/tools/containment.ts
import { isAbsolute as isAbsolute2, join as join8, parse, relative as relative2, sep as sep2 } from "node:path";
function projectRootFromDbPath(dbPath) {
  if (!dbPath || dbPath === ":memory:") return null;
  const segments = dbPath.split(sep2);
  const idx = segments.lastIndexOf(".claude");
  if (idx <= 0) return null;
  return segments.slice(0, idx).join(sep2) || sep2;
}

// src/utils/repo-paths.ts
function repoRowPath(db, path) {
  if (isAbsolute3(path)) return path;
  const base = db.dbPath === ":memory:" ? process.cwd() : projectRootFromDbPath(db.dbPath) ?? dirname3(db.dbPath);
  return resolve2(base, path);
}
function resolveRepoForSync(db, repoName) {
  if (repoName) {
    const row = db.get(`SELECT name, path FROM repos WHERE name = ?`, [repoName]);
    return row ? { name: row.name, path: repoRowPath(db, row.path) } : null;
  }
  const rows = db.all(`SELECT name, path FROM repos`);
  if (rows.length !== 1) return null;
  return { name: rows[0].name, path: repoRowPath(db, rows[0].path) };
}

// src/parsing/loader.ts
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname4, join as join9 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var RUNTIME_WASM = "tree-sitter.wasm";
var GRAMMAR_WASM = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  bash: "tree-sitter-bash.wasm",
  python: "tree-sitter-python.wasm"
};
var INDEXED = ["typescript", "tsx", "javascript", "bash"];
var pending = null;
var loads = 0;
function wasmDir() {
  const here = dirname4(fileURLToPath2(import.meta.url));
  for (const dir of [join9(here, "parsing"), here]) {
    if (existsSync4(join9(dir, RUNTIME_WASM))) return dir;
  }
  throw new Error(`tree-sitter runtime not found: no ${RUNTIME_WASM} in ${join9(here, "parsing")} or ${here}`);
}
var runtime = null;
var grammars = /* @__PURE__ */ new Map();
function memo(promise, forget) {
  promise.catch(forget);
  return promise;
}
function loadRuntime() {
  runtime ??= memo(
    (async () => {
      const dir = wasmDir();
      const mod = await Promise.resolve().then(() => (init_tree_sitter(), tree_sitter_exports));
      await mod.Parser.init({ locateFile: (file) => join9(dir, file) });
      return mod;
    })(),
    () => {
      runtime = null;
    }
  );
  return runtime;
}
function loadParser(name2) {
  let parser = grammars.get(name2);
  if (!parser) {
    parser = memo(
      (async () => {
        const { Parser: Parser2, Language: Language2 } = await loadRuntime();
        const p = new Parser2();
        p.setLanguage(await Language2.load(join9(wasmDir(), GRAMMAR_WASM[name2])));
        return p;
      })(),
      () => grammars.delete(name2)
    );
    grammars.set(name2, parser);
  }
  return parser;
}
async function load() {
  const parsers = {};
  for (const name2 of INDEXED) parsers[name2] = await loadParser(name2);
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

// src/parsing/extract.ts
import { createHash } from "node:crypto";
import { basename as basename4 } from "node:path";
var GENERATED_PATH = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /\.map$/,
  /\.min\.js$/
];
var LOCKFILE_PATH = [/(^|\/)package-lock\.json$/, /\.lock(b)?$/];
var EXTENSION_LANGUAGE = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  sh: "bash",
  bash: "bash",
  sql: "sql"
};
var SH_BUILTINS = new Set(
  "echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh".split(
    " "
  )
);
var STOPWORDS2 = new Set(
  "a an the and or of to in on for with by is are was were be been when where what which who how why does do did it its this that these those from as at into per not no than then there their them our we you i set get".split(
    " "
  )
);
var md5 = (s) => createHash("md5").update(s).digest("hex");
var DOC_MAX = 1e3;
function splitWords(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().trim();
}
var clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
var oneLine = (s) => s.replace(/\s+/g, " ").trim();
function isGeneratedPath(relPath) {
  return GENERATED_PATH.some((re) => re.test(relPath));
}
function inSymbolScope(relPath) {
  return !isGeneratedPath(relPath) && !LOCKFILE_PATH.some((re) => re.test(relPath));
}
function languageOf(relPath, head) {
  const name2 = basename4(relPath);
  const dot = name2.lastIndexOf(".");
  if (dot > 0) return EXTENSION_LANGUAGE[name2.slice(dot + 1).toLowerCase()] ?? null;
  return /^#!.*\b(bash|sh)\b/.test(head().slice(0, 120)) ? "bash" : null;
}
function symbolTerms(kind, qualifiedName, relPath) {
  return `${splitWords(qualifiedName)} ${kind.replace("_", " ")} ${splitWords(basename4(relPath))}`;
}
function normalizedHash(node) {
  const base = node.startIndex;
  let text = node.text;
  const comments = node.descendantsOfType("comment").filter((c) => c !== null).sort((a, b) => b.startIndex - a.startIndex);
  for (const c of comments) text = text.slice(0, c.startIndex - base) + text.slice(c.endIndex - base);
  return md5(oneLine(text));
}
function isRuleLine(line) {
  const rest = line.replace(/^\s*(\/\*\*?|\/\/|#|\*)/, "").replace(/\*\/\s*$/, "").trim();
  return rest.length >= 3 && /^[-=#*_~/ ]+$/.test(rest);
}
function docOf(node) {
  const anchor = node.parent?.type === "export_statement" ? node.parent : node;
  const lines2 = [];
  let edge = anchor.startPosition.row;
  let prev = anchor.previousNamedSibling;
  while (prev && prev.type === "comment" && prev.endPosition.row === edge - 1) {
    lines2.unshift(prev.text);
    edge = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  if (lines2.some((block) => block.split("\n").some(isRuleLine))) return "";
  const raw = lines2.map(
    (l) => l.replace(/\*\//g, " ").replace(/^\s*(\/\*\*?|\*|\/\/+|#+)/gm, " ")
  ).join(" ");
  return clip(oneLine(raw), DOC_MAX);
}
var STRING_PARTS = /* @__PURE__ */ new Set(["string_fragment", "escape_sequence"]);
function descriptionText(pair) {
  if (pair.childForFieldName("key")?.text.replace(/['"]/g, "") !== "description") return null;
  const value = pair.childForFieldName("value");
  if (!value || !["string", "template_string", "binary_expression", "parenthesized_expression"].includes(value.type)) {
    return null;
  }
  const parts2 = value.descendantsOfType([...STRING_PARTS]).filter((n) => n !== null).map((n) => n.text);
  const text = oneLine(parts2.join(""));
  return /[a-z]{3}/i.test(text) ? text : null;
}
function signatureOf(node, src) {
  const body2 = node.childForFieldName("body");
  const end = body2 ? body2.startIndex : Math.min(node.endIndex, node.startIndex + 160);
  return clip(oneLine(src.slice(node.startIndex, end)), 200);
}
var SQL_HINT = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;
function sqlRefs(text) {
  if (!SQL_HINT.test(text)) return [];
  const out2 = [];
  for (const m of text.matchAll(
    /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_]\w*)/g
  )) {
    out2.push(["writes_table", m[1]]);
  }
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+["`]?([A-Za-z_]\w*)/g)) out2.push(["reads_table", m[1]]);
  for (const m of text.matchAll(/\bALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)/g)) out2.push(["writes_table", m[1]]);
  return out2;
}
var Collector = class {
  symbols = [];
  edges = [];
  byKey = /* @__PURE__ */ new Map();
  symbol(s) {
    const key = `${s.kind}\0${s.qualified_name}`;
    const known = this.byKey.get(key);
    if (known !== void 0) return known;
    this.symbols.push(s);
    this.byKey.set(key, this.symbols.length - 1);
    return this.symbols.length - 1;
  }
  edge(src, kind, dstName, line, hint = null) {
    this.edges.push({ src, kind, dst_name: dstName, line, hint });
  }
};
function lineCounter(text, lineBase) {
  const starts = [0];
  for (let i2 = text.indexOf("\n"); i2 >= 0; i2 = text.indexOf("\n", i2 + 1)) starts.push(i2 + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lineBase + lo + 1;
  };
}
function statementEnd(text, start2, virtual) {
  if (virtual) return text.indexOf(";", start2);
  let depth = 0;
  let i2 = text.indexOf("(", start2);
  for (; i2 >= 0 && i2 < text.length; i2++) {
    if (text[i2] === "(") depth++;
    else if (text[i2] === ")" && --depth === 0) break;
  }
  return i2;
}
function columnNames(stmt) {
  const inner = stmt.slice(stmt.indexOf("(") + 1, stmt.lastIndexOf(")"));
  const cols = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      cols.push(cur);
      cur = "";
    } else cur += ch;
  }
  cols.push(cur);
  return cols.map((c) => c.trim().split(/\s+/)[0] ?? "").filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|content|content_rowid|tokenize|--)/i.test(c));
}
function extractSqlDdl(text, out2, moduleSymbol, lineBase = 0) {
  const lineAt = lineCounter(text, lineBase);
  for (const m of text.matchAll(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
    const start2 = m.index;
    let end = statementEnd(text, start2, Boolean(m[1]));
    if (end < 0) end = Math.min(text.length, start2 + 400);
    const stmt = text.slice(start2, end + 1);
    const name2 = m[2];
    out2.symbol({
      kind: "sql_table",
      qualified_name: name2,
      signature: clip(`${name2}(${columnNames(stmt).join(", ")})`, 240),
      doc: "",
      start_line: lineAt(start2),
      end_line: lineAt(end),
      body_hash: md5(oneLine(stmt)),
      exported: 0
    });
  }
  for (const m of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi)) {
    const line = lineAt(m.index);
    const id = out2.symbol({
      kind: "sql_index",
      qualified_name: m[1],
      signature: oneLine(m[0]),
      doc: "",
      start_line: line,
      end_line: line,
      body_hash: md5(m[0]),
      exported: 0
    });
    out2.edge(id, "indexes", m[2], line);
  }
  for (const m of text.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([\s\S]*?)\bON\s+(\w+)([\s\S]*?)\bEND\b/gi)) {
    const line = lineAt(m.index);
    const id = out2.symbol({
      kind: "sql_trigger",
      qualified_name: m[1],
      signature: clip(oneLine(`${m[1]} ${m[2]} ON ${m[3]}`), 200),
      doc: "",
      start_line: line,
      end_line: lineAt(m.index + m[0].length),
      body_hash: md5(oneLine(m[0])),
      exported: 0
    });
    out2.edge(id, "triggers_on", m[3], line);
    for (const [kind, table] of sqlRefs(m[4])) out2.edge(id, kind, table, line);
  }
  if (moduleSymbol !== null) {
    for (const m of text.matchAll(/\bALTER\s+TABLE\s+(\w+)/gi)) out2.edge(moduleSymbol, "writes_table", m[1], lineAt(m.index));
  }
}
function named(node) {
  return node.namedChildren.filter((c) => c !== null);
}
var FUNCTION_VALUES = /* @__PURE__ */ new Set(["arrow_function", "function_expression", "function"]);
function extractTs(root, src, out2, moduleSymbol) {
  const definition = (node, kind, qualifiedName) => out2.symbol({
    kind,
    qualified_name: qualifiedName,
    signature: signatureOf(node, src),
    doc: docOf(node),
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    body_hash: normalizedHash(node),
    exported: node.parent?.type === "export_statement" ? 1 : 0
  });
  const visit = (node, scope, cls) => {
    let inner = scope;
    let innerCls = cls;
    const t = node.type;
    const name2 = () => node.childForFieldName("name")?.text;
    if (t === "function_declaration" || t === "generator_function_declaration") {
      const n = name2();
      if (n) inner = definition(node, "function", n);
    } else if (t === "class_declaration" || t === "abstract_class_declaration") {
      const n = name2();
      if (n) {
        inner = definition(node, "class", n);
        innerCls = n;
      }
    } else if (t === "method_definition" && cls) {
      const n = name2();
      if (n) inner = definition(node, "method", `${cls}.${n}`);
    } else if (t === "interface_declaration") {
      const n = name2();
      if (n) definition(node, "interface", n);
    } else if (t === "type_alias_declaration" || t === "enum_declaration") {
      const n = name2();
      if (n) definition(node, "type", n);
    } else if (t === "variable_declarator" && scope === moduleSymbol) {
      const decl = node.parent;
      const holder = decl?.parent?.type;
      const n = node.childForFieldName("name");
      if (decl && (holder === "program" || holder === "export_statement") && n?.type === "identifier") {
        const value = node.childForFieldName("value");
        const isFn = value !== null && FUNCTION_VALUES.has(value.type);
        const bodyStart = value?.type === "arrow_function" ? value.childForFieldName("body")?.startIndex : void 0;
        inner = out2.symbol({
          kind: isFn ? "function" : "const",
          qualified_name: n.text,
          signature: clip(oneLine(src.slice(decl.startIndex, bodyStart ?? Math.min(decl.endIndex, decl.startIndex + 140))), 200),
          doc: docOf(decl),
          start_line: decl.startPosition.row + 1,
          end_line: decl.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: holder === "export_statement" ? 1 : 0
        });
      }
    } else if (t === "call_expression" || t === "new_expression") {
      const fn = node.childForFieldName(t === "call_expression" ? "function" : "constructor");
      let callee;
      let receiver;
      if (fn?.type === "identifier") callee = fn.text;
      else if (fn?.type === "member_expression") {
        callee = fn.childForFieldName("property")?.text;
        receiver = fn.childForFieldName("object")?.text;
      }
      if (callee) {
        out2.edge(
          scope,
          t === "call_expression" ? "calls" : "instantiates",
          callee,
          node.startPosition.row + 1,
          receiver && receiver.length < 40 ? receiver : null
        );
      }
    } else if (t === "import_statement") {
      const spec = node.childForFieldName("source")?.text.slice(1, -1) ?? null;
      for (const s of node.descendantsOfType("import_specifier")) {
        const n = s?.childForFieldName("name")?.text;
        if (n) out2.edge(moduleSymbol, "imports", n, node.startPosition.row + 1, spec);
      }
      return;
    } else if (t === "pair" && scope !== moduleSymbol) {
      const text = descriptionText(node);
      const owner = out2.symbols[scope];
      if (text && owner) owner.doc = clip(owner.doc ? `${owner.doc} ${text}` : text, DOC_MAX);
    } else if (t === "string" || t === "template_string") {
      const text = node.text;
      for (const [kind, table] of sqlRefs(text)) out2.edge(scope, kind, table, node.startPosition.row + 1);
      if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(text)) extractSqlDdl(text, out2, null, node.startPosition.row);
    }
    for (const c of named(node)) visit(c, inner, innerCls);
  };
  visit(root, moduleSymbol, null);
}
function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, "");
}
function extractBash(root, out2, moduleSymbol) {
  const visit = (node, scope) => {
    let inner = scope;
    const t = node.type;
    if (t === "function_definition") {
      const n = node.childForFieldName("name")?.text;
      if (n) {
        inner = out2.symbol({
          kind: "sh_function",
          qualified_name: n,
          signature: `${n}()`,
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: 1
        });
      }
    } else if (t === "command") {
      const name2 = node.childForFieldName("name")?.text;
      const args2 = named(node).filter((c) => c.type !== "command_name").map((c) => stripQuotes(c.text));
      const line = node.startPosition.row + 1;
      if (name2 === "source" || name2 === ".") {
        if (args2[0]) out2.edge(scope, "sources", basename4(args2[0]), line);
      } else if (name2 && /\.sh$/.test(name2)) out2.edge(scope, "runs", basename4(name2), line);
      else if ((name2 === "bash" || name2 === "sh") && args2[0] && /\.sh$/.test(args2[0])) {
        out2.edge(scope, "runs", basename4(args2[0]), line);
      } else if (name2 && /^[A-Za-z_][\w-]*$/.test(name2) && !SH_BUILTINS.has(name2)) out2.edge(scope, "calls", name2, line);
    } else if (t === "string" || t === "raw_string" || t === "heredoc_body") {
      for (const [kind, table] of sqlRefs(node.text)) out2.edge(scope, kind, table, node.startPosition.row + 1);
    }
    for (const c of named(node)) visit(c, inner);
  };
  visit(root, moduleSymbol);
}
function moduleDoc(lang, src) {
  const out2 = [];
  const comment = lang === "bash" || lang === "sql" ? /^\s*(?:#|--)\s?(.*)$/ : /^\s*(?:\/\/|\/\*\*?|\*)\s?(.*?)(\*\/)?$/;
  for (const l of src.split("\n")) {
    if (/^#!/.test(l)) continue;
    const m = l.match(comment);
    if (m) {
      if (m[1].trim()) out2.push(m[1].trim());
    } else if (out2.length || l.trim()) break;
  }
  return clip(out2.join(" "), DOC_MAX);
}
function extractFile(parsers, relPath, lang, src) {
  const out2 = new Collector();
  const moduleSymbol = out2.symbol({
    kind: "module",
    qualified_name: relPath,
    signature: relPath,
    doc: moduleDoc(lang, src),
    start_line: 1,
    end_line: src.split("\n").length,
    body_hash: md5(src),
    exported: 0
  });
  if (lang === "sql") {
    extractSqlDdl(src, out2, moduleSymbol);
    return out2;
  }
  if (!parsers) throw new Error(`no parser loaded for ${lang}`);
  const tree = parsers[lang].parse(src);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${relPath}`);
  try {
    if (lang === "bash") extractBash(tree.rootNode, out2, moduleSymbol);
    else extractTs(tree.rootNode, src, out2, moduleSymbol);
  } finally {
    tree.delete();
  }
  return out2;
}

// src/parsing/hooks.ts
var HOOKS_PATH = "hooks/hooks.json";
var REGISTRATIONS_PATH = "scripts/hooks/lib/registrations.sh";
var EVENT_ORDER = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "WorktreeCreate",
  "WorktreeRemove",
  "SessionEnd"
];
function dispatchChains(registrations) {
  const chains = /* @__PURE__ */ new Map();
  for (const m of registrations.matchAll(/^\s*([\w-]+)\)\s*\n\s*printf '%s\\n' \\\n((?:\s*'[^']*'\s*\\?\n)+)/gm)) {
    chains.set(m[1], [...m[2].matchAll(/'([\w-]+)\s/g)].map((x) => x[1]));
  }
  return chains;
}
function eventRanks(events) {
  const unknown = events.filter((e) => !EVENT_ORDER.includes(e));
  const stop2 = EVENT_ORDER.indexOf("Stop");
  const order = [...EVENT_ORDER.slice(0, stop2 + 1), ...unknown, ...EVENT_ORDER.slice(stop2 + 1)];
  return new Map(order.map((e, i2) => [e, i2 + 1]));
}
var scriptOf = (gate) => `scripts/hooks/${gate}.sh`;
function extractHooks(src, chains) {
  const out2 = { symbols: [], edges: [] };
  const parsed = JSON.parse(src);
  const hooks = parsed.hooks ?? {};
  const ranks = eventRanks(Object.keys(hooks));
  const lines2 = src.split("\n");
  const lineOf = (needle, from) => {
    for (let i2 = from; i2 < lines2.length; i2++) if (lines2[i2].includes(needle)) return i2 + 1;
    return 0;
  };
  let cursor = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    const rank = ranks.get(event);
    let pos = 0;
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = group.matcher ?? "";
      for (const hook of group.hooks ?? []) {
        pos++;
        const cmd = hook.command ?? "";
        const gate = cmd.match(/dispatch\.sh"?\s+([\w.-]+)/)?.[1];
        const direct = gate ? null : cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+\.sh)/)?.[1] ?? null;
        const name2 = gate ?? direct?.split("/").pop() ?? `hook${pos}`;
        const line = lineOf(gate ?? direct ?? cmd, cursor);
        cursor = line || cursor;
        const members = gate ? chains.get(gate) : void 0;
        const target = members ? `chain ${members.join(", ")}` : gate ? scriptOf(gate) : direct ?? cmd;
        const qualifiedName = `${event}#${pos}:${name2}`;
        out2.symbols.push({
          kind: "hook",
          qualified_name: qualifiedName,
          signature: clip(oneLine(cmd), 200),
          doc: `${event} hook #${pos}${matcher ? ` (matcher ${matcher})` : ""} runs ${target}`,
          start_line: line,
          end_line: line,
          body_hash: md5(`${matcher}\0${cmd}`),
          exported: 1,
          run_order: rank * 100 + pos
        });
        const at = out2.symbols.length - 1;
        if (members) {
          members.forEach((m, i2) => out2.edges.push({ src: at, kind: "runs", dst_name: scriptOf(m), line: i2 + 1, hint: null }));
        } else if (gate || direct) {
          out2.edges.push({ src: at, kind: "runs", dst_name: gate ? scriptOf(gate) : direct, line, hint: null });
        }
      }
    }
  }
  return out2;
}

// src/symbol-index.ts
var EXTRACTOR_VERSION = 2;
var MAX_PARSE_BYTES = 1e6;
var FAILED_SUFFIX = ":failed";
var FAILED_PATHS_CAP = 20;
var FAILED_ERROR_MAX = 200;
var SYMBOL_COLUMNS = "s.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order";
var CALLABLE = /* @__PURE__ */ new Set(["function", "method", "class", "sh_function"]);
var TABLE_EDGES = /* @__PURE__ */ new Set(["reads_table", "writes_table", "indexes", "triggers_on"]);
function isTestPath(path) {
  return /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/.test(path);
}
function outsideConceptLane(path) {
  return isTestPath(path) || /(^|\/)(__)?fixtures(__)?\//.test(path);
}
function shortName(kind, qualifiedName) {
  return kind === "method" ? qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1) : qualifiedName;
}
function namesOf(kind, qualifiedName, path) {
  return kind === "module" ? [basename5(path), path] : [shortName(kind, qualifiedName)];
}
function readSource(repoPath, relPath) {
  return readFileSync4(join10(repoPath, relPath), "utf8");
}
function sourceLanguage(repoPath, relPath, sizeBytes) {
  if (sizeBytes > MAX_PARSE_BYTES) return null;
  return languageOf(relPath, () => {
    try {
      return readSource(repoPath, relPath).slice(0, 120);
    } catch {
      return "";
    }
  });
}
function resolveImport(fromFile, spec, fileSet) {
  if (!spec || !spec.startsWith(".")) return null;
  const base = posix2.normalize(posix2.join(posix2.dirname(fromFile), spec));
  const stem2 = base.replace(/\.(m?js|ts)$/, "");
  for (const c of [base, `${stem2}.ts`, `${stem2}.tsx`, `${stem2}.js`, `${stem2}.mjs`, `${stem2}/index.ts`, `${stem2}/index.js`]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}
var SymbolWriter = class {
  constructor(db, repo) {
    this.db = db;
    this.repo = repo;
  }
  db;
  repo;
  inserted = /* @__PURE__ */ new Set();
  // Upsert one file's symbols by (kind, qualified_name) so unchanged symbols
  // keep their ids, drop the ones that disappeared, and replace its edges.
  writeFile(path, extraction) {
    const existing = new Map(
      this.db.all(
        `SELECT ${SYMBOL_COLUMNS}, s.terms FROM wm_symbols s WHERE s.repo = ? AND s.path = ?`,
        [this.repo, path]
      ).map((r) => [`${r.kind}\0${r.qualified_name}`, r])
    );
    this.db.run(
      `DELETE FROM wm_edges WHERE src_id IN (SELECT id FROM wm_symbols WHERE repo = ? AND path = ?)`,
      [this.repo, path]
    );
    const ids = extraction.symbols.map((s) => {
      const terms = symbolTerms(s.kind, s.qualified_name, path);
      const key = `${s.kind}\0${s.qualified_name}`;
      const row = existing.get(key);
      const runOrder = s.run_order ?? null;
      if (!row) {
        for (const n of namesOf(s.kind, s.qualified_name, path)) this.inserted.add(n);
        return Number(
          this.db.run(
            `INSERT INTO wm_symbols (repo, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, terms, run_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [this.repo, path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder]
          ).lastInsertRowid
        );
      }
      existing.delete(key);
      const changed = row.signature !== s.signature || row.doc !== s.doc || Number(row.start_line) !== s.start_line || Number(row.end_line) !== s.end_line || row.body_hash !== s.body_hash || Number(row.exported) !== s.exported || row.terms !== terms || (row.run_order === null ? null : Number(row.run_order)) !== runOrder;
      if (changed) {
        this.db.run(
          `UPDATE wm_symbols SET signature = ?, doc = ?, start_line = ?, end_line = ?, body_hash = ?, exported = ?, terms = ?, run_order = ? WHERE id = ?`,
          [s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder, row.id]
        );
      }
      return Number(row.id);
    });
    for (const gone of existing.values()) this.db.run(`DELETE FROM wm_symbols WHERE id = ?`, [gone.id]);
    return extraction.edges.map((edge) => ({
      rowid: Number(
        this.db.run(`INSERT INTO wm_edges (src_id, dst_name, kind, resolution, line, hint) VALUES (?, ?, ?, 'unresolved', ?, ?)`, [
          ids[edge.src],
          edge.dst_name,
          edge.kind,
          edge.line,
          edge.hint
        ]).lastInsertRowid
      ),
      from: path,
      edge
    }));
  }
};
var Resolver = class {
  byName = /* @__PURE__ */ new Map();
  modules = /* @__PURE__ */ new Map();
  byBase = /* @__PURE__ */ new Map();
  fileSet = /* @__PURE__ */ new Set();
  importMap = /* @__PURE__ */ new Map();
  sourced = /* @__PURE__ */ new Map();
  constructor(db, repo, pending2) {
    for (const s of db.all(
      `SELECT id, path, kind, qualified_name FROM wm_symbols WHERE repo = ?`,
      [repo]
    )) {
      const c = { id: Number(s.id), path: s.path, kind: s.kind };
      if (s.kind === "module") {
        this.modules.set(s.path, c.id);
        this.fileSet.add(s.path);
        push(this.byBase, basename5(s.path), c);
      } else {
        push(this.byName, shortName(s.kind, s.qualified_name), c);
      }
    }
    for (const { from, edge } of pending2) {
      if (edge.kind === "imports") {
        const target = resolveImport(from, edge.hint, this.fileSet);
        if (target) {
          const m = this.importMap.get(from) ?? /* @__PURE__ */ new Map();
          m.set(edge.dst_name, target);
          this.importMap.set(from, m);
        }
      } else if (edge.kind === "sources") {
        const cands = this.byBase.get(edge.dst_name) ?? [];
        const pick = cands.find((c) => posix2.dirname(c.path) === posix2.dirname(from)) ?? cands[0];
        if (pick) push(this.sourced, from, pick.path);
      }
    }
  }
  resolve(from, edge) {
    if (edge.kind === "imports") {
      const target = resolveImport(from, edge.hint, this.fileSet);
      if (!target) return null;
      const hit = (this.byName.get(edge.dst_name) ?? []).find((c) => c.path === target);
      const dst = hit?.id ?? this.modules.get(target);
      return dst === void 0 ? null : { dst, how: "exact" };
    }
    if (edge.kind === "runs" || edge.kind === "sources") {
      const byPath = edge.dst_name.includes("/") ? this.modules.get(edge.dst_name) : void 0;
      if (byPath !== void 0) return { dst: byPath, how: "exact" };
      const cands2 = this.byBase.get(edge.dst_name) ?? [];
      const pick = cands2.find((c) => posix2.dirname(c.path) === posix2.dirname(from)) ?? (cands2.length === 1 ? cands2[0] : void 0);
      return pick ? { dst: pick.id, how: cands2.length === 1 ? "exact" : "name" } : null;
    }
    if (TABLE_EDGES.has(edge.kind)) {
      const cands2 = (this.byName.get(edge.dst_name) ?? []).filter((c) => c.kind === "sql_table");
      const pick = cands2.find((c) => c.path.endsWith(".sql") && !isTestPath(c.path)) ?? cands2.find((c) => !isTestPath(c.path)) ?? cands2[0];
      return pick ? { dst: pick.id, how: "name" } : null;
    }
    const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
    const member = edge.hint !== null && edge.hint !== "this";
    const same = cands.find((c) => c.path === from);
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    const viaSource = (this.sourced.get(from) ?? []).map((p) => cands.find((c) => c.path === p)).find(Boolean);
    if (same && !member) return { dst: same.id, how: "exact" };
    if (viaImport) {
      const hit = cands.find((c) => c.path === viaImport);
      if (hit) return { dst: hit.id, how: "exact" };
    } else if (viaSource) return { dst: viaSource.id, how: "exact" };
    const unique = cands.filter((c) => !isTestPath(c.path) && (!member || c.kind === "method"));
    return unique.length === 1 && edge.dst_name.length >= 4 ? { dst: unique[0].id, how: "name" } : null;
  }
};
function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
function markOrphanedEdges(db) {
  db.run(`UPDATE wm_edges SET resolution = 'unresolved' WHERE dst_id IS NULL AND resolution <> 'unresolved'`);
}
function deleteFileSymbols(db, repo, path) {
  db.run(`DELETE FROM wm_symbols WHERE repo = ? AND path = ?`, [repo, path]);
}
function registrationChains(repoPath) {
  try {
    return dispatchChains(readSource(repoPath, REGISTRATIONS_PATH));
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
var toPending = (r) => ({
  from: r.path,
  edge: { src: 0, kind: r.kind, dst_name: r.dst_name, line: Number(r.line), hint: r.hint }
});
function reresolveEdges(db, repo, names, skip) {
  const candidates = db.all(
    `SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ?
          AND ((e.dst_id IS NULL AND e.resolution <> 'unresolved')
            OR ((e.resolution <> 'exact' OR e.dst_id IS NULL) AND e.dst_name IN (SELECT value FROM json_each(?))))`,
    [repo, JSON.stringify([...names])]
  ).filter((r) => !skip.has(Number(r.rowid)));
  if (candidates.length === 0) return 0;
  const context = db.all(
    `SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
       FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
      WHERE s.repo = ? AND e.kind IN ('imports', 'sources') AND s.path IN (SELECT value FROM json_each(?))`,
    [repo, JSON.stringify([...new Set(candidates.map((c) => c.path))])]
  );
  const resolver = new Resolver(db, repo, context.map(toPending));
  let resolved = 0;
  for (const c of candidates) {
    const { from, edge } = toPending(c);
    const hit = resolver.resolve(from, edge);
    if (!hit || hit.how === c.resolution && hit.dst === (c.dst_id === null ? null : Number(c.dst_id))) continue;
    db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [hit.dst, hit.how, c.rowid]);
    resolved++;
  }
  return resolved;
}
async function indexRepoSymbols(db, repo, repoPath, extractorVersion = EXTRACTOR_VERSION) {
  const version = String(extractorVersion);
  const stale = db.all(
    `SELECT id, path, content_md5, size_bytes FROM wm_files
        WHERE repo = ? AND symbols_md5 IS NOT content_md5 || ':' || ?
          AND symbols_md5 IS NOT content_md5 || ':' || ? || ? ORDER BY path`,
    [repo, version, version, FAILED_SUFFIX]
  ).filter((f) => inSymbolScope(f.path));
  if (stale.some((f) => f.path === REGISTRATIONS_PATH) && !stale.some((f) => f.path === HOOKS_PATH)) {
    const hooksFile = db.get(
      `SELECT id, path, content_md5, size_bytes FROM wm_files WHERE repo = ? AND path = ?`,
      [repo, HOOKS_PATH]
    );
    if (hooksFile) stale.push(hooksFile);
  }
  const jobs = stale.map((f) => ({ file: f, lang: sourceLanguage(repoPath, f.path, Number(f.size_bytes)) }));
  const parsers = jobs.some((j) => j.lang !== null && j.lang !== "sql") ? await loadParsers() : null;
  const failed = [];
  const parsed = [];
  for (const { file, lang } of jobs) {
    const isHooks = file.path === HOOKS_PATH;
    if (lang === null && !isHooks) {
      parsed.push({ file, extraction: null });
      continue;
    }
    try {
      const src = readSource(repoPath, file.path);
      const extraction = isHooks ? extractHooks(src, registrationChains(repoPath)) : extractFile(parsers, file.path, lang, src);
      parsed.push({ file, extraction });
    } catch (e) {
      failed.push({ file, error: clip(oneLine(e instanceof Error ? e.message : String(e)), FAILED_ERROR_MAX) });
    }
  }
  return db.transaction(() => {
    const writer = new SymbolWriter(db, repo);
    const pending2 = [];
    let symbols = 0;
    for (const { file, extraction } of parsed) {
      if (extraction) {
        pending2.push(...writer.writeFile(file.path, extraction));
        symbols += extraction.symbols.length;
      } else {
        deleteFileSymbols(db, repo, file.path);
      }
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? WHERE id = ?`, [version, file.id]);
    }
    for (const { file } of failed) {
      deleteFileSymbols(db, repo, file.path);
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? || ? WHERE id = ?`, [version, FAILED_SUFFIX, file.id]);
    }
    let resolved = 0;
    if (pending2.length > 0) {
      const resolver = new Resolver(db, repo, pending2);
      for (const p of pending2) {
        const hit = resolver.resolve(p.from, p.edge);
        if (!hit) continue;
        db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [hit.dst, hit.how, p.rowid]);
        resolved++;
      }
    }
    resolved += reresolveEdges(db, repo, writer.inserted, new Set(pending2.map((p) => p.rowid)));
    markOrphanedEdges(db);
    return {
      files_parsed: parsed.filter((p) => p.extraction !== null).length,
      files_failed: failed.length,
      symbols,
      edges: pending2.length,
      edges_resolved: resolved,
      failed_paths: failed.slice(0, FAILED_PATHS_CAP).map(({ file, error }) => ({ path: file.path, error }))
    };
  });
}

// src/world-model/concepts.ts
import { spawnSync as spawnSync2 } from "node:child_process";

// src/success-criteria.ts
var CONCEPT_KINDS = ["flow", "subsystem", "invariant"];
var HANDOFFS = ["calls", "sources", "runs", "hook_fires"];
var CLAIMS = ["exists", "calls", "only_writers_of", "tested_by"];
function parseStoredReport(stored) {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return parsed && Array.isArray(parsed.criteria) ? parsed : null;
  } catch {
    return null;
  }
}

// src/tools/agent-runs.ts
var SWE_ORPHAN_AFTER_MS = 10 * 60 * 1e3;
var NO_USAGE_SQL = "COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0";
var UNMEASURED_IF_NO_USAGE_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${NO_USAGE_SQL} THEN 'unmeasured' END)`;

// src/tools/lifecycle.ts
var LIVE_TASK_STATUSES = ["pending", "running", "needs_validation", "completed"];
var LIVE_IN = LIVE_TASK_STATUSES.map((s) => `'${s}'`).join(", ");
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

// src/world-model/concepts.ts
var PASS = "pass";
function anchorLabel(ordinal, a) {
  return `step ${ordinal} ${a.qualified_name || a.path}`;
}
function currentHash(db, a) {
  if (!a.kind) {
    return db.get(`SELECT content_md5 AS h FROM wm_files WHERE repo = ? AND path = ?`, [a.repo, a.path])?.h ?? null;
  }
  return db.get(
    `SELECT body_hash AS h FROM wm_symbols WHERE repo = ? AND path = ? AND kind = ? AND qualified_name = ?`,
    [a.repo, a.path, a.kind, a.qualified_name]
  )?.h ?? null;
}
function symbolIdAt(db, repo, path, qualifiedName) {
  if (typeof path !== "string" || typeof qualifiedName !== "string") return null;
  const row = db.get(
    `SELECT id FROM wm_symbols WHERE repo = ? AND path = ? AND qualified_name = ? ORDER BY kind = 'module', id LIMIT 1`,
    [repo, path, qualifiedName]
  );
  return row ? Number(row.id) : null;
}
var ref = (v) => typeof v === "object" && v !== null ? v : {};
function evalClaim(db, repo, claim, args2) {
  switch (claim) {
    case "exists":
      return symbolIdAt(db, repo, args2["path"], args2["qualified_name"]) !== null ? PASS : "fail: no such symbol";
    case "calls": {
      const from = ref(args2["from"]);
      const to = ref(args2["to"]);
      const a = symbolIdAt(db, repo, from.path, from.qualified_name);
      const b = symbolIdAt(db, repo, to.path, to.qualified_name);
      if (a === null || b === null) return `fail: no such ${a === null ? "caller" : "callee"}`;
      return db.get(`SELECT 1 AS hit FROM wm_edges WHERE src_id = ? AND dst_id = ?`, [a, b]) ? PASS : "fail: no edge";
    }
    case "only_writers_of": {
      const table = args2["table"];
      const writers = args2["writers"];
      if (typeof table !== "string" || !Array.isArray(writers)) return "fail: needs table and writers[]";
      const actual = db.all(
        `SELECT DISTINCT s.path FROM wm_edges e
             JOIN wm_symbols s ON s.id = e.src_id
             JOIN wm_symbols t ON t.id = e.dst_id
            WHERE e.kind = 'writes_table' AND t.qualified_name = ? AND s.repo = ?
            ORDER BY s.path`,
        [table, repo]
      ).map((r) => r.path).filter((p) => !outsideConceptLane(p));
      const extra = actual.filter((p) => !writers.includes(p));
      return extra.length > 0 ? `fail: also written by ${extra.join(", ")}` : PASS;
    }
    case "tested_by": {
      const a = symbolIdAt(db, repo, args2["path"], args2["qualified_name"]);
      if (a === null) return "fail: no such symbol";
      const hit = db.get(
        `SELECT 1 AS hit FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id WHERE e.dst_id = ? AND s.path = ?`,
        [a, args2["test_path"]]
      );
      return hit ? PASS : "fail: no reference from test_path";
    }
    default:
      return "fail: unknown claim";
  }
}
function headSha(repoPath) {
  if (!repoPath) return null;
  const r = spawnSync2("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() || null : null;
}
function upsertConcept(db, input, opts) {
  const name2 = input.name?.trim();
  if (!name2) throw new Error("name is required");
  const kind = input.kind ?? "flow";
  if (!CONCEPT_KINDS.includes(kind)) throw new Error(`kind must be one of ${CONCEPT_KINDS.join(", ")}`);
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error("steps must be a non-empty array");
  const claims = input.claims ?? [];
  if (!Array.isArray(claims)) throw new Error("claims must be an array");
  const steps = input.steps.map((s, i2) => {
    const ordinal = i2 + 1;
    const anchor = {
      repo: input.repo,
      path: typeof s?.path === "string" ? s.path : "",
      kind: s?.kind ?? "",
      qualified_name: s?.kind ? s.qualified_name ?? "" : ""
    };
    const description = typeof s?.description === "string" ? s.description.trim() : "";
    if (!anchor.path) throw new Error(`step ${ordinal}: path is required`);
    if (!description) throw new Error(`step ${ordinal}: description is required`);
    if (outsideConceptLane(anchor.path)) throw new Error(`step ${ordinal}: ${anchor.path} is a test or fixture path`);
    const handoff = ordinal === input.steps.length ? null : s.handoff ?? null;
    if (handoff !== null && !HANDOFFS.includes(handoff)) {
      throw new Error(`step ${ordinal}: handoff must be one of ${HANDOFFS.join(", ")}`);
    }
    const hash = currentHash(db, anchor);
    if (hash === null) {
      throw new Error(`anchor not found: ${anchorLabel(ordinal, anchor)} (${anchor.path} ${anchor.kind || "file"})`);
    }
    return { ...anchor, ordinal, description, handoff, hash };
  });
  const evaluated = claims.map((c, i2) => {
    if (!CLAIMS.includes(c?.claim)) throw new Error(`claim ${i2 + 1}: claim must be one of ${CLAIMS.join(", ")}`);
    const args2 = typeof c.args === "object" && c.args !== null ? c.args : {};
    const result2 = evalClaim(db, input.repo, c.claim, args2);
    if (result2 !== PASS) throw new Error(`claim fails at write time: ${c.claim} ${JSON.stringify(args2)} \u2192 ${result2}`);
    return { claim: c.claim, args: args2 };
  });
  const sha = headSha(opts.repoPath);
  const now2 = nowISO();
  const stepsText = steps.map((s) => s.description).join("\n");
  return db.transaction(() => {
    const existing = db.get(`SELECT id FROM wm_concepts WHERE repo = ? AND name = ?`, [input.repo, name2]);
    let id;
    if (existing) {
      id = Number(existing.id);
      db.run(
        `UPDATE wm_concepts
            SET kind = ?, body = ?, status = 'verified', status_reason = NULL, verified_sha = ?, verified_by = ?,
                verified_at = ?, updated_at = ?, steps_text = ?
          WHERE id = ?`,
        [kind, input.body ?? "", sha, opts.agent, now2, now2, stepsText, id]
      );
      db.run(`DELETE FROM wm_concept_steps WHERE concept_id = ?`, [id]);
      db.run(`DELETE FROM wm_concept_claims WHERE concept_id = ?`, [id]);
    } else {
      id = Number(
        db.run(
          `INSERT INTO wm_concepts (repo, kind, name, body, status, verified_sha, verified_by, verified_at, created_at, updated_at, steps_text)
           VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)`,
          [input.repo, kind, name2, input.body ?? "", sha, opts.agent, now2, now2, now2, stepsText]
        ).lastInsertRowid
      );
    }
    for (const s of steps) {
      db.run(
        `INSERT INTO wm_concept_steps (concept_id, ordinal, repo, path, kind, qualified_name, description, handoff, hash_at_verify, trust)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`,
        [id, s.ordinal, s.repo, s.path, s.kind, s.qualified_name, s.description, s.handoff, s.hash]
      );
    }
    for (const c of evaluated) {
      db.run(`INSERT INTO wm_concept_claims (concept_id, claim, args, last_result) VALUES (?, ?, ?, ?)`, [
        id,
        c.claim,
        JSON.stringify(c.args),
        PASS
      ]);
    }
    return { id, status: "verified", steps: steps.length, claims: evaluated.length };
  });
}
var WORST = { verified: 0, suspect: 1, broken: 2 };
function refreshConcepts(db, repo) {
  const concepts = db.all(
    `SELECT id, status, status_reason FROM wm_concepts WHERE repo = ? AND status <> 'retired' ORDER BY id`,
    [repo]
  );
  let changed = 0;
  db.transaction(() => {
    for (const c of concepts) {
      let status = "verified";
      const reasons = [];
      for (const s of db.all(`SELECT * FROM wm_concept_steps WHERE concept_id = ? ORDER BY ordinal`, [c.id])) {
        const hash = currentHash(db, s);
        const trust = hash === null ? "broken" : hash !== s.hash_at_verify ? "suspect" : "verified";
        const reason2 = trust === "broken" ? "anchor gone" : trust === "suspect" ? "changed since verification" : null;
        if (reason2) reasons.push(`${anchorLabel(Number(s.ordinal), s)}: ${reason2}`);
        if (WORST[trust] > WORST[status]) status = trust;
        if (trust !== s.trust || reason2 !== s.trust_reason) {
          db.run(`UPDATE wm_concept_steps SET trust = ?, trust_reason = ? WHERE concept_id = ? AND ordinal = ?`, [
            trust,
            reason2,
            c.id,
            s.ordinal
          ]);
        }
      }
      for (const cl of db.all(`SELECT id, claim, args, last_result FROM wm_concept_claims WHERE concept_id = ? ORDER BY id`, [c.id])) {
        let args2 = {};
        try {
          args2 = JSON.parse(cl.args);
        } catch {
          args2 = {};
        }
        const result2 = evalClaim(db, repo, cl.claim, args2);
        if (result2 !== cl.last_result) db.run(`UPDATE wm_concept_claims SET last_result = ? WHERE id = ?`, [result2, cl.id]);
        if (result2 !== PASS) {
          status = "broken";
          reasons.push(`claim ${cl.claim}: ${result2}`);
        }
      }
      const reason = reasons.length > 0 ? reasons.join("; ") : null;
      if (status !== c.status || reason !== c.status_reason) {
        db.run(`UPDATE wm_concepts SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`, [status, reason, nowISO(), c.id]);
        changed++;
      }
    }
  });
  return { checked: concepts.length, changed };
}
var PROPOSAL_REJECT_AFTER_DAYS = 14;
var DAY_MS = 864e5;
var PROPOSAL_EVENTS = ["concept_proposal_applied", "concept_proposal_rejected"];
function applyConceptProposals(db, repo, repoPath, now2 = /* @__PURE__ */ new Date()) {
  const stats = { applied: 0, rejected: 0, pending: 0 };
  const repos = db.get(`SELECT COUNT(*) AS n, MAX(name) AS name FROM repos`);
  const soleRepo = Number(repos?.n) === 1 ? repos?.name ?? null : null;
  const tasks = db.all(
    `SELECT t.id, t.issue_id, t.branch_id, t.repo, t.updated_at, t.completion_report FROM tasks t
      WHERE t.status = 'closed'
        AND CASE WHEN json_valid(t.completion_report) THEN json_type(t.completion_report, '$.concepts') END = 'array'
        AND ${HAS_PASS_SQL}
      ORDER BY t.id`
  );
  if (tasks.length === 0) return stats;
  const settled = new Set(
    db.all(
      `SELECT json_extract(content_json, '$.task_id') AS task_id, json_extract(content_json, '$.name') AS name
           FROM audit WHERE event_type IN (${PROPOSAL_EVENTS.map((e) => `'${e}'`).join(", ")}) AND json_valid(content_json)`
    ).map((r) => `${Number(r.task_id)}\0${r.name}`)
  );
  const at = now2.toISOString();
  for (const t of tasks) {
    const expired = (now2.getTime() - Date.parse(t.updated_at)) / DAY_MS >= PROPOSAL_REJECT_AFTER_DAYS;
    for (const c of parseStoredReport(t.completion_report)?.concepts ?? []) {
      if ((c.repo ?? t.repo ?? soleRepo) !== repo) continue;
      const taskId = Number(t.id);
      if (settled.has(`${taskId}\0${c.name}`)) continue;
      const audit = { issue_id: Number(t.issue_id), branch_id: t.branch_id, from_node: "bro", repo, created_at: at };
      try {
        const out2 = upsertConcept(db, { ...c, repo }, { repoPath, agent: "swe" });
        insertAudit(db, {
          ...audit,
          event_type: "concept_proposal_applied",
          summary: `Concept '${c.name}' proposed by task ${taskId} applied`,
          content_json: JSON.stringify({ task_id: taskId, concept_id: out2.id, name: c.name })
        });
        stats.applied++;
      } catch (e) {
        if (!expired) {
          stats.pending++;
          continue;
        }
        insertAudit(db, {
          ...audit,
          event_type: "concept_proposal_rejected",
          summary: `Concept '${c.name}' proposed by task ${taskId} rejected`,
          content_json: JSON.stringify({ task_id: taskId, name: c.name, error: e.message })
        });
        stats.rejected++;
      }
    }
  }
  return stats;
}

// src/tools/milestones.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "node:fs";
import { join as join12 } from "node:path";

// src/sync/backend.ts
import { spawnSync as spawnSync3 } from "node:child_process";

// src/utils/live-cli-guard.ts
function liveCliBlockReason(env = process.env) {
  if (env.TMB_FORBID_LIVE_SYNC === "1") return "TMB_FORBID_LIVE_SYNC=1";
  if (env.NODE_TEST_CONTEXT) return `NODE_TEST_CONTEXT=${env.NODE_TEST_CONTEXT}`;
  return null;
}
function liveCliBlockedMessage(reason, cmd, args2) {
  return `live CLI blocked in test context (${reason}) \u2014 refused to spawn "${cmd} ${args2.join(" ")}"; inject _spawnFn`;
}

// src/sync/backend.ts
var _availabilityCache = null;
function detectAvailable(_spawnFn) {
  if (_spawnFn === void 0 && _availabilityCache !== null) {
    return _availabilityCache;
  }
  const check = (cmd, args2) => {
    try {
      if (_spawnFn) {
        const result4 = _spawnFn(cmd, args2);
        return result4.status === 0;
      }
      if (liveCliBlockReason()) return false;
      const result3 = spawnSync3(cmd, args2, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" });
      return result3.status === 0;
    } catch {
      return false;
    }
  };
  const result2 = {
    gh: check("gh", ["auth", "status"]),
    glab: check("glab", ["auth", "status"])
  };
  if (_spawnFn === void 0) {
    _availabilityCache = result2;
  }
  return result2;
}
function remoteSyncEnvDisabled() {
  const v = process.env.TMB_DISABLE_REMOTE_SYNC;
  return v === "1" || v?.toLowerCase() === "true";
}
function resolveBackend(configValue, repoRemotes2, hasSpawnFn = false, availability) {
  if (!hasSpawnFn && remoteSyncEnvDisabled()) {
    return null;
  }
  if (configValue === "off") return "off";
  if (configValue === "gh") return "gh";
  if (configValue === "glab") return "glab";
  if (configValue === "both") return "both";
  const available = availability ?? detectAvailable();
  const ghUsable = (repoRemotes2?.github ?? false) && available.gh;
  const glUsable = (repoRemotes2?.gitlab ?? false) && available.glab;
  if (ghUsable && glUsable) return "both";
  if (ghUsable) return "gh";
  if (glUsable) return "glab";
  return null;
}
function resolveBackendFor(configValue, repoRemotes2, spawnFn) {
  const availability = configValue === "auto" && spawnFn ? detectAvailable(spawnFn) : void 0;
  return resolveBackend(configValue, repoRemotes2, spawnFn !== void 0, availability);
}

// src/sync/issue_sync.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join11 } from "node:path";
function resolveLogDir() {
  if (process.env.TMB_SYNC_LOG_DIR) return process.env.TMB_SYNC_LOG_DIR;
  return resolveClaudeLogDir();
}
var readyLogDirs = /* @__PURE__ */ new Set();
function syncLog(entry) {
  try {
    const logDir = resolveLogDir();
    if (!readyLogDirs.has(logDir)) {
      mkdirSync2(logDir, { recursive: true });
      readyLogDirs.add(logDir);
    }
    const line = JSON.stringify({ ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() }) + "\n";
    appendFileSync2(join11(logDir, "issue-sync.log"), line);
  } catch {
  }
}
function defaultSpawnFn(cmd, args2, opts) {
  const blockReason = liveCliBlockReason();
  if (blockReason) {
    const message2 = liveCliBlockedMessage(blockReason, cmd, args2);
    syncLog({ event: "live_cli_blocked", cmd, args: args2, reason: blockReason });
    return { status: null, stdout: "", stderr: message2 };
  }
  const result2 = spawnSync4(cmd, args2, opts);
  return {
    status: result2.status,
    stdout: result2.stdout ? String(result2.stdout) : "",
    stderr: result2.stderr ? String(result2.stderr) : ""
  };
}
function extractRemoteHostAndRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const httpMatch = remoteUrl.match(/https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)(?:\.git)?$/);
  if (httpMatch) return { host: httpMatch[1], repoPath: httpMatch[2] };
  const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return { host: sshMatch[1], repoPath: sshMatch[2] };
  return null;
}
function repoSlugFromRemoteUrl(remoteUrl) {
  const parsed = extractRemoteHostAndRepo(remoteUrl);
  if (!parsed) return null;
  const repoPath = parsed.repoPath.replace(/\.git$/, "");
  return `${parsed.host}/${repoPath}`;
}

// src/sync/milestone_sync.ts
function splitSlug(slug) {
  const i2 = slug.indexOf("/");
  if (i2 <= 0 || i2 === slug.length - 1) return null;
  return { host: slug.slice(0, i2), path: slug.slice(i2 + 1) };
}
function collectionPath(target) {
  const parts2 = splitSlug(target.slug);
  if (!parts2) return null;
  const path = target.backend === "gh" ? `repos/${parts2.path}/milestones` : `projects/${encodeURIComponent(parts2.path)}/milestones`;
  return { host: parts2.host, path };
}
function runApi(target, apiArgs, spawnFn) {
  const opts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: "utf8" };
  if (target.cwd) opts.cwd = target.cwd;
  try {
    return spawnFn(target.backend, ["api", ...apiArgs], opts);
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}
function failure(target, result2) {
  if ("thrown" in result2) {
    return { ok: false, backend: target.backend, reason: "spawn_error", message: result2.thrown };
  }
  return {
    ok: false,
    backend: target.backend,
    reason: "non_zero_exit",
    exit_code: result2.status ?? void 0,
    stderr: result2.stderr.slice(0, 1024)
  };
}
function badSlug(target) {
  return { ok: false, backend: target.backend, reason: "bad_slug", message: `cannot derive an API path from "${target.slug}"` };
}
function fetchRemoteMilestones(target, spawnFn = defaultSpawnFn) {
  const coll = collectionPath(target);
  if (!coll) return badSlug(target);
  const query = target.backend === "gh" ? "?state=all&per_page=100" : "?per_page=100";
  const result2 = runApi(target, ["--hostname", coll.host, `${coll.path}${query}`], spawnFn);
  if ("thrown" in result2 || result2.status !== 0) return failure(target, result2);
  let parsed;
  try {
    parsed = JSON.parse(result2.stdout);
  } catch {
    return { ok: false, backend: target.backend, reason: "parse_failed", message: "milestone list is not JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, backend: target.backend, reason: "parse_failed", message: "milestone list is not an array" };
  }
  const milestones = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    const title = e["title"];
    const rawState = e["state"];
    const id = target.backend === "gh" ? e["number"] : e["id"];
    if (typeof title !== "string" || title === "" || typeof id !== "number") continue;
    const state = rawState === "closed" ? "closed" : rawState === "open" || rawState === "active" ? "open" : null;
    if (state === null) continue;
    milestones.push({ id, title, state });
  }
  return { ok: true, milestones };
}
function createRemoteMilestone(target, title, spawnFn = defaultSpawnFn) {
  const coll = collectionPath(target);
  if (!coll) return badSlug(target);
  const result2 = runApi(target, ["--hostname", coll.host, "-X", "POST", coll.path, "-f", `title=${title}`], spawnFn);
  if ("thrown" in result2 || result2.status !== 0) return failure(target, result2);
  return { ok: true };
}

// src/tools/milestones.ts
function auditMilestone(db, eventType, summary, content) {
  insertAudit(db, {
    issue_id: -1,
    from_node: "bro",
    event_type: eventType,
    summary,
    content_json: JSON.stringify(content),
    repo: null
  });
}
function resolveMilestoneTargets(db, repoName, spawnFn) {
  const resolved = resolveRepoForSync(db, repoName);
  if (!resolved) return { gated: false, targets: [] };
  const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  let syncConfig = "off";
  if (row) {
    try {
      syncConfig = String(JSON.parse(row.value_json));
    } catch {
      syncConfig = "off";
    }
  }
  const slugFor = (provider) => {
    const entry = syncRemotes(db, resolved.name).find((r) => r.provider === provider);
    return entry ? repoSlugFromRemoteUrl(entry.url) : null;
  };
  const ghSlug = slugFor("github");
  const glSlug = slugFor("gitlab");
  const backend = resolveBackendFor(
    syncConfig,
    { github: ghSlug !== null, gitlab: glSlug !== null },
    spawnFn ? (cmd, args2) => spawnFn(cmd, args2, { encoding: "utf8" }) : void 0
  );
  if (backend === null || backend === "off") return { gated: false, targets: [] };
  const targets = [];
  if ((backend === "gh" || backend === "both") && ghSlug) {
    targets.push({ backend: "gh", slug: ghSlug, cwd: resolved.path });
  }
  if ((backend === "glab" || backend === "both") && glSlug) {
    targets.push({ backend: "glab", slug: glSlug, cwd: resolved.path });
  }
  return { gated: true, targets };
}
function failureContent(f) {
  return { backend: f.backend, reason: f.reason, exit_code: f.exit_code, stderr: f.stderr, message: f.message };
}
function reconcileRepoMilestones(db, repo, targets, spawnFn) {
  const merged = /* @__PURE__ */ new Map();
  let anyFetched = false;
  let allFetched = true;
  for (const target of targets) {
    const listed = fetchRemoteMilestones(target, spawnFn);
    if (!listed.ok) {
      allFetched = false;
      auditMilestone(db, "milestone_reconcile_failed", `milestone reconcile failed for ${repo} via ${target.backend}: ${listed.reason}`, {
        repo,
        ...failureContent(listed)
      });
      continue;
    }
    anyFetched = true;
    for (const m of listed.milestones) {
      if (merged.get(m.title) !== "open") merged.set(m.title, m.state);
    }
  }
  if (!anyFetched) return { ok: false };
  let imported = 0;
  let closed = 0;
  db.transaction(() => {
    for (const [name2, state] of merged) {
      const existing = db.get(`SELECT state FROM milestones WHERE name = ? AND repo = ?`, [name2, repo]);
      if (!existing) {
        db.run(`INSERT INTO milestones (name, repo, state) VALUES (?, ?, ?)`, [name2, repo, state]);
        imported++;
        if (state === "closed") closed++;
      } else if (existing.state !== state) {
        db.run(`UPDATE milestones SET state = ? WHERE name = ? AND repo = ?`, [state, name2, repo]);
        if (state === "closed") closed++;
      }
    }
  });
  auditMilestone(db, "milestones_reconciled", `milestones reconciled for ${repo}: ${imported} imported, ${closed} closed`, {
    imported,
    closed,
    repo
  });
  return { ok: allFetched };
}
var SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
function parseSemver(raw) {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function nextPatchMilestone(version) {
  const parts2 = parseSemver(version);
  if (!parts2) return null;
  return `v${parts2[0]}.${parts2[1]}.${parts2[2] + 1}`;
}
function readJsonVersion(path) {
  if (!existsSync5(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync5(path, "utf8"));
    return typeof parsed.version === "string" && parseSemver(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}
function readTomlVersion(path, table) {
  if (!existsSync5(path)) return null;
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch {
    return null;
  }
  let inTable = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inTable = trimmed === `[${table}]`;
      continue;
    }
    if (!inTable) continue;
    const m = /^version\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (m) return parseSemver(m[1]) ? m[1] : null;
  }
  return null;
}
function highestVersionTag(repoPath) {
  try {
    const r = spawnSync5("git", ["-C", repoPath, "tag", "--list", "v*"], { encoding: "utf8", timeout: 3e3 });
    if (r.status !== 0) return null;
    let best = null;
    for (const tag of (r.stdout ?? "").split("\n").map((t) => t.trim())) {
      const parts2 = parseSemver(tag);
      if (!parts2) continue;
      if (best === null || parts2[0] > best.parts[0] || parts2[0] === best.parts[0] && parts2[1] > best.parts[1] || parts2[0] === best.parts[0] && parts2[1] === best.parts[1] && parts2[2] > best.parts[2]) {
        best = { tag, parts: parts2 };
      }
    }
    return best?.tag ?? null;
  } catch {
    return null;
  }
}
function readRepoVersion(repoPath) {
  const candidates = [
    ["package.json", () => readJsonVersion(join12(repoPath, "package.json"))],
    [".claude-plugin/plugin.json", () => readJsonVersion(join12(repoPath, ".claude-plugin", "plugin.json"))],
    ["pyproject.toml", () => readTomlVersion(join12(repoPath, "pyproject.toml"), "project")],
    ["Cargo.toml", () => readTomlVersion(join12(repoPath, "Cargo.toml"), "package")],
    ["git_tag", () => highestVersionTag(repoPath)]
  ];
  for (const [source, read] of candidates) {
    const version = read();
    if (version) return { version, source };
  }
  return null;
}
function seedRepoMilestone(db, repo, repoPath, gate, spawnFn) {
  const count = db.get(`SELECT COUNT(*) AS n FROM milestones WHERE repo = ?`, [repo]);
  if ((count?.n ?? 0) > 0) return;
  const found = readRepoVersion(repoPath);
  const name2 = found ? nextPatchMilestone(found.version) : null;
  if (!found || !name2) {
    auditMilestone(db, "milestone_seed_skipped", `milestone seed skipped for ${repo}: no version source`, {
      repo,
      reason: "no_version_source"
    });
    return;
  }
  db.run(`INSERT INTO milestones (name, repo, state) VALUES (?, ?, 'open')`, [name2, repo]);
  const failures = [];
  if (gate.gated) {
    for (const target of gate.targets) {
      const created = createRemoteMilestone(target, name2, spawnFn);
      if (!created.ok) failures.push(failureContent(created));
    }
  }
  const remoteCreated = gate.gated && gate.targets.length > 0 && failures.length === 0;
  const content = { name: name2, repo, source: found.source, remote_created: remoteCreated };
  if (failures.length > 0) content["remote_failures"] = failures;
  auditMilestone(db, "milestone_seeded", `milestone ${name2} seeded for ${repo} from ${found.source}`, content);
}
function syncRepoMilestones(db, repo, repoPath, spawnFn) {
  const gate = resolveMilestoneTargets(db, repo, spawnFn);
  if (gate.gated && gate.targets.length > 0) {
    const reconciled = reconcileRepoMilestones(db, repo, gate.targets, spawnFn);
    if (!reconciled.ok) {
      const count = db.get(`SELECT COUNT(*) AS n FROM milestones WHERE repo = ?`, [repo]);
      if ((count?.n ?? 0) === 0) {
        auditMilestone(db, "milestone_seed_skipped", `milestone seed skipped for ${repo}: remote reconcile failed`, {
          repo,
          reason: "reconcile_failed"
        });
      }
      return;
    }
  }
  seedRepoMilestone(db, repo, repoPath, gate, spawnFn);
}

// src/tools/scan.ts
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err2(message2) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message2 }) }],
    isError: true
  };
}
function wrap(fn) {
  return async (args2) => {
    try {
      return await fn(args2);
    } catch (e) {
      return err2(e.message);
    }
  };
}
function resolveScanScript() {
  const here = dirname5(fileURLToPath3(import.meta.url));
  const candidates = [
    join13(here, "..", "..", "..", "..", "scripts", "scan.sh"),
    join13(here, "..", "..", "..", "scripts", "scan.sh")
  ];
  for (const c of candidates) if (existsSync6(c)) return c;
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (pluginRoot) {
    const c = join13(pluginRoot, "scripts", "scan.sh");
    if (existsSync6(c)) return c;
  }
  throw new Error("scan.sh not found \u2014 expected at <plugin>/scripts/scan.sh");
}
function runScanWithScript(script, sessionDir, timeoutMs, dbPath = "") {
  return new Promise((resolve3, reject) => {
    const env = dbPath && dbPath !== ":memory:" ? { ...process.env, TRAJECTORY_DB_PATH: dbPath } : process.env;
    const child = spawn("bash", [script, sessionDir], {
      cwd: sessionDir,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    let settled = false;
    let killTimer = null;
    function killGroup() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    }
    killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      reject(new Error("scan.sh timed out after 10 minutes"));
    }, timeoutMs);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`scan.sh spawn error: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2e3);
      if (code !== 0) {
        reject(new Error(`scan.sh failed (exit ${code ?? "?"}): ${stderr || "unknown error"}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`scan.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
        return;
      }
      if (!parsed.repos || !parsed.files) {
        reject(new Error("scan.sh emitted unexpected shape (missing repos/files)"));
        return;
      }
      resolve3(parsed);
    });
  });
}
function runScan(sessionDir, timeoutMs, dbPath) {
  return runScanWithScript(resolveScanScript(), sessionDir, timeoutMs, dbPath);
}
var VALID_SCAN_SOURCES = /* @__PURE__ */ new Set([
  "user_manual",
  "bro_auto_post_close",
  "bro_auto_post_change",
  "bro_auto_initial",
  "startup_catchup"
]);
function detectStructuralChange(db, currentRepos, currentTopDirs, refilledEmptyGraph = false) {
  if (refilledEmptyGraph) return true;
  const prev = db.get(
    `SELECT content_json FROM audit
     WHERE event_type = 'deep_scan_completed'
     ORDER BY id DESC
     LIMIT 1`
  );
  if (!prev?.content_json) return true;
  let parsed = {};
  try {
    parsed = JSON.parse(prev.content_json);
  } catch {
    return true;
  }
  const prevRepos = new Set(parsed.repos_seen ?? []);
  const curRepos = new Set(currentRepos.map((r) => r.name));
  if (prevRepos.size !== curRepos.size) return true;
  for (const r of curRepos) if (!prevRepos.has(r)) return true;
  const prevDirs = new Set(parsed.top_dirs ?? []);
  if (prevDirs.size !== currentTopDirs.size) return true;
  for (const d of currentTopDirs) if (!prevDirs.has(d)) return true;
  return false;
}
var README_CANDIDATES = ["README.md", "readme.md", "README.rst", "readme.rst"];
var README_MAX_BYTES = 1024;
var STRUCTURAL_LIST_MAX = 8;
var STRUCTURAL_PURPOSES_MAX = 5;
function basename6(p) {
  const i2 = p.lastIndexOf("/");
  return i2 >= 0 ? p.slice(i2 + 1) : p;
}
function deriveDirectoryEntries(out2) {
  const dirMap = /* @__PURE__ */ new Map();
  function ensureDir(repo, dirPath) {
    const key = `${repo} ${dirPath}`;
    if (dirMap.has(key)) return;
    let parent_path = null;
    if (dirPath !== "") {
      const lastSlash = dirPath.lastIndexOf("/");
      parent_path = lastSlash >= 0 ? dirPath.slice(0, lastSlash) : "";
    }
    dirMap.set(key, { repo, path: dirPath, parent_path, file_count: 0, file_names: [] });
    if (parent_path !== null) ensureDir(repo, parent_path);
  }
  for (const r of out2.repos) ensureDir(r.name, "");
  for (const f of out2.files) {
    const lastSlash = f.path.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? f.path.slice(0, lastSlash) : "";
    ensureDir(f.repo, dirPath);
    const entry = dirMap.get(`${f.repo} ${dirPath}`);
    if (entry) {
      entry.file_count++;
      entry.file_names.push(basename6(f.path));
    }
  }
  return dirMap;
}
function buildStructuralSummary(dirPath, fileNames, subdirNames, filePurposes = []) {
  const leaf = dirPath === "" ? "(repo root)" : basename6(dirPath);
  const join14 = (names) => {
    const shown = names.slice(0, STRUCTURAL_LIST_MAX).join(", ");
    const extra = names.length - STRUCTURAL_LIST_MAX;
    return extra > 0 ? `${shown}, +${extra} more` : shown;
  };
  const parts2 = [];
  const fileCount = `${fileNames.length} file${fileNames.length === 1 ? "" : "s"}`;
  if (filePurposes.length > 0) {
    const shown = filePurposes.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, STRUCTURAL_PURPOSES_MAX).map((f) => `${f.name}: ${f.purpose}`);
    parts2.push(fileCount, frameUntrusted("file-purpose", shown.join("; ")).replace(/\n/g, " "));
  } else if (fileNames.length > 0) {
    parts2.push(`${fileCount} (${join14(fileNames.slice().sort())})`);
  }
  if (subdirNames.length > 0) {
    parts2.push(`subdirs: ${join14(subdirNames.slice().sort())}`);
  }
  return `${leaf}/ \u2014 ${parts2.length > 0 ? parts2.join("; ") : "empty directory"}`;
}
function readReadme(absDirPath, candidates = README_CANDIDATES) {
  for (const name2 of candidates) {
    const readmePath = join13(absDirPath, name2);
    if (!existsSync6(readmePath)) continue;
    try {
      return { name: name2, text: readFileSync6(readmePath, "utf8") };
    } catch {
    }
  }
  return null;
}
function readReadmeSummary(absDirPath) {
  const readme = readReadme(absDirPath);
  if (!readme) return null;
  const text = cleanReadme(readme.text);
  const clipped = text.length > README_MAX_BYTES ? text.slice(0, README_MAX_BYTES) : text;
  return frameUntrusted("readme", clipped);
}
function planReadmeDrift(out2) {
  const drift = /* @__PURE__ */ new Map();
  const dirMap = deriveDirectoryEntries(out2);
  const repoPaths = new Map(out2.repos.map((r) => [r.name, r.path]));
  const histories = /* @__PURE__ */ new Map();
  const historyFor = (repo, root) => {
    if (!histories.has(repo)) {
      const trackedDirs = /* @__PURE__ */ new Set();
      for (const e of dirMap.values()) if (e.repo === repo && e.path !== "") trackedDirs.add(e.path);
      histories.set(repo, readRepoHistory(root, trackedDirs));
    }
    return histories.get(repo) ?? null;
  };
  for (const entry of dirMap.values()) {
    const root = repoPaths.get(entry.repo);
    const tracked = README_CANDIDATES.filter((name2) => entry.file_names.includes(name2));
    if (!root || tracked.length === 0) continue;
    const history = historyFor(entry.repo, root);
    if (!history) continue;
    const readme = readReadme(entry.path === "" ? root : join13(root, entry.path), tracked);
    if (!readme) continue;
    const d = readmeDrift(history, entry.path, readme.name, readme.text);
    if (d) drift.set(`${entry.repo} ${entry.path}`, d);
  }
  return drift;
}
function persistDirectoriesGraph(graph, out2, now2, purposesByDir = /* @__PURE__ */ new Map(), driftByDir = /* @__PURE__ */ new Map()) {
  const repoPaths = /* @__PURE__ */ new Map();
  for (const r of out2.repos) repoPaths.set(r.name, r.path);
  const dirMap = deriveDirectoryEntries(out2);
  let dirs_upserted = 0;
  let dirs_readme_summarized = 0;
  let dirs_structural_summarized = 0;
  const subdirsByParent = /* @__PURE__ */ new Map();
  for (const entry of dirMap.values()) {
    if (entry.parent_path === null) continue;
    const key = `${entry.repo} ${entry.parent_path}`;
    const list = subdirsByParent.get(key);
    if (list) list.push(basename6(entry.path));
    else subdirsByParent.set(key, [basename6(entry.path)]);
  }
  for (const entry of dirMap.values()) {
    const repoPath = repoPaths.get(entry.repo);
    if (!repoPath) continue;
    const absDirPath = entry.path === "" ? repoPath : join13(repoPath, entry.path);
    const readmeSummary = readReadmeSummary(absDirPath);
    const subdirNames = subdirsByParent.get(`${entry.repo} ${entry.path}`) ?? [];
    const summary = readmeSummary ?? buildStructuralSummary(
      entry.path,
      entry.file_names,
      subdirNames,
      purposesByDir.get(`${entry.repo} ${entry.path}`) ?? []
    );
    const drift = readmeSummary !== null ? driftByDir.get(`${entry.repo} ${entry.path}`) : void 0;
    graph.upsertDirectory({
      repo: entry.repo,
      path: entry.path,
      parent_path: entry.parent_path,
      summary,
      summary_source: readmeSummary !== null ? "readme" : "structural",
      summary_updated_at: now2,
      file_count: entry.file_count,
      summary_sha: drift?.summary_sha ?? null,
      commits_behind: drift?.commits_behind ?? null,
      dead_refs: drift?.dead_refs ?? null
    });
    if (readmeSummary !== null) dirs_readme_summarized++;
    else dirs_structural_summarized++;
    dirs_upserted++;
  }
  for (const entry of dirMap.values()) {
    if (entry.parent_path === null) continue;
    graph.upsertContains(
      { repo: entry.repo, path: entry.parent_path },
      { repo: entry.repo, path: entry.path }
    );
  }
  return { dirs_upserted, dirs_readme_summarized, dirs_structural_summarized };
}
function fileDir(relPath) {
  const i2 = relPath.lastIndexOf("/");
  return i2 >= 0 ? relPath.slice(0, i2) : "";
}
function planFiles(graph, out2, now2) {
  const repoPaths = new Map(out2.repos.map((r) => [r.name, r.path]));
  const existing = /* @__PURE__ */ new Map();
  for (const r of out2.repos) {
    for (const f of graph.allFilesForRepo(r.name)) existing.set(f.path, f);
  }
  const plan = { nodes: [], writes: [], extracted: 0 };
  for (const f of out2.files) {
    const repoPath = repoPaths.get(f.repo);
    if (!repoPath) continue;
    const path = WorldModelGraph.fileKey(f.repo, f.path);
    const prev = existing.get(path);
    const md52 = f.content_md5 ?? "";
    if (prev && md52 !== "" && prev.content_md5 === md52) {
      if (prev.purpose_source === "none" && isPurposeCandidate(f.path)) {
        const extracted = extractPurpose(f.path, readFileHead(join13(repoPath, f.path)));
        plan.extracted++;
        if (extracted.source !== "none") {
          const node2 = { ...prev, purpose: extracted.purpose, purpose_source: extracted.source, updated_at: now2 };
          plan.nodes.push(node2);
          plan.writes.push(node2);
          continue;
        }
      }
      plan.nodes.push(prev);
      continue;
    }
    const facts = {
      path,
      repo: f.repo,
      dir: fileDir(f.path),
      content_md5: md52,
      size_bytes: Number(f.size_bytes ?? 0),
      last_commit_sha: f.last_commit_sha ?? "",
      updated_at: now2
    };
    let node;
    if (prev?.purpose_source === "swe") {
      node = { ...facts, purpose: prev.purpose, purpose_source: prev.purpose_source };
    } else {
      const extracted = isPurposeCandidate(f.path) ? extractPurpose(f.path, readFileHead(join13(repoPath, f.path))) : { purpose: "", source: "none" };
      node = { ...facts, purpose: extracted.purpose, purpose_source: extracted.source };
      plan.extracted++;
    }
    plan.nodes.push(node);
    plan.writes.push(node);
  }
  return plan;
}
function purposesByDirectory(nodes) {
  const byDir = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (!n.purpose) continue;
    const key = `${n.repo} ${n.dir}`;
    const entry = { name: basename6(WorldModelGraph.relativeFilePath(n)), purpose: n.purpose };
    const list = byDir.get(key);
    if (list) list.push(entry);
    else byDir.set(key, [entry]);
  }
  return byDir;
}
function persistFilesGraph(graph, out2, plan) {
  let files_retired = 0;
  for (const n of plan.writes) graph.upsertFile(n);
  for (const r of out2.repos) {
    const linked = graph.filePathsWithDirectory(r.name);
    for (const n of plan.nodes) {
      if (n.repo === r.name && !linked.has(n.path)) graph.upsertHasFile(n.repo, n.dir, n.path);
    }
    const keep = new Set(plan.nodes.filter((n) => n.repo === r.name).map((n) => n.path));
    files_retired += graph.pruneFiles(r.name, keep);
  }
  return { files_upserted: plan.writes.length, files_retired };
}
function readRepoRemotes(path) {
  try {
    const opts = { encoding: "utf8", timeout: 3e3 };
    const listR = spawnSync6("git", ["-C", path, "remote"], opts);
    if (listR.status !== 0) return [];
    const names = (listR.stdout ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    const remotes = [];
    for (const name2 of names) {
      const urlR = spawnSync6("git", ["-C", path, "remote", "get-url", name2], opts);
      if (urlR.status !== 0) continue;
      const url = (urlR.stdout ?? "").trim();
      if (!url) continue;
      remotes.push({ name: name2, provider: classifyUrl(url), url });
    }
    return remotes;
  } catch {
    return [];
  }
}
function canonicalPath(p) {
  try {
    return realpathSync2(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}
function normalizeRemoteUrl(url) {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}
function primaryRemoteUrl(remotes) {
  const primary = remotes[primaryIndex(remotes)];
  return primary ? normalizeRemoteUrl(primary.url) : null;
}
function detectRenames(existing, discovered, remotesByRepo, storedRemotes) {
  const scannedNames = new Set(discovered.map((r) => r.name));
  const existingNames = new Set(existing.map((r) => r.name));
  const orphaned = existing.filter((r) => !scannedNames.has(r.name));
  const claimed = /* @__PURE__ */ new Set();
  const candidates = [];
  for (const r of discovered) {
    if (existingNames.has(r.name)) continue;
    const path = canonicalPath(r.path);
    const remote = primaryRemoteUrl(remotesByRepo.get(r.name) ?? []);
    let match = null;
    for (const row of orphaned) {
      if (claimed.has(row.name)) continue;
      if (canonicalPath(row.path) === path) {
        match = { name: row.name, by: "path" };
        break;
      }
    }
    if (!match && remote) {
      for (const row of orphaned) {
        if (claimed.has(row.name)) continue;
        if (primaryRemoteUrl(storedRemotes(row.name)) === remote) {
          match = { name: row.name, by: "remote" };
          break;
        }
      }
    }
    if (match) {
      claimed.add(match.name);
      candidates.push({ old: match.name, new: r.name, by: match.by, path: r.path });
    }
  }
  return candidates;
}
function noSyncRemoteWarnings(db, repos) {
  const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
  let issueSync = "off";
  try {
    if (row) issueSync = String(JSON.parse(row.value_json));
  } catch {
    issueSync = "off";
  }
  if (issueSync === "off") return [];
  return repos.filter((repo) => {
    const remotes = repoRemotes(db, repo);
    return remotes.length > 0 && !remotes.some((r) => r.sync);
  }).map((repo) => ({
    repo,
    reason: "no_sync_remote",
    hint: "Issue and milestone sync reach no remote for this repo; re-run /onboard to choose the Remote."
  }));
}
var SYMBOL_STAT_KEYS = ["files_parsed", "files_failed", "symbols", "edges", "edges_resolved"];
function persistedFiles(files, renamedTo) {
  return files.filter((f) => !renamedTo.has(f.repo) && !isGeneratedPath(f.path));
}
async function persistScan(db, graph, out2, sessionDir) {
  const now2 = nowISO();
  const normSession = sessionDir.replace(/\/+$/, "");
  const existing = db.all(`SELECT name, path FROM repos`);
  const remotesByRepo = /* @__PURE__ */ new Map();
  for (const r of out2.repos) remotesByRepo.set(r.name, readRepoRemotes(r.path));
  const rename_candidates = detectRenames(existing, out2.repos, remotesByRepo, (repo) => repoRemotes(db, repo));
  const renamedTo = new Set(rename_candidates.map((c) => c.new));
  const renamedFrom = new Set(rename_candidates.map((c) => c.old));
  const persisted = {
    ...out2,
    repos: out2.repos.filter((r) => !renamedTo.has(r.name)),
    files: persistedFiles(out2.files, renamedTo)
  };
  const scannedNames = new Set(persisted.repos.map((r) => r.name));
  const toRetire = existing.filter((r) => {
    const normPath = r.path.replace(/\/+$/, "");
    const underSession = normPath === normSession || normPath.startsWith(normSession + "/");
    return underSession && !scannedNames.has(r.name) && !renamedFrom.has(r.name);
  });
  let repos_upserted = 0;
  let repos_retired = 0;
  let dirs_retired = 0;
  const retired = [];
  const repos_stale_kept = [];
  db.transaction(() => {
    for (const r of persisted.repos) {
      db.run(
        `INSERT INTO repos (name, path, file_count, last_scanned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           file_count = excluded.file_count,
           last_scanned_at = excluded.last_scanned_at`,
        [r.name, r.path, r.file_count, now2]
      );
      upsertRepoRemotes(db, r.name, remotesByRepo.get(r.name) ?? []);
      repos_upserted++;
    }
    for (const r of toRetire) {
      if (db.get(`SELECT 1 FROM tasks WHERE repo = ? LIMIT 1`, [r.name])) {
        repos_stale_kept.push({ name: r.name, path: r.path, reason: "task_referenced" });
        continue;
      }
      db.run(`SAVEPOINT retire_repo`);
      try {
        db.run(
          `DELETE FROM milestones WHERE repo = ? AND NOT EXISTS
             (SELECT 1 FROM issues WHERE issues.repo = milestones.repo AND issues.milestone = milestones.name)`,
          [r.name]
        );
        db.run(`DELETE FROM repos WHERE name = ?`, [r.name]);
        db.run(`RELEASE retire_repo`);
        repos_retired++;
        retired.push({ name: r.name, path: r.path });
      } catch {
        db.run(`ROLLBACK TO retire_repo`);
        db.run(`RELEASE retire_repo`);
        repos_stale_kept.push({ name: r.name, path: r.path, reason: "row_referenced" });
      }
    }
    for (const c of rename_candidates) {
      insertAudit(db, {
        issue_id: -1,
        from_node: "bro",
        event_type: "repo_rename_detected",
        summary: `Scan: repo ${c.old} looks renamed to ${c.new} (matched by ${c.by}); run repo_rename to apply`,
        content_json: JSON.stringify({ old: c.old, new: c.new, by: c.by }),
        repo: c.old
      });
    }
  });
  let files_upserted = 0;
  let files_extracted = 0;
  let files_retired = 0;
  let dirs_upserted = 0;
  let dirs_readme_summarized = 0;
  let dirs_structural_summarized = 0;
  if (graph) {
    const plan = planFiles(graph, persisted, now2);
    files_extracted = plan.extracted;
    const drift = planReadmeDrift(persisted);
    graph.transaction(() => {
      for (const r of retired) {
        dirs_retired += graph.pruneDirectories(r.name, /* @__PURE__ */ new Set());
        files_retired += graph.pruneFiles(r.name, /* @__PURE__ */ new Set());
      }
      const stats = persistDirectoriesGraph(graph, persisted, now2, purposesByDirectory(plan.nodes), drift);
      dirs_upserted = stats.dirs_upserted;
      dirs_readme_summarized = stats.dirs_readme_summarized;
      dirs_structural_summarized = stats.dirs_structural_summarized;
      const dirMap = deriveDirectoryEntries(persisted);
      for (const r of persisted.repos) {
        const keepKeys = /* @__PURE__ */ new Set();
        for (const [, entry] of dirMap) {
          if (entry.repo === r.name) {
            keepKeys.add(WorldModelGraph.dirKey(r.name, entry.path));
          }
        }
        graph.pruneDirectories(r.name, keepKeys);
      }
      const fileStats = persistFilesGraph(graph, persisted, plan);
      files_upserted = fileStats.files_upserted;
      files_retired += fileStats.files_retired;
    });
  }
  const symbols = { files_parsed: 0, files_failed: 0, symbols: 0, edges: 0, edges_resolved: 0 };
  if (graph) {
    for (const r of persisted.repos) {
      try {
        const repoStats = await indexRepoSymbols(db, r.name, r.path);
        for (const key of SYMBOL_STAT_KEYS) symbols[key] += repoStats[key];
      } catch (e) {
        symbols.error = `${r.name}: ${e.message}`;
        serverLog({ event: "symbol_index_error", repo: r.name, error: e.message });
      }
      try {
        refreshSymbolPurposes(db, r.name);
      } catch (e) {
        serverLog({ event: "symbol_purpose_error", repo: r.name, error: e.message });
      }
      try {
        refreshConcepts(db, r.name);
      } catch (e) {
        serverLog({ event: "concept_refresh_error", repo: r.name, error: e.message });
      }
      try {
        applyConceptProposals(db, r.name, r.path);
      } catch (e) {
        serverLog({ event: "concept_proposals_error", repo: r.name, error: e.message });
      }
    }
  }
  return {
    repos_discovered: out2.repos.length,
    repos_upserted,
    repos_retired,
    repos_stale_kept,
    dirs_upserted,
    dirs_retired,
    dirs_readme_summarized,
    dirs_structural_summarized,
    files_upserted,
    files_extracted,
    files_retired,
    symbols,
    rename_candidates
  };
}
var SCAN_TIMEOUT_MS = 10 * 60 * 1e3;
function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync6(lockPath, "utf8"));
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireLock(lockPath) {
  const existing = readLock(lockPath);
  if (existing) {
    if (pidAlive(existing.pid)) return false;
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: nowISO() }), { flag: "wx" });
  return true;
}
function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
  }
}
function scanTools(db, graphHolder = null, dbPath = "") {
  const definitions = [
    {
      name: "scan_run",
      description: "Run a deterministic project scan: discovers git repos under the session dir, enumerates tracked files (.gitignore-aware), and writes directory + file rows to the world model. Directory summaries come from README.md (summary_source='readme') or a structural fallback (summary_source='structural'). Emits a deep_scan_completed audit event with source and structural_change fields. A renamed repo lands in rename_candidates for repo_rename, never as a second row. warnings (always an array, empty when none) lists repos whose remotes have no sync row while issue_sync is on (reason no_sync_remote). Hard timeout: 10 minutes.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          session_dir: {
            type: "string",
            description: "Absolute path to the session directory (workspace root). Defaults to the project root (the directory holding the trajectory DB's .claude/)."
          },
          source: {
            type: "string",
            enum: ["user_manual", "bro_auto_post_close", "bro_auto_post_change", "bro_auto_initial", "startup_catchup"],
            description: "Who fired this scan. user_manual = the user typed /scan; bro_auto_post_close = post-task-close-rescan.sh hook; bro_auto_post_change = bro decided to rescan mid-session; bro_auto_initial = bro hit the registry-cold gate and ran scan as remediation; startup_catchup = the server's connect-time catch-up. Defaults to bro_auto_initial."
          }
        },
        required: ["agent"]
      }
    },
    {
      name: "repos_list",
      description: "List all repos discovered by the most recent scan.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" }
        },
        required: ["agent"]
      }
    }
  ];
  const handlers = {
    scan_run: requireRoles(
      "scan_run",
      ["bro"],
      wrap(async (args2) => {
        const sessionDir = args2["session_dir"] ?? projectRootFromDbPath(dbPath);
        if (!sessionDir) {
          return err2("session_dir is required: the project root is unknown for this trajectory DB");
        }
        const rawSource = args2["source"] ?? "bro_auto_initial";
        const source = VALID_SCAN_SOURCES.has(rawSource) ? rawSource : "bro_auto_initial";
        const graph = graphHolder ? graphHolder.ensureGraph() : new WorldModelGraph(db);
        const graphOpenError = graphHolder?.openError ?? null;
        if (!graph && graphOpenError) {
          return err2(`graph_db_open_failed: ${graphOpenError}`);
        }
        const lockPath = dbPath && dbPath !== ":memory:" ? join13(dirname5(dbPath), "scan.lock") : "";
        if (lockPath) {
          const existing = readLock(lockPath);
          if (existing && pidAlive(existing.pid)) {
            return err2(`scan already running (pid ${existing.pid}, started ${existing.started_at})`);
          }
          let acquired = false;
          let acquireThrew = false;
          try {
            acquired = acquireLock(lockPath);
          } catch {
            acquireThrew = true;
          }
          if (!acquired) {
            const recheck = readLock(lockPath);
            if (recheck && pidAlive(recheck.pid)) {
              return err2(`scan already running (pid ${recheck.pid}, started ${recheck.started_at})`);
            }
            if (!acquireThrew) {
              return err2("scan lock could not be acquired");
            }
          }
        }
        try {
          const out2 = await runScan(sessionDir, SCAN_TIMEOUT_MS, dbPath);
          if (!graph && out2.files.length > 0) {
            return err2("world_model_unavailable: no world-model graph to write; repos and deep_scan_completed left unchanged");
          }
          const dirsBefore = graph?.directoryCount() ?? 0;
          const stats = await persistScan(db, graph, out2, sessionDir);
          const spawnFn = args2["_spawnFn"];
          const renamedTo = new Set(stats.rename_candidates.map((c) => c.new));
          const upsertedRepos = out2.repos.filter((repo) => !renamedTo.has(repo.name));
          const files = persistedFiles(out2.files, renamedTo);
          const warnings = noSyncRemoteWarnings(db, upsertedRepos.map((r) => r.name));
          for (const r of upsertedRepos) {
            try {
              syncRepoMilestones(db, r.name, r.path, spawnFn);
            } catch (e) {
              serverLog({ event: "milestone_sync_error", repo: r.name, error: e.message });
            }
          }
          const topDirs = new Set(files.map((f) => f.path.split("/")[0]).filter(Boolean));
          const structuralChange = detectStructuralChange(
            db,
            out2.repos,
            topDirs,
            dirsBefore === 0 && stats.dirs_upserted > 0
          );
          const pluginInventory = out2.plugin_inventory ?? null;
          const pluginNote = pluginInventory?.status === "unavailable" ? `; plugins unavailable: ${pluginInventory.note}` : "";
          const mcpInventory = out2.mcp_inventory ?? null;
          const mcpNote = mcpInventory?.status === "unavailable" ? `; mcp servers unavailable: ${mcpInventory.note}` : "";
          insertAudit(db, {
            issue_id: -1,
            from_node: "bro",
            event_type: "deep_scan_completed",
            summary: `Scan: discovered ${stats.repos_discovered} repos, upserted ${stats.repos_upserted}, retired ${stats.repos_retired}${stats.repos_stale_kept.length ? ` (kept ${stats.repos_stale_kept.length} stale, still referenced)` : ""}; ${files.length} files; dirs upserted ${stats.dirs_upserted} (${stats.dirs_readme_summarized} README + ${stats.dirs_structural_summarized} structural), retired ${stats.dirs_retired}; files upserted ${stats.files_upserted} (${stats.files_extracted} extracted), retired ${stats.files_retired}; symbols ${stats.symbols.symbols} in ${stats.symbols.files_parsed} parsed files (${stats.symbols.files_failed} failed), edges ${stats.symbols.edges_resolved}/${stats.symbols.edges} resolved \u2014 source=${source}${structuralChange ? ", structural-change" : ""}${pluginNote}${mcpNote}`,
            content_json: JSON.stringify({
              ...stats,
              session_dir: out2.session_dir,
              scanned_at: out2.scanned_at,
              source,
              structural_change: structuralChange,
              repos_seen: out2.repos.map((r) => r.name),
              top_dirs: Array.from(topDirs).sort()
            })
          });
          return ok({
            session_dir: out2.session_dir,
            scanned_at: out2.scanned_at,
            repos: out2.repos.map((r) => ({ name: r.name, file_count: r.file_count })),
            source,
            structural_change: structuralChange,
            plugin_inventory: pluginInventory,
            mcp_inventory: mcpInventory,
            ...stats,
            warnings
          });
        } finally {
          if (lockPath) releaseLock(lockPath);
        }
      })
    ),
    repos_list: requireRoles(
      "repos_list",
      ["bro", "swe", "code-reviewer", "consultant"],
      wrap(async () => {
        const rows = db.all(`SELECT name, path, file_count, last_scanned_at FROM repos ORDER BY name`);
        return ok({ repos: rows });
      })
    )
  };
  return { definitions, handlers };
}
export {
  GraphHolder,
  TrajectoryDB,
  WorldModelGraph2 as WorldModelGraph,
  scanTools
};
//# sourceMappingURL=run-scan.js.map
