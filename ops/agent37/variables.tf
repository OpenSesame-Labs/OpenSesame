variable "api_base_url" {
  description = "Agent37 API origin. Loopback HTTP requires the explicit local-test opt-in."
  type        = string
  default     = "https://api.agent37.com"

  validation {
    condition = can(regex("^https://api[.]agent37[.]com/?$", var.api_base_url)) || (
      var.allow_http_loopback && can(regex("^http://127[.]0[.]0[.]1:[0-9]+/?$", var.api_base_url))
    )
    error_message = "Use the Agent37 HTTPS API origin; a loopback HTTP test server requires allow_http_loopback = true."
  }
}

variable "allow_http_loopback" {
  description = "Allow an unencrypted loopback API endpoint for local tests with a test-only key."
  type        = bool
  default     = false
}

variable "instances" {
  description = "Agent37 instances to allocate, keyed by a stable deployment name."
  type = map(object({
    name                 = string
    template             = string
    type                 = optional(string, "default")
    region               = optional(string, "us")
    resources            = object({ cpu = number, memory = number, disk = number })
    mount_path           = optional(string)
    auto_sleep           = optional(bool, false)
    idle_timeout_seconds = optional(number, 900)
    network              = optional(string, "allow-all")
    metadata             = optional(map(string), {})
  }))
  default = {}

  validation {
    condition     = alltrue([for instance in values(var.instances) : length(trimspace(instance.name)) > 0 && length(instance.name) <= 60 && length(trimspace(instance.template)) > 0])
    error_message = "Every instance needs a nonempty name (at most 60 characters) and template."
  }

  validation {
    condition = alltrue([for instance in values(var.instances) :
      contains(["default", "vm", "performance"], instance.type) &&
      contains(["us", "eu", "ap-south"], instance.region) &&
      (instance.region == "us" || instance.type != "default") &&
      (!startswith(instance.template, "agent37-ubuntu") || instance.type == "vm") &&
      (!startswith(instance.template, "agent37-android") || instance.type == "vm")
    ])
    error_message = "Use a supported type and region; default is US-only, and the Ubuntu and Android system templates require type vm."
  }

  validation {
    condition = alltrue([for instance in values(var.instances) :
      (contains(["2/4", "4/8", "4/16", "4/32"], "${instance.resources.cpu}/${instance.resources.memory}") ||
      (instance.type != "default" && "${instance.resources.cpu}/${instance.resources.memory}" == "8/64")) &&
      instance.resources.disk == floor(instance.resources.disk) && instance.resources.disk >= 2 &&
      instance.resources.disk <= (instance.type == "default" ? lookup({ "4" = 12, "8" = 20, "16" = 40, "32" = 80 }, tostring(instance.resources.memory), 0) : 100)
    ])
    error_message = "Choose a documented CPU/memory shape and a whole-number disk size within its limits."
  }

  validation {
    condition = alltrue([for instance in values(var.instances) :
      instance.idle_timeout_seconds == floor(instance.idle_timeout_seconds) &&
      instance.idle_timeout_seconds >= 300 && instance.idle_timeout_seconds <= 86400 &&
      contains(["allow-all", "deny-all"], instance.network) &&
      (instance.mount_path == null ? true : startswith(instance.mount_path, "/") && instance.mount_path != "/")
    ])
    error_message = "Use an idle timeout of 300–86400 seconds, allow-all or deny-all networking, and an absolute non-root mount path."
  }
}