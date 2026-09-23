"""JSON-lines bridge between mcp-compression-proxy and a local Needle 3 model.

The proxy starts this script only when servers.json has a "model" section.
It reads one JSON request per line on stdin and writes one JSON response per
line on stdout:

    {"id": 1, "method": "embed", "params": {"texts": ["..."]}}
    {"id": 1, "result": {"dim": 3072, "vectors": ["<base64 float32>", ...]}}

The first line written is {"ready": true, ...} once the model is loaded, or
{"fatal": "..."} before exiting when it cannot be. Nothing else may reach
stdout, so library output is redirected to stderr.

Requires `pip install cactus-needle`. Needle's usage telemetry is switched off
before it is imported: the proxy promises nothing leaves the machine.
"""

import base64
import hashlib
import json
import os
import struct
import sys

os.environ["NEEDLE_TELEMETRY"] = "0"
os.environ["DO_NOT_TRACK"] = "1"

PROTOCOL = sys.stdout
sys.stdout = sys.stderr


def send(message):
    PROTOCOL.write(json.dumps(message) + "\n")
    PROTOCOL.flush()


try:
    import needle
except Exception as exc:  # ImportError, or a broken native engine
    send({"fatal": f"cannot import needle ({exc}); install it with: pip install cactus-needle"})
    sys.exit(1)


def encode_vector(values):
    return base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode("ascii")


class Models:
    """One Needle agent per tool set; the engine keeps one set bound at a time."""

    def __init__(self):
        self._embedder = None
        self._agents = {}

    def embedder(self):
        if self._embedder is None:
            self._embedder = needle.Needle(tools=[])
        return self._embedder

    def agent(self, tools):
        key = hashlib.sha256(json.dumps(tools, sort_keys=True).encode("utf-8")).hexdigest()
        agent = self._agents.get(key)
        if agent is None:
            if len(self._agents) >= 8:
                self._agents.pop(next(iter(self._agents))).close()
            agent = needle.Needle(tools=tools, auto_date=False)
            self._agents[key] = agent
        return agent


def summarize(response):
    return {
        "calls": response.get("function_calls") or [],
        "suppressed": response.get("suppressed_calls") or [],
        "confidence": response.get("confidence"),
        "reasoning": response.get("reasoning"),
        "ungrounded": (response.get("validation") or {}).get("ungrounded") or [],
    }


def handle(models, method, params):
    if method == "ping":
        return {"model": "needle3", "version": getattr(needle, "__version__", None)}

    if method == "embed":
        embedder = models.embedder()
        vectors = [embedder.embed(text or " ") for text in params.get("texts", [])]
        dim = len(vectors[0]) if vectors else 0
        return {"dim": dim, "vectors": [encode_vector(vector) for vector in vectors]}

    if method == "select":
        agent = models.agent(params["tools"])
        agent.reset()
        return summarize(agent.complete(params["query"]))

    if method == "extract":
        agent = models.agent([params["schema"]])
        agent.reset()
        result = summarize(agent.complete(params["text"]))
        record = (result["calls"] or result["suppressed"] or [None])[0]
        result["value"] = record.get("arguments") if record else None
        result["withheld"] = not result["calls"] and bool(result["suppressed"])
        return result

    raise ValueError(f"unknown method: {method}")


def main():
    models = Models()
    try:
        models.embedder()
    except Exception as exc:
        send({"fatal": f"cannot load the Needle model ({exc})"})
        sys.exit(1)
    send({"ready": True, "model": "needle3"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = handle(models, request.get("method"), request.get("params") or {})
            send({"id": request_id, "result": result})
        except Exception as exc:
            send({"id": request_id, "error": {"message": f"{type(exc).__name__}: {exc}"}})


if __name__ == "__main__":
    main()
