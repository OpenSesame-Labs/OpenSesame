# npm registry visibility for staged @opensesame-labs/web-pwa and live CLI alpha.
GET https://registry.npmjs.org/@opensesame-labs%2fweb-pwa/{{expected_version}}
HTTP 200
[Asserts]
jsonpath "$.version" == "{{expected_version}}"

GET https://registry.npmjs.org/-/package/@opensesame-labs%2fcli/dist-tags
HTTP 200
[Captures]
cli_alpha: jsonpath "$.alpha"
[Asserts]
jsonpath "$.alpha" matches /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/

GET https://registry.npmjs.org/@opensesame-labs%2fcli/{{cli_alpha}}
HTTP 200
[Asserts]
jsonpath "$.version" == "{{cli_alpha}}"
