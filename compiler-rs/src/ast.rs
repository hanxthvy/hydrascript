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
    Component { name: String, params: Vec<Param>, body: Vec<Node> },
    Def { name: String, params: Vec<Param>, body: Vec<Node> },
    Import { from: Option<String>, names: Vec<String> },
    Assign { target: Box<Node>, value: Box<Node> },
    AugAssign { target: Box<Node>, op: String, value: Box<Node> },
    Return(Box<Node>),
    ExprStmt(Box<Node>),
    If { test: Box<Node>, body: Vec<Node>, orelse: Option<Vec<Node>> },
    For { target: String, iter: Box<Node>, body: Vec<Node> },
    While { test: Box<Node>, body: Vec<Node> },
    Try { body: Vec<Node>, handlers: Vec<Except>, orelse: Option<Vec<Node>>, finally: Option<Vec<Node>> },
    Break,
    Continue,
    Pass,
    /// `async def name(...)` — emits `async function`.
    AsyncDef { name: String, params: Vec<Param>, body: Vec<Node> },
    /// `export def` / `export NAME = ...` — emits a JS `export`.
    Export(Box<Node>),
    /// A `tag:` or `tag(props):` block — the thing that becomes JSX.
    Tree { head: Box<Node>, body: Vec<Node> },

    // ---- expressions
    Name(String),
    Str { value: String, is_f: bool },
    /// A parsed f-string. The interpolation is compiled, not copied — otherwise
    /// `f"{'a' if x else 'b'}"` would leak Python syntax into the JS output.
    FString(Vec<FPart>),
    Num(String),
    Bool(bool),
    Null,
    Attr { obj: Box<Node>, name: String },
    Index { obj: Box<Node>, index: Box<Node> },
    Bin { op: String, left: Box<Node>, right: Box<Node> },
    Unary { op: String, operand: Box<Node> },
    Ternary { test: Box<Node>, body: Box<Node>, orelse: Box<Node> },
    Lambda { params: Vec<String>, defaults: Vec<Option<Node>>, body: Box<Node> },
    List(Vec<Node>),
    Tuple(Vec<Node>),
    Dict(Vec<(Option<Node>, Node)>),
    Spread(Box<Node>),
    Call { func: Box<Node>, args: Vec<Node>, kwargs: Vec<(String, Node)> },
    /// `[expr for x in iter if cond]`
    Comprehension { expr: Box<Node>, target: String, iter: Box<Node>, cond: Option<Box<Node>> },
    /// `xs[start:stop]` — Python slicing, no JS equivalent.
    Slice { obj: Box<Node>, start: Option<Box<Node>>, stop: Option<Box<Node>> },
    /// `await expr`
    Await(Box<Node>),
    /// `match subject:` with `case pattern:` arms
    Match { subject: Box<Node>, cases: Vec<CaseArm> },
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
