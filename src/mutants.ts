// 壊し方の規則（EqualityOperator・LogicalOperator・ConditionalExpression・BooleanLiteral・
// MethodExpression・CallExpression）と構文木のたどり方は、
// mizchi/mutator の packages/core/src/mutators.ts と ast.ts（97f8260590f80c20c1b7ccfcf8a92db5be5b7c7e）から移した。
// 許諾の文はmutants-license.txtにあり、生成するruntimeの先頭にも書く。
import assert from 'node:assert/strict';
import type * as Oxc from 'oxc-parser';
import { isRecord, sha256 } from './values.ts';

// oxc-parserは、mutationの操作を実行したときに読み込む。生成したruntimeを読み込む時点では、組み込みモジュールだけをimportする。
export type Parser = Pick<typeof Oxc, 'parseSync' | 'visitorKeys'>;

export type Rule =
  | 'BooleanLiteral'
  | 'CallExpression'
  | 'ConditionalExpression'
  | 'EqualityOperator'
  | 'LogicalOperator'
  | 'MethodExpression';

/** startとendは、置き換える範囲のUTF-16の位置である。lineは1から数える。 */
export type Mutant = {
  key: string;
  path: string;
  line: number;
  rule: Rule;
  original: string;
  replacement: string;
  start: number;
  end: number;
};

type Node = { type: string; start: number; end: number; [key: string]: unknown };

type Frame = { node: Node; parent: Frame | undefined; key: string; index: number | undefined };

type Candidate = { rule: Rule; start: number; end: number; replacement: string; frame: Frame };

function isNode(value: unknown): value is Node {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  );
}

function child(node: Node, key: string): Node | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function operator(node: Node): string {
  return typeof node.operator === 'string' ? node.operator : '';
}

// 型だけを持つキー。型引数の>や型の真偽値を壊さない。
const typeKeys = new Set([
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeArguments',
  'implements',
  'decorators',
]);

// 実行時の式を包むか含むTSの構文。declareで宣言したものを除き、中をたどる。
const tsRuntime = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'TSParameterProperty',
  'TSExportAssignment',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSEnumDeclaration',
  'TSEnumBody',
  'TSEnumMember',
]);

function isDirective(node: Node) {
  return node.type === 'ExpressionStatement' && typeof node.directive === 'string';
}

// 式の値と位置を変えない包み。
const transparent = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
]);

/** 包みと?.の連なりを外した式。 */
function unwrap(node: Node): Node {
  let current = node;
  while (transparent.has(current.type) || current.type === 'ChainExpression') {
    const inner = child(current, 'expression');
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

// 実行時のコードを含まない構文。
function isSkipped(node: Node): boolean {
  if (node.type.startsWith('TS')) {
    return !tsRuntime.has(node.type) || node.declare === true;
  }
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'Decorator':
      return true;
    case 'ExportNamedDeclaration':
      return node.source !== null || node.exportKind === 'type';
    case 'VariableDeclaration':
    case 'ClassDeclaration':
    case 'PropertyDefinition':
      return node.declare === true;
    case 'FunctionDeclaration':
      return node.declare === true || node.body === null;
    case 'ExpressionStatement':
      return isDirective(node);
    default:
      return false;
  }
}

function childFrames(frame: Frame, visitorKeys: Parser['visitorKeys']): Frame[] {
  const frames: Frame[] = [];
  for (const key of visitorKeys[frame.node.type] ?? []) {
    if (typeKeys.has(key)) {
      continue;
    }
    const value = frame.node[key];
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => {
        if (isNode(item)) {
          frames.push({ node: item, parent: frame, key, index });
        }
      });
    } else if (isNode(value)) {
      frames.push({ node: value, parent: frame, key, index: undefined });
    }
  }
  return frames;
}

/** 実行時の構文を、親から子の順にたどる。 */
function walk(program: Node, visitorKeys: Parser['visitorKeys'], visit: (frame: Frame) => void) {
  const go = (frame: Frame) => {
    if (isSkipped(frame.node)) {
      return;
    }
    visit(frame);
    for (const next of childFrames(frame, visitorKeys)) {
      go(next);
    }
  };
  go({ node: program, parent: undefined, key: '', index: undefined });
}

/** 包みの一番外側のframe。その親とキーが、式の実際の位置である。 */
function outermost(frame: Frame): Frame {
  let current = frame;
  while (current.parent && transparent.has(current.parent.node.type)) {
    current = current.parent;
  }
  return current;
}

function whole(frame: Frame, rule: Rule, replacement: string): Candidate {
  return { rule, start: frame.node.start, end: frame.node.end, replacement, frame };
}

/** leftとrightの間の演算子を置き換える。??は括弧なしで&&・||と混ぜられないため、論理式の項は括弧で包む。 */
function swapOperator(source: string, node: Node, from: string, to: string, logical: boolean) {
  const left = child(node, 'left');
  const right = child(node, 'right');
  // BinaryExpressionとLogicalExpressionは、ESTreeでleftとrightを必ず持つ。
  assert(left !== undefined && right !== undefined, `${node.type}にleftとrightがありません`);
  // 項の間のコメントにある同じ字を書き換えないよう、コメントを飛ばした演算子そのものの位置を探す。
  // oxc-parserは括弧をParenthesizedExpressionとして残すため、項の間には空白とコメントと演算子だけがある。
  const at = nextToken(source, left.end, from);
  assert(at >= 0 && at + from.length <= right.start, `${node.type}の演算子${from}が見つかりません`);
  const operand = (item: Node) => {
    const text = source.slice(item.start, item.end);
    return logical && item.type === 'LogicalExpression' ? `(${text})` : text;
  };
  const text =
    source.slice(node.start, left.start) +
    operand(left) +
    source.slice(left.end, at) +
    to +
    source.slice(at + from.length, right.start) +
    operand(right) +
    source.slice(right.end, node.end);
  return logical ? `(${text})` : text;
}

/**
 * startの位置が、文の並びの中にある式文の先頭か。
 * ifやwhileの波括弧の無い本体は、文の並びの中にないため含めない。そこへ;を置くと本体が空の文になる。
 */
function startsListedStatement(frame: Frame, start: number) {
  let current = frame;
  while (current.parent !== undefined && current.parent.node.start === start) {
    if (current.parent.node.type === 'ExpressionStatement') {
      return current.parent.index !== undefined;
    }
    current = current.parent;
  }
  return false;
}

const equality: Record<string, string[]> = {
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '==': ['!='],
  '!=': ['=='],
  '===': ['!=='],
  '!==': ['==='],
};

function isComparison(node: Node) {
  return node.type === 'BinaryExpression' && Object.hasOwn(equality, operator(node));
}

function equalityOperator(frame: Frame, source: string): Candidate[] {
  const { node } = frame;
  if (node.type !== 'BinaryExpression') {
    return [];
  }
  const from = operator(node);
  return (Object.hasOwn(equality, from) ? (equality[from] ?? []) : []).map((to) =>
    whole(frame, 'EqualityOperator', swapOperator(source, node, from, to, false)),
  );
}

const logical: Record<string, string> = { '&&': '||', '||': '&&', '??': '&&' };

function logicalOperator(frame: Frame, source: string): Candidate[] {
  const { node } = frame;
  const from = operator(node);
  const to = Object.hasOwn(logical, from) ? logical[from] : undefined;
  if (node.type !== 'LogicalExpression' || to === undefined) {
    return [];
  }
  return [whole(frame, 'LogicalOperator', swapOperator(source, node, from, to, true))];
}

const loops = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);
const conditions = new Set(['IfStatement', 'ConditionalExpression']);

/** fromの後に、空白とコメントだけを挟んでtokenがあれば、その位置を返す。ほかの字が先に来れば-1を返す。 */
function nextToken(source: string, from: number, token: string): number {
  let index = from;
  while (index < source.length) {
    if (source.startsWith(token, index)) {
      return index;
    }
    if (/\s/.test(source[index] ?? '')) {
      index++;
    } else if (source.startsWith('//', index)) {
      const newline = source.slice(index).search(/[\n\r\u2028\u2029]/);
      if (newline < 0) {
        return -1;
      }
      index += newline;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) {
        return -1;
      }
      index = end + 2;
    } else {
      return -1;
    }
  }
  return -1;
}

/** for (init; ; update)の空の条件へfalseを入れる。 */
function emptyForTest(frame: Frame, source: string): Candidate[] {
  const { node } = frame;
  const init = child(node, 'init');
  let from: number;
  if (init === undefined) {
    const paren = nextToken(source, node.start + 'for'.length, '(');
    if (paren < 0) {
      return [];
    }
    from = paren + 1;
  } else {
    from = init.end;
  }
  const semicolon = nextToken(source, from, ';');
  return semicolon < 0
    ? []
    : [
        {
          rule: 'ConditionalExpression',
          start: semicolon + 1,
          end: semicolon + 1,
          replacement: 'false',
          frame,
        },
      ];
}

// ループと条件分岐の条件の位置にあるか。
function isConditionTest(frame: Frame) {
  const type = frame.parent?.node.type;
  return frame.key === 'test' && type !== undefined && (loops.has(type) || conditions.has(type));
}

function isNegation(frame: Frame | undefined): frame is Frame {
  return frame?.node.type === 'UnaryExpression' && operator(frame.node) === '!';
}

function isNegatedConditionTest(position: Frame) {
  const negation = position.parent;
  return isNegation(negation) && isConditionTest(outermost(negation));
}

/** 条件の位置の外にある比較と論理式を、trueかfalseへ置き換える。 */
function operandConditions(frame: Frame): Candidate[] {
  const { node } = frame;
  const isLogical = node.type === 'LogicalExpression' && operator(node) !== '??';
  // 条件の位置にある式は、親の文が同じ壊し方をすでに作っている。
  const position = outermost(frame);
  if ((!isComparison(node) && !isLogical) || isConditionTest(position)) {
    return [];
  }
  if (isNegatedConditionTest(position)) {
    return [];
  }
  // a || trueとa && falseは、親の式を壊した結果と同じになるため作らない。
  const outer = position.parent?.node;
  const parentOperator = outer?.type === 'LogicalExpression' ? operator(outer) : undefined;
  return [
    ...(parentOperator === '||' ? [] : [whole(frame, 'ConditionalExpression', 'true')]),
    ...(parentOperator === '&&' ? [] : [whole(frame, 'ConditionalExpression', 'false')]),
  ];
}

function conditionalExpression(frame: Frame, source: string): Candidate[] {
  const { node, parent } = frame;
  if (parent === undefined) {
    return [];
  }
  if (node.type === 'ForStatement' && child(node, 'test') === undefined) {
    return emptyForTest(frame, source);
  }
  if (!isConditionTest(frame)) {
    return operandConditions(frame);
  }
  // ループの条件をtrueにすると終わらないため、falseだけにする。
  return loops.has(parent.node.type)
    ? [whole(frame, 'ConditionalExpression', 'false')]
    : [
        whole(frame, 'ConditionalExpression', 'true'),
        whole(frame, 'ConditionalExpression', 'false'),
      ];
}

const bare = new Set(['Identifier', 'ParenthesizedExpression']);

function booleanLiteral(frame: Frame, source: string): Candidate[] {
  const { node } = frame;
  if (node.type === 'Literal' && typeof node.value === 'boolean') {
    return [whole(frame, 'BooleanLiteral', node.value ? 'false' : 'true')];
  }
  const argument = child(node, 'argument');
  if (isNegation(frame) && argument !== undefined && !isNegation(outermost(frame).parent)) {
    const text = source.slice(argument.start, argument.end);
    // 外した後の先頭の字が、前の字や文の始まりとつながって読まれないよう、名前と括弧の式のほかは括弧で包む。
    return [whole(frame, 'BooleanLiteral', bare.has(argument.type) ? text : `(${text})`)];
  }
  return [];
}

function isSuperCall(node: Node | undefined) {
  return node?.type === 'CallExpression' && child(node, 'callee')?.type === 'Super';
}

/** call();を;へ置き換える。throwは、それを囲む条件の壊し方と重なるため壊さない。 */
function callExpression(frame: Frame): Candidate[] {
  const { node } = frame;
  const expression = node.type === 'ExpressionStatement' ? child(node, 'expression') : undefined;
  const call = expression === undefined ? undefined : unwrap(expression);
  if (call?.type !== 'CallExpression' || isSuperCall(call)) {
    return [];
  }
  return [whole(frame, 'CallExpression', ';')];
}

const methodRemovals = new Set([
  'charAt',
  'filter',
  'reverse',
  'slice',
  'sort',
  'substr',
  'substring',
  'trim',
]);

const methodSwaps: Record<string, string> = {
  endsWith: 'startsWith',
  startsWith: 'endsWith',
  every: 'some',
  some: 'every',
  toLocaleLowerCase: 'toLocaleUpperCase',
  toLocaleUpperCase: 'toLocaleLowerCase',
  toLowerCase: 'toUpperCase',
  toUpperCase: 'toLowerCase',
  trimEnd: 'trimStart',
  trimStart: 'trimEnd',
  min: 'max',
  max: 'min',
};

/** メソッドの呼び出しの、対になるメソッドへの入れ替えと、呼び出しを外して呼び出し先の式だけを残す壊し方。 */
function methodExpression(frame: Frame, source: string): Candidate[] {
  const { node } = frame;
  const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined;
  // obj[name]()の計算したキーと、#nameのprivateのメソッドは壊さない。
  if (callee?.type !== 'MemberExpression' || callee.computed === true) {
    return [];
  }
  const object = child(callee, 'object');
  const property = child(callee, 'property');
  const name = property?.type === 'Identifier' ? property.name : undefined;
  if (object === undefined || property === undefined || typeof name !== 'string') {
    return [];
  }
  // super.slice()からsuperだけを残すと、構文解析を通らない。入れ替えは、メソッドの名前だけを変えるので作る。
  if (methodRemovals.has(name)) {
    return object.type === 'Super'
      ? []
      : [whole(frame, 'MethodExpression', source.slice(object.start, object.end))];
  }
  const swap = Object.hasOwn(methodSwaps, name) ? methodSwaps[name] : undefined;
  return swap === undefined
    ? []
    : [
        {
          rule: 'MethodExpression',
          start: property.start,
          end: property.end,
          replacement: swap,
          frame,
        },
      ];
}

// 同じ範囲を同じ内容へ置き換える壊し方は、先に並ぶ規則の名前で1件にする。
const rules = [
  booleanLiteral,
  callExpression,
  conditionalExpression,
  equalityOperator,
  logicalOperator,
  methodExpression,
];

const functionTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function identifierName(node: Node | undefined) {
  if (node?.type === 'Identifier' && typeof node.name === 'string') {
    return node.name;
  }
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

/** クラスかオブジェクトの名前。宣言の名前か、代入先の変数の名前である。 */
function ownerName(frame: Frame | undefined): string | undefined {
  if (frame === undefined) {
    return undefined;
  }
  const own = identifierName(child(frame.node, 'id'));
  const holder = outermost(frame).parent?.node;
  return (
    own ?? (holder?.type === 'VariableDeclarator' ? identifierName(child(holder, 'id')) : undefined)
  );
}

const members = new Set(['MethodDefinition', 'Property', 'PropertyDefinition']);

/** メソッドとプロパティの名前。同じ名前のメソッドが別のクラスにあっても区別できるよう、持ち主と種類を付ける。 */
function memberName(holder: Frame): string | undefined {
  // [foo]のような計算したキーは、同じ字のfooという名前と区別できないため、名前に使わない。
  const key = holder.node.computed === true ? undefined : identifierName(child(holder.node, 'key'));
  if (key === undefined) {
    return undefined;
  }
  // メソッドの親はClassBodyで、その親がクラスである。プロパティの親はオブジェクトである。
  const owner = ownerName(holder.node.type === 'Property' ? holder.parent : holder.parent?.parent);
  const kind =
    holder.node.kind === 'get' || holder.node.kind === 'set' ? `${holder.node.kind} ` : '';
  const placement = holder.node.static === true ? 'static ' : '';
  return `${placement}${kind}${owner === undefined ? '' : `${owner}.`}${key}`;
}

/** 関数の名前。宣言の名前、代入先の変数、メソッドやプロパティの名前の順に探す。 */
function functionName(frame: Frame): string | undefined {
  const holder = outermost(frame).parent;
  return holder !== undefined && members.has(holder.node.type)
    ? memberName(holder)
    : ownerName(frame);
}

/** ファイルの先頭の文が宣言する名前。exportの中の宣言も読む。変数は1つだけを宣言する文に限る。 */
function declaredName(node: Node): string | undefined {
  const declaration =
    node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      ? child(node, 'declaration')
      : node;
  const declarators = declaration?.declarations;
  if (declaration?.type === 'VariableDeclaration' && Array.isArray(declarators)) {
    const [only, ...rest] = declarators.filter(isNode);
    return only !== undefined && rest.length === 0 ? identifierName(child(only, 'id')) : undefined;
  }
  const id = declaration === undefined ? undefined : child(declaration, 'id');
  return id?.type === 'Identifier' ? identifierName(id) : undefined;
}

function segment(frame: Frame) {
  // ファイルの先頭の文は、宣言する名前で指す。前に文を足しても、鍵が変わらない。
  const name = frame.parent?.parent === undefined ? declaredName(frame.node) : undefined;
  if (name !== undefined) {
    return `${frame.key}{${name}}`;
  }
  return frame.index === undefined ? frame.key : `${frame.key}[${frame.index}]`;
}

/**
 * 壊し方の鍵に使う、囲む関数の名前と、その関数からの構文木の経路。
 * 名前のない関数は経路に含め、名前のある関数かファイルの先頭を起点にする。関数の外の変更では、関数の中の鍵が変わらない。
 * 名前の付かない文の位置は、番号で指す。
 */
function location(frame: Frame) {
  const steps: string[] = [];
  const names: string[] = [];
  let current: Frame | undefined = frame;
  while (current?.parent !== undefined) {
    const name = functionTypes.has(current.node.type) ? functionName(current) : undefined;
    if (name !== undefined) {
      names.unshift(name);
    } else if (names.length === 0) {
      steps.unshift(segment(current));
    }
    current = current.parent;
  }
  return { scope: names.length > 0 ? names.join('>') : '<top>', steps: steps.join('.') };
}

function lineStarts(source: string) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function lineAt(starts: number[], offset: number) {
  return starts.findLastIndex((start) => start <= offset) + 1;
}

const identifierPart = /[\p{ID_Continue}$\u200c\u200d]/u;

/** 置き換えを、前の字や前の行の式とつながって読まれない形にする。 */
function separated(source: string, { replacement, start, frame }: Candidate) {
  // 括弧などで始まる式文は、セミコロンを省いたソースで前の行の式の続きとして読まれる。先頭に;を置いて文を区切る。
  if (/^[([`]/.test(replacement) && startsListedStatement(frame, start)) {
    return `;${replacement}`;
  }
  // return!aのように空白を挟まない名前の後ろでは、1つの名前として読まれないよう、空白を置く。
  return identifierPart.test(source[start - 1] ?? '') && identifierPart.test(replacement[0] ?? '')
    ? ` ${replacement}`
    : replacement;
}

/**
 * 鍵のパスと関数の部分に含まれる':'と'%'を、'%3A'と'%25'に置き換える。
 * 関数の名前は文字列のメンバー名（'user:created'など）から':'を含みうるため、置き換えないと鍵の字だけでパスの境目が決まらない。
 */
export function keyPart(text: string) {
  return text.replaceAll(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'));
}

/** 鍵のパス。鍵の最初の':'より前を、置き換える前の字へ戻したものである。':'が無ければundefinedを返す。 */
export function keyPath(key: string): string | undefined {
  const end = key.indexOf(':');
  // %253Aを%3Aへ戻し、':'まで戻さないよう、1回の置き換えで戻す。
  return end < 0
    ? undefined
    : key.slice(0, end).replaceAll(/%3A|%25/g, (code) => (code === '%25' ? '%' : ':'));
}

/** pathはrepo相対のパスで、拡張子から構文（JS・TS・JSX）を決める。同じソースからは同じ壊し方を同じ順で返す。 */
export function mutants(parser: Parser, path: string, source: string): Mutant[] {
  const parsed = parser.parseSync(path, source);
  const [error] = parsed.errors;
  assert(error === undefined, `${path}を構文解析できません: ${error?.message ?? ''}`);
  const program: unknown = parsed.program;
  assert(isNode(program), `${path}の構文木を読めません`);
  const candidates: Candidate[] = [];
  walk(program, parser.visitorKeys, (frame) => {
    for (const rule of rules) {
      candidates.push(...rule(frame, source));
    }
  });
  const starts = lineStarts(source);
  const edits = new Set<string>();
  const keys = new Set<string>();
  const result: Mutant[] = [];
  for (const candidate of candidates) {
    const original = source.slice(candidate.start, candidate.end);
    const edit = JSON.stringify([candidate.start, candidate.end, candidate.replacement]);
    if (candidate.replacement === original || edits.has(edit)) {
      continue;
    }
    edits.add(edit);
    const replacement = separated(source, candidate);
    const { scope, steps } = location(candidate.frame);
    const base = `${keyPart(path)}:${keyPart(scope)}:${steps}:${candidate.rule}:${sha256(replacement).slice(0, 12)}`;
    // 名前で区別できない関数の中の同じ位置は、作った順に番号を付けて区別する。
    let key = base;
    for (let count = 2; keys.has(key); count++) {
      key = `${base}#${count}`;
    }
    keys.add(key);
    result.push({
      key,
      path,
      line: lineAt(starts, candidate.start),
      rule: candidate.rule,
      original,
      replacement,
      start: candidate.start,
      end: candidate.end,
    });
  }
  return result;
}
