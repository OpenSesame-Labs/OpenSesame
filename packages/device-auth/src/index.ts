export {
  type DeviceAuthProjection,
  type DevicePollError,
  MAX_POLL_INTERVAL_SECONDS,
  type PollIntervalState,
  applySlowDown,
  evaluateDevicePoll,
  initialPollInterval,
  projectDeviceAuth,
  shouldSlowDown,
} from "./projection.js";
