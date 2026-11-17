#!/usr/bin/env python3
"""Exercise the Terraform configuration against a local Agent37 API double.

Run `terraform init -backend=false` in ops/agent37 first, then set TERRAFORM
if the terraform executable is not on PATH. No real Agent37 account is used.
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "agent37-test-token-only"


class Agent37Handler(BaseHTTPRequestHandler):
    instances = {}
    requests = []
    next_id = 4
    fail_after_create = False

    def log_message(self, *_args):
        pass

    def respond(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size) or b"{}")
        self.requests.append((self.command, self.path, body))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self.respond(401, {"error": "invalid key"})
        if self.command == "POST" and self.path == "/v1/instances":
            instance_id = f"abc123def{Agent37Handler.next_id}"
            Agent37Handler.next_id += 1
            obj = {**body, "id": instance_id, "status": "running",
                   "url": f"https://{instance_id}.agent37.app",
                   "status_reason": None, "template_revision": None,
                   "image_ref": "ghcr.io/example/image:tag", "image_digest": "sha256:test",
                   "mount_path": body.get("mount_path", "/root"), "domain_urls": [],
                   "public_ports": [], "past_due": False, "created": 1}
            self.instances[instance_id] = obj
            if Agent37Handler.fail_after_create:
                Agent37Handler.fail_after_create = False
                return self.respond(503, {"error": "response lost after create"})
            return self.respond(201, obj)
        instance_id = self.path.removeprefix("/v1/instances/")
        if instance_id not in self.instances:
            return self.respond(404, {"error": "not_found"})
        if self.command == "GET":
            return self.respond(200, self.instances[instance_id])
        if self.command == "PATCH":
            permitted = {"name", "metadata", "auto_sleep", "idle_timeout_seconds", "network"}
            if not body or not set(body) <= permitted:
                return self.respond(400, {"error": "invalid_request"})
            self.instances[instance_id].update(body)
            return self.respond(200, self.instances[instance_id])
        if self.command == "DELETE":
            return self.respond(403, {"error": "unexpected deletion"})
        return self.respond(405, {"error": "method_not_allowed"})

    do_GET = dispatch
    do_POST = dispatch
    do_PATCH = dispatch
    do_DELETE = dispatch


class LoggingSafetyTest(unittest.TestCase):
    def test_wrapper_disables_logging_before_starting_terraform(self):
        with tempfile.TemporaryDirectory(prefix="agent37-logging-test-") as tmp:
            fake = Path(tmp) / "terraform"
            fake.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                            "print(json.dumps({'log': os.getenv('TF_LOG'), "
                            "'provider': os.getenv('TF_LOG_PROVIDER'), "
                            "'path': os.getenv('TF_LOG_PATH'), "
                            "'debug': os.getenv('REST_API_DEBUG'), 'args': sys.argv[1:]}))\n")
            fake.chmod(0o755)
            env = os.environ.copy()
            env.update({"AGENT37_TERRAFORM_BIN": str(fake), "TF_LOG": "TRACE",
                        "TF_LOG_PROVIDER": "TRACE", "TF_LOG_PATH": str(Path(tmp) / "terraform.log"),
                        "REST_API_DEBUG": "true"})
            result = subprocess.run(["bash", str(ROOT / "terraform.sh"), "plan", "-input=false"],
                                    env=env, text=True, capture_output=True, check=True, timeout=10)
            self.assertEqual(json.loads(result.stdout), {"log": "OFF", "provider": None,
                             "path": None, "debug": None, "args": ["plan", "-input=false"]})


class TerraformLifecycleTest(unittest.TestCase):
    def test_allocation_refresh_updates_and_protected_replacement(self):
        self.assertTrue((ROOT / ".terraform/providers").is_dir(), "Run terraform init in ops/agent37 first")
        Agent37Handler.instances = {}
        Agent37Handler.requests = []
        Agent37Handler.next_id = 4
        Agent37Handler.fail_after_create = False
        server = ThreadingHTTPServer(("127.0.0.1", 0), Agent37Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        with tempfile.TemporaryDirectory(prefix="agent37-terraform-test-") as tmp:
            directory = Path(tmp)
            for path in ROOT.glob("*.tf"):
                shutil.copy(path, directory / path.name)
            shutil.copy(ROOT / ".terraform.lock.hcl", directory)
            shutil.copytree(ROOT / ".terraform", directory / ".terraform")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("REST_API_", "TF_VAR_", "TF_CLI_ARGS", "TF_LOG"))
                   and key not in {"TF_DATA_DIR", "TF_WORKSPACE"}}
            env.update({"REST_API_BEARER": TOKEN, "TF_INPUT": "0", "TF_IN_AUTOMATION": "1",
                        "TF_VAR_api_base_url": f"http://127.0.0.1:{server.server_port}"})
            terraform = os.environ.get("TERRAFORM", "terraform")
            values = {"instances": {"host": {"name": "test-host", "template": "agent37-ubuntu",
                      "type": "vm", "region": "eu", "resources": {"cpu": 2, "memory": 4, "disk": 20}}}}
            varfile = directory / "test.tfvars.json"

            def command(*args, expected=0):
                result = subprocess.run([terraform, f"-chdir={directory}", *args, "-no-color"],
                                        env=env, text=True, capture_output=True, timeout=90)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result.stdout + result.stderr

            def write_values():
                varfile.write_text(json.dumps(values))

            write_values()
            command("init", "-backend=false", "-input=false", "-lockfile=readonly")
            command("apply", "-auto-approve", f"-var-file={varfile}")
            created = next(body for method, _, body in Agent37Handler.requests if method == "POST")
            self.assertEqual(created["resources"], {"cpu": 2, "memory": 4, "disk": 20})
            self.assertEqual((created["type"], created["region"]), ("vm", "eu"))
            self.assertNotIn("env", created)
            self.assertNotIn("public_ports", created)
            self.assertNotIn(TOKEN, (directory / "terraform.tfstate").read_text())
            command("plan", "-detailed-exitcode", f"-var-file={varfile}")

            values["instances"]["host"]["auto_sleep"] = True
            write_values()
            command("apply", "-auto-approve", f"-var-file={varfile}")
            patch = [body for method, _, body in Agent37Handler.requests if method == "PATCH"][-1]
            self.assertTrue(patch["auto_sleep"])
            self.assertFalse({"type", "region", "template", "resources"} & set(patch))
            command("plan", "-detailed-exitcode", f"-var-file={varfile}")

            Agent37Handler.instances["abc123def4"]["auto_sleep"] = False
            command("plan", "-detailed-exitcode", f"-var-file={varfile}", expected=2)
            command("apply", "-auto-approve", f"-var-file={varfile}")
            self.assertTrue(Agent37Handler.instances["abc123def4"]["auto_sleep"])

            values["instances"]["worker"] = {"name": "test-worker", "template": "agent37-base",
                                               "resources": {"cpu": 2, "memory": 4, "disk": 4}}
            write_values()
            command("apply", "-auto-approve", f"-var-file={varfile}")
            self.assertEqual(set(Agent37Handler.instances), {"abc123def4", "abc123def5"})
            command("plan", "-detailed-exitcode", f"-var-file={varfile}")

            Agent37Handler.instances["abc123def4"]["resources"]["disk"] = 24
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("prevent_destroy", output)
            Agent37Handler.instances["abc123def4"]["resources"]["disk"] = 20

            saved = copy.deepcopy(values)
            values["instances"]["host"]["resources"]["disk"] = 24
            write_values()
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("prevent_destroy", output)

            values = {"instances": {}}
            write_values()
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("prevent_destroy", output)
            self.assertFalse(any(method == "DELETE" for method, _, _ in Agent37Handler.requests))

            values = copy.deepcopy(saved)
            values["instances"]["host"].update({"type": "default", "region": "eu"})
            write_values()
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("default is US-only", output)

            values = copy.deepcopy(saved)
            values["instances"]["host"].update({"template": "agent37-base", "type": "default",
                                                  "region": "us", "resources": {"cpu": 16, "memory": 4, "disk": 4}})
            write_values()
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("documented CPU/memory shape", output)

            values = copy.deepcopy(saved)
            values["instances"]["host"]["idle_timeout_seconds"] = 299
            write_values()
            output = command("plan", f"-var-file={varfile}", expected=1)
            self.assertIn("idle timeout of 300", output)

            values = saved
            write_values()
            Agent37Handler.instances.pop("abc123def4")
            output = command("plan", "-detailed-exitcode", f"-var-file={varfile}", expected=1)
            self.assertIn("Error Parsing Plan Data", output)
            result = subprocess.run([terraform, f"-chdir={directory}", "state", "rm", "-no-color",
                                     'restapi_object.instance["host"]'], env=env, text=True,
                                    capture_output=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            command("plan", "-detailed-exitcode", f"-var-file={varfile}", expected=2)
            command("apply", "-auto-approve", f"-var-file={varfile}")

            # Agent37 has no documented idempotency key. If the response is lost
            # after creation, the operator must inspect the workspace before retrying.
            values["instances"]["ambiguous"] = {"name": "orphan", "template": "agent37-base",
                                                  "resources": {"cpu": 2, "memory": 4, "disk": 4}}
            write_values()
            create_count = sum(method == "POST" for method, _, _ in Agent37Handler.requests)
            Agent37Handler.fail_after_create = True
            command("apply", "-auto-approve", f"-var-file={varfile}", expected=1)
            self.assertEqual(sum(method == "POST" for method, _, _ in Agent37Handler.requests), create_count + 1)
            self.assertTrue(any(instance["name"] == "orphan" for instance in Agent37Handler.instances.values()))
            self.assertNotIn('restapi_object.instance["ambiguous"]', command("state", "list"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
