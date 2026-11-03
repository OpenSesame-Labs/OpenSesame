# Live GitHub Pages deploy: release marker, core files, PWA shell assets.
GET {{pages_base}}
HTTP 200
[Asserts]
body matches /./

GET {{pages_base}}release.json?release={{github_sha}}
HTTP 200
[Asserts]
jsonpath "$.format" == "opensesame-pages-release"
jsonpath "$.version" == 1
jsonpath "$.revision" == "{{github_sha}}"
jsonpath "$.sha256['index.html']" == "{{sha256_index}}"
jsonpath "$.sha256['os-runtime-config.json']" == "{{sha256_os_runtime}}"

GET {{pages_base}}index.html?release={{github_sha}}
HTTP 200
[Captures]
live_index_sha: sha256
[Asserts]
variable "live_index_sha" toHex == "{{sha256_index}}"

GET {{pages_base}}os-runtime-config.json?release={{github_sha}}
HTTP 200
[Captures]
live_runtime_sha: sha256
[Asserts]
variable "live_runtime_sha" toHex == "{{sha256_os_runtime}}"

GET {{pages_base}}manifest.webmanifest?release={{github_sha}}
HTTP 200
[Captures]
live_manifest_sha: sha256
[Asserts]
variable "live_manifest_sha" toHex == "{{sha256_manifest}}"
jsonpath "$.name" exists
jsonpath "$.start_url" exists

GET {{pages_base}}sw.js?release={{github_sha}}
HTTP 200
[Captures]
live_sw_sha: sha256
[Asserts]
variable "live_sw_sha" toHex == "{{sha256_sw}}"
body contains "addEventListener"
