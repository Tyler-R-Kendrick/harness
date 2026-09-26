import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

/** Base ACP protocol version this implementation speaks: the official SDK's. */
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Version of the `_harness` ACP extension profile, negotiated in `initialize`. */
export const HARNESS_PROFILE_VERSION = 1;

/**
 * Daemon-specific operations beyond base ACP, published as namespaced ACP extension
 * methods. A stock ACP client never needs them; base sessions and prompts work without.
 */
export const HARNESS_METHODS = {
  sessionAttach: "_harness/session/attach",
  sessionDetach: "_harness/session/detach",
  sessionAck: "_harness/session/ack",
  sessionTree: "_harness/session/tree",
  /** Notification: a daemon-side session event (turn/permission lifecycle) with its log offset. */
  sessionEvent: "_harness/session/event",
  /** Notification: the subscriber fell too far behind and must re-attach from `head`. */
  sessionResync: "_harness/session/resync",
  capabilitiesList: "_harness/capabilities/list",
  capabilitiesOffer: "_harness/capabilities/offer",
  capabilitiesWithdraw: "_harness/capabilities/withdraw",
  hooksSubscribe: "_harness/hooks/subscribe",
  hooksPoll: "_harness/hooks/poll",
  hooksAck: "_harness/hooks/ack",
  /** Run a cognitive-core operation (judge, route, embed, compress, parse, decide-tools) on the platform's models. */
  cognitiveInvoke: "_harness/cognitive/invoke",
  /** The model ensemble: members, their state, and the ranking per task. */
  cognitiveStatus: "_harness/cognitive/status",
} as const;

/** ACP methods the daemon uses from the base protocol, named by the official SDK. */
export const ACP_METHODS = {
  initialize: AGENT_METHODS.initialize,
  sessionNew: AGENT_METHODS.session_new,
  sessionLoad: AGENT_METHODS.session_load,
  sessionList: AGENT_METHODS.session_list,
  sessionPrompt: AGENT_METHODS.session_prompt,
  sessionCancel: AGENT_METHODS.session_cancel,
  sessionUpdate: CLIENT_METHODS.session_update,
  requestPermission: CLIENT_METHODS.session_request_permission,
  cancelRequest: PROTOCOL_METHODS.cancel_request,
} as const;
