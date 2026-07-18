#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"

// Ante is indentation-sensitive (the off-side rule) with a twist: an indented
// line only opens a *block* when the token before the line break expects one
// (after `=`, `then`, `do`, `->`, ...). Otherwise the indent merely continues
// the current expression ("semicolon inference"). See ~/src/ante/src/lexer/mod.rs.
//
// We reproduce that rule structurally: the grammar only makes INDENT a valid
// symbol in positions where a block may begin, so the scanner can rely on
// `valid_symbols[INDENT]` to decide block-vs-continuation.
//
// Token order here must match the `externals` array in grammar.js.
enum TokenType {
    NEWLINE,
    INDENT,
    DEDENT,
    ERROR_SENTINEL,
};

typedef struct {
    // Stack of indentation columns for the currently open blocks. Always has at
    // least one entry (the base level, column 0).
    Array(uint16_t) indents;
    // True while we are still emitting the sequence of layout tokens produced by
    // a single physical line break (e.g. several DEDENTs followed by a NEWLINE).
    // Lets us emit that trailing NEWLINE on a later scan call, after the newline
    // character itself has already been consumed.
    bool in_line_transition;
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, true); }

// Skip spaces, tabs, carriage returns, line/block comments and newlines.
// Returns true if at least one '\n' was consumed. All consumed characters are
// treated as leading trivia (advance with skip=true), so on a `false` return the
// internal lexer resumes at the next real token.
static bool skip_whitespace(TSLexer *lexer, uint16_t *out_column) {
    bool saw_newline = false;
    // Column of the first non-whitespace character on the current physical line,
    // whether that is a comment or real code. This — not the column reached after
    // skipping comments — is the line's indentation, so `/* c */ code` counts as
    // indented to the comment, not to `code`.
    bool at_line_start = true;
    uint16_t indent = 0;
    for (;;) {
        if (lexer->eof(lexer)) {
            *out_column = indent;
            return saw_newline;
        }
        int32_t c = lexer->lookahead;
        if (c == '\n') {
            saw_newline = true;
            at_line_start = true;
            advance(lexer);
        } else if (c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == 0x0b) {
            advance(lexer);
        } else if (c == '/') {
            if (at_line_start) {
                indent = (uint16_t)lexer->get_column(lexer);
            }
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '/') {
                // Line comment: consume to end of line.
                while (lexer->lookahead != '\n' && !lexer->eof(lexer)) {
                    advance(lexer);
                }
            } else if (lexer->lookahead == '*') {
                // Block comment (non-nested for now): consume to `*/`.
                advance(lexer);
                int32_t prev = 0;
                while (!lexer->eof(lexer)) {
                    int32_t ch = lexer->lookahead;
                    advance(lexer);
                    if (prev == '*' && ch == '/') {
                        break;
                    }
                    prev = ch;
                }
                // Content following a block comment is on the same line.
                at_line_start = false;
            } else {
                // A lone '/' is the divide operator, not trivia. Stop here so
                // the internal lexer can pick it up.
                *out_column = indent;
                return saw_newline;
            }
        } else {
            // Real code.
            if (at_line_start) {
                indent = (uint16_t)lexer->get_column(lexer);
            }
            *out_column = indent;
            return saw_newline;
        }
    }
}

bool tree_sitter_ante_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    // During error recovery tree-sitter marks every symbol valid; opt out and
    // let the internal lexer drive.
    if (valid_symbols[ERROR_SENTINEL]) {
        return false;
    }

    uint16_t line_column = 0;
    bool saw_newline = skip_whitespace(lexer, &line_column);
    lexer->mark_end(lexer);

    bool at_eof = lexer->eof(lexer);

    // Only act at the start of a logical line (a real newline was seen) or while
    // still flushing the layout tokens of the line break we are in the middle of.
    if (!saw_newline && !scanner->in_line_transition) {
        return false;
    }

    scanner->in_line_transition = true;

    // On a fresh line use the computed indentation column; while flushing a
    // pending line transition we are already at content, so query directly.
    uint16_t column = at_eof ? 0
                    : saw_newline ? line_column
                    : (uint16_t)lexer->get_column(lexer);
    uint16_t top = *array_back(&scanner->indents);

    // A deeper indent opens a block, but only where the grammar permits one.
    if (!at_eof && column > top) {
        if (valid_symbols[INDENT]) {
            array_push(&scanner->indents, column);
            scanner->in_line_transition = false;
            lexer->result_symbol = INDENT;
            return true;
        }
        // Line continuation: the indent is not a block. Whitespace has been
        // consumed as trivia; let the expression continue.
        scanner->in_line_transition = false;
        return false;
    }

    // A shallower indent (or EOF) closes one or more blocks. Emit one DEDENT per
    // call; get_column stays stable because no content is consumed.
    if (column < top && scanner->indents.size > 1) {
        if (valid_symbols[DEDENT]) {
            array_pop(&scanner->indents);
            lexer->result_symbol = DEDENT;
            return true;
        }
    }

    // Same indentation (or finished dedenting): separate statements with NEWLINE.
    if (valid_symbols[NEWLINE] && !at_eof) {
        scanner->in_line_transition = false;
        lexer->result_symbol = NEWLINE;
        return true;
    }

    scanner->in_line_transition = false;
    return false;
}

void *tree_sitter_ante_external_scanner_create(void) {
    Scanner *scanner = ts_calloc(1, sizeof(Scanner));
    array_init(&scanner->indents);
    array_push(&scanner->indents, 0);
    scanner->in_line_transition = false;
    return scanner;
}

void tree_sitter_ante_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    array_delete(&scanner->indents);
    ts_free(scanner);
}

unsigned tree_sitter_ante_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    unsigned size = 0;

    buffer[size++] = (char)scanner->in_line_transition;

    // Store as many indent levels as fit; the base level (0) is implicit.
    uint32_t count = scanner->indents.size;
    for (uint32_t i = 1; i < count; i++) {
        if (size + 2 > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
            break;
        }
        uint16_t level = *array_get(&scanner->indents, i);
        buffer[size++] = (char)(level & 0xFF);
        buffer[size++] = (char)((level >> 8) & 0xFF);
    }
    return size;
}

void tree_sitter_ante_external_scanner_deserialize(void *payload, const char *buffer,
                                                   unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    array_clear(&scanner->indents);
    array_push(&scanner->indents, 0);
    scanner->in_line_transition = false;

    if (length == 0) {
        return;
    }

    unsigned size = 0;
    scanner->in_line_transition = (bool)buffer[size++];
    while (size + 2 <= length) {
        uint16_t level = (uint16_t)((unsigned char)buffer[size]) |
                         ((uint16_t)((unsigned char)buffer[size + 1]) << 8);
        size += 2;
        array_push(&scanner->indents, level);
    }
}
