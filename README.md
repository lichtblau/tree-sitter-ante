# tree-sitter-ante

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for the
[Ante](https://antelang.org) programming language (`.an` files).

## Features

Covers the surface syntax of Ante, including:

- Significant indentation via a hand-written external scanner
  (`src/scanner.c`) — `INDENT`/`DEDENT`/`NEWLINE` with Ante's context-sensitive
  "semicolon inference" (an indented line only opens a block after a token that
  expects one, otherwise it continues the current expression).
- Definitions: functions, methods (`Type.method`), operators (`(+) x y = …`,
  `(.*) = …`), value bindings and irrefutable destructuring.
- Types: structs, tagged unions, aliases, type application, function types with
  closure environments (`[env]`) and effect rows (`{Fail}`), references, `forall`.
- Expressions: full operator-precedence table, application by juxtaposition,
  member access / indexing / deref, lambdas and trailing lambdas, `_`
  placeholders, named constructors (`T with …`), string interpolation.
- Control flow: `if/then/else`, `match`, `while`, `for`, `loop`/`recur`,
  effect `handler … for … in …`, `do` blocks and thunks.
- Abilities & effects: `ability`, `impl … with`, `implicit`.
- Comments: line (`//`), doc (`///`), and block (`/* … */`).

## Development

```sh
tree-sitter generate      # build src/parser.c from grammar.js (+ scanner.c)
tree-sitter test          # run the corpus in test/corpus/
tree-sitter parse FILE.an # print a parse tree
```

The grammar parses **214 of 215** valid files across the Ante compiler's
`stdlib/src` and `examples` trees with zero `ERROR`/`MISSING` nodes (the
`examples/parser` directory is excluded because it intentionally contains
syntactically invalid programs that exercise the compiler's error recovery).

## Known limitations

- A trailing `do` thunk whose body is written at the *same* indentation as its
  call (e.g. `panic_on_fail do` followed by same-indent statements) is not yet
  handled; `do` blocks that are indented or inline parse fine.
- Block comments (`/* … */`) do not yet nest, though Ante allows nesting.
- The strict indentation-consistency checks (all-spaces-or-all-tabs, 2-space
  minimum) are not enforced — well-formed input parses regardless.
- The generated `src/parser.c` is large (~21k parse states) because Ante's
  juxtaposition-based application, significant indentation, and shared
  expression/pattern syntax are highly ambiguous. A future pass could shrink it
  by layering the expression grammar to remove some GLR conflicts.
