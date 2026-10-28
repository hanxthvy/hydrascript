// [xihanzu-NR]
//! Abstract syntax tree.
//!
//! Every node that can appear in an error carries its source position. That is
//! what lets the emitter build a real source map instead of a guess.

#[derive(Debug, Clone)]
pub struct Node {
    pub kind: Kind,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone)]
pub enum Kind {
    // ---- statements
    Module(Vec<Node>),
    Component {
        name: String,
        params: Vec<Param>,
        body: Vec<Node>,
    },
    Def {
        name: String,
        params: Vec<Param>,
        body: Vec<Node>,
    },
    Import {
        from: Option<String>,
        names: Vec<String>,
    },
    Assign {
        target: Box<Node>,
        value: Box<Node>,
    },
    AugAssign {
        target: Box<Node>,
        op: String,
        value: Box<Node>,
    },
    Return(Option<Box<Node>>),
    ExprStmt(Box<Node>),
    If {
        test: Box<Node>,
        body: Vec<Node>,
        orelse: Option<Vec<Node>>,
    },
    For {
        target: String,
        iter: Box<Node>,
        body: Vec<Node>,
    },
    While {
        test: Box<Node>,
        body: Vec<Node>,
    },
    Try {
        body: Vec<Node>,
        handlers: Vec<Except>,
        orelse: Option<Vec<Node>>,
        finally: Option<Vec<Node>>,
    },
    Break,
    Continue,
    Pass,
    /// `async def name(...)` — emits `async function`.
    AsyncDef {
        name: String,
        params: Vec<Param>,
        body: Vec<Node>,
    },
    /// `export def` / `export NAME = ...` — emits a JS `export`.
    Export(Box<Node>),
    /// `export default X` — a distinct JS form, not `export default` glued on.
    ExportDefault(Box<Node>),
    /// A `tag:` or `tag(props):` block — the thing that becomes JSX.
    Tree {
        head: Box<Node>,
        body: Vec<Node>,
    },
    /// `interface Name: ...` — TypeScript interface, passed through verbatim.
    Interface {
        name: String,
        body: String,
    },
    /// `type Name = ...` — TypeScript type alias, passed through verbatim.
    TypeAlias {
        name: String,
        body: String,
    },
    /// Raw TypeScript/JavaScript passthrough — lines starting with `@raw`.
    RawTS(String),

    // ---- expressions
    Name(String),
    Str {
        value: String,
        is_f: bool,
    },
    /// A parsed f-string. The interpolation is compiled, not copied — otherwise
    /// `f"{'a' if x else 'b'}"` would leak Python syntax into the JS output.
    FString(Vec<FPart>),
    Num(String),
    Bool(bool),
    Null,
    Attr {
        obj: Box<Node>,
        name: String,
    },
    OptAttr {
        obj: Box<Node>,
        name: String,
    },
    Index {
        obj: Box<Node>,
        index: Box<Node>,
    },
    OptIndex {
        obj: Box<Node>,
        index: Box<Node>,
    },
    Bin {
        op: String,
        left: Box<Node>,
        right: Box<Node>,
    },
    Unary {
        op: String,
        operand: Box<Node>,
    },
    Ternary {
        test: Box<Node>,
        body: Box<Node>,
        orelse: Box<Node>,
    },
    Lambda {
        params: Vec<String>,
        defaults: Vec<Option<Node>>,
        body: Box<Node>,
    },
    List(Vec<Node>),
    Tuple(Vec<Node>),
    Dict(Vec<(Option<Node>, Node)>),
    Spread(Box<Node>),
    Call {
        func: Box<Node>,
        args: Vec<Node>,
        kwargs: Vec<(String, Node)>,
    },
    /// `fn?.(x)` — optional call. Emits `fn?.(x)`, not a guarded if.
    OptCall {
        func: Box<Node>,
        args: Vec<Node>,
        kwargs: Vec<(String, Node)>,
    },
    /// `[expr for x in iter if cond]`
    Comprehension {
        expr: Box<Node>,
        target: String,
        iter: Box<Node>,
        cond: Option<Box<Node>>,
    },
    /// `{k: v for x in iter if cond}` — no JS equivalent, compiles to a reducer.
    DictComprehension {
        key: Box<Node>,
        value: Box<Node>,
        target: String,
        iter: Box<Node>,
        cond: Option<Box<Node>>,
    },
    /// `{x for x in iter if cond}` — a Set in JS, which is what Python means.
    SetComprehension {
        expr: Box<Node>,
        target: String,
        iter: Box<Node>,
        cond: Option<Box<Node>>,
    },
    /// `(x := value)` — assignment as an expression.
    Walrus {
        name: String,
        value: Box<Node>,
    },
    /// `yield expr` — a generator function body.
    Yield(Option<Box<Node>>),
    /// `` `text ${expr}` `` — a JavaScript template literal, passed through.
    TemplateLiteral(String),
    /// `xs[start:stop]` — Python slicing, no JS equivalent.
    Slice {
        obj: Box<Node>,
        start: Option<Box<Node>>,
        stop: Option<Box<Node>>,
        /// `xs[::step]` — Python allows a step; JS `slice` does not.
        step: Option<Box<Node>>,
    },
    /// `a < b < c` — Python chains, JavaScript does not. Emitting it as
    /// `(a < b) < c` compares a boolean with a number, which is valid JS with
    /// the wrong answer, so this gets its own node and an `&&` chain.
    ChainedCompare {
        ops: Vec<String>,
        operands: Vec<Node>,
    },
    /// `a is not b` / `a is b` — identity, spelled out so `is not` cannot be
    /// parsed as `is` applied to a unary `not`.
    /// (Kept as Bin with op "is"/"is not" so the emitter stays simple.)
    /// `x, y = y, x` — multiple targets, multiple values, evaluated left to
    /// right with parallel assignment semantics.
    TupleAssign {
        targets: Vec<Node>,
        value: Box<Node>,
    },
    /// `a = b = c = 0` — chained assignment.
    ChainedAssign {
        targets: Vec<Node>,
        value: Box<Node>,
    },
    /// `assert cond, "message"` — throws in JS rather than silently vanishing.
    Assert {
        test: Box<Node>,
        message: Option<Box<Node>>,
    },
    /// `raise ValueError("bad")` — `throw`.
    Raise(Option<Box<Node>>),
    /// `import("./Page.hyx")` — dynamic import expression.
    DynamicImport(Box<Node>),
    /// `"a" in xs` / `x in d` — Python membership. JS `in` checks keys of an
    /// object, so strings and arrays need different code.
    Contains {
        item: Box<Node>,
        container: Box<Node>,
        negated: bool,
    },
    /// `await expr`
    Await(Box<Node>),
    /// `new expr` — JS constructor call. Python has no equivalent, but every
    /// browser API a UI needs (IntersectionObserver, ResizeObserver, Date,
    /// WebSocket, Worker, AbortController) is reached by constructing one.
    New(Box<Node>),
    /// `match subject:` with `case pattern:` arms
    Match {
        subject: Box<Node>,
        cases: Vec<CaseArm>,
    },
}

#[derive(Debug, Clone)]
pub struct CaseArm {
    pub pattern: Box<Node>,
    pub body: Vec<Node>,
}

#[derive(Debug, Clone)]
pub enum FPart {
    Lit(String),
    Expr(Node),
}

/// One `except Cls as name:` arm.
#[derive(Debug, Clone)]
pub struct Except {
    /// The exception class name, or None for a bare `except:`.
    pub class: Option<String>,
    pub name: Option<String>,
    pub body: Vec<Node>,
}

#[derive(Debug, Clone)]
pub struct Param {
    pub name: String,
    pub ty: Option<String>,
    pub default: Option<Node>,
    pub has_default: bool,
}

impl Node {
    pub fn new(kind: Kind, line: usize, col: usize) -> Self {
        Self { kind, line, col }
    }
}
