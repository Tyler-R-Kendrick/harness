/** Base ACP protocol version this implementation speaks. */
export const ACP_PROTOCOL_VERSION = 1;

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
} as const;

/** ACP methods the daemon uses from the base protocol. */
export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  cancelRequest: "$/cancel_request",
} as const;
