"""Make an onnxruntime-genai decoder export steerable at one layer.

Adds, at resid_post of layer L (the sum inside layer L+1's input layernorm):
  - output `resid.L`  [batch, sequence, hidden]: the residual stream after layer L
  - input  `steer.L`  [hidden]: a vector added into that residual at every position
Nothing else in the graph changes.
"""
import argparse

import onnx
from onnx import TensorProto, helper


def activation_type(graph: onnx.GraphProto) -> int:
    """The KV cache has the activations' dtype (float32 in CPU builds, float16 in fp16 builds)."""
    for i in graph.input:
        if i.name.startswith("past_key_values."):
            return i.type.tensor_type.elem_type
    return TensorProto.FLOAT


def make_steerable(model: onnx.ModelProto, layer: int, hidden: int) -> onnx.ModelProto:
    g = model.graph
    target = f"/model/layers.{layer + 1}/input_layernorm/SkipLayerNorm"
    index = next((i for i, n in enumerate(g.node) if n.name == target), None)
    if index is None:
        raise SystemExit(f"no node {target}: is this an onnxruntime-genai decoder export, and is layer {layer} not the last?")
    node = g.node[index]
    if node.op_type != "SkipSimplifiedLayerNormalization":
        raise SystemExit(f"{target} is {node.op_type}, expected SkipSimplifiedLayerNormalization")
    while len(node.output) < 4:
        node.output.append("")
    if not node.output[3]:
        node.output[3] = f"/model/layers.{layer + 1}/input_layernorm/output_3"
    elem = activation_type(g)

    steer = f"steer.{layer}"
    g.input.append(helper.make_tensor_value_info(steer, elem, [hidden]))
    steered = f"/steer/layers.{layer}/Add/output_0"
    g.node.insert(index, helper.make_node("Add", [node.input[1], steer], [steered], name=f"/steer/layers.{layer}/Add"))
    node.input[1] = steered

    resid = f"resid.{layer}"
    g.node.append(helper.make_node("Identity", [node.output[3]], [resid], name=f"/steer/layers.{layer}/Resid"))
    g.output.append(helper.make_tensor_value_info(resid, elem, ["batch_size", "sequence_length", hidden]))
    return model


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source")
    p.add_argument("target")
    p.add_argument("--layer", type=int, required=True)
    p.add_argument("--hidden", type=int, default=2048)
    a = p.parse_args()
    model = make_steerable(onnx.load(a.source), a.layer, a.hidden)
    # onnx.checker does not know onnxruntime's contrib ops (com.microsoft); check_steerable.py runs the model instead.
    onnx.save(model, a.target)
    print(f"wrote {a.target}: resid.{a.layer} out, steer.{a.layer} in")


if __name__ == "__main__":
    main()
