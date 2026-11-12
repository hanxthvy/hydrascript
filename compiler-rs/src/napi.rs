// [xihanzu-NR]
//! Direct Node-API (N-API) bindings for in-memory Node.js integration.
//!
//! Enables in-process compilation — no subprocess spawn, no IPC — for Node.js
//! tools (bundlers, editors, the runner).

use crate::compile_checked;

/// Node export: `compile(source, filename): { code?, map?, error?, warnings? }`
///
/// `warnings` is the rendered semantic findings, one per line, empty when there
/// are none. A single string rather than an array so the binding needs no new
/// Node-API calls; the caller splits it.

type NapiEnv = *mut std::ffi::c_void;
type NapiValue = *mut std::ffi::c_void;
type NapiCallbackInfo = *mut std::ffi::c_void;
type NapiStatus = i32;

type NapiCallback = Option<unsafe extern "C" fn(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue>;

extern "C" {
    fn napi_get_cb_info(
        env: NapiEnv,
        info: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut std::ffi::c_void,
    ) -> NapiStatus;

    fn napi_get_value_string_utf8(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut u8,
        bufsize: usize,
        result: *mut usize,
    ) -> NapiStatus;

    fn napi_create_string_utf8(
        env: NapiEnv,
        str_: *const u8,
        length: usize,
        result: *mut NapiValue,
    ) -> NapiStatus;

    fn napi_create_object(env: NapiEnv, result: *mut NapiValue) -> NapiStatus;

    fn napi_set_named_property(
        env: NapiEnv,
        object: NapiValue,
        utf8name: *const std::ffi::c_char,
        value: NapiValue,
    ) -> NapiStatus;

    fn napi_create_function(
        env: NapiEnv,
        utf8name: *const std::ffi::c_char,
        length: usize,
        cb: NapiCallback,
        data: *mut std::ffi::c_void,
        result: *mut NapiValue,
    ) -> NapiStatus;
}

/// `napi_ok`. Every Node-API call returns one of these, and ignoring it is how
/// `h.compile(123, 456)` used to return a successful compile of `""`.
const NAPI_OK: NapiStatus = 0;

/// Read an argument as a UTF-8 string.
///
/// The status is CHECKED. It used to be dropped, so a non-string argument left
/// `len` at 0 and the function compiled an empty file successfully — a caller got
/// `{code: ""}` with no error, which is the worst possible answer.
unsafe fn get_string(env: NapiEnv, val: NapiValue) -> Result<String, String> {
    let mut len = 0usize;
    let status = napi_get_value_string_utf8(env, val, std::ptr::null_mut(), 0, &mut len);
    if status != NAPI_OK {
        return Err("argument is not a string".to_string());
    }
    let mut buf = vec![0u8; len + 1];
    let mut copied = 0usize;
    let status = napi_get_value_string_utf8(env, val, buf.as_mut_ptr(), len + 1, &mut copied);
    if status != NAPI_OK {
        return Err("argument is not a valid UTF-8 string".to_string());
    }
    Ok(String::from_utf8_lossy(&buf[..copied]).to_string())
}

unsafe fn make_string(env: NapiEnv, s: &str) -> NapiValue {
    let mut val: NapiValue = std::ptr::null_mut();
    napi_create_string_utf8(env, s.as_ptr(), s.len(), &mut val);
    val
}

/// Node export: `compile(source: string, filename: string): { code?: string, map?: string, error?: string }`
/// Node export: `compile(source: string, filename: string): { code?: string, map?: string, error?: string, warnings?: string }`
pub unsafe extern "C" fn node_compile(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 2;
    let mut argv: [NapiValue; 2] = [std::ptr::null_mut(), std::ptr::null_mut()];
    napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );

    let mut res_obj: NapiValue = std::ptr::null_mut();
    napi_create_object(env, &mut res_obj);

    if argc < 2 {
        let err_str = make_string(env, "compile expects (source, filename)");
        napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_str);
        return res_obj;
    }

    let source = match get_string(env, argv[0]) {
        Ok(v) => v,
        Err(msg) => {
            let err_val = make_string(env, &msg);
            napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_val);
            return res_obj;
        }
    };
    let filename = match get_string(env, argv[1]) {
        Ok(v) => v,
        Err(msg) => {
            let err_val = make_string(env, &msg);
            napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_val);
            return res_obj;
        }
    };

    // A panic inside the compiler must not take the HOST down with it.
    //
    // The addon is a cdylib linked into Node, so an unwinding panic crosses the
    // C ABI — undefined behaviour at best, and with `panic = "abort"` (the shipped
    // release profile) it is an immediate abort: the editor, the Vite dev server or
    // the bundler that merely compiled an untrusted file dies, with no message a
    // person can act on. The `addon` profile switches to `unwind` and this catches
    // it. A stack overflow is still not catchable, which is why the parser has a
    // node budget of its own.
    let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        compile_checked(&source, &filename)
    }));
    let compiled = match compiled {
        Ok(v) => v,
        Err(payload) => {
            let detail = panic_message(&payload);
            let msg = format!("hydra compiler panicked: {detail}. This is a bug in hydra, not in your file.");
            let err_val = make_string(env, &msg);
            napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_val);
            return res_obj;
        }
    };

    match compiled {
        Ok((code, map, warnings)) => {
            let code_val = make_string(env, &code);
            let map_val = make_string(env, &map);
            napi_set_named_property(env, res_obj, b"code\0".as_ptr() as *const _, code_val);
            napi_set_named_property(env, res_obj, b"map\0".as_ptr() as *const _, map_val);
            let rendered = warnings
                .iter()
                .map(|w| w.render(&filename))
                .collect::<Vec<_>>()
                .join("\n");
            let warn_val = make_string(env, &rendered);
            napi_set_named_property(
                env,
                res_obj,
                b"warnings\0".as_ptr() as *const _,
                warn_val,
            );
        }
        Err(err) => {
            let err_val = make_string(env, &err.pretty());
            napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_val);
        }
    }

    res_obj
}

/// The payload of a caught panic, as a string. `panic!("x")` payloads are
/// `&str`/`String`; anything else is reported by type rather than dropped.
fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic payload".to_string()
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let mut fn_val: NapiValue = std::ptr::null_mut();
    napi_create_function(
        env,
        b"compile\0".as_ptr() as *const _,
        usize::MAX,
        Some(node_compile),
        std::ptr::null_mut(),
        &mut fn_val,
    );
    napi_set_named_property(env, exports, b"compile\0".as_ptr() as *const _, fn_val);
    exports
}
