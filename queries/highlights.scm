; Highlights for the Ante language.

; ---------------------------------------------------------------- comments
(line_comment) @comment
(block_comment) @comment
(doc_comment) @comment.documentation

; ---------------------------------------------------------------- literals
(integer) @number
(float) @number.float
(boolean) @boolean
(char) @character
(unit) @constant.builtin

(string) @string
(escape_sequence) @string.escape
(interpolation "${" @punctuation.special "}" @punctuation.special)

; ------------------------------------------------------------------- types
(primitive_type) @type.builtin
(type_identifier) @type
(constructor_path (type_identifier) @type)
(lifetime) @label
(type_hole) @type
(placeholder) @variable.builtin

; -------------------------------------------------------------- constructors
(constructor_pattern
  constructor: (type_identifier) @constructor)
(union_variant
  name: (type_identifier) @constructor)

; --------------------------------------------------------------- definitions
(definition
  name: (identifier) @function)
(definition
  name: (method_name (identifier) @function))
(method_name (type_identifier) @type)

(struct_field name: (identifier) @property)
(constructor_field name: (identifier) @property)
(member_access member: (identifier) @property)

; ---------------------------------------------------------------- functions
(call
  function: (identifier) @function.call)
(call
  function: (member_access member: (identifier) @function.method))

; ------------------------------------------------------------------ imports
(module_path (type_identifier) @module)

; --------------------------------------------------------------- parameters
(typed_parameter pattern: (identifier) @variable.parameter)
(implicit_parameter (identifier) @variable.parameter)

; ---------------------------------------------------------------- variables
(identifier) @variable

; ----------------------------------------------------------------- keywords
[
  "type"
  "ability"
  "impl"
  "implicit"
  "extern"
] @keyword

[
  "import"
  "export"
] @keyword.import

[
  "if"
  "then"
  "else"
  "match"
  "while"
  "for"
  "loop"
  "do"
  "in"
  "handler"
  "with"
] @keyword.control

[
  "return"
  "break"
] @keyword.control.return
(continue_expression) @keyword.control.return

[
  "fn"
  "move"
] @keyword.function

[
  "forall"
] @keyword

[
  "ref"
  "mut"
  "imm"
  "uniq"
  "owned"
  "shared"
  "var"
] @keyword.modifier

[
  "and"
  "or"
  "not"
  "is"
  "as"
] @keyword.operator

; ---------------------------------------------------------------- operators
[
  "="
  ":="
  "+="
  "-="
  "*="
  "/="
  "%="
  "+"
  "-"
  "*"
  "/"
  "%"
  "%%"
  "++"
  "=="
  "!="
  "<"
  ">"
  "<="
  ">="
  ".."
  "->"
  "=>"
  "~>"
  "<|"
  "|>"
  "@"
  "!"
  ".*"
] @operator

; -------------------------------------------------------------- punctuation
[ "(" ")" "[" "]" "{" "}" ] @punctuation.bracket
[ "," ":" "." "|" ] @punctuation.delimiter
