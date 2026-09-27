// A stand-in for a Cactus WASM engine's Emscripten loader (CommonJS, as Emscripten emits
// it): packaged with the extension, and served by the test's hub as the verified file.
module.exports = async function (arg) {
  const heap = new Uint8Array(1 << 16);
  let next = 16;
  return {
    HEAPU8: heap,
    _malloc: (n) => { const p = next; next += Math.ceil((n + 8) / 16) * 16; return p; },
    _free: () => {},
    _tiny_load: () => (arg.wasmBinary.length > 0 ? 0 : -1),
    UTF8ToString: (p) => { let e = p; while (heap[e]) e++; return new TextDecoder().decode(heap.subarray(p, e)); },
    ccall: (name, _r, _t, args) => {
      if (name === "tiny_embed") return 2;
      if (name !== "tiny_complete") return 0;
      const reply = new TextEncoder().encode(JSON.stringify({ success: true, function_calls: [{ name: "t", arguments: {} }], confidence: 0.9, reasoning: "" }));
      heap.set(reply, args[2]);
      heap[args[2] + reply.length] = 0;
      return 1;
    },
  };
};
