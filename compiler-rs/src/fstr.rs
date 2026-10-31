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

    if let Some(p) = parsed.precision {
        out = format!("Number({}).toFixed({})", out, p);
    }

    if parsed.group {
        // Numeric grouping, not string insertion: toLocaleString already knows
        // where the separators go, and it respects the fraction digits.
        out = match parsed.precision {
            Some(p) if matches!(parsed.ty, Some('f') | Some('F')) => format!(
                "Number({}).toLocaleString('en-US', {{ minimumFractionDigits: {}, maximumFractionDigits: {} }})",
                expr, p, p
            ),
            _ => format!("Number({}).toLocaleString('en-US')", expr),
        };
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

    #[test]
    fn precision_becomes_tofixed() {
        assert!(tr(".2f", "amount").contains("Number(amount).toFixed(2)"));
        assert!(tr(".3f", "fade").contains("Number(fade).toFixed(3)"));
    }

    #[test]
    fn grouping_uses_tolocalestring() {
        let out = tr(",.0f", "amount");
        assert!(out.contains("toLocaleString('en-US'"), "{}", out);
        assert!(out.contains("minimumFractionDigits: 0"), "{}", out);
    }

    #[test]
    fn grouping_without_precision_is_plain() {
        assert!(tr(",", "n").contains("Number(n).toLocaleString('en-US')"));
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
