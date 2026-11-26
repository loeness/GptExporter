(function attachGptExporterComparisonExtractor(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const MAX_SOURCE_BYTES = 256 * 1024;
  const MAX_AST_NODES = 45000;
  const MAX_AST_DEPTH = 128;
  const MAX_EVAL_DEPTH = 64;
  const MAX_EVAL_STEPS = 15000;
  const MAX_TOTAL_EVAL_STEPS = 90000;
  const MAX_CARDS = 12;
  const MAX_LIST_LENGTH = 128;
  const MAX_DATA_ENTRIES = 18000;
  const MAX_TEXT_LENGTH = 8000;
  const MAX_OUTPUT_TEXT = 24000;
  const MAX_OUTPUT_NODES = 1600;
  const RESERVED = new Set(['DIL', '__dil', '__dilSafe', 'Math', 'Array', 'Number']);
  const JSX_TYPES = new Set([
    'card', 'box', 'row', 'column', 'text', 'title', 'caption', 'divider', 'table',
    'table-row', 'table-cell', 'strong', 'em', 'bold', 'italic', 'code',
    'list', 'list-item', 'badge', 'heading', 'label'
  ]);
  const JSX_PROPS = new Set(['header', 'color', 'align', 'size', 'weight', 'variant']);
  const UNSUPPORTED = Symbol('unsupported');
  const MISSING = Symbol('missing');

  function check(condition) {
    if (!condition) throw UNSUPPORTED;
  }

  function isScalar(value) {
    return value === null || typeof value === 'boolean'
      || (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH)
      || (typeof value === 'number' && Number.isFinite(value));
  }

  function checkedScalar(value) {
    check(isScalar(value));
    return value;
  }

  function isSafeKey(key) {
    return (typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)))
      && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  function dataProperty(object, key) {
    check(object && typeof object === 'object' && isSafeKey(key));
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return MISSING;
    check(Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
  }

  function cloneJson(value, budget, depth = 0) {
    check(depth <= MAX_EVAL_DEPTH && --budget.remaining >= 0);
    if (isScalar(value)) return value;
    check(value && typeof value === 'object');
    if (Array.isArray(value)) {
      check(value.length <= MAX_LIST_LENGTH && value.length <= budget.remaining);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(cloneJson(dataProperty(value, index), budget, depth + 1));
      }
      return items;
    }
    const record = Object.create(null);
    for (const key of Object.keys(value)) {
      // Prototype-related property names have no representation in interpreter data.
      if (isSafeKey(key)) record[key] = cloneJson(dataProperty(value, key), budget, depth + 1);
    }
    return record;
  }

  function identifier(node, name) {
    return node?.type === 'Identifier' && node.name === name;
  }

  function directCall(node, name) {
    return node?.type === 'CallExpression' && !node.optional && identifier(node.callee, name);
  }

  function methodCall(node, receiver, method) {
    const callee = node?.callee;
    return node?.type === 'CallExpression' && !node.optional
      && callee?.type === 'MemberExpression' && !callee.optional && !callee.computed
      && identifier(callee.object, receiver) && identifier(callee.property, method);
  }

  function jsxType(node) {
    if (methodCall(node, '__dil', 'jsx') && node.arguments[0]?.type === 'Literal') {
      return node.arguments[0].value;
    }
    return null;
  }

  function objectProperties(node) {
    check(node?.type === 'ObjectExpression' && node.properties.length <= MAX_LIST_LENGTH);
    return node.properties.map(property => {
      check(property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed);
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      check(isSafeKey(key));
      return [String(key), property.value];
    });
  }

  function arrow(node) {
    check(node?.type === 'ArrowFunctionExpression' && !node.async && node.params.length <= 3);
    const names = node.params.map(param => {
      check(param.type === 'Identifier' && !RESERVED.has(param.name));
      return param.name;
    });
    check(new Set(names).size === names.length);
    return names;
  }

  function renderRoots(program) {
    return program.body.flatMap(statement => {
      const render = statement.expression;
      const jsx = render?.arguments?.[0];
      const component = jsx?.arguments?.[0];
      if (statement.type === 'ExpressionStatement' && methodCall(render, 'DIL', 'render')
        && methodCall(jsx, '__dil', 'jsx') && component?.type === 'ArrowFunctionExpression'
        && !component.async && component.params.length === 0 && component.body.type === 'BlockStatement') {
        return [component.body.body];
      }
      return [];
    });
  }

  function rootBindings(statements, dil) {
    const bindings = new Map();
    const states = new Map();
    const declarations = new Set();
    const jsonRoots = new WeakMap();
    const constants = dataProperty(dil, 'constants');
    const rawView = dataProperty(dil, 'viewState');
    const view = rawView && typeof rawView === 'object' ? dataProperty(rawView, 'root') : MISSING;

    function declare(identifierNode) {
      check(identifierNode?.type === 'Identifier');
      const name = identifierNode.name;
      check(!RESERVED.has(name) && !declarations.has(name));
      declarations.add(name);
      return name;
    }

    for (const statement of statements) {
      if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
      for (const { id, init } of statement.declarations) {
        if (id.type === 'Identifier') {
          const name = declare(id);
          if (methodCall(init, 'DIL', 'useConstants') && init.arguments.length === 0) {
            const reference = Object.create(null);
            if (constants !== MISSING) jsonRoots.set(reference, constants);
            bindings.set(name, reference);
          } else if (init?.type === 'Literal' && isScalar(init.value)) {
            bindings.set(name, init.value);
          }
          continue;
        }

        if (id.type !== 'ArrayPattern' || id.elements.length !== 2
          || !id.elements.every(element => element?.type === 'Identifier')
          || !methodCall(init, 'DIL', 'useState')) continue;
        const name = declare(id.elements[0]);
        const setter = declare(id.elements[1]);
        const [initial, settings] = init.arguments;
        if (initial?.type !== 'Literal' || !isScalar(initial.value)) continue;
        let value = initial.value;
        if (settings?.type === 'ObjectExpression') {
          const key = new Map(objectProperties(settings)).get('key');
          if (key?.type === 'Literal' && typeof key.value === 'string' && isSafeKey(key.value)
            && view && typeof view === 'object') {
            const current = dataProperty(view, key.value);
            if (isScalar(current)) value = current;
          }
        }
        bindings.set(name, value);
        states.set(name, setter);
      }
    }
    check(bindings.size <= 256);
    return { bindings, states, jsonRoots };
  }

  function comparisonCandidates(expression, budget) {
    const candidates = new Map();

    function walk(node, containers, depth) {
      check(depth <= MAX_AST_DEPTH && --budget.remaining >= 0);
      const type = jsxType(node);
      if (type === 'segmented-control' && containers.length) {
        const owner = containers.at(-1);
        const candidate = candidates.get(owner) || { control: node, controlCount: 0 };
        candidate.controlCount += 1;
        candidates.set(owner, candidate);
      }

      const ancestors = type === 'box' || type === 'card' ? [...containers, node] : containers;
      if (methodCall(node, '__dil', 'jsx')) {
        // Follow rendered children only. A card in a callback prop has not rendered.
        for (const child of node.arguments.slice(2)) walk(child, ancestors, depth + 1);
        return;
      }
      if (directCall(node, '__dilSafe')) {
        const callback = node.arguments[0];
        if (callback?.type === 'ArrowFunctionExpression' && !callback.async && !callback.params.length &&
            callback.body.type !== 'BlockStatement') walk(callback.body, ancestors, depth + 1);
        return;
      }
      if (node.type === 'ArrayExpression') {
        for (const child of node.elements) if (child) walk(child, ancestors, depth + 1);
      }
    }

    walk(expression, [], 0);
    return [...candidates].sort(([left], [right]) => left.start - right.start);
  }

  function applyBinary(operator, left, right) {
    checkedScalar(left);
    checkedScalar(right);
    switch (operator) {
      case '+': return checkedScalar(left + right);
      case '-': return checkedScalar(left - right);
      case '*': return checkedScalar(left * right);
      case '/': return checkedScalar(left / right);
      case '%': return checkedScalar(left % right);
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '===': return left === right;
      case '!==': return left !== right;
      default: throw UNSUPPORTED;
    }
  }

  function createInterpreter(control, totalBudget, jsonRoots) {
    let steps = MAX_EVAL_STEPS;
    let outputText = MAX_OUTPUT_TEXT;
    let outputNodes = MAX_OUTPUT_NODES;
    const nodes = new WeakMap();
    const dataBudget = { remaining: MAX_DATA_ENTRIES };

    function appendChild(output, value, size, depth = 0) {
      check(depth <= MAX_EVAL_DEPTH && --outputNodes >= 0);
      if (Array.isArray(value)) {
        for (const item of value) appendChild(output, item, size, depth + 1);
      } else if (typeof value === 'string' || typeof value === 'number') {
        const length = String(value).length;
        outputText -= length;
        size.text += length;
        size.nodes += 1;
        output.push(value);
      } else if (value && nodes.has(value)) {
        const childSize = nodes.get(value);
        outputText -= childSize.text;
        outputNodes -= childSize.nodes - 1;
        size.text += childSize.text;
        size.nodes += childSize.nodes;
        output.push(value);
      } else {
        check(value === null || value === undefined || typeof value === 'boolean');
      }
      check(outputText >= 0 && outputNodes >= 0);
    }

    function evaluate(node, scope, depth = 0) {
      check(node && depth <= MAX_EVAL_DEPTH && --steps >= 0 && --totalBudget.remaining >= 0);
      const read = child => evaluate(child, scope, depth + 1);

      function invoke(callback, values) {
        const names = arrow(callback);
        const inner = new Map(scope);
        names.forEach((name, index) => inner.set(name, values[index]));
        if (callback.body.type !== 'BlockStatement') return evaluate(callback.body, inner, depth + 1);
        const statements = callback.body.body;
        check(statements.length === 1 && statements[0].type === 'ReturnStatement');
        return evaluate(statements[0].argument, inner, depth + 1);
      }

      switch (node.type) {
        case 'Literal':
          return checkedScalar(node.value);
        case 'Identifier':
          check(scope.has(node.name));
          return scope.get(node.name);
        case 'ArrayExpression':
          check(node.elements.length <= MAX_LIST_LENGTH);
          return node.elements.map(read);
        case 'ObjectExpression': {
          const data = Object.create(null);
          for (const [key, value] of objectProperties(node)) data[key] = read(value);
          return data;
        }
        case 'MemberExpression': {
          check(!node.optional);
          const object = read(node.object);
          check(object && !nodes.has(object));
          const key = node.computed ? read(node.property) : node.property.name;
          const fromConstants = jsonRoots.has(object);
          const value = dataProperty(fromConstants ? jsonRoots.get(object) : object, key);
          check(value !== MISSING);
          return fromConstants ? cloneJson(value, dataBudget) : value;
        }
        case 'ConditionalExpression':
          return read(node.test) ? read(node.consequent) : read(node.alternate);
        case 'LogicalExpression': {
          const left = read(node.left);
          if (node.operator === '&&') return left && read(node.right);
          if (node.operator === '||') return left || read(node.right);
          if (node.operator === '??') return left ?? read(node.right);
          throw UNSUPPORTED;
        }
        case 'UnaryExpression': {
          const value = checkedScalar(read(node.argument));
          if (node.operator === '!') return !value;
          if (node.operator === '+') return checkedScalar(+value);
          if (node.operator === '-') return checkedScalar(-value);
          throw UNSUPPORTED;
        }
        case 'BinaryExpression':
          return applyBinary(node.operator, read(node.left), read(node.right));
        case 'CallExpression': {
          check(!node.optional);
          const args = node.arguments;
          if (node === control) return null;
          if (directCall(node, '__dilSafe')) {
            check(args.length === 1 || args.length === 2);
            return invoke(args[0], []);
          }
          if (methodCall(node, '__dil', 'jsx')) {
            const type = jsxType(node);
            check(JSX_TYPES.has(type));
            const props = {};
            if (args[1] && !(args[1].type === 'Literal' && args[1].value === null)) {
              for (const [key, expression] of objectProperties(args[1])) {
                if (JSX_PROPS.has(key)) props[key] = checkedScalar(read(expression));
              }
            }
            const children = [];
            const size = { nodes: 1, text: 0 };
            for (const child of args.slice(2)) appendChild(children, read(child), size);
            const component = { type, props, children };
            nodes.set(component, size);
            return component;
          }
          if (directCall(node, 'Number')) {
            check(args.length === 1);
            return checkedScalar(Number(checkedScalar(read(args[0]))));
          }
          if (methodCall(node, 'Math', 'min') || methodCall(node, 'Math', 'max')) {
            check(args.length > 0 && args.length <= MAX_LIST_LENGTH);
            const values = args.map(arg => Number(checkedScalar(read(arg))));
            return checkedScalar(methodCall(node, 'Math', 'min') ? Math.min(...values) : Math.max(...values));
          }
          if (methodCall(node, 'Array', 'from')) {
            check(args.length === 2);
            const properties = objectProperties(args[0]);
            check(properties.length === 1 && properties[0][0] === 'length');
            const length = read(properties[0][1]);
            check(Number.isInteger(length) && length >= 0 && length <= MAX_LIST_LENGTH);
            arrow(args[1]);
            return Array.from({ length }, (_, index) => invoke(args[1], [undefined, index]));
          }
          const callee = node.callee;
          if (callee.type === 'MemberExpression' && !callee.optional && !callee.computed
            && identifier(callee.property, 'map') && args.length === 1) {
            const list = read(callee.object);
            check(Array.isArray(list) && list.length <= MAX_LIST_LENGTH);
            arrow(args[0]);
            return list.map((item, index) => invoke(args[0], [item, index, list]));
          }
          throw UNSUPPORTED;
        }
        default:
          throw UNSUPPORTED;
      }
    }

    return { evaluate };
  }

  function validatedOptions(control, { bindings, states, jsonRoots }, budget) {
    check(control.arguments.length === 2);
    const properties = new Map(objectProperties(control.arguments[1]));
    const state = properties.get('value');
    check(state?.type === 'Identifier' && states.has(state.name));
    check(identifier(properties.get('onChange'), states.get(state.name)));
    const options = createInterpreter(null, budget, jsonRoots).evaluate(properties.get('options'), bindings);
    check(Array.isArray(options) && options.length >= 2 && options.length <= 6);
    const usedValues = new Set();
    const usedLabels = new Set();
    const values = options.map(option => {
      const value = option && typeof option === 'object' ? dataProperty(option, 'value') : option;
      const label = option && typeof option === 'object' ? dataProperty(option, 'label') : String(value);
      check((typeof value === 'string' || typeof value === 'number') && isScalar(value));
      check(typeof label === 'string' && label.trim() && label.length <= 200);
      check(!usedLabels.has(label) && !usedValues.has(value));
      usedLabels.add(label);
      usedValues.add(value);
      return { label, value };
    });
    return { name: state.name, values };
  }

  function extractDilComparisons(dil) {
    const comparisons = [];
    try {
      const code = dataProperty(dil, 'code');
      check(typeof code === 'string' && code.length <= MAX_SOURCE_BYTES
        && new TextEncoder().encode(code).length <= MAX_SOURCE_BYTES);
      if (typeof root.acorn?.parse !== 'function') return comparisons;
      const program = root.acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
      const astBudget = { remaining: MAX_AST_NODES };
      const evalBudget = { remaining: MAX_TOTAL_EVAL_STEPS };

      for (const statements of renderRoots(program)) {
        const returns = statements.filter(statement => statement.type === 'ReturnStatement');
        if (returns.length !== 1 || !returns[0].argument) continue;
        let environment;
        try {
          environment = rootBindings(statements, dil);
        } catch {
          continue;
        }

        for (const [container, candidate] of comparisonCandidates(returns[0].argument, astBudget)) {
          if (comparisons.length >= MAX_CARDS || evalBudget.remaining <= 0) return comparisons;
          if (candidate.controlCount !== 1) continue;
          try {
            const { bindings, jsonRoots } = environment;
            const { name, values } = validatedOptions(candidate.control, environment, evalBudget);
            const options = values.map(({ label, value }) => {
              const scope = new Map(bindings).set(name, value);
              const node = createInterpreter(candidate.control, evalBudget, jsonRoots).evaluate(container, scope);
              return { label, nodes: [node] };
            });
            comparisons.push({ options });
          } catch {
            // A card with any unsupported option is omitted as a whole.
          }
        }
      }
    } catch {
      // Malformed or oversized payloads leave the surrounding export intact.
    }
    return comparisons;
  }

  api.extractDilComparisons = extractDilComparisons;
})(globalThis);
