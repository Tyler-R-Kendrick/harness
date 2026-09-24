"""Prove a steerable export against its source on a short prompt.

1. With zero steering, logits equal the source model's (the surgery changed nothing else).
2. Adding a steering vector moves resid.L by exactly that vector at every position.
3. Steering changes the logits (the vector reaches downstream layers).
"""
import argparse
import json

import numpy as np
import onnxruntime as ort


def feeds(session: ort.InferenceSession, ids: list[int], config: dict) -> dict:
    d = config["model"]["decoder"]
    kv, head = d["num_key_value_heads"], d["head_size"]
    f = {"input_ids": np.array([ids], dtype=np.int64), "attention_mask": np.ones((1, len(ids)), dtype=np.int64)}
    for i in session.get_inputs():
        if i.name.startswith("past_key_values."):
            f[i.name] = np.zeros((1, kv, 0, head), dtype=np.float32 if i.type == "tensor(float)" else np.float16)
        elif i.name == "position_ids":
            f[i.name] = np.arange(len(ids), dtype=np.int64)[None, :]
    return f


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source")
    p.add_argument("steerable")
    p.add_argument("--layer", type=int, required=True)
    p.add_argument("--config", default=None, help="genai_config.json (defaults next to the source)")
    a = p.parse_args()
    config = json.load(open(a.config or a.source.rsplit("/", 1)[0] + "/genai_config.json"))
    hidden = config["model"]["decoder"]["hidden_size"]
    ids = [151644, 872, 198, 9707, 11, 1246, 525, 498, 30, 151645, 198]  # "<|im_start|>user\nHello, how are you?<|im_end|>\n"

    src = ort.InferenceSession(a.source, providers=["CPUExecutionProvider"])
    dst = ort.InferenceSession(a.steerable, providers=["CPUExecutionProvider"])
    base = src.run(["logits"], feeds(src, ids, config))[0]

    steer_name, resid_name = f"steer.{a.layer}", f"resid.{a.layer}"
    zero = feeds(dst, ids, config) | {steer_name: np.zeros(hidden, dtype=np.float32)}
    logits0, resid0 = dst.run(["logits", resid_name], zero)
    print("zero-steer max |Δlogits|:", float(np.abs(logits0 - base).max()))
    assert np.allclose(logits0, base, atol=1e-4), "zero steering changed the logits"

    rng = np.random.default_rng(0)
    v = rng.standard_normal(hidden).astype(np.float32) * 4
    logits1, resid1 = dst.run(["logits", resid_name], zero | {steer_name: v})
    shift = resid1 - resid0
    print("resid shift − steer, max abs:", float(np.abs(shift - v[None, None, :]).max()))
    assert np.allclose(shift, v[None, None, :], atol=1e-3), "the residual did not move by the steering vector"
    print("steered max |Δlogits|:", float(np.abs(logits1 - logits0).max()))
    assert np.abs(logits1 - logits0).max() > 1e-2, "steering did not reach the logits"
    print("ok: resid", resid0.shape, "logits", logits0.shape)


if __name__ == "__main__":
    main()
