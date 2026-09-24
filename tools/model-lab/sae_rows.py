"""Extract the SAE rows a behavior graph uses into sae-rows.json (no torch needed).

Reads a dictionary_learning SAE saved with torch.save (a zip holding a pickle and raw
tensor storages): encoder.weight [width, dims], encoder.bias [width], decoder.weight
[dims, width], b_dec [dims], threshold (scalar, for BatchTopK/JumpReLU inference).

Activation is relu(W_enc (x - b_dec) + b_enc) gated by the threshold, so b_dec is
folded into each row's bias: bias_i = b_enc_i - W_enc_i . b_dec. The pack then
computes w_i . x + bias_i exactly, from the row alone.
"""
import argparse
import base64
import collections
import json
import pickle
import zipfile

import numpy as np


class _Storage:
    def __init__(self, dtype):
        self.dtype = dtype


_DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64, "IntStorage": np.int32, "LongStorage": np.int64, "BFloat16Storage": None}


def load_state_dict(path: str) -> dict:
    zf = zipfile.ZipFile(path)
    pkl = next(n for n in zf.namelist() if n.endswith("data.pkl"))
    prefix = pkl[: -len("data.pkl")]

    def rebuild(storage, offset, size, stride, *_):
        arr = storage
        itemsize = arr.itemsize
        return np.lib.stride_tricks.as_strided(arr[offset:], shape=tuple(size), strides=tuple(s * itemsize for s in stride)).copy()

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if module == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild
            if module == "collections" and name == "OrderedDict":
                return collections.OrderedDict
            if module == "torch" and name in _DTYPES:
                if _DTYPES[name] is None:
                    raise SystemExit(f"{name} is not supported; save the SAE in float32")
                return _Storage(_DTYPES[name])
            raise SystemExit(f"refusing to unpickle {module}.{name}")

        def persistent_load(self, pid):
            _, storage_type, key, _location, _numel = pid
            return np.frombuffer(zf.read(f"{prefix}data/{key}"), dtype=storage_type.dtype)

    return Unpickler(zf.open(pkl)).load()


def b64(v: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(v, dtype="<f4").tobytes()).decode()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("sae", help="ae.pt")
    p.add_argument("out", help="sae-rows.json")
    p.add_argument("--features", required=True, help="comma-separated feature indexes")
    p.add_argument("--source", default="{}", help="JSON describing where the SAE came from (repo, revision, file)")
    a = p.parse_args()
    sd = load_state_dict(a.sae)
    w_enc, b_enc, w_dec, b_dec = sd["encoder.weight"], sd["encoder.bias"], sd["decoder.weight"], sd["b_dec"]
    threshold = float(np.asarray(sd.get("threshold", 0.0)).reshape(-1)[0])
    width, dims = w_enc.shape
    rows = {}
    for i in (int(x) for x in a.features.split(",")):
        rows[str(i)] = {
            "encoder": b64(w_enc[i]),
            "bias": float(b_enc[i] - w_enc[i] @ b_dec),
            "threshold": threshold,
            "decoder": b64(w_dec[:, i]),
        }
    json.dump({"format": "harness.sae-rows/v1", "source": json.loads(a.source), "dims": int(dims), "width": int(width), "features": rows}, open(a.out, "w"), indent=1)
    print(f"wrote {len(rows)} feature rows ({dims}-d, width {width}, threshold {threshold:.4f}) to {a.out}")


if __name__ == "__main__":
    main()
