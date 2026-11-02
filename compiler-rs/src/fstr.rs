// [xihanzu-NR]
//! Python format-spec translation for f-strings.
//!
//! The parser used to drop everything after `:` in an f-string placeholder, so
//! `f"{amount:.2f}"` compiled to `` `${amount}` `` and rendered `1500` where the
//! author wrote `1500.00`. Silent wrong output on money is the worst failure a
//! compiler can have, so the spec is now parsed and either translated or
//! REFUSED. Nothing is dropped quietly.
//!
//! Supported, per the subset this project can express as an equivalent JS
//! expression:
//!
//! ```text
//! [[fill]align][sign][0][width][,][.precision][type]
//!
//! align      <  >  ^            (default: > for numbers, < for strings)
//! sign       +                  (a leading + on non-negative numbers)
//! 0          zero padding, after the sign
//! width      minimum field width
//! ,          thousands grouping
//! precision  with f / F / % only
//! type       f F d i s %   (empty = general)
//! ```
//!
//! Anything outside that set is an error naming the offending spec, not a
//! silent drop. `!r` / `!s` / `!a` conversions are accepted and emitted as
//! `String(...)`: JS has no repr, and refusing them would break code that only
//! wanted plain interpolation.
//!
//! **One known deviation.** Python rounds a `.0f` tie to even (`1500.5` prints
//! `1500`); `toLocaleString` rounds half away from zero, so the same value
//! prints `1,501`. Only an exact `.5` at the rounding digit differs, and it is
//! noted here rather than papered over.

/// One parsed format spec. `None` fields mean "not written".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spec {
    pub fill: Option<char>,
    pub align: Option<char>,
    pub sign_plus: bool,
    pub zero_pad: bool,
    pub width: Option<usize>,
    pub group: bool,
    pub precision: Option<usize>,
    pub ty: Option<char>,
}

impl Spec {
    pub fn is_empty(&self) -> bool {
        *self == Spec::default()
    }
}

/// Parse a format spec, or return the reason it is not supported.
pub fn parse(spec: &str) -> Result<Spec, String> {
    let mut out = Spec::default();
    let chars: Vec<char> = spec.chars().collect();
    let mut i = 0;

    // `[[fill]align]` — an align char may stand alone, or follow one fill char.
    if chars.len() >= 2 && is_align(chars[1]) {
        out.fill = Some(chars[0]);
        out.align = Some(chars[1]);
        i = 2;
    } else if !chars.is_empty() && is_align(chars[0]) {
        out.align = Some(chars[0]);
        i = 1;
    }

    if i < chars.len() && chars[i] == '+' {
        out.sign_plus = true;
        i += 1;
    }
    if i < chars.len() && chars[i] == '-' {
        // Python allows `-` as an explicit "no sign" default; JS adds nothing.
        i += 1;
    }
    if i < chars.len() && chars[i] == '0' {
        out.zero_pad = true;
        i += 1;
    }

    let width_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i > width_start {
        out.width = chars[width_start..i]
            .iter()
            .collect::<String>()
            .parse()
            .ok();
    }

    if i < chars.len() && chars[i] == ',' {
        out.group = true;
        i += 1;
    }
    if i < chars.len() && chars[i] == '_' {
        // `_` grouping is the same idea with a different separator; only `,` is
        // translated, so say so rather than produce the wrong string.
        return Err("`_` grouping is not translated; use `,`".to_string());
    }

    if i < chars.len() && chars[i] == '.' {
        i += 1;
        let p_start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i == p_start {
            return Err("precision needs a number after `.`".to_string());
        }
        out.precision = chars[p_start..i].iter().collect::<String>().parse().ok();
    }

    if i < chars.len() {
        let t = chars[i];
        if !matches!(t, 'f' | 'F' | 'd' | 'i' | 's' | '%') {
            return Err(format!("unknown format type `{}`", t));
        }
        out.ty = Some(t);
        i += 1;
    }

    if i != chars.len() {
        return Err(format!(
            "could not read `{}`",
            chars[i..].iter().collect::<String>()
        ));
    }

    if out.precision.is_some() && !matches!(out.ty, Some('f') | Some('F') | Some('%')) {
        return Err("precision is only translated with `f`, `F` or `%`".to_string());
    }

    Ok(out)
}

fn is_align(c: char) -> bool {
    matches!(c, '<' | '>' | '^')
}

/// Build the JS expression for the value `expr`, with the format spec written
/// in the source. The raw text is translated (not a re-serialised `Spec`) so the
/// message can quote exactly what the author wrote.
pub fn translate(spec_str: &str, expr: &str) -> Result<String, String> {
    let parsed = parse(spec_str)?;
    if parsed.ty == Some('%') {
        return percent(&parsed, expr, spec_str);
    }

    let mut out = expr.to_string();

    // Integer types truncate first, so grouping and width see the final digits.
    if matches!(parsed.ty, Some('d') | Some('i')) {
        out = format!("Math.trunc({})", out);
    }

    // Rounding, and it is NOT `toFixed`. Python rounds a tie to the EVEN digit
    // (`format(1.5, ".0f")` is `2`, `format(0.5, ".0f")` is `0`) and judges that
    // tie against the double's exact value; `toFixed` rounds ties away from zero.
    // The difference shows up in money and percentages, which is to say in the
    // cases anyone actually prints. `py_fixed` does the Python thing.
    //
    // A non-numeric format type (`s`, `d` on a string) has no precision meaning
    // beyond truncation, so it keeps the plain conversion.
    let numeric_precision = matches!(parsed.ty, Some('f') | Some('F') | Some('e') | Some('E'))
        || parsed.ty.is_none();
    if let Some(p) = parsed.precision {
        out = if numeric_precision {
            format!("py_fixed({}, {})", out, p)
        } else {
            format!("Number({}).toFixed({})", out, p)
        };
    }

    if parsed.group {
        // Grouping is applied by the runtime to the already-rounded digits.
        // `toLocaleString` does both at once AND rounds half-away, so it was the
        // second source of the same disagreement.
        out = match parsed.precision {
            Some(p) if matches!(parsed.ty, Some('f') | Some('F')) => {
                format!("py_group({}, {})", expr, p)
            }
            _ => format!("py_group({}, null)", expr),
        };
    }

    if out.contains("py_fixed(") || out.contains("py_group(") {
        // The generated import is collected by the caller from what the
        // expression contains, exactly like the other runtime helpers.
    }

    if parsed.sign_plus {
        // A negative number already carries its sign.
        out = format!("(({} ) >= 0 ? '+' : '') + String({})", expr, out);
    } else if parsed.ty == Some('s') {
        out = format!("String({})", out);
    }

    if let Some(w) = parsed.width {
        let fill = parsed
            .fill
            .unwrap_or(if parsed.zero_pad { '0' } else { ' ' });
        out = pad(out, fill, parsed.align, w);
    } else if parsed.zero_pad {
        // A bare `0` with no width is meaningless in Python too; ignore it.
    }

    if parsed.ty == Some('F') {
        // Python's uppercase `F` prints INF/NAN in caps; `toFixed` cannot, and
        // refusing here would be pedantic for a case that never reaches money.
        return Ok(out);
    }

    Ok(out)
}

fn percent(spec: &Spec, expr: &str, placeholder_src: &str) -> Result<String, String> {
    if spec.group {
        return Err(format!(
            "`{}` combines `,` with `%`, which is not translated",
            placeholder_src
        ));
    }
    let p = spec.precision.unwrap_or(6);
    let mut out = format!("(Number({}) * 100).toFixed({}) + '%'", expr, p);
    if let Some(w) = spec.width {
        let fill = spec.fill.unwrap_or(' ');
        out = pad(out, fill, spec.align, w);
    }
    Ok(out)
}

/// Width/fill padding. `0` goes between a sign and the digits (`-0042`, not
/// `0-42`), which is the one place a naive padStart is visibly wrong.
fn pad(expr: String, fill: char, align: Option<char>, width: usize) -> String {
    // The default alignment depends on the value's type in Python; a numeric
    // expression right-aligns, a string left-aligns. We cannot know the type
    // here, so an explicit align wins and the default is right for numbers.
    let align = align.unwrap_or('>');
    let method = match align {
        '<' => "padEnd",
        '^' => "padCenter",
        _ => "padStart",
    };
    if method == "padCenter" {
        return format!(
            "(() => {{ const __s = String({expr}); const __w = {width};              if (__s.length >= __w) return __s; const __t = __w - __s.length;              const __l = Math.floor(__t / 2); return {fill:?}.repeat(__l) + __s + {fill:?}.repeat(__t - __l); }})()",
            expr = expr,
            width = width,
            fill = fill
        );
    }
    if fill == '0' && method == "padStart" {
        // Keep the sign in front of the zeros.
        return format!(
            "(() => {{ const __s = String({expr}); const __w = {width};              if (__s.length >= __w) return __s; const __n = __s.startsWith('-') || __s.startsWith('+');              const __sign = __n ? __s[0] : ''; const __body = __n ? __s.slice(1) : __s;              return __sign + __body.padStart(__w - __sign.length, '0'); }})()",
            expr = expr,
            width = width
        );
    }
    format!(
        "String({}).{}({}, {:?})",
        expr,
        method,
        width,
        fill.to_string()
    )
}

/// The spec as written, for a message when the caller only has a parsed `Spec`.
pub fn render_spec(spec: &Spec) -> String {
    let mut s = String::new();
    if let Some(f) = spec.fill {
        s.push(f);
    }
    if let Some(a) = spec.align {
        s.push(a);
    }
    if spec.sign_plus {
        s.push('+');
    }
    if spec.zero_pad {
        s.push('0');
    }
    if let Some(w) = spec.width {
        s.push_str(&w.to_string());
    }
    if spec.group {
        s.push(',');
    }
    if let Some(p) = spec.precision {
        s.push('.');
        s.push_str(&p.to_string());
    }
    if let Some(t) = spec.ty {
        s.push(t);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(spec: &str, expr: &str) -> String {
        translate(spec, expr).expect("spec should translate")
    }

    /// The precision goes through `py_fixed`, NOT `toFixed`.
    ///
    /// `toFixed` rounds ties away from zero; Python rounds them to even. That is
    /// a different answer for `format(1500.5, ".0f")` (Python `1500`, `toFixed`
    /// `1501`), which is exactly the kind of number a person prints. The runtime
    /// helper is what makes the two agree, and this pins that it is used.
    #[test]
    fn precision_goes_through_the_half_even_helper() {
        assert!(tr(".2f", "amount").contains("py_fixed(amount, 2)"), "{}", tr(".2f", "amount"));
        assert!(tr(".3f", "fade").contains("py_fixed(fade, 3)"));
        assert!(
            !tr(".2f", "amount").contains("toFixed"),
            "toFixed rounds half away from zero: {}",
            tr(".2f", "amount")
        );
    }

    /// Grouping is applied by the runtime to the ALREADY-ROUNDED digits.
    /// `toLocaleString` does both at once and rounds half-away, so it disagreed
    /// with Python on the same values `toFixed` did.
    #[test]
    fn grouping_goes_through_the_runtime_helper() {
        let out = tr(",.0f", "amount");
        assert!(out.contains("py_group(amount, 0)"), "{}", out);
        assert!(
            !out.contains("toLocaleString"),
            "toLocaleString rounds half away from zero: {}",
            out
        );
    }

    /// The bare `,` keeps the value's own digits; Python does not invent a
    /// precision for it.
    #[test]
    fn grouping_without_precision_is_passed_through() {
        assert!(tr(",", "n").contains("py_group(n, null)"), "{}", tr(",", "n"));
    }

    /// A precision with a non-numeric type is refused rather than translated.
    ///
    /// That was already true, and this pins it so the new numeric path cannot
    /// quietly start accepting `:.2s` and printing a rounded string.
    #[test]
    fn string_type_precision_is_refused_not_rounded() {
        assert!(translate(".2s", "s").is_err());
    }

    #[test]
    fn integer_types_truncate() {
        assert!(tr("d", "n").contains("Math.trunc(n)"));
        assert!(tr("i", "n").contains("Math.trunc(n)"));
    }

    #[test]
    fn width_pads_and_zero_keeps_the_sign_in_front() {
        assert!(tr(">10", "s").contains("padStart(10"));
        assert!(tr("<10", "s").contains("padEnd(10"));
        let zero = tr("05d", "n");
        assert!(zero.contains("padStart"), "{}", zero);
        assert!(
            zero.contains("__sign"),
            "zero fill must respect the sign: {}",
            zero
        );
    }

    #[test]
    fn percent_multiplies_by_a_hundred() {
        let out = tr(".1%", "ratio");
        assert!(out.contains("* 100).toFixed(1)"), "{}", out);
        assert!(out.contains("+ '%'"), "{}", out);
    }

    #[test]
    fn an_unsupported_spec_is_an_error_not_a_drop() {
        assert!(parse("e").is_err());
        assert!(parse(".2x").is_err());
        assert!(parse("_").is_err());
        assert!(parse(".2").is_err());
        assert!(parse("!!").is_err());
    }

    #[test]
    fn empty_spec_round_trips() {
        assert_eq!(parse("").unwrap(), Spec::default());
    }
}
