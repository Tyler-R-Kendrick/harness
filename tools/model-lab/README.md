# model-lab

Offline tools that produce files the product loads. Nothing in `packages/` imports
this directory, and it is not part of CI.

| Tool | Makes |
|---|---|
| `steerable_onnx.py` | a steerable ONNX: the residual stream at one layer as an output (`resid.L`) and a steering vector added into it as an input (`steer.L`) |
| `check_steerable.py` | proves a steerable export against the original: zero steering gives the same logits, and the residual moves by exactly the steering vector |
| `sae_rows.py` | extracts the SAE rows a behavior graph uses (encoder row, bias, threshold, decoder row) into `sae-rows.json` for `compilePack` |

```sh
python3 -m venv .venv && .venv/bin/pip install onnx onnxruntime numpy
.venv/bin/python steerable_onnx.py model.onnx steerable.onnx --layer 14
.venv/bin/python check_steerable.py model.onnx steerable.onnx --layer 14
```

The exports come from onnxruntime-genai (onnx-community/Qwen3-1.7B-ONNX). There the
residual add is fused into `SkipSimplifiedLayerNormalization`; output 3 of layer L+1's
input layernorm is the residual stream after layer L (resid_post L), which is what the
SAEs are trained on.
