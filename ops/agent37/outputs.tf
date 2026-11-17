output "instances" {
  description = "Instance IDs and authenticated Agent37 base URLs."
  value = {
    for key, instance in restapi_object.instance : key => {
      id     = instance.id
      url    = instance.api_data["url"]
      region = instance.api_data["region"]
    }
  }
}
