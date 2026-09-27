// [xihanzu-NR]
//! Direct Node-API (N-API) bindings for in-memory Node.js integration.
//!
//! Enables zero-IPC, zero-subprocess compilation from Vite and Node.js tools.

use crate::compile;

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

    fn napi_create_object(
        env: NapiEnv,
        result: *mut NapiValue,
    ) -> NapiStatus;

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

unsafe fn get_string(env: NapiEnv, val: NapiValue) -> String {
    let mut len = 0;
    napi_get_value_string_utf8(env, val, std::ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len + 1];
    let mut copied = 0;
    napi_get_value_string_utf8(env, val, buf.as_mut_ptr(), len + 1, &mut copied);
    String::from_utf8_lossy(&buf[..copied]).to_string()
}

unsafe fn make_string(env: NapiEnv, s: &str) -> NapiValue {
    let mut val: NapiValue = std::ptr::null_mut();
    napi_create_string_utf8(env, s.as_ptr(), s.len(), &mut val);
    val
}

/// Node export: `compile(source: string, filename: string): { code?: string, map?: string, error?: string }`
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

    let source = get_string(env, argv[0]);
    let filename = get_string(env, argv[1]);

    match compile(&source, &filename) {
        Ok((code, map)) => {
            let code_val = make_string(env, &code);
            let map_val = make_string(env, &map);
            napi_set_named_property(env, res_obj, b"code\0".as_ptr() as *const _, code_val);
            napi_set_named_property(env, res_obj, b"map\0".as_ptr() as *const _, map_val);
        }
        Err(err) => {
            let err_val = make_string(env, &err.pretty());
            napi_set_named_property(env, res_obj, b"error\0".as_ptr() as *const _, err_val);
        }
    }

    res_obj
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
