terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    restapi = {
      source  = "Mastercard/restapi"
      version = "= 3.0.0"
    }
  }
}

# REST_API_BEARER supplies the workspace API key; do not put it in tfvars.
provider "restapi" {
  uri                  = var.api_base_url
  insecure             = false
  write_returns_object = true
  timeout              = 600
  debug                = false
}
