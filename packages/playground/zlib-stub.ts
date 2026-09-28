// The playground's stand-in for node:zlib, which just-bash names for gzip commands (see build.ts).
const unavailable = () => {
  throw new Error("gzip is not available in the browser playground");
};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export const deflateSync = unavailable;
export const inflateSync = unavailable;
export const constants = {};
export default { gzipSync, gunzipSync, deflateSync, inflateSync, constants };
