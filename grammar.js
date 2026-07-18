/**
 * @file Ante grammar for tree-sitter
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Operator precedence, mirroring `Parser::precedence` in
// ~/src/ante/src/parser/mod.rs (higher number binds tighter). Everything at or
// below `as` is a binary operator; the entries above it (annotation, unary
// prefix, application, member access) live inside a single "term".
const PREC = {
  semicolon: 1,
  apply_left: 2,   // <|   (right)
  apply_right: 3,  // |> ~> (left)
  comma: 4,        // ,    (right)
  or: 5,
  and: 6,
  is: 7,
  compare: 8,      // == != > < >= <= %%
  append: 9,       // ++
  range: 10,       // ..
  add: 11,         // + -
  multiply: 12,    // * / %
  as: 14,
  annotation: 16,  // e : T
  unary: 17,       // - not ref mut imm uniq
  apply: 18,       // function application by juxtaposition
  member: 19,      // . .[ .*
};

const PRIMITIVE_TYPES = [
  'I8', 'I16', 'I32', 'I64', 'Isz',
  'U8', 'U16', 'U32', 'U64', 'Usz',
  'F32', 'F64',
];

// Words that must never be lexed as an identifier. Without this a keyword such
// as `else` can fall back to an identifier where the keyword is not expected,
// producing spurious parses (e.g. detaching an `else` from its `if`). `resume`
// is intentionally NOT reserved — it is a normal identifier in Ante that only
// acts as a keyword directly before `fn`.
const KEYWORDS = [
  'ability', 'and', 'as', 'break', 'continue', 'do', 'else', 'export',
  'extern', 'fn', 'for', 'forall', 'handler', 'if', 'imm', 'impl', 'implicit',
  'import', 'in', 'is', 'loop', 'match', 'move', 'mut', 'not', 'or', 'owned',
  'ref', 'return', 'shared', 'then', 'true', 'false', 'type', 'uniq', 'var',
  'while', 'with',
];

module.exports = grammar({
  name: 'ante',

  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
    $._error_sentinel,
  ],

  // `\n` is in `extras` so that when the external scanner declines to emit a
  // layout token (a line continuation, or inside brackets) tree-sitter resets to
  // the newline and skips it as trivia. Where a NEWLINE/INDENT/DEDENT is valid the
  // scanner runs first (it has priority) and consumes the break itself.
  extras: $ => [
    /[ \t\r\n\f\v]/,
    $.line_comment,
    $.block_comment,
    $.doc_comment,
  ],

  word: $ => $.identifier,

  reserved: {
    global: $ => KEYWORDS,
  },

  conflicts: $ => [
    [$._atom, $._pattern_atom],
    [$._atom, $._binding_atom],
    [$._atom, $.definition],
    [$._definition_name, $._atom],
    [$.method_name, $._atom, $.constructor_path],
    [$.assignment, $._expr_or_tuple],
    [$._type_atom, $.reference_type],
    [$.constructor_field],
    [$._type, $.type_application],
    [$.tuple_pattern, $.or_pattern],
    [$.or_pattern],
    [$.named_constructor],
    [$.if_expression],
    [$.match_expression],
    [$.placeholder, $.wildcard_pattern],
    [$.ability_impl, $._type_atom],
    [$.handler_expression],
    [$._term, $.trailing_do_call],
  ],

  rules: {
    source_file: $ => seq(
      repeat($._newline),
      optional(sep1(repeat1($._newline), $._item)),
    ),

    _item: $ => choice(
      $.import,
      $.export,
      $.definition,
      $.type_definition,
      $.ability_definition,
      $.ability_impl,
      $.comptime,
      $.assignment,
      $._expression,
    ),

    // ---------------------------------------------------------------- imports
    import: $ => seq(
      'import',
      $.module_path,
      optional(seq(',', commaSep1($._import_item))),
    ),

    module_path: $ => sep1('.', choice($.type_identifier, $.identifier)),

    _import_item: $ => choice($.identifier, $.type_identifier, $.operator_reference),

    export: $ => seq('export', commaSep1($._import_item)),

    // ------------------------------------------------------------ definitions
    definition: $ => seq(
      optional('implicit'),
      choice(
        // function definition: name param+ (: type)? = body
        seq(
          field('name', $._definition_name),
          field('parameters', repeat1($._parameter)),
          optional(seq(':', field('return_type', $._type))),
          '=',
          field('body', $._block_or_expression),
        ),
        // operator or method definition with no parameters, e.g. `(.*) = deref`.
        seq(
          field('name', choice($.operator_reference, $.method_name)),
          optional(seq(':', field('return_type', $._type))),
          '=',
          field('body', $._block_or_expression),
        ),
        // value binding: an irrefutable target = body. Refutable constructor
        // destructuring belongs in `match`, so it is excluded here (that keeps
        // `Foo a b` at statement start unambiguously a call, not a binding LHS).
        seq(
          optional('var'),
          field('name', $._binding_pattern),
          optional(seq(':', field('type', $._type))),
          '=',
          field('body', $._block_or_expression),
        ),
      ),
    ),

    _definition_name: $ => choice(
      $.identifier,
      $.operator_reference,
      $.method_name,
    ),

    // Irrefutable binding targets only. Uses dedicated tuple/alias rules built
    // from binding-safe atoms so a bare constructor application (`Foo a b`) can
    // never be read as a binding LHS (it stays a call expression).
    _binding_pattern: $ => choice(
      $._binding_atom,
      $.tuple_binding,
      $.alias_binding,
    ),

    _binding_atom: $ => choice(
      $.identifier,
      $.wildcard_pattern,
      $.unit,
      seq('(', $._pattern, ')'),
    ),

    tuple_binding: $ => prec.right(seq(
      $._binding_atom,
      repeat1(seq(',', $._binding_atom)),
    )),

    alias_binding: $ => seq(
      field('binder', $.identifier),
      '@',
      field('pattern', $._binding_atom),
    ),

    method_name: $ => seq($.type_identifier, repeat(seq('.', $.type_identifier)), '.', $.identifier),

    _parameter: $ => choice(
      $._pattern_atom,
      $.typed_parameter,
      $.implicit_parameter,
    ),

    typed_parameter: $ => seq('(', optional('var'), field('pattern', $._pattern), ':', field('type', $._type), ')'),

    implicit_parameter: $ => seq('{', optional('var'), $._pattern, optional(seq(':', $._type)), '}'),

    // ------------------------------------------------------- type definitions
    type_definition: $ => seq(
      optional('shared'),
      optional('mut'),
      'type',
      field('name', choice($.type_identifier, $.operator_reference)),
      field('generics', repeat($._generic_parameter)),
      '=',
      field('body', $._type_body),
    ),

    _generic_parameter: $ => choice(
      $.identifier,
      $.lifetime,
      seq('(', $.identifier, ':', $._kind, ')'),
    ),

    _kind: $ => choice('type', $.primitive_type),

    _type_body: $ => choice(
      $.struct_body,
      $.union_body,
      $.tuple_type,
      $._type,
    ),

    // A bare tuple type on the right of a `type` alias, e.g. `type Pair a = a, a`.
    tuple_type: $ => prec.right(seq($._type, repeat1(seq(',', $._type)))),

    struct_body: $ => choice(
      // inline: field: T, field: T  (one or more)
      seq($.struct_field, repeat(seq(',', $.struct_field))),
      // indented block of fields
      $._indented_struct_body,
    ),

    _indented_struct_body: $ => seq($._indent, sep1($._newline, $.struct_field), $._dedent),

    struct_field: $ => seq(field('name', $.identifier), ':', field('type', $._type)),

    union_body: $ => choice(
      seq('|', $.union_variant, repeat(seq('|', $.union_variant))),
      seq(
        $._indent,
        seq('|', $.union_variant),
        repeat(seq($._newline, '|', $.union_variant)),
        $._dedent,
      ),
    ),

    union_variant: $ => seq(field('name', $.type_identifier), repeat($._type_atom)),

    // --------------------------------------------------- abilities and impls
    ability_definition: $ => seq(
      'ability',
      field('name', $.type_identifier),
      field('generics', repeat($._generic_parameter)),
      '=',
      field('body', choice(
        $.ability_declaration,
        seq($._indent, sep1($._newline, $.ability_declaration), $._dedent),
      )),
    ),

    ability_declaration: $ => seq(
      field('name', choice($.identifier, $.operator_reference)),
      ':',
      field('type', $._type),
    ),

    ability_impl: $ => seq(
      'impl',
      optional(seq(field('name', $.identifier), repeat($._parameter), ':')),
      field('ability', $._type),
      'with',
      field('body', choice($.block, $.definition)),
    ),

    // ------------------------------------------------------------- comptime
    comptime: $ => seq('#', $._expression),

    // ------------------------------------------------------------- blocks
    block: $ => seq($._indent, sep1($._newline, $._statement), $._dedent),

    _block_or_expression: $ => choice($.block, $.assignment, $._expr_or_tuple),

    _statement: $ => choice(
      $.definition,
      $.type_definition,
      $.ability_definition,
      $.ability_impl,
      $.comptime,
      $.assignment,
      $._expr_or_tuple,
    ),

    assignment: $ => seq(
      field('target', $._expression),
      field('operator', choice(':=', '+=', '-=', '*=', '/=', '%=')),
      field('value', $._block_or_expression),
    ),

    // --------------------------------------------------------- expressions
    _expr_or_tuple: $ => choice($._expression, $.tuple),

    tuple: $ => prec.right(PREC.comma, seq(
      $._expression,
      repeat1(seq(',', $._expression)),
    )),

    _expression: $ => choice(
      $._term,
      $.binary_expression,
      $.is_expression,
      $.if_expression,
      $.match_expression,
      $.while_expression,
      $.for_expression,
      $.loop_expression,
      $.handler_expression,
      $.lambda,
      $.named_constructor,
      $.do_expression,
      $.trailing_do_call,
      $.return_expression,
      $.break_expression,
      $.continue_expression,
    ),

    do_expression: $ => prec.right(seq('do', field('body', $._block_or_expression))),

    // A `do` thunk passed as the trailing argument of an application, e.g.
    // `on_fail f do 42`. Restricted to an application head (never a bare binary
    // condition) so `while i < 3 do body` keeps its own `do`.
    trailing_do_call: $ => prec.dynamic(-1, seq(
      field('function', $._application),
      field('argument', $.do_expression),
    )),

    _term: $ => choice(
      $.type_annotation,
      $.unary_expression,
      $._application,
    ),

    type_annotation: $ => prec(PREC.annotation, seq(
      field('value', $._term),
      ':',
      field('type', $._type),
    )),

    unary_expression: $ => prec.right(PREC.unary, seq(
      field('operator', choice('-', 'not', 'ref', 'mut', 'imm', 'uniq', '!', '@')),
      field('operand', $._term),
    )),

    _application: $ => choice($.call, $._postfix_expression),

    call: $ => prec.left(PREC.apply, seq(
      field('function', $._postfix_expression),
      field('arguments', repeat1($._argument)),
    )),

    _argument: $ => choice(
      $._postfix_expression,
      $.implicit_argument,
      $.lambda,
    ),

    implicit_argument: $ => seq('{', $._expression, '}'),

    _postfix_expression: $ => choice(
      $.member_access,
      $.index_expression,
      $.deref_expression,
      $._atom,
    ),

    member_access: $ => prec.left(PREC.member, seq(
      field('object', $._postfix_expression),
      '.',
      field('member', choice($.identifier, $.type_identifier, $.integer, $.operator_reference)),
    )),

    index_expression: $ => prec.left(PREC.member, seq(
      field('object', $._postfix_expression),
      '.[',
      field('index', $._expression),
      ']',
    )),

    deref_expression: $ => prec.left(PREC.member, seq(
      field('object', $._postfix_expression),
      '.*',
    )),

    binary_expression: $ => {
      const table = [
        [PREC.as, 'as', 'left'],
        [PREC.multiply, choice('*', '/', '%'), 'left'],
        [PREC.add, choice('+', '-'), 'left'],
        [PREC.range, '..', 'left'],
        [PREC.append, '++', 'left'],
        [PREC.compare, choice('==', '!=', '<', '>', '<=', '>=', '%%'), 'left'],
        [PREC.and, 'and', 'left'],
        [PREC.or, 'or', 'left'],
        [PREC.apply_right, choice('|>', '~>'), 'left'],
        [PREC.apply_left, '<|', 'right'],
        [PREC.semicolon, ';', 'left'],
      ];
      return choice(...table.map(([precedence, operator, assoc]) => {
        const rule = seq(
          field('left', $._expression),
          field('operator', operator),
          field('right', $._expression),
        );
        return assoc === 'left'
          ? prec.left(precedence, rule)
          : prec.right(precedence, rule);
      }));
    },

    // `is` takes a pattern on its right-hand side.
    is_expression: $ => prec.left(PREC.is, seq(
      field('left', $._expression),
      'is',
      field('pattern', $._pattern),
    )),

    // --------------------------------------------------------- control flow
    if_expression: $ => seq(
      'if',
      field('condition', $._expr_or_tuple),
      optional($._newline),
      'then',
      field('consequence', $._block_or_expression),
      optional(seq(
        optional($._newline),
        'else',
        field('alternative', $._block_or_expression),
      )),
    ),

    match_expression: $ => seq(
      'match',
      field('subject', $._expr_or_tuple),
      optional($._indent),
      repeat1($.match_arm),
      optional($._dedent),
    ),

    match_arm: $ => seq(
      optional($._newline),
      '|',
      field('pattern', $._pattern),
      '->',
      field('body', $._block_or_expression),
    ),

    while_expression: $ => seq(
      'while',
      field('condition', $._block_or_expression),
      'do',
      field('body', $._block_or_expression),
    ),

    for_expression: $ => seq(
      'for',
      field('pattern', $._pattern),
      'in',
      field('iterable', $._expression),
      'do',
      field('body', $._block_or_expression),
    ),

    loop_expression: $ => seq(
      'loop',
      field('arguments', repeat($._loop_argument)),
      '->',
      field('body', $._block_or_expression),
    ),

    _loop_argument: $ => choice(
      $.identifier,
      $.unit,
      seq('(', $._pattern, '=', $._expression, ')'),
    ),

    handler_expression: $ => seq(
      'handler',
      field('name', $.identifier),
      'for',
      optional($._indent),
      $.handler_arm,
      repeat($.handler_arm),
      optional($._dedent),
      optional(seq(
        optional($._newline),
        'in',
        field('body', $._block_or_expression),
      )),
    ),

    handler_arm: $ => seq(
      optional($._newline),
      optional('|'),
      field('operation', $.identifier),
      field('parameters', repeat($._pattern_atom)),
      '->',
      field('body', $._block_or_expression),
    ),

    return_expression: $ => prec.right(seq('return', optional($._expr_or_tuple))),
    break_expression: $ => prec.right(seq('break', optional($._expr_or_tuple))),
    continue_expression: $ => 'continue',

    // ------------------------------------------------------------- lambdas
    lambda: $ => prec.right(seq(
      optional('move'),
      'fn',
      field('parameters', repeat($._parameter)),
      optional(seq(':', field('return_type', $._type))),
      choice('->', '=>'),
      field('body', $._block_or_expression),
    )),

    // `prec.dynamic` biases GLR toward keeping every `T with ...` field inside
    // the constructor rather than letting the tuple operator (`,`) split the
    // field list — Ante's ban-comma rule for constructor fields.
    named_constructor: $ => prec.dynamic(1, seq(
      field('type', choice($.type_identifier, $.constructor_path, $.method_name)),
      'with',
      field('fields', choice(
        commaSep1($.constructor_field),
        seq($._indent, sep1($._newline, $.constructor_field), $._dedent),
      )),
    )),

    constructor_field: $ => seq(
      field('name', $.identifier),
      optional(seq(
        repeat($._parameter),
        '=',
        field('value', choice($.block, $._expression)),
      )),
    ),

    // -------------------------------------------------------------- atoms
    _atom: $ => choice(
      $._literal,
      $.identifier,
      $.type_identifier,
      $.primitive_type,
      $.placeholder,
      $.unit,
      $.parenthesized_expression,
      $.array,
      $.operator_reference,
      $.extern,
    ),

    // `_` used as a value is a partial-application placeholder, e.g. `_ * 2`.
    placeholder: $ => '_',

    parenthesized_expression: $ => seq('(', $._expr_or_tuple, ')'),

    array: $ => seq('[', optional(commaSep1($._expression)), optional(','), ']'),

    operator_reference: $ => seq('(', choice(
      'and', 'or', 'not', 'in', 'is', 'as',
      '==', '!=', '<', '>', '<=', '>=',
      '<|', '|>', '~>', '++', '..', '%%',
      '*', '/', '%', '+', '-',
      '.[]', '.[]:=', '.*',
      ',',
    ), ')'),

    extern: $ => prec.right(seq('extern', optional(choice($.string, $.identifier)))),

    // -------------------------------------------------------------- types
    _type: $ => choice(
      $._type_atom,
      $.type_application,
      $.function_type,
      $.reference_type,
      $.forall_type,
    ),

    type_hole: $ => '_',

    _type_atom: $ => choice(
      $.type_identifier,
      $.constructor_path,
      $.identifier,
      $.primitive_type,
      $.integer,
      $.lifetime,
      $.type_hole,
      $.parenthesized_type,
    ),

    type_application: $ => prec.left(seq(
      field('constructor', $._type_atom),
      repeat1($._type_atom),
    )),

    function_type: $ => prec.right(seq(
      optional('resume'),
      'fn',
      repeat($._type_atom),
      optional($.closure_environment),
      repeat($._effect_set),
      choice('->', '=>'),
      $._type,
    )),

    // Explicit closure environment, e.g. `fn A [env] -> B`.
    closure_environment: $ => seq('[', $._type, ']'),

    _effect_set: $ => seq('{', commaSep($._type), '}'),

    reference_type: $ => prec.right(seq(
      choice('ref', 'mut', 'imm', 'uniq', 'owned', 'shared'),
      optional($.lifetime),
      $._type,
    )),

    forall_type: $ => seq('forall', repeat1($._generic_parameter), '.', $._type),

    parenthesized_type: $ => seq(
      '(',
      optional(seq($._type, repeat(seq(',', $._type)), optional(','))),
      ')',
    ),

    // ------------------------------------------------------------ patterns
    _pattern: $ => choice(
      $._pattern_atom,
      $.constructor_pattern,
      $.tuple_pattern,
      $.or_pattern,
      $.alias_pattern,
      $.typed_pattern,
    ),

    _pattern_atom: $ => choice(
      $.identifier,
      $.type_identifier,
      $.constructor_path,
      $._literal,
      $.unit,
      $.wildcard_pattern,
      $.operator_reference,
      seq('(', $._pattern, ')'),
    ),

    // A qualified constructor, e.g. `Maybe.Some` or `Std.C.String`.
    constructor_path: $ => prec.left(seq(
      $.type_identifier,
      repeat1(seq('.', $.type_identifier)),
    )),

    wildcard_pattern: $ => '_',

    constructor_pattern: $ => prec.left(PREC.apply, seq(
      field('constructor', choice($.type_identifier, $.constructor_path, $.method_name)),
      repeat1($._pattern_atom),
    )),

    tuple_pattern: $ => prec.right(PREC.comma, seq(
      $._pattern,
      repeat1(seq(',', $._pattern)),
    )),

    or_pattern: $ => prec.left(seq(
      $._pattern,
      repeat1(seq(optional($._newline), '|', $._pattern)),
    )),

    alias_pattern: $ => prec(PREC.member, seq(
      field('binder', $.identifier),
      '@',
      field('pattern', $._pattern),
    )),

    typed_pattern: $ => prec(PREC.annotation, seq(
      $._pattern,
      ':',
      $._type,
    )),

    // -------------------------------------------------------------- literals
    _literal: $ => choice(
      $.integer,
      $.float,
      $.string,
      $.char,
      $.boolean,
    ),

    integer: $ => token(seq(
      /[0-9][0-9_]*/,
      optional(/(i8|i16|i32|i64|isz|u8|u16|u32|u64|usz)/),
    )),

    float: $ => token(seq(
      /[0-9][0-9_]*/,
      '.',
      /[0-9][0-9_]*/,
      optional(/(f|f32|f64)/),
    )),

    boolean: $ => choice('true', 'false'),

    unit: $ => seq('(', ')'),

    char: $ => token(seq(
      "'",
      choice(/[^'\\\n]/, seq('\\', /./)),
      "'",
    )),

    string: $ => seq(
      '"',
      repeat(choice(
        $._string_content,
        $.escape_sequence,
        $.interpolation,
      )),
      '"',
    ),

    _string_content: $ => token.immediate(prec(1, /[^"\\$]+/)),

    escape_sequence: $ => token.immediate(seq('\\', /./)),

    interpolation: $ => seq('${', $._expression, '}'),

    lifetime: $ => token(seq("'", /[a-zA-Z_][a-zA-Z0-9_]*/)),

    identifier: $ => /[a-z_][a-zA-Z0-9_]*/,

    type_identifier: $ => /[A-Z][a-zA-Z0-9_]*/,

    primitive_type: $ => choice(...PRIMITIVE_TYPES),

    // -------------------------------------------------------------- comments
    line_comment: $ => token(seq('//', /[^\n]*/)),

    doc_comment: $ => token(prec(1, seq('///', optional(seq(/[^/\n]/, /[^\n]*/))))),

    block_comment: $ => token(seq(
      '/*',
      /[^*]*\*+([^/*][^*]*\*+)*/,
      '/',
    )),
  },
});

function sep1(separator, rule) {
  return seq(rule, repeat(seq(separator, rule)));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

function commaSep(rule) {
  return optional(commaSep1(rule));
}
