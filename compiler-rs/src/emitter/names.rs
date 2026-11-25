//! Name-mapping tables: a Python name to the JavaScript spelling it becomes.



pub fn python_base_class(name: &str) -> Option<String> {
    const KEYS: &[&str] = &[
        "Exception",
        "BaseException",
        "ValueError",
        "KeyError",
        "IndexError",
        "RuntimeError",
        "ZeroDivisionError",
        "AttributeError",
        "StopIteration",
        "NotImplementedError",
        "FileNotFoundError",
        "PermissionError",
        "OSError",
        "IOError",
        "ArithmeticError",
        "AssertionError",
        "LookupError",
        "OverflowError",
        "RangeError",
        "UnicodeError",
    ];
    if KEYS.contains(&name) {
        Some(name.to_string())
    } else {
        None
    }
}

pub fn prop_map(k: &str) -> String {
    if k.starts_with("aria_") || k.starts_with("data_") {
        return k.replace('_', "-");
    }
    match k {
        "class" | "cls" => "className".into(),
        "for" => "htmlFor".into(),
        "on_click" => "onClick".into(),
        "on_change" => "onChange".into(),
        "on_input" => "onInput".into(),
        "on_submit" => "onSubmit".into(),
        "on_key_down" => "onKeyDown".into(),
        "on_key_up" => "onKeyUp".into(),
        "on_blur" => "onBlur".into(),
        "on_focus" => "onFocus".into(),
        "on_mouse_enter" => "onMouseEnter".into(),
        "on_mouse_leave" => "onMouseLeave".into(),
        "on_double_click" => "onDoubleClick".into(),
        "read_only" => "readOnly".into(),
        "auto_focus" => "autoFocus".into(),
        "auto_complete" => "autoComplete".into(),
        "tab_index" => "tabIndex".into(),
        "max_length" => "maxLength".into(),
        "col_span" => "colSpan".into(),
        "row_span" => "rowSpan".into(),
        "src_set" => "srcSet".into(),
        "type_" => "type".into(),
        other => other.into(),
    }
}

pub fn str_method(m: &str) -> &str {
    match m {
        "strip" => "trim",
        "lstrip" => "trimStart",
        "rstrip" => "trimEnd",
        "upper" => "toUpperCase",
        "lower" => "toLowerCase",
        "startswith" => "startsWith",
        "endswith" => "endsWith",
        "replace" => "replaceAll",
        "find" => "indexOf",
        "split" => "split",
        "join" => "join",
        "append" => "push",
        "copy" => "slice",
        // NOTE: "keys"/"values"/"items" are NOT here on purpose. They were
        // emitted as `.keys()` / `.values()` / `.entries()` — JS method calls —
        // which throw on a plain object literal (`d.keys is not a function`)
        // even though `hydra check` stayed silent. They are free-function
        // rewrites now; see `free_func` below.
        // Dunder introspection. `type(x).__name__` is the common one; without
        // this it emitted `.__name__`, which is `undefined` on every JS value.
        "__name__" => "name",
        "__class__" => "constructor",
        "__doc__" => "toString",
        "__module__" => "name",
        other => other,
    }
}

/// Python methods with no JS equivalent that are rewritten to a free function
/// call into the `hydra` runtime: `s.capitalize()` -> `capitalize(s)`.
///
/// The dict, list, str and dict-lookup entries here are the ones that used to
/// produce JavaScript that either threw or silently did the wrong thing:
/// `", ".join(xs)` emitted a method call on a string (TypeError), `d.get("k", 0)`
/// emitted a method call on an object (TypeError), `len(d)` emitted `.length` on
/// an object (undefined), and `xs.extend(ys)` emitted `.extend` (TypeError).
/// Each one is now mapped to the helper that implements the Python behaviour.
pub fn free_func(m: &str) -> Option<&'static str> {
    match m {
        // strings
        "capitalize" => Some("capitalize"),
        "title" => Some("title"),
        "count" => Some("count"),
        "format" => Some("format"),
        "zfill" => Some("zfill"),
        "isdigit" => Some("isDigit"),
        "isalpha" => Some("isAlpha"),
        "isalnum" => Some("isAlnum"),
        "isspace" => Some("isSpace"),
        "isupper" => Some("isUpper"),
        "islower" => Some("isLower"),
        "center" => Some("center"),
        "ljust" => Some("ljust"),
        "rjust" => Some("rjust"),
        "partition" => Some("str_partition"),
        "rpartition" => Some("str_rpartition"),
        "swapcase" => Some("swapcase"),
        // join is a string method in Python and an array method in JS; the
        // operands are the other way round, so it needs a helper.
        "join" => Some("join"),
        // dict
        "get" => Some("dict_get"),
        "setdefault" => Some("dict_setdefault"),
        "update" => Some("dict_update"),
        "pop" => Some("pop_of"),
        "popitem" => Some("dict_popitem"),
        "fromkeys" => Some("dict_fromkeys"),
        // list
        "extend" => Some("list_extend"),
        "insert" => Some("list_insert"),
        "remove" => Some("list_remove"),
        "index" => Some("list_index"),
        // Plain-object dicts have no JS methods at all. `d.keys()` used to emit
        // `d.keys()` and throw `d.keys is not a function` at runtime — silently,
        // because the checker did not model dict methods and the gate only sees
        // the code a render actually runs.
        "keys" => Some("dict_keys"),
        "values" => Some("dict_values"),
        "items" => Some("dict_items"),
        // set-like helpers
        "add" => Some("set_add"),
        "discard" => Some("set_discard"),
        _ => None,
    }
}


// [xihanzu-NR]
/// Python truthiness for a CONDITION: an empty list, dict or string and 0 are
/// falsy, where JS calls `[]` and `{}` true.
///
/// Only non-trivial tests are wrapped. `if x == 1`, `if not x` and `if fn()` are
/// already correct in JS, and wrapping them would emit `truthy(x === 1)` — noise
/// that makes the output harder to read for no behaviour change.
pub fn py_cond(cond: &str) -> String {
    // A bare `!expr` is already Python's `not`, because `not` lowers to `!` and
    // JS `!` agrees with Python for every falsy scalar; the sequence cases are
    // what differ, and those come through as a bare NAME or a member access.
    let trimmed = cond.trim();
    if trimmed.starts_with('!') || trimmed.starts_with("Boolean(") || trimmed.starts_with("truthy(") {
        return cond.to_string();
    }
    if trimmed.contains(" == ") || trimmed.contains(" === ") || trimmed.contains(" != ")
        || trimmed.contains(" !== ") || trimmed.starts_with("!!(") || trimmed.starts_with("(")
    {
        return cond.to_string();
    }
    format!("truthy({})", cond)
}
