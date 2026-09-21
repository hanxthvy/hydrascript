# [xihanzu-NR]
"""Serpent Compiler: Pythonic syntax to React TSX.

Grammar:
    module        := stmt*
    stmt          := component | def | import | from_import | if_stmt | for_stmt
                   | assign | aug_assign | return_stmt | tree_block | expr_stmt
    component     := 'component' IDENT ['(' params ')'] ':' NEWLINE INDENT (stmt | tree_block)* DEDENT
    tree_block    := (IDENT | call) ':' (inline_body | NEWLINE INDENT tree_child* DEDENT)
    tree_child    := tree_block | if_tree | for_tree | expr_child
    if_tree       := 'if' expr ':' tree_body ('elif' expr ':' tree_body)* ['else' ':' tree_body]
    for_tree      := 'for' IDENT 'in' expr ':' tree_body
"""
import re, json, sys
from typing import List, Optional, Tuple

SPEC = [
    ('COMMENT', r'#[^\n]*'),
    ('FSTRING', r'f"(?:\\.|[^"\\])*"|f\'(?:\\.|[^\'\\])*\''),
    ('STRING',  r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\''),
    ('NUMBER',  r'\d+(?:\.\d+)?'),
    ('ARROW',   r'->'),
    ('COLON',   r':'), ('COMMA', r','), ('DOT', r'\.'),
    ('LPAREN',  r'\('), ('RPAREN', r'\)'),
    ('LBRACK',  r'\['), ('RBRACK', r'\]'),
    ('LBRACE',  r'\{'), ('RBRACE', r'\}'),
    ('OP',      r'==|!=|<=|>=|\+=|-=|\*=|/=|\*\*|//|[=+\-*/%<>!&|]'),
    ('IDENT',   r'[a-zA-Z_][a-zA-Z0-9_]*'),
    ('WS',      r'[ \t]+'),
    ('MISC',    r'.'),
]
TOK_RE = re.compile('|'.join(f'(?P<{n}>{p})' for n, p in SPEC))
KW = {'component', 'if', 'elif', 'else', 'for', 'in', 'def', 'return', 'import',
      'from', 'as', 'and', 'or', 'not', 'True', 'False', 'None', 'lambda'}

TAGS = {'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'button', 'input', 'form', 'label', 'select', 'option', 'textarea', 'img', 'nav',
        'header', 'footer', 'main', 'section', 'article', 'aside', 'table', 'thead', 'tbody',
        'tr', 'td', 'th', 'br', 'hr', 'pre', 'code', 'em', 'strong', 'small', 'figure',
        'figcaption', 'video', 'audio', 'canvas', 'svg', 'iframe', 'dialog'}

PROPS = {
    'class': 'className', 'cls': 'className', 'for': 'htmlFor',
    'on_click': 'onClick', 'on_change': 'onChange', 'on_input': 'onInput',
    'on_submit': 'onSubmit', 'on_key_down': 'onKeyDown', 'on_key_up': 'onKeyUp',
    'on_blur': 'onBlur', 'on_focus': 'onFocus', 'on_mouse_enter': 'onMouseEnter',
    'on_mouse_leave': 'onMouseLeave', 'on_double_click': 'onDoubleClick',
    'read_only': 'readOnly', 'auto_focus': 'autoFocus', 'auto_complete': 'autoComplete',
    'tab_index': 'tabIndex', 'max_length': 'maxLength', 'col_span': 'colSpan',
    'row_span': 'rowSpan', 'src_set': 'srcSet', 'type_': 'type',
}

# Python builtins -> JS, applied to a single argument.
BUILTINS = {
    'len':     '{0}.length',
    'str':     'String',
    'int':     'parseInt',
    'float':   'parseFloat',
    'abs':     'Math.abs',
    'round':   'Math.round',
    'min':     'Math.min',
    'max':     'Math.max',
    'sum':     '{0}.reduce((a, b) => a + b, 0)',
    'sorted':  '{0}.slice().sort()',
    'reversed':'{0}.slice().reverse()',
    'list':    '{0}.slice()',
    'bool':    'Boolean',
}

# Python string/list methods -> JS equivalents.
STR_METHODS = {
    'strip':    'trim',
    'lstrip':   'trimStart',
    'rstrip':   'trimEnd',
    'upper':    'toUpperCase',
    'lower':    'toLowerCase',
    'startswith': 'startsWith',
    'endswith': 'endsWith',
    'replace':  'replaceAll',
    'find':     'indexOf',
    'split':    'split',
    'join':     'join',
    'append':   'push',
    'insert':   'splice',
    'remove':   'splice',
    'pop':      'pop',
    'keys':     'keys',
    'values':   'values',
    'items':    'entries',
    'copy':     'slice',
    'index':    'indexOf',
    'count':    'filter',
    'extend':   'push',
    'get':      'get',
    'isdigit':  'match',
    'isspace':  'match',
    'format':   'replace',
    'title':    'toLowerCase',
}


class Tok:
    __slots__ = ('type', 'value', 'line', 'col')
    def __init__(self, t, v, l, c): self.type, self.value, self.line, self.col = t, v, l, c
    def __repr__(self): return f"{self.type}({self.value!r})@{self.line}:{self.col}"


class CompileError(Exception):
    def __init__(self, msg: str, line: int, col: int, src: List[str], hint: Optional[str] = None):
        self.msg, self.line, self.col, self.src, self.hint = msg, line, col, src, hint
        super().__init__(msg)

    def pretty(self) -> str:
        o = [f"\033[1;31merror\033[0m: {self.msg}", f"  --> line {self.line}, col {self.col + 1}"]
        if 0 < self.line <= len(self.src):
            s = self.src[self.line - 1]
            o += ["   |", f"{self.line:2d} | {s}", f"   | {' ' * self.col}\033[1;31m^\033[0m"]
        if self.hint: o.append(f"   = \033[1;36mhint\033[0m: {self.hint}")
        return "\n".join(o)


def lex(src: str) -> List[Tok]:
    lines = src.split('\n')
    out, stack = [], [0]
    for i, raw in enumerate(lines, 1):
        if not raw.strip() or raw.strip().startswith('#'): continue
        ind = len(raw) - len(raw.lstrip(' '))
        if ind > stack[-1]:
            stack.append(ind); out.append(Tok('INDENT', ind, i, 0))
        else:
            while ind < stack[-1]:
                stack.pop(); out.append(Tok('DEDENT', ind, i, 0))
            if ind != stack[-1]:
                raise CompileError(f"inconsistent indentation: expected {stack[-1]} spaces, got {ind}",
                                   i, 0, lines, "keep one indent width across the file")
        pos = ind
        while pos < len(raw):
            m = TOK_RE.match(raw, pos)
            if not m or not m.lastgroup: break
            t, v = m.lastgroup, m.group(m.lastgroup)
            pos = m.end()
            if t == 'WS': continue
            if t == 'COMMENT': break
            if t == 'IDENT' and v in KW: t = v.upper()
            out.append(Tok(t, v, i, pos - len(v)))
        out.append(Tok('NEWLINE', '\n', i, len(raw)))
    while len(stack) > 1:
        stack.pop(); out.append(Tok('DEDENT', 0, len(lines), 0))
    out.append(Tok('EOF', '', len(lines) + 1, 0))
    return out


class Parser:
    def __init__(self, toks: List[Tok], src: List[str]):
        self.t, self.i, self.src = toks, 0, src
    @property
    def c(self): return self.t[self.i]
    def at(self, *ts): return self.c.type in ts
    def eat(self, t=None):
        tok = self.c
        if t and tok.type != t:
            raise CompileError(f"expected {t}, found {tok.type} ({tok.value!r})",
                               tok.line, tok.col, self.src)
        self.i += 1; return tok
    def nl(self):
        while self.at('NEWLINE'): self.i += 1

    def module(self):
        body = []; self.nl()
        while not self.at('EOF'):
            body.append(self.stmt()); self.nl()
        return body

    def block(self):
        self.eat('COLON')
        if not self.at('NEWLINE'):
            return [self.stmt()]
        self.eat('NEWLINE')
        if not self.at('INDENT'):
            return []          # empty block:  `br:` with nothing under it
        self.eat('INDENT')
        body = []; self.nl()
        while not self.at('DEDENT', 'EOF'):
            body.append(self.stmt()); self.nl()
        if self.at('DEDENT'): self.eat('DEDENT')
        return body

    def stmt(self):
        t = self.c
        if t.type == 'COMPONENT': return self.component()
        if t.type == 'IMPORT':    return self.imp()
        if t.type == 'FROM':      return self.from_imp()
        if t.type == 'DEF':       return self.defn()
        if t.type == 'RETURN':    self.eat(); return {'k': 'Return', 'v': self.expr()}
        if t.type == 'IF':        return self.ifs()
        if t.type == 'FOR':       return self.fors()
        e = self.expr()
        if self.at('COMMA'):
            items = [e]
            while self.at('COMMA'):
                self.eat()
                if self.at('OP') and self.c.value == '=': break
                items.append(self.expr())
            e = {'k': 'Tuple', 'items': items, 'line': t.line, 'col': t.col}
        if self.at('COLON'):
            return {'k': 'Tree', 'tag': e, 'body': self.block(), 'line': t.line, 'col': t.col}
        if self.at('OP') and self.c.value == '=':
            self.eat('OP')
            return {'k': 'Assign', 't': e, 'v': self.expr(), 'line': t.line, 'col': t.col}
        if self.at('OP') and self.c.value in ('+=', '-=', '*=', '/='):
            op = self.eat('OP').value
            return {'k': 'Aug', 't': e, 'op': op[0], 'v': self.expr(), 'line': t.line, 'col': t.col}
        return {'k': 'Expr', 'e': e, 'line': t.line, 'col': t.col}

    def imp(self):
        self.eat('IMPORT'); n = [self.eat('IDENT').value]
        while self.at('COMMA'): self.eat(); n.append(self.eat('IDENT').value)
        return {'k': 'Import', 'names': n}
    def from_imp(self):
        self.eat('FROM'); m = self.eat('IDENT').value; self.eat('IMPORT')
        n = [self.eat('IDENT').value]
        while self.at('COMMA'): self.eat(); n.append(self.eat('IDENT').value)
        return {'k': 'Import', 'from': m, 'names': n}

    def component(self):
        kw = self.eat('COMPONENT'); name = self.eat('IDENT').value
        ps = self.params() if self.at('LPAREN') else []
        return {'k': 'Component', 'name': name, 'params': ps, 'body': self.block(),
                'line': kw.line, 'col': kw.col}

    def defn(self):
        kw = self.eat('DEF'); name = self.eat('IDENT').value
        ps = self.params() if self.at('LPAREN') else []
        ret = None
        if self.at('ARROW'): self.eat(); ret = self.type()
        return {'k': 'Def', 'name': name, 'params': ps, 'ret': ret, 'body': self.block(),
                'line': kw.line, 'col': kw.col}

    def params(self):
        self.eat('LPAREN'); ps = []
        while not self.at('RPAREN'):
            n = self.eat('IDENT').value
            ty = None
            if self.at('COLON'): self.eat(); ty = self.type()
            d = None
            has_default = False
            if self.at('OP') and self.c.value == '=':
                self.eat('OP')
                d = self.expr()
                has_default = True
            ps.append({'name': n, 'type': ty, 'default': d, 'has_default': has_default})
            if self.at('COMMA'): self.eat()
            else: break
        self.eat('RPAREN'); return ps

    def type(self):
        M = {'str': 'string', 'int': 'number', 'float': 'number', 'bool': 'boolean',
             'None': 'null', 'Any': 'any', 'list': 'Array', 'dict': 'Record'}
        if self.at('LBRACK'):
            self.eat(); inner = [self.type()]
            while self.at('COMMA'): self.eat(); inner.append(self.type())
            self.eat('RBRACK'); return '(' + ' | '.join(inner) + ')'
        if self.at('NONE'):
            self.eat(); base = 'None'
        else:
            base = self.eat('IDENT').value
            while self.at('DOT'): self.eat(); base += '.' + self.eat('IDENT').value
        out = M.get(base, base)
        if self.at('LBRACK'):
            self.eat(); inner = [self.type()]
            while self.at('COMMA'): self.eat(); inner.append(self.type())
            self.eat('RBRACK')
            out += '<' + ', '.join(inner) + '>'
        while self.at('OP') and self.c.value == '|':
            self.eat(); out += ' | ' + self.type()
        return out

    def ifs(self):
        kw = self.eat('IF'); test = self.expr(); body = self.block(); ore = None
        if self.at('ELIF'): ore = [self._elif()]
        elif self.at('ELSE'): self.eat(); ore = self.block()
        return {'k': 'If', 'test': test, 'body': body, 'ore': ore, 'line': kw.line, 'col': kw.col}

    def _elif(self):
        kw = self.eat('ELIF'); test = self.expr(); body = self.block(); ore = None
        if self.at('ELIF'): ore = [self._elif()]
        elif self.at('ELSE'): self.eat(); ore = self.block()
        return {'k': 'If', 'test': test, 'body': body, 'ore': ore, 'line': kw.line, 'col': kw.col}

    def fors(self):
        kw = self.eat('FOR'); tgt = self.eat('IDENT').value
        self.eat('IN'); it = self.expr()
        return {'k': 'For', 'tgt': tgt, 'it': it, 'body': self.block(), 'line': kw.line, 'col': kw.col}

    def expr(self): return self.ternary()
    def ternary(self):
        n = self.or_()
        if self.at('IF'):
            self.eat(); c = self.or_(); self.eat('ELSE')
            return {'k': 'Tern', 'test': c, 'body': n, 'ore': self.ternary()}
        return n
    def or_(self):
        n = self.and_()
        while self.at('OR'): self.eat(); n = {'k': 'Bin', 'op': '||', 'l': n, 'r': self.and_()}
        return n
    def and_(self):
        n = self.not_()
        while self.at('AND'): self.eat(); n = {'k': 'Bin', 'op': '&&', 'l': n, 'r': self.not_()}
        return n
    def not_(self):
        if self.at('NOT'): self.eat(); return {'k': 'Un', 'op': '!', 'v': self.not_()}
        return self.cmp()
    def cmp(self):
        n = self.add()
        while self.at('OP') and self.c.value in ('==', '!=', '<', '>', '<=', '>='):
            op = self.eat('OP').value
            n = {'k': 'Bin', 'op': {'==': '===', '!=': '!=='}.get(op, op), 'l': n, 'r': self.add()}
        return n
    def add(self):
        n = self.mul()
        while self.at('OP') and self.c.value in ('+', '-'):
            op = self.eat('OP').value; n = {'k': 'Bin', 'op': op, 'l': n, 'r': self.mul()}
        return n
    def mul(self):
        n = self.un()
        while self.at('OP') and self.c.value in ('*', '/', '%'):
            op = self.eat('OP').value; n = {'k': 'Bin', 'op': op, 'l': n, 'r': self.un()}
        return n
    def un(self):
        if self.at('OP') and self.c.value == '-':
            self.eat(); return {'k': 'Un', 'op': '-', 'v': self.un()}
        return self.post()
    def post(self):
        n = self.atom()
        while True:
            if self.at('LPAREN'): n = self.call(n)
            elif self.at('DOT'):
                self.eat(); n = {'k': 'Attr', 'o': n, 'n': self.eat('IDENT').value}
            elif self.at('LBRACK'):
                self.eat(); i = self.expr(); self.eat('RBRACK')
                n = {'k': 'Idx', 'o': n, 'i': i}
            else: break
        return n
    def call(self, fn):
        self.eat('LPAREN'); args, kw = [], []
        depth = 0
        while not self.at('RPAREN'):
            # newlines inside parens are insignificant (like Python)
            while self.at('NEWLINE', 'INDENT', 'DEDENT'):
                if self.at('INDENT'): depth += 1
                elif self.at('DEDENT'):
                    if depth == 0: break
                    depth -= 1
                self.i += 1
            if self.at('RPAREN'): break
            if self.at('OP') and self.c.value == '*':
                self.eat(); args.append({'k': 'Spread', 'v': self.expr()})
            elif self.at('IDENT') and self.t[self.i + 1].type == 'OP' and self.t[self.i + 1].value == '=':
                k = self.eat('IDENT').value; self.eat('OP')
                kw.append((k, self.expr()))
            else:
                args.append(self.expr())
            if self.at('COMMA'): self.eat()
            elif self.at('NEWLINE', 'INDENT', 'DEDENT'): continue
            else: break
        while self.at('NEWLINE', 'INDENT', 'DEDENT'):
            self.i += 1
        self.eat('RPAREN')
        return {'k': 'Call', 'fn': fn, 'args': args, 'kw': kw}
    def atom(self):
        t = self.c
        if t.type in ('STRING', 'FSTRING'):
            self.eat(); return {'k': 'Str', 'v': t.value, 'f': t.type == 'FSTRING'}
        if t.type == 'NUMBER': self.eat(); return {'k': 'Num', 'v': t.value}
        if t.type == 'IDENT': self.eat(); return {'k': 'Name', 'id': t.value}
        if t.type in ('TRUE', 'FALSE'): self.eat(); return {'k': 'Bool', 'v': t.type == 'TRUE'}
        if t.type == 'NONE': self.eat(); return {'k': 'Null'}
        if t.type == 'LAMBDA':
            self.eat(); ps = []
            if not self.at('COLON'):
                ps = [self.eat('IDENT').value]
                while self.at('COMMA'): self.eat(); ps.append(self.eat('IDENT').value)
            self.eat('COLON')
            return {'k': 'Lam', 'params': ps, 'body': self.expr()}
        if t.type == 'LBRACK':
            self.eat()
            if self.at('RBRACK'):               # empty list: []
                self.eat()
                return {'k': 'List', 'items': []}
            first = self.expr()
            if self.at('FOR'):                  # List comprehension: [expr for x in it if c]
                self.eat('FOR')
                tgt = self.eat('IDENT').value
                self.eat('IN')
                it = self.or_()                 # not expr() — `if` here is the filter, not a ternary
                cond = None
                if self.at('IF'):
                    self.eat('IF')
                    cond = self.or_()
                self.eat('RBRACK')
                return {'k': 'Comp', 'expr': first, 'tgt': tgt, 'it': it, 'cond': cond}
            it = [first]
            while self.at('COMMA'):
                self.eat()
                if self.at('RBRACK'): break
                it.append(self.expr())
            self.eat('RBRACK'); return {'k': 'List', 'items': it}
        if t.type == 'LBRACE':
            self.eat()
            if self.at('RBRACE'):               # empty dict: {}
                self.eat()
                return {'k': 'Dict', 'pairs': []}
            pr = []
            while not self.at('RBRACE'):
                k = self.expr()
                if self.at('COLON'): self.eat(); pr.append((k, self.expr()))
                else: pr.append((None, k))
                if self.at('COMMA'): self.eat()
                else: break
            self.eat('RBRACE'); return {'k': 'Dict', 'pairs': pr}
        if t.type == 'LPAREN':
            self.eat()
            if self.at('RPAREN'):               # empty tuple: ()
                self.eat()
                return {'k': 'Tuple', 'items': []}
            first = self.expr()
            if self.at('COMMA'):
                items = [first]
                while self.at('COMMA'):
                    self.eat()
                    if self.at('RPAREN'): break
                    items.append(self.expr())
                self.eat('RPAREN'); return {'k': 'Tuple', 'items': items}
            self.eat('RPAREN'); return first
        raise CompileError(f"unexpected {t.type} ({t.value!r}) — expected an expression",
                           t.line, t.col, self.src, "check for a missing comma or a stray operator")


class Emitter:
    def __init__(self, src: List[str]):
        self.src = src
        self.L: List[str] = []
        self.d = 0
        self.imports: set = set()
        # For each output line index, the source line that produced it.
        # This is what makes a browser stack trace point at the .hsx file.
        self.linemap: List[int] = []
        self.cur_src = 1

    def w(self, s=''):
        line = ('  ' * self.d) + s if s else ''
        self.L.append(line)
        # A single w() call may carry embedded newlines (e.g. a multi-line JSX
        # return). Record one source-line entry per PHYSICAL output line, or the
        # source map drifts out of sync with the emitted file.
        for _ in range(line.count('\n') + 1):
            self.linemap.append(self.cur_src)
    def out(self) -> str: return '\n'.join(self.L)

    def js(self, n) -> str:
        k = n['k']
        if k == 'Str':  return self.fstr(n) if n['f'] else n['v']
        if k == 'Num':  return n['v']
        if k == 'Bool': return 'true' if n['v'] else 'false'
        if k == 'Null': return 'null'
        if k == 'Name': return n['id']
        if k == 'Attr': return f"{self.js(n['o'])}.{STR_METHODS.get(n['n'], n['n'])}"
        if k == 'Idx':  return f"{self.js(n['o'])}[{self.js(n['i'])}]"
        if k == 'Bin':
            op = n['op']
            l, r = self.js(n['l']), self.js(n['r'])
            if op == '+' and (n['l']['k'] in ('List', 'Tuple') or n['r']['k'] in ('List', 'Tuple')):
                return f"[...{l}, ...{r}]"
            return f"({l} {op} {r})"
        if k == 'Un':   return f"({n['op']}{self.js(n['v'])})"
        if k == 'Tern': return f"({self.js(n['test'])} ? {self.js(n['body'])} : {self.js(n['ore'])})"
        if k == 'Lam':  return f"(({', '.join(n['params'])}) => {self.js(n['body'])})"
        if k == 'List': return '[' + ', '.join(self.js(i) for i in n['items']) + ']'
        if k == 'Comp':
            # [expr for x in it if cond] -> it.filter(x => cond).map(x => expr)
            it, tgt = self.js(n['it']), n['tgt']
            res = it
            if n.get('cond'):
                res = f"{res}.filter(({tgt}) => {self.js(n['cond'])})"
            exp = self.js(n['expr'])
            if exp != tgt:
                res = f"{res}.map(({tgt}) => {exp})"
            return res
        if k == 'Tuple':return '[' + ', '.join(self.js(i) for i in n['items']) + ']'
        if k == 'Spread': return '...' + self.js(n['v'])
        if k == 'Dict':
            ps = []
            for kk, vv in n['pairs']:
                ps.append(self.js(vv) if kk is None else f"{self.js(kk)}: {self.js(vv)}")
            return '({' + ', '.join(ps) + '})'
        if k == 'Call':
            # Python builtins that map onto JS
            f = n['fn']
            if f['k'] == 'Name' and f['id'] in BUILTINS and len(n['args']) == 1 and not n['kw']:
                tpl = BUILTINS[f['id']]
                if '{0}' in tpl:
                    return tpl.replace('{0}', self.js(n['args'][0]))
                return f"({tpl})({self.js(n['args'][0])})"
            fn = self.js(n['fn'])
            if self.is_el(n): return self.jsx_inline(n, fn)
            a = [self.js(x) for x in n['args']] + [f"{PROPS.get(kk, kk)}: {self.js(vv)}" for kk, vv in n['kw']]
            return f"{fn}({', '.join(a)})"
        raise CompileError(f"cannot compile expression {k}", 0, 0, self.src)

    def fstr(self, n) -> str:
        body = n['v'][2:-1]
        return '`' + re.sub(r'\{([^{}]+)\}', lambda m: '${' + m.group(1) + '}', body) + '`'

    def is_el(self, n) -> bool:
        f = n['fn']
        return f['k'] == 'Name' and (f['id'] in TAGS or f['id'][:1].isupper())

    def attr_str(self, kw) -> str:
        attrs = []
        for k, v in kw:
            pk = 'key' if k == 'key' else PROPS.get(k, k)
            if v['k'] == 'Str' and not v.get('f'):
                # string literal attr: className="foo" (not className={"foo"})
                attrs.append(f'{pk}={v["v"]}')
            else:
                attrs.append(f'{pk}={{{self.js(v)}}}')
        return (' ' + ' '.join(attrs)) if attrs else ''

    def jsx_inline(self, n, tag: str) -> str:
        a = self.attr_str(n['kw'])
        kids = n['args']
        if not kids: return f"<{tag}{a} />"
        inner = ''.join(self.kid_inline(k) for k in kids)
        return f"<{tag}{a}>{inner}</{tag}>"

    def kid_inline(self, k) -> str:
        if k['k'] == 'Str' and not k.get('f'):
            return k['v'][1:-1]  # unquoted text inside JSX
        if k['k'] == 'Num':
            return k['v']
        return '{' + self.js(k) + '}'

    def tree(self, n, ind: int) -> str:
        """Render a tree block as JSX. `ind` = indent level of the OPENING tag."""
        head = n['tag']
        if head['k'] == 'Name' and (head['id'] in TAGS or head['id'][:1].isupper()):
            tag, a = head['id'], ''
        elif head['k'] == 'Call' and self.is_el(head):
            tag, a = self.js(head['fn']), self.attr_str(head['kw'])
        else:
            raise CompileError("a tree block must start with an element or component",
                               n['line'], n['col'], self.src, 'e.g. `div(className="x"):` or `h1:`')
        kids = [self.child(k, ind + 1) for k in n['body']]
        if not kids:
            return f"<{tag}{a} />"
        # A lone inline child stays on one line:  <h1>Hello</h1>
        if len(kids) == 1 and '\n' not in kids[0] and len(kids[0]) < 60:
            return f"<{tag}{a}>{kids[0].strip()}</{tag}>"
        inner = '\n'.join(('  ' * (ind + 1)) + k for k in kids)
        return f"<{tag}{a}>\n{inner}\n{('  ' * ind)}</{tag}>"

    def child(self, s, ind: int) -> str:
        """Render one tree child. Returns UNPADDED content (caller adds indent)."""
        k = s['k']
        if k == 'Tree':
            return self.tree(s, ind)
        if k == 'Expr':
            e = s['e']
            if e['k'] == 'Str' and not e.get('f'):
                return e['v'][1:-1]
            if e['k'] == 'Num':
                return e['v']
            # an element call used without a block:  input(value=..., ...)
            if e['k'] == 'Call' and self.is_el(e):
                return self.jsx_inline(e, self.js(e['fn']))
            return '{' + self.js(e) + '}'
        if k == 'If':
            cond = self.js(s['test'])
            body = self.frag(s['body'], ind)
            if s.get('ore'):
                o = s['ore']
                # An `elif` is a nested If — but it is already inside a `{...}`
                # expression, so its braces must be stripped or the JSX breaks.
                if len(o) == 1 and o[0]['k'] == 'If':
                    inner = self.child(o[0], ind).strip('{}')
                    return '{' + f"{cond} ? (" + body + f") : ({inner})" + '}'
                return '{' + f"{cond} ? (" + body + f") : ({self.frag(o, ind)})" + '}'
            return '{' + f"{cond} && (" + body + ')}'
        if k == 'For':
            body = self.frag(s['body'], ind)
            return '{' + f"{self.js(s['it'])}.map(({s['tgt']}) => (" + body + '))}'
        raise CompileError(f"`{k}` is not allowed inside a tree block",
                           s.get('line', 0), s.get('col', 0), self.src,
                           "move logic above the tree — tree blocks only accept elements, if, and for")

    def frag(self, body, ind: int) -> str:
        """A list of tree children as ONE JSX expression, indented for its opening context."""
        kids = [self.child(s, ind) for s in body]
        if len(kids) == 1:
            return kids[0]
        return '<>\n' + '\n'.join(('  ' * (ind + 1)) + k for k in kids) + f"\n{('  ' * ind)}</>"

    def stmt(self, s):
        k = s['k']
        if 'line' in s: self.cur_src = s['line']
        if k == 'Assign':
            tgt = s['t']
            lhs = ('[' + ', '.join(self.js(i) for i in tgt['items']) + ']'
                   if tgt['k'] == 'Tuple' else self.js(tgt))
            self.w(f"const {lhs} = {self.js(s['v'])};")
        elif k == 'Aug':
            self.w(f"{self.js(s['t'])} {s['op']}= {self.js(s['v'])};")
        elif k == 'Return':
            self.w(f"return {self.js(s['v'])};")
        elif k == 'Expr':
            self.w(f"{self.js(s['e'])};")
        elif k == 'Tree':
            self.w(f"return (\n{('  ' * (self.d + 1))}{self.tree(s, self.d + 1)}\n{('  ' * self.d)});")
        elif k == 'Def':
            ps = ', '.join(self.par(p) for p in s['params'])
            self.w(f"const {s['name']} = ({ps}) => {{")
            self.d += 1
            for x in s['body']: self.stmt(x)
            self.d -= 1
            self.w("};")
        elif k == 'If':
            self.w(f"if ({self.js(s['test'])}) {{")
            self.d += 1
            for x in s['body']: self.stmt(x)
            self.d -= 1
            self.w("}")
            if s.get('ore'):
                self.w("else {")
                self.d += 1
                for x in s['ore']: self.stmt(x)
                self.d -= 1
                self.w("}")
        elif k == 'For':
            self.w(f"for (const {s['tgt']} of {self.js(s['it'])}) {{")
            self.d += 1
            for x in s['body']: self.stmt(x)
            self.d -= 1
            self.w("}")
        elif k == 'Import':
            pass  # handled in pass 1
        else:
            raise CompileError(f"cannot compile statement {k}", s.get('line', 0), s.get('col', 0), self.src)

    def par(self, p):
        d = p.get('default')
        # `x=None` marks a prop optional. Emitting `x = null` would be wrong —
        # React would hand the component null instead of undefined.
        if d is not None and d['k'] != 'Null':
            return f"{p['name']} = {self.js(d)}"
        return p['name']

    def component(self, n):
        ps = ', '.join(self.par(p) for p in n['params'])
        arg = f"{{ {ps} }}: {n['name']}Props" if n['params'] else ""
        self.w(f"export function {n['name']}({arg}) {{")
        self.d += 1
        trees = [s for s in n['body'] if s['k'] == 'Tree']
        if len(trees) > 1:
            for s in n['body']:
                if s['k'] != 'Tree': self.stmt(s)
            parts = [self.tree(s, self.d + 1) for s in trees]
            pad = '  ' * self.d
            pad2 = '  ' * (self.d + 1)
            inner = '\n'.join(f"{pad2}{p}" for p in parts)
            self.w(f"return (\n{pad}<>\n{inner}\n{pad}</>\n{pad});")
        else:
            for s in n['body']: self.stmt(s)
        self.d -= 1
        self.w("}")
        if n['params']:
            self.w()
            self.w(f"export interface {n['name']}Props {{")
            self.d += 1
            for p in n['params']:
                opt = '?' if p.get('has_default') else ''
                self.w(f"{p['name']}{opt}: {p['type'] or 'any'};")
            self.d -= 1
            self.w("}")

    def run(self, mod) -> str:
        self.imports = set()
        for s in mod:
            if s['k'] == 'Import':
                if s.get('from'):
                    self.imports.add(f"import {{ {', '.join(s['names'])} }} from '{s['from']}';")
                else:
                    self.imports.add(f"import {', '.join(s['names'])} from 'serpent';")
        head = ["// [xihanzu-NR]", "// GENERATED by serpent — edit the .hsx file, not this one"]
        for i in sorted(self.imports): head.append(i)
        head.append("")
        for s in mod:
            if s['k'] == 'Component':
                self.component(s)
                self.w()
            elif s['k'] != 'Import':
                self.stmt(s)
        self.head_lines = head
        # Join with '\n' and keep a trailing separator so head and body stay
        # line-aligned with self.linemap (which indexes body lines only).
        return '\n'.join(head) + '\n' + self.out()

    def sourcemap(self, filename: str, src: str) -> str:
        """Build a v3 source map from the recorded line map."""

        # One segment per generated line, VLQ-delta encoded.
        segs, prev_src = [], 0
        for _ in range(len(self.head_lines)):
            segs.append(encode_vlq(0) + encode_vlq(0) + encode_vlq(0))
        for sl in self.linemap:
            d = (sl - 1) - prev_src
            prev_src = sl - 1
            segs.append(encode_vlq(0) + encode_vlq(d) + encode_vlq(0))
        return json.dumps({
            'version': 3,
            'file': filename.rsplit('.', 1)[0] + '.tsx',
            'sources': [filename],
            'sourcesContent': [src],
            'names': [],
            'mappings': ';'.join(segs),
        })


def compile_serpent(src: str) -> str:
    lines = src.split('\n')
    toks = lex(src)
    mod = Parser(toks, lines).module()
    return Emitter(lines).run(mod)


_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def encode_vlq(n: int) -> str:
    v = ((-n) << 1) | 1 if n < 0 else n << 1
    out = ''
    while True:
        digit = v & 31
        v >>= 5
        if v: digit |= 32
        out += _B64[digit]
        if not v: break
    return out


def compile_file(src: str, filename: str) -> Tuple[str, str]:
    """Compile source and return (code_with_sourcemap_comment, sourcemap_json)."""
    lines = src.split('\n')
    toks = lex(src)
    mod = Parser(toks, lines).module()
    em = Emitter(lines)
    code = em.run(mod)
    smap = em.sourcemap(filename, src)
    b64 = __import__('base64').b64encode(smap.encode()).decode()
    code += f"\n//# sourceMappingURL=data:application/json;base64,{b64}\n"
    return code, smap


if __name__ == '__main__':
    SAMPLE = '''
from serpent import state, effect

component TodoApp():
    todos, set_todos = state(["Belajar Python", "Bikin Framework"])
    text, set_text = state("")
    count = len(todos)

    def add_todo():
        if text.strip():
            set_todos(todos + [text])
            set_text("")

    div(className="max-w-md mx-auto p-6 bg-white rounded-xl shadow-md space-y-4"):
        h1(className="text-2xl font-bold text-gray-900"): "Serpent Todo App"
        p(className="text-sm text-gray-500"): f"Total: {count} tasks"

        div(className="flex gap-2"):
            input(
                value=text,
                on_change=lambda e: set_text(e.target.value),
                placeholder="Tulis todo baru...",
                className="flex-1 px-3 py-2 border rounded-lg"
            )
            button(on_click=add_todo, className="px-4 py-2 bg-blue-600 text-white rounded-lg"): "Tambah"

        if count == 0:
            p(className="text-gray-400 italic text-center py-4"): "Belum ada todo. Mulai sekarang!"
        else:
            ul(className="divide-y divide-gray-200"):
                for item in todos:
                    li(key=item, className="py-2 flex justify-between items-center"):
                        span: item
                        button(on_click=lambda: set_todos([t for t in todos if t != item]), className="text-red-500 text-sm"): "Hapus"
'''
    try:
        out = compile_serpent(SAMPLE)
        print("=" * 70)
        print("SERPENT COMPILER SELF-TEST: PASSED")
        print("=" * 70)
        print(out)
    except CompileError as e:
        print(e.pretty())
        sys.exit(1)
