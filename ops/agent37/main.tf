# Agent37 does not PATCH these fields with the other instance settings. A
# change must be an explicit migration; prevent_destroy below blocks the
# resulting replacement until the operator has secured the instance's data.
resource "terraform_data" "instance_identity" {
  for_each = var.instances

  triggers_replace = {
    template   = each.value.template
    type       = each.value.type
    region     = each.value.region
    resources  = each.value.resources
    mount_path = each.value.mount_path
  }
}

resource "restapi_object" "instance" {
  for_each = var.instances

  path          = "/v1/instances"
  update_method = "PATCH"
  data = jsonencode(merge({
    name                 = each.value.name
    template             = each.value.template
    type                 = each.value.type
    region               = each.value.region
    resources            = each.value.resources
    auto_sleep           = each.value.auto_sleep
    idle_timeout_seconds = each.value.idle_timeout_seconds
    network              = each.value.network
    metadata             = merge(each.value.metadata, { managed_by = "terraform", project = "opensesame" })
  }, each.value.mount_path == null ? {} : { mount_path = each.value.mount_path }))

  # PATCH accepts only mutable fields; creation-only fields would be rejected.
  update_data = jsonencode({
    name                 = each.value.name
    auto_sleep           = each.value.auto_sleep
    idle_timeout_seconds = each.value.idle_timeout_seconds
    network              = each.value.network
    metadata             = merge(each.value.metadata, { managed_by = "terraform", project = "opensesame" })
  })

  # A manual resize or template change must not be silently treated as a
  # successful PATCH; it needs the same protected migration as a config edit.
  force_new = ["template", "type", "region", "resources", "mount_path"]

  # Ignore response-only fields while retaining drift detection for fields we
  # manage. The provider's ignore_server_additions also suppresses drift.
  ignore_changes_to = concat([
    "id", "status", "status_reason", "template_revision", "image_ref",
    "image_digest", "url", "domain_urls", "public_ports", "past_due",
    "created", "slept_at"
  ], each.value.mount_path == null ? ["mount_path"] : [])

  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.instance_identity[each.key]]
  }
}
