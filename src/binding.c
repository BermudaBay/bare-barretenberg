#include <assert.h>
#include <bare.h>
#include <js.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>

// barretenberg (libbb-external): one msgpack request in, one msgpack response out, the same
// API bb.js drives in WASM. It parallelises proving on its own native threads.
void
bbapi(const uint8_t *in, size_t in_len, uint8_t **out, size_t *out_len);

void
bbfree(void *ptr);

// Noir witness generation (src/witness.rs).
int32_t
bare_barretenberg_execute(const uint8_t *bytecode, size_t bytecode_len, const uint8_t *abi_json, size_t abi_len, const uint8_t *inputs_json, size_t inputs_len, uint8_t **out, size_t *out_len);

void
bare_barretenberg_free(uint8_t *ptr, size_t len);

typedef struct {
  uv_work_t req;
  js_env_t *env;
  js_ref_t *callback;
  bool execute;
  uint8_t *in[3];
  size_t in_len[3];
  uint8_t *out;
  size_t out_len;
  int32_t status;
} bare_barretenberg_job_t;

static void
bare_barretenberg__work(uv_work_t *req) {
  bare_barretenberg_job_t *job = (bare_barretenberg_job_t *) req;

  if (job->execute) {
    job->status = bare_barretenberg_execute(job->in[0], job->in_len[0], job->in[1], job->in_len[1], job->in[2], job->in_len[2], &job->out, &job->out_len);
  } else {
    bbapi(job->in[0], job->in_len[0], &job->out, &job->out_len);
  }
}

static void
bare_barretenberg__after_work(uv_work_t *req, int status) {
  int err;

  bare_barretenberg_job_t *job = (bare_barretenberg_job_t *) req;
  js_env_t *env = job->env;

  js_handle_scope_t *scope;
  err = js_open_handle_scope(env, &scope);
  assert(err == 0);

  // The callback is called with (error, result), as Bare's own addons report async work.
  js_value_t *args[2];

  if (job->status == 0) {
    err = js_get_null(env, &args[0]);
    assert(err == 0);

    void *data;
    err = js_create_arraybuffer(env, job->out_len, &data, &args[1]);
    assert(err == 0);

    memcpy(data, job->out, job->out_len);
  } else {
    js_value_t *message;
    err = js_create_string_utf8(env, (const utf8_t *) job->out, job->out_len, &message);
    assert(err == 0);

    err = js_create_error(env, NULL, message, &args[0]);
    assert(err == 0);

    err = js_get_undefined(env, &args[1]);
    assert(err == 0);
  }

  if (job->execute) bare_barretenberg_free(job->out, job->out_len);
  else bbfree(job->out);

  js_value_t *callback;
  err = js_get_reference_value(env, job->callback, &callback);
  assert(err == 0);

  js_value_t *receiver;
  err = js_get_undefined(env, &receiver);
  assert(err == 0);

  err = js_call_function(env, receiver, callback, 2, args, NULL);
  (void) err;

  err = js_delete_reference(env, job->callback);
  assert(err == 0);

  err = js_close_handle_scope(env, scope);
  assert(err == 0);

  for (int i = 0; i < 3; i++) free(job->in[i]);
  free(job);
}

// Runs `bbapi(request, callback)` or `execute(bytecode, abiJson, inputsJson, callback)` on the libuv
// thread pool. Each input is a Uint8Array, copied so that JavaScript can drop it meanwhile.
static js_value_t *
bare_barretenberg__queue(js_env_t *env, js_callback_info_t *info, bool execute) {
  int err;

  size_t inputs = execute ? 3 : 1;
  size_t argc = inputs + 1;
  js_value_t *argv[4];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_barretenberg_job_t *job = calloc(1, sizeof(bare_barretenberg_job_t));
  assert(job != NULL);

  job->env = env;
  job->execute = execute;

  for (size_t i = 0; i < inputs; i++) {
    void *data;
    err = js_get_typedarray_info(env, argv[i], NULL, &data, &job->in_len[i], NULL, NULL);
    assert(err == 0);

    job->in[i] = malloc(job->in_len[i] > 0 ? job->in_len[i] : 1);
    assert(job->in[i] != NULL);

    memcpy(job->in[i], data, job->in_len[i]);
  }

  err = js_create_reference(env, argv[inputs], 1, &job->callback);
  assert(err == 0);

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  err = uv_queue_work(loop, &job->req, bare_barretenberg__work, bare_barretenberg__after_work);
  assert(err == 0);

  return NULL;
}

static js_value_t *
bare_barretenberg_bbapi(js_env_t *env, js_callback_info_t *info) {
  return bare_barretenberg__queue(env, info, false);
}

static js_value_t *
bare_barretenberg_execute_witness(js_env_t *env, js_callback_info_t *info) {
  return bare_barretenberg__queue(env, info, true);
}

static js_value_t *
bare_barretenberg_exports(js_env_t *env, js_value_t *exports) {
  int err;

#define V(name, fn) \
  { \
    js_value_t *val; \
    err = js_create_function(env, name, -1, fn, NULL, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

  V("bbapi", bare_barretenberg_bbapi)
  V("execute", bare_barretenberg_execute_witness)
#undef V

  return exports;
}

BARE_MODULE(bare_barretenberg, bare_barretenberg_exports)
