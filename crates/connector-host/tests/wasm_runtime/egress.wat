;; A real component that always calls the host HTTP import, then returns an
;; empty successful connector result. Its egress implementation is an in-memory
;; recorder: the URL exercises destination admission without opening a socket.
(component
  (import "opensesame:connector/types@1.0.0" (instance $types
    (export "connection-handle" (type (sub resource)))
  ))
  (alias export $types "connection-handle" (type $conn))

  (type $http-type (instance
    (alias outer 1 $conn (type $outer-conn))
    (export "connection-handle" (type (eq $outer-conn)))
    (type $pair (tuple string string))
    (type $headers (list $pair))
    (type $bytes (list u8))
    (type $request (record
      (field "method" string) (field "url" string)
      (field "headers" $headers) (field "body" $bytes)))
    (export "request" (type (eq $request)))
    (type $response (record
      (field "status" u16) (field "headers" $headers) (field "body" $bytes)))
    (export "response" (type (eq $response)))
    (type $borrow-conn (borrow 1))
    (type $http-result (result 8 (error string)))
    (type $authorized (func
      (param "connection" $borrow-conn)
      (param "req" 6)
      (result $http-result)))
    (export "authorized-request" (func (type $authorized)))
  ))
  (import "opensesame:connector/host-http@1.0.0" (instance $http (type $http-type)))
  (alias export $http "authorized-request" (func $authorized-request))

  ;; Memory exists before the core guest so the host import can be lowered
  ;; against it without a cyclic instance dependency.
  (core module $storage
    (memory (export "memory") 2)
    (global $heap (mut i32) (i32.const 4096))
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (local $start i32)
      (local.set $start
        (i32.and
          (i32.add (global.get $heap) (i32.sub (local.get 2) (i32.const 1)))
          (i32.sub (i32.const 0) (local.get 2))))
      (global.set $heap (i32.add (local.get $start) (local.get 3)))
      (local.get $start))
    (data (i32.const 16) "echo1.0.0")
    ;; connector-info: id pointer/length, version pointer/length, empty list.
    (data (i32.const 64) "\10\00\00\00\04\00\00\00\14\00\00\00\05\00\00\00\00\00\00\00\00\00\00\00")
    (data (i32.const 512) "GET")
    (data (i32.const 520) "https://api.github.com/repos")
  )
  (core instance $storage-instance (instantiate $storage))
  (alias core export $storage-instance "memory" (core memory $memory))
  (alias core export $storage-instance "cabi_realloc" (core func $realloc))
  (core func $authorized-lowered
    (canon lower (func $authorized-request) (memory $memory) (realloc $realloc) string-encoding=utf8))
  (canon resource.drop $conn (core func $drop))

  (core module $guest
    (import "host" "memory" (memory 2))
    (import "host" "drop-connection" (func $drop-conn (param i32)))
    ;; connection, method, URL, headers, body, result pointer.
    (import "host" "authorized-request"
      (func $http (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)))
    (func (export "describe") (result i32) (i32.const 64))
    (func (export "invoke")
      (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i64 i32 i32)
      (result i32)
      (call $http
        (local.get 0)
        (i32.const 512) (i32.const 3)
        (i32.const 520) (i32.const 28)
        (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)
        (i32.const 256))
      (call $drop-conn (local.get 0))
      ;; Offset 128 is zero-initialized: result<list<u8>, error>::ok([]).
      (i32.const 128))
  )
  (core instance $guest-instance (instantiate $guest
    (with "host" (instance
      (export "memory" (memory $memory))
      (export "drop-connection" (func $drop))
      (export "authorized-request" (func $authorized-lowered))))))

  (type $info-t (record
    (field "id" string) (field "version" string) (field "operations" (list string))))
  (export $info "connector-info" (type $info-t))
  (type $intent-t (record
    (field "id" string) (field "operation" string) (field "resource" string)
    (field "audience" string) (field "parameters" (list u8))
    (field "parameters-digest" string) (field "expires-at-unix-ms" u64)
    (field "idempotency-key" string)))
  (export $intent "intent" (type $intent-t))
  (type $error-t (variant
    (case "invalid-input" string) (case "unauthorized" string)
    (case "approval-required" string) (case "rate-limited" (option u64))
    (case "provider-error" (tuple u16 string)) (case "transient" string)
    (case "permanent" string)))
  (export $invoke-error "invoke-error" (type $error-t))
  (func (export "describe") (result $info)
    (canon lift (core func $guest-instance "describe") (memory $memory) (realloc $realloc) string-encoding=utf8))
  (func (export "invoke")
    (param "connection" (borrow $conn)) (param "intent" $intent)
    (result (result (list u8) (error $invoke-error)))
    (canon lift (core func $guest-instance "invoke") (memory $memory) (realloc $realloc) string-encoding=utf8))
)
